/**
 * `agent.runtime` conformance: what every `AgentRuntime` must do, whatever runs
 * the agent. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createAgentRuntimeConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite drives a scripted agent that the fixture provides, and observes the runtime only
 * through the capability and the `agent.*` events, as a channel would. It never sees an agent
 * message (they are opaque in the core), so an answer is attributed by its text.
 *
 * The script every fixture implements:
 * - Each turn answers `answer: <text of the newest inbound message>`.
 * - A turn whose newest message is exactly `hold` first calls a tool that blocks until
 *   `fixture.hold.release()`. The tool honours cancellation. Once it returns, the turn answers the
 *   newest inbound message as usual (`answer: hold`).
 * - `holdAtEnd()` pauses the next run at its final answer, before it ends.
 * - `failNext()` makes the next model call wait, then fail: the run in progress fails.
 *
 * Messages that arrive while a run goes are queued (`Admission` `queued`) and taken together by the
 * next run, which answers them all: its `requestIds` lists them, and only the first has an
 * `agent.started`. A steer (`whenBusy: "steer"`) is queued too, but joins the run in progress after
 * its tool round (the `hold` tool's), which answers it; one that arrives as the run answers gets the
 * next run, as a follow-up; one to an idle conversation starts a run.
 */

import {
  type App,
  type AppContext,
  type AppEvents,
  BACKGROUND_CONTEXT,
  type ComponentDefinition,
  defineApp,
  defineComponent,
  silentLogger,
  withCancel,
} from "@pikit/core";
import type { Admission, AgentRuntime, ConversationRef } from "../agent.ts";
import type { ConformanceCase } from "@pikit/core/testing";

/** A fresh set of records and a scripted agent, built for one case. */
export interface AgentRuntimeFixture {
  /**
   * One worker: the component providing `agent.runtime` and everything it uses (agents, storage,
   * models). The suite may create several apps from them over the same records, one after the
   * other, so they must keep durable state outside the components' setup (in the fixture).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** A new conversation of the scripted agent, new in the runtime's storage. */
  conversation(): Promise<ConversationRef>;
  /** The `hold` tool of this fixture. One hold per case. */
  hold: {
    /** Resolves when a run has called the tool. */
    readonly started: Promise<void>;
    /** Lets the tool return. */
    release(): void;
  };
  /** Pause the next run at its final answer (the model's answer has not ended the run yet), until `release()`. */
  holdAtEnd(): { reached: Promise<void>; release(): void };
  /**
   * Make the next model call wait until `release()`, then fail as a provider error that is not
   * retried, so its run ends failed. `reached` resolves once that call has started.
   */
  failNext(): { reached: Promise<void>; release(): void };
  /**
   * A conversation whose previous worker died in the middle of a `hold` run: its records say the
   * run is open, and no process drives it. When resumed, the tool must not block again (a tool that
   * is not replayed reports it was interrupted). Returns the run's request id.
   */
  interrupted(): Promise<{ conversation: ConversationRef; requestId: string }>;
  /** Release what the fixture holds (temporary directories). */
  dispose?(): Promise<void>;
}

export interface AgentRuntimeConformanceOptions {
  /** How long to wait for an expected event. Default 5000 ms. */
  timeoutMs?: number;
  /** How long the conversation must stay quiet when the suite checks that nothing else runs. Default 50 ms. */
  quietMs?: number;
}

type AgentEventName = "agent.dispatched" | "agent.started" | "agent.settled" | "agent.failed";
type Recorded = { [K in AgentEventName]: { name: K; payload: AppEvents[K] } }[AgentEventName];
type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

const GROUP = "agent.runtime";
/** A 1×1 transparent PNG, base64: the image of the images case. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export function createAgentRuntimeConformance(
  factory: () => AgentRuntimeFixture | Promise<AgentRuntimeFixture>,
  options: AgentRuntimeConformanceOptions = {},
): readonly ConformanceCase[] {
  const timeoutMs = options.timeoutMs ?? 5000;
  const quietMs = options.quietMs ?? 50;
  const runtimeCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const workers: Worker[] = [];
      const subject = createSubject(fixture, workers, timeoutMs, quietMs);
      try {
        await run(subject);
      } finally {
        fixture.hold.release();
        for (const worker of workers) await worker.app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    runtimeCase("an idle conversation starts a run, and its answer is agent.settled", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();

      expect(await w.dispatch("r1", "hello", conversation), { kind: "started", requestId: "r1" }, "admission");

      const dispatched = await w.event("agent.dispatched", (e) => e.admission.requestId === "r1");
      same(dispatched.conversation, conversation, "agent.dispatched conversation");
      const started = await w.event("agent.started", (e) => e.requestId === "r1");
      expect(started, { conversation, requestId: "r1", resumed: false }, "agent.started");
      const result = await w.result("r1");
      expect([result.kind, result.text, result.requestIds], ["completed", "answer: hello", ["r1"]], "result");
      same(result.conversation, conversation, "result conversation");
    }),

    runtimeCase("a message with images is admitted and answered like any other (the script answers its text)", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      const images = [{ mimeType: "image/png", data: PIXEL }];

      const admission = await s.within(w.runtime.dispatch({ requestId: "r1", conversation, prompt: "look at this", images }, w.app.context()), "dispatch(r1)");
      expect(admission, { kind: "started", requestId: "r1" }, "admission");
      const result = await w.result("r1");
      expect([result.kind, result.text, result.requestIds], ["completed", "answer: look at this", ["r1"]], "result");
    }),

    runtimeCase("messages to a busy conversation are queued, and the next run takes them together", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      await w.dispatch("r1", "hold", conversation);
      await s.within(s.fixture.hold.started, "the hold tool to start");

      expect(await w.dispatch("r2", "change course", conversation), { kind: "queued", requestId: "r2" }, "admission of r2");
      expect(await w.dispatch("r3", "and hurry", conversation), { kind: "queued", requestId: "r3" }, "admission of r3");
      s.fixture.hold.release();

      const first = await w.result("r1");
      expect([first.kind, first.text, first.requestIds], ["completed", "answer: hold", ["r1"]], "result of the run in progress");
      expect(await w.event("agent.started", (e) => e.requestId === "r2"), { conversation, requestId: "r2", resumed: false }, "agent.started of the next run");
      const next = await w.result("r2");
      expect([next.kind, next.text], ["completed", "answer: and hurry"], "result of the next run");
      expect(next.requestIds, ["r2", "r3"], "the requests the next run answered");
      await s.quiet();
      w.none((e) => (e.name === "agent.started" || e.name === "agent.settled" || e.name === "agent.failed") && requestIdOf(e) === "r3", "a run of its own for r3");
    }),

    runtimeCase("a message that arrives as the run ends gets the next run", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      const end = s.fixture.holdAtEnd();
      await w.dispatch("r1", "hello", conversation);
      await s.within(end.reached, "the run to reach its end");

      expect(await w.dispatch("r2", "one more thing", conversation), { kind: "queued", requestId: "r2" }, "admission");
      end.release();

      const first = await w.result("r1");
      expect([first.kind, first.text, first.requestIds], ["completed", "answer: hello", ["r1"]], "result of the run");
      const next = await w.result("r2");
      expect([next.kind, next.text, next.requestIds], ["completed", "answer: one more thing", ["r2"]], "result of the next run");
    }),

    runtimeCase("a message queued behind a run that fails gets a run of its own, and its answer", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      const failing = s.fixture.failNext();
      await w.dispatch("r1", "hello", conversation);
      await s.within(failing.reached, "the model call to start");

      // Queued while the model answers: no boundary takes it before the run fails.
      expect(await w.dispatch("r2", "are you there?", conversation), { kind: "queued", requestId: "r2" }, "admission");
      failing.release();

      const failed = await w.result("r1");
      expect([failed.kind, failed.requestIds], ["failed", ["r1"]], "result of the failed run");
      // No third message: the runtime starts the run for what the failed one left queued.
      expect(await w.event("agent.started", (e) => e.requestId === "r2"), { conversation, requestId: "r2", resumed: false }, "agent.started");
      const answered = await w.result("r2");
      expect([answered.kind, answered.text, answered.requestIds], ["completed", "answer: are you there?", ["r2"]], "its result");
      expect(await w.dispatch("r2", "are you there?", conversation), { kind: "duplicate", requestId: "r2" }, "a redelivery");
    }),

    runtimeCase("a repeated requestId is a duplicate: settled, running, queued, and concurrent", async (s) => {
      const w = await s.worker();
      const settled = await s.fixture.conversation();
      await w.dispatch("r1", "hello", settled);
      await w.result("r1");
      expect(await w.dispatch("r1", "hello", settled), { kind: "duplicate", requestId: "r1" }, "a settled request");
      await w.event("agent.dispatched", (e) => e.admission.kind === "duplicate" && e.admission.requestId === "r1");

      const busy = await s.fixture.conversation();
      await w.dispatch("r2", "hold", busy);
      await s.within(s.fixture.hold.started, "the hold tool to start");
      expect(await w.dispatch("r2", "hold", busy), { kind: "duplicate", requestId: "r2" }, "a running request");
      await w.dispatch("r3", "change course", busy);
      expect(await w.dispatch("r3", "change course", busy), { kind: "duplicate", requestId: "r3" }, "a queued request");
      s.fixture.hold.release();
      await w.result("r2");

      const concurrent = await s.fixture.conversation();
      const kinds = (await Promise.all([w.dispatch("r4", "hello", concurrent), w.dispatch("r4", "hello", concurrent)]))
        .map((a) => a.kind)
        .sort();
      expect(kinds, ["duplicate", "started"], "two deliveries at the same time");
      await w.result("r4");
      await s.quiet();
      expect(w.all("agent.started", (e) => e.requestId === "r4").length, 1, "runs started for r4");
    }),

    runtimeCase("cancelling the caller's context stops the wait, not the run; agent.settled still arrives", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      const { context, cancel } = withCancel(BACKGROUND_CONTEXT);

      await w.dispatch("r1", "hold", conversation, w.app.context(context));
      await s.within(s.fixture.hold.started, "the hold tool to start");
      cancel(new Error("the caller went away"));
      s.fixture.hold.release();

      const result = await w.result("r1");
      expect([result.kind, result.text], ["completed", "answer: hold"], "result");
    }),

    runtimeCase("abort() stops the run; a message queued in it is withdrawn and stays a duplicate", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      await w.dispatch("r1", "hold", conversation);
      await s.within(s.fixture.hold.started, "the hold tool to start");
      await w.dispatch("r2", "change course", conversation);

      await s.within(w.runtime.abort(conversation, w.app.context()), "abort() to return");

      const aborted = await w.result("r1");
      expect([aborted.kind, aborted.requestIds], ["aborted", ["r1"]], "result, without the withdrawn request");
      expect(await w.dispatch("r2", "change course", conversation), { kind: "duplicate", requestId: "r2" }, "a withdrawn request");
      // The conversation is usable again.
      expect((await w.dispatch("r3", "hello", conversation)).kind, "started", "a new message after abort");
      expect((await w.result("r3")).text, "answer: hello", "its answer");
    }),

    runtimeCase("a steer to a busy conversation joins the run in progress after its tool round, and that run answers it", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      await w.dispatch("r1", "hold", conversation);
      await s.within(s.fixture.hold.started, "the hold tool to start");

      expect(await w.steer("r2", "change course", conversation), { kind: "queued", requestId: "r2" }, "admission of the steer");
      s.fixture.hold.release();

      const result = await w.result("r1");
      expect([result.kind, result.text, result.requestIds], ["completed", "answer: change course", ["r1", "r2"]], "the run it joined");
      await s.quiet();
      w.none((e) => (e.name === "agent.started" || e.name === "agent.settled" || e.name === "agent.failed") && requestIdOf(e) === "r2", "a run of its own for the steer");
      expect(await w.steer("r2", "change course", conversation), { kind: "duplicate", requestId: "r2" }, "a redelivered steer");
    }),

    runtimeCase("a steer that arrives as the run answers gets the next run, as a follow-up", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      const end = s.fixture.holdAtEnd();
      await w.dispatch("r1", "hello", conversation);
      await s.within(end.reached, "the run to reach its end");

      expect(await w.steer("r2", "one more thing", conversation), { kind: "queued", requestId: "r2" }, "admission");
      end.release();

      const first = await w.result("r1");
      expect([first.kind, first.text, first.requestIds], ["completed", "answer: hello", ["r1"]], "result of the run");
      expect(await w.event("agent.started", (e) => e.requestId === "r2"), { conversation, requestId: "r2", resumed: false }, "agent.started of the next run");
      const next = await w.result("r2");
      expect([next.kind, next.text, next.requestIds], ["completed", "answer: one more thing", ["r2"]], "result of the next run");
    }),

    runtimeCase("a steer to an idle conversation starts a run", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();

      expect(await w.steer("r1", "hello", conversation), { kind: "started", requestId: "r1" }, "admission");

      expect(await w.event("agent.started", (e) => e.requestId === "r1"), { conversation, requestId: "r1", resumed: false }, "agent.started");
      const result = await w.result("r1");
      expect([result.kind, result.text, result.requestIds], ["completed", "answer: hello", ["r1"]], "result");
    }),

    runtimeCase("resume() continues a run a dead worker left open, and agent.settled arrives", async (s) => {
      const { conversation, requestId } = await s.fixture.interrupted();
      const w = await s.worker();

      await s.within(w.runtime.resume(conversation, w.app.context()), "resume() to return");

      expect(await w.event("agent.started", (e) => e.requestId === requestId), { conversation, requestId, resumed: true }, "agent.started");
      expect((await w.result(requestId)).kind, "completed", "result kind");
    }),

    runtimeCase("a request is still a duplicate after its worker died", async (s) => {
      const { conversation, requestId } = await s.fixture.interrupted();
      const w = await s.worker();

      expect(await w.dispatch(requestId, "hold", conversation), { kind: "duplicate", requestId }, "admission");
      expect((await w.result(requestId)).kind, "completed", "the resumed run");
    }),

    runtimeCase("a message to a conversation with an interrupted run resumes it, and the next run answers the message", async (s) => {
      const { conversation, requestId } = await s.fixture.interrupted();
      // The resumed run may be fast: keep it open until the message is admitted.
      const end = s.fixture.holdAtEnd();
      const w = await s.worker();

      expect(await w.dispatch("r2", "after the crash", conversation), { kind: "queued", requestId: "r2" }, "admission");
      end.release();

      const resumed = await w.result(requestId);
      expect([resumed.kind, resumed.requestIds], ["completed", [requestId]], "result of the resumed run");
      const next = await w.result("r2");
      expect([next.kind, next.text, next.requestIds], ["completed", "answer: after the crash", ["r2"]], "result of the next run");
    }),
  ];
}

interface Worker {
  app: App;
  runtime: AgentRuntime;
  dispatch(requestId: string, prompt: string, conversation: ConversationRef, ctx?: AppContext): Promise<Admission>;
  /** `dispatch` with `whenBusy: "steer"`. */
  steer(requestId: string, prompt: string, conversation: ConversationRef): Promise<Admission>;
  event<K extends AgentEventName>(name: K, match: (payload: AppEvents[K]) => boolean): Promise<AppEvents[K]>;
  /** The `agent.settled` or `agent.failed` of the run started by `requestId`. */
  result(requestId: string): Promise<Result>;
  all<K extends AgentEventName>(name: K, match: (payload: AppEvents[K]) => boolean): AppEvents[K][];
  none(match: (event: Recorded) => boolean, what: string): void;
}

interface Subject {
  fixture: AgentRuntimeFixture;
  /** A new worker (app) over the fixture's records, started. */
  worker(): Promise<Worker>;
  within<T>(promise: Promise<T>, what: string): Promise<T>;
  /** Let anything still in flight happen before checking that it did not. */
  quiet(): Promise<void>;
}

function createSubject(fixture: AgentRuntimeFixture, workers: Worker[], timeoutMs: number, quietMs: number): Subject {
  const within = <T>(promise: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${GROUP}: timed out after ${timeoutMs} ms waiting for ${what}`)), timeoutMs);
    });
    // Workers' clearTimeout takes no `undefined`: the suites also compile against its types.
    return Promise.race([promise, timeout]).finally(() => timer !== undefined && clearTimeout(timer));
  };

  return {
    fixture,
    within,
    quiet: () => new Promise((resolve) => setTimeout(resolve, quietMs)),
    async worker() {
      const recorded: Recorded[] = [];
      const waiters = new Set<() => void>();
      let runtime: AgentRuntime | undefined;
      const observer = defineComponent({
        name: "agent-runtime-conformance",
        setup(pikit) {
          const handle = pikit.use("agent.runtime");
          const record = (event: Recorded) => {
            recorded.push(event);
            for (const wake of waiters) wake();
          };
          pikit.on("agent.dispatched", (payload) => record({ name: "agent.dispatched", payload }));
          pikit.on("agent.started", (payload) => record({ name: "agent.started", payload }));
          pikit.on("agent.settled", (payload) => record({ name: "agent.settled", payload }));
          pikit.on("agent.failed", (payload) => record({ name: "agent.failed", payload }));
          return {
            start() {
              runtime = handle.get();
            },
          };
        },
      });
      const app = await defineApp({
        components: [...fixture.components, observer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      await app.start();
      if (runtime === undefined) throw new Error(`${GROUP}: agent.runtime was not resolved`);
      const agentRuntime = runtime;

      const find = <K extends AgentEventName>(name: K, match: (payload: AppEvents[K]) => boolean) =>
        recorded.filter((e): e is Extract<Recorded, { name: K }> => e.name === name).map((e) => e.payload as AppEvents[K]).filter(match);
      const waitFor = <T>(probe: () => T | undefined, what: string): Promise<T> =>
        within(
          new Promise<T>((resolve) => {
            const check = () => {
              const found = probe();
              if (found === undefined) return;
              waiters.delete(check);
              resolve(found);
            };
            waiters.add(check);
            check();
          }),
          what,
        );

      const worker: Worker = {
        app,
        runtime: agentRuntime,
        dispatch: (requestId, prompt, conversation, ctx) =>
          within(agentRuntime.dispatch({ requestId, conversation, prompt }, ctx ?? app.context()), `dispatch(${requestId})`),
        steer: (requestId, prompt, conversation) =>
          within(agentRuntime.dispatch({ requestId, conversation, prompt, whenBusy: "steer" }, app.context()), `steer(${requestId})`),
        event: (name, match) => waitFor(() => find(name, match)[0], `${name} matching the case`),
        result: (requestId) =>
          waitFor(
            () => find("agent.settled", (e) => e.requestId === requestId)[0] ?? find("agent.failed", (e) => e.requestId === requestId)[0],
            `the result of ${requestId}`,
          ),
        all: find,
        none(match, what) {
          const found = recorded.find(match);
          if (found !== undefined) throw new Error(`${GROUP}: expected no ${what}, got ${found.name} ${JSON.stringify(found.payload)}`);
        },
      };
      workers.push(worker);
      return worker;
    },
  };
}

function requestIdOf(event: Recorded): string {
  return event.name === "agent.dispatched" ? event.payload.admission.requestId : event.payload.requestId;
}

/** Deep equality on JSON-shaped values, so the suite does not depend on a test framework. */
function expect(actual: unknown, expected: unknown, what: string): void {
  if (!equal(actual, expected)) {
    throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function same(actual: ConversationRef, expected: ConversationRef, what: string): void {
  expect(
    { key: actual.key, agent: actual.agent, conversationId: actual.conversationId },
    { key: expected.key, agent: expected.agent, conversationId: expected.conversationId },
    what,
  );
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
