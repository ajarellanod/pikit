/**
 * `agent.runtime` conformance (SPEC §6.1, §14): what every `AgentRuntime` must do, whatever runs
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
 *   newest inbound message as usual (`answer: hold`, or a message that arrived meanwhile).
 * - `holdAtEnd()` pauses the next run after its final answer, before it ends.
 */

import { type ComponentDefinition, defineApp, defineComponent, type App, type AppContext } from "../app.ts";
import type { Admission, AgentRuntime, ConversationRef } from "../agent.ts";
import { BACKGROUND_CONTEXT, withCancel } from "../context.ts";
import { silentLogger } from "../contracts/logger.ts";
import type { AppEvents } from "../events.ts";
import type { ConformanceCase } from "./lifecycle.ts";

/** A fresh set of records and a scripted agent, built for one case. */
export interface AgentRuntimeFixture {
  /**
   * One worker: the component providing `agent.runtime` and everything it uses (agents, sessions,
   * models). The suite may create several apps from them over the same records, one after the
   * other, so they must keep durable state outside the components' setup (in the fixture).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** A new conversation of the scripted agent, with a new session. */
  conversation(): Promise<ConversationRef>;
  /** The `hold` tool of this fixture. One hold per case. */
  hold: {
    /** Resolves when a run has called the tool. */
    readonly started: Promise<void>;
    /** Lets the tool return. */
    release(): void;
  };
  /** Pause the next run that ends after its final answer, until `release()`. */
  holdAtEnd(): { reached: Promise<void>; release(): void };
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

    runtimeCase("a message to a busy conversation is queued and the run in progress answers it", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      await w.dispatch("r1", "hold", conversation);
      await s.within(s.fixture.hold.started, "the hold tool to start");

      expect(await w.dispatch("r2", "change course", conversation), { kind: "queued", requestId: "r2" }, "admission");
      s.fixture.hold.release();

      const result = await w.result("r1");
      expect([result.kind, result.text], ["completed", "answer: change course"], "result of the run");
      expect(result.requestIds, ["r1", "r2"], "the requests the run answered");
      await s.quiet();
      w.none((e) => e.name !== "agent.dispatched" && requestIdOf(e) === "r2", "a run of its own for the queued message");
    }),

    runtimeCase("a message that arrives as the run ends is answered by that run", async (s) => {
      const w = await s.worker();
      const conversation = await s.fixture.conversation();
      const end = s.fixture.holdAtEnd();
      await w.dispatch("r1", "hello", conversation);
      await s.within(end.reached, "the run to reach its end");

      expect(await w.dispatch("r2", "one more thing", conversation), { kind: "queued", requestId: "r2" }, "admission");
      end.release();

      const result = await w.result("r1");
      expect([result.kind, result.text], ["completed", "answer: one more thing"], "result of the run");
      expect(result.requestIds, ["r1", "r2"], "the requests the run answered");
      await s.quiet();
      w.none((e) => e.name !== "agent.dispatched" && requestIdOf(e) === "r2", "a run of its own for the late message");
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

    runtimeCase("a message to a conversation with an interrupted run resumes it, and that run answers", async (s) => {
      const { conversation, requestId } = await s.fixture.interrupted();
      // The resumed run may be fast: keep it open until the message is admitted.
      const end = s.fixture.holdAtEnd();
      const w = await s.worker();

      expect(await w.dispatch("r2", "after the crash", conversation), { kind: "queued", requestId: "r2" }, "admission");
      end.release();

      const result = await w.result(requestId);
      expect([result.kind, result.text], ["completed", "answer: after the crash"], "result of the resumed run");
      expect(result.requestIds, [requestId, "r2"], "the requests the resumed run answered");
    }),
  ];
}

interface Worker {
  app: App;
  runtime: AgentRuntime;
  dispatch(requestId: string, prompt: string, conversation: ConversationRef, ctx?: AppContext): Promise<Admission>;
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
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    { key: actual.key, agent: actual.agent, sessionId: actual.sessionId },
    { key: expected.key, agent: expected.agent, sessionId: expected.sessionId },
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
