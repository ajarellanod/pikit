/**
 * `agent.observe` conformance: what every observer of an agent runtime guarantees (`../observe.ts`).
 * Runner-independent:
 *
 *   for (const c of createAgentObserveConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite talks to the runtime as a channel would (`agent.conversations`, `agent.runtime`, the
 * `agent.*` events) and checks what the observer says about it. It knows nothing of the runtime's
 * JSON: an answer is found by its text (`AgentResult.text`) anywhere in what the observer returns.
 * A watch is followed as a view would: every `live` event's ops applied in order to the first value
 * (`applyOps`), each state checked to be an `ObservedLive`.
 */

import { type App, type AppContext, type AppEvents, type ComponentDefinition, defineApp, defineComponent, silentLogger, withAbortSignal } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { AgentConversations, AgentRuntime, ConversationRef } from "../agent.ts";
import { applyOps, type JsonOp } from "../json-ops.ts";
import type { JsonValue } from "../json.ts";
import type { AgentObserver, ObservedEvent, ObservedLive, TranscriptEntry } from "../observe.ts";
import { checker, expecter } from "./assert.ts";

export interface AgentObserveFixture {
  /** The runtime, providing `agent.runtime`, `agent.conversations` and `agent.observe`, and what it uses. */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** An agent of `components` that answers every message with some text. */
  agent: string;
  /**
   * An agent of `components` that answers every message with some text, written over a second or
   * more, a few characters at a time (runtime-pi: a model streaming a few tokens a second), so a watch
   * sees the answer being written and a run can be aborted before it answers.
   */
  streaming: string;
  dispose?(): Promise<void>;
}

export interface AgentObserveConformanceOptions {
  /** How long to wait for an answer or an event. Default 10000 ms. */
  timeoutMs?: number;
}

const GROUP = "agent.observe";
const expect = expecter(GROUP);
const check = checker(GROUP);

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

/** An event a watch gave, with the live state once its ops are applied. */
type Logged = ObservedEvent & { readonly after: ObservedLive };

/** One watch, followed as a view follows it. */
interface Watched {
  /** The state the `live` ops built so far. */
  readonly state: ObservedLive;
  /** The state after each `live` event, the first one's included. */
  readonly states: readonly ObservedLive[];
  /** Every event after the first, in order. */
  readonly log: readonly Logged[];
  /** Every entry the `entries` events brought, in order. */
  readonly entries: readonly TranscriptEntry[];
  /** Takes events until `done()` holds; resolves with how many it took. Fails if the stream ends first. */
  until(done: () => boolean, what: string): Promise<number>;
  /** Cancels the watch's context and waits for the stream to end. */
  stop(): Promise<void>;
}

interface Running {
  app: App;
  ctx: AppContext;
  observe: AgentObserver;
  /** The fixture's streaming agent. */
  streaming: string;
  /** A new conversation of `agent` (default the fixture's agent), under `key`. */
  conversation(key: string, agent?: string): Promise<ConversationRef>;
  /** Sends `prompt` and resolves with the run's end, checked to be an answer. */
  send(conversation: ConversationRef, requestId: string, prompt: string): Promise<Result>;
  /** Sends `prompt` and resolves with the run's end, however it ends. */
  dispatch(conversation: ConversationRef, requestId: string, prompt: string): Promise<Result>;
  abort(conversation: ConversationRef): Promise<void>;
  /** Watches a conversation and takes its first event, checked to be its whole live state. */
  watch(conversationId: string): Promise<Watched>;
}

export function createAgentObserveConformance(
  factory: () => AgentObserveFixture | Promise<AgentObserveFixture>,
  options: AgentObserveConformanceOptions = {},
): readonly ConformanceCase[] {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const within = <T>(promise: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${GROUP}: timed out after ${timeoutMs} ms waiting for ${what}`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => timer !== undefined && clearTimeout(timer));
  };

  const observeCase = (name: string, run: (s: Running) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const results = new Map<string, (result: Result) => void>();
      const ended = new Map<string, Result>();
      const watches: Watched[] = [];
      let handles: { runtime: () => AgentRuntime; conversations: () => AgentConversations; observe: () => AgentObserver } | undefined;
      const probe = defineComponent({
        name: "observe-conformance",
        setup(pikit) {
          const runtime = pikit.use("agent.runtime");
          const conversations = pikit.use("agent.conversations");
          const observe = pikit.use("agent.observe");
          handles = { runtime: () => runtime.get(), conversations: () => conversations.get(), observe: () => observe.get() };
          const record = (result: Result) => {
            for (const requestId of result.requestIds) {
              ended.set(requestId, result);
              results.get(requestId)?.(result);
            }
          };
          pikit.on("agent.settled", record);
          pikit.on("agent.failed", record);
        },
      });
      const app = await defineApp({ components: [...fixture.components, probe], ...(fixture.config !== undefined && { config: fixture.config }), logger: silentLogger }).create();
      try {
        await within(app.start(), "the app to start");
        if (handles === undefined) throw new Error(`${GROUP}: the probe did not set up`);
        const { runtime, conversations, observe } = handles;
        const ctx = app.context();
        /** Dispatches; `ended` is the run's end. */
        const dispatch = async (conversation: ConversationRef, requestId: string, prompt: string): Promise<{ ended: Promise<Result> }> => {
          const result = new Promise<Result>((resolve) => {
            const done = ended.get(requestId);
            if (done !== undefined) resolve(done);
            else results.set(requestId, resolve);
          });
          await runtime().dispatch({ requestId, conversation, prompt }, ctx);
          return { ended: result };
        };
        await run({
          app,
          ctx,
          observe: observe(),
          streaming: fixture.streaming,
          conversation: async (key, agent) => ({ key, agent: agent ?? fixture.agent, conversationId: await conversations().create(ctx) }),
          async send(conversation, requestId, prompt) {
            const settled = await within((await dispatch(conversation, requestId, prompt)).ended, `the answer to ${requestId}`);
            check(settled.kind === "completed", `the run of ${requestId} to complete, got ${settled.kind} ${JSON.stringify(settled.error)}`);
            return settled;
          },
          dispatch: async (conversation, requestId, prompt) => (await dispatch(conversation, requestId, prompt)).ended,
          abort: (conversation) => runtime().abort(conversation, ctx),
          watch: async (conversationId) => {
            const w = await follow(observe(), conversationId, ctx, within);
            watches.push(w);
            return w;
          },
        });
      } finally {
        for (const w of watches) await w.stop().catch(() => {});
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    observeCase("a conversation a message reached is listed with its key, agent, last activity and cost, idle once answered", async (s) => {
      const conversation = await s.conversation("conformance:listed");
      const result = await s.send(conversation, "r-listed", "hello, observer");
      const listed = await allConversations(s.observe, s.ctx);
      const found = listed.find((c) => c.conversationId === conversation.conversationId);

      check(found !== undefined, `conversation ${conversation.conversationId} in the list ${JSON.stringify(listed.map((c) => c.conversationId))}`);
      expect([found?.key, found?.agent, found?.busy], [conversation.key, conversation.agent, false], "its key, agent and busy");
      check(typeof found?.lastActivity === "number" && found.lastActivity > 0, `a last activity, got ${JSON.stringify(found?.lastActivity)}`);
      expect(found?.usage, await s.observe.usage(conversation.conversationId, s.ctx), "its usage, as usage() says");
      if (result.usage !== undefined) expect(tokensOf(found?.usage), tokensOf(result.usage), "its tokens: its one run's");
      expect(await s.observe.conversation(conversation.conversationId, s.ctx), found, "conversation(id), as the list says");
    }),

    observeCase("a conversation no message reached has no key, no agent, no cost", async (s) => {
      const conversation = await s.conversation("conformance:empty");
      const found = await s.observe.conversation(conversation.conversationId, s.ctx);

      check(found !== undefined, "the new conversation to be found");
      expect([found?.key, found?.agent, found?.busy, tokensOf(found?.usage)], [undefined, undefined, false, 0], "its key, agent, busy and tokens");
    }),

    observeCase("conversations come a page at a time, each once", async (s) => {
      const made = [await s.conversation("conformance:p1"), await s.conversation("conformance:p2"), await s.conversation("conformance:p3")];
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await s.observe.conversations(cursor === undefined ? { limit: 1 } : { limit: 1, cursor }, s.ctx);
        check(page.items.length <= 1, `a page of at most 1, got ${page.items.length}`);
        seen.push(...page.items.map((c) => c.conversationId));
        cursor = page.next;
        check(++pages < 1000, "the pages to end");
      } while (cursor !== undefined);

      expect(new Set(seen).size, seen.length, "each conversation once");
      for (const conversation of made) check(seen.includes(conversation.conversationId), `conversation ${conversation.conversationId} on a page`);
      expect(seen, (await allConversations(s.observe, s.ctx)).map((c) => c.conversationId), "the pages, as one long list");
    }),

    observeCase("the transcript holds each message and its answer, newest first, a page at a time", async (s) => {
      const conversation = await s.conversation("conformance:transcript");
      const first = await s.send(conversation, "r-t1", "first message to observe");
      const second = await s.send(conversation, "r-t2", "second message to observe");

      const whole = await s.observe.transcript(conversation.conversationId, { limit: 500 }, s.ctx);
      check(whole !== undefined, "the transcript to be found");
      const text = JSON.stringify(whole?.items);
      for (const expected of ["first message to observe", "second message to observe", first.text ?? "", second.text ?? ""]) {
        check(text.includes(JSON.stringify(expected).slice(1, -1)), `the transcript to hold ${JSON.stringify(expected)}`);
      }
      const at = (needle: string) => (whole?.items ?? []).findIndex((entry) => JSON.stringify(entry.messages).includes(needle));
      check(at("second message to observe") < at("first message to observe"), "the second message before the first (newest first)");

      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.observe.transcript(conversation.conversationId, cursor === undefined ? { limit: 1 } : { limit: 1, cursor }, s.ctx);
        paged.push(...(page?.items ?? []).map((entry) => entry.id));
        cursor = page?.next;
      } while (cursor !== undefined && paged.length < 1000);
      expect(paged, whole?.items.map((entry) => entry.id), "the pages of one entry, as the whole transcript");
    }),

    observeCase("an unknown conversation is undefined, and watching one fails", async (s) => {
      for (const id of ["999999999", "not-a-conversation"]) {
        expect(await s.observe.conversation(id, s.ctx), undefined, `conversation(${JSON.stringify(id)})`);
        expect(await s.observe.transcript(id, {}, s.ctx), undefined, `transcript(${JSON.stringify(id)})`);
        expect(await s.observe.usage(id, s.ctx), undefined, `usage(${JSON.stringify(id)})`);
        const failed = await s.observe
          .watch(id, s.ctx)
          [Symbol.asyncIterator]()
          .next()
          .then(
            () => false,
            () => true,
          );
        check(failed, `watch(${JSON.stringify(id)}) to fail`);
      }
    }),

    observeCase("watch starts with the whole live state of a conversation, idle", async (s) => {
      const empty = await s.conversation("conformance:watch-empty");
      const fresh = await s.watch(empty.conversationId);
      expect(fresh.state, { busy: false, tools: [] }, "the first state of a conversation no message reached");
      await fresh.stop();

      const conversation = await s.conversation("conformance:watch-first");
      await s.send(conversation, "r-first", "before watching");
      const watched = await s.watch(conversation.conversationId);
      expect(watched.state, { busy: false, tools: [] }, "the first state once its run ended: idle, no requests, no partial, no tools, no failure");
      await watched.stop();
    }),

    observeCase("watch follows a run: busy with its request, the answer streaming, its entry before the answer ends, its cost, then idle", async (s) => {
      const conversation = await s.conversation("conformance:watched", s.streaming);
      const known = new Set((await s.observe.transcript(conversation.conversationId, { limit: 500 }, s.ctx))?.items.map((entry) => entry.id));
      const w = await s.watch(conversation.conversationId);

      const answered = s.send(conversation, "r-w1", "stream an answer while watching");
      await w.until(() => w.states.some((state) => state.busy) && !w.state.busy, "the run to start and end");
      const answer = (await answered).text ?? "";
      check(answer !== "", "the run to answer with some text");

      check(
        w.states.some((state) => state.busy && state.requests?.includes("r-w1") === true),
        `a busy state naming the request r-w1, saw ${JSON.stringify(w.states.map((state) => [state.busy, state.requests]))}`,
      );
      // It streams: the answer is seen being written, its text growing, before it is whole.
      const prefixes = w.states.flatMap((state) => (state.partial === undefined ? [] : [prefixHeld(state.partial, answer)]));
      check(prefixes.some((held) => held > 0 && held < answer.length), `a partial answer holding part of ${JSON.stringify(answer)}, saw prefixes of ${JSON.stringify(prefixes)}`);
      check(new Set(prefixes).size >= 2 && prefixes.every((held, i) => i === 0 || held >= (prefixes[i - 1] ?? 0)), `the partial answer to grow, saw prefixes of ${JSON.stringify(prefixes)}`);

      const holding = w.log.findIndex((event) => event.type === "entries" && JSON.stringify(event.entries).includes(escaped(answer)));
      check(holding !== -1, `an entries event holding the answer ${JSON.stringify(answer)}`);
      const firstPartial = w.log.findIndex((event) => event.type === "live" && event.after.partial !== undefined);
      const partialEnd = w.log.findIndex((event, i) => i > firstPartial && event.type === "live" && event.after.partial === undefined);
      check(holding < partialEnd, `the answer's entry (event ${holding}) before the partial answer ends (event ${partialEnd})`);
      check(w.log.some((event) => event.type === "usage"), `a usage event, saw ${JSON.stringify(w.log.map((event) => event.type))}`);
      expect(w.state, { busy: false, tools: [] }, "the state once the run ended: idle, no requests, no partial, no tools, no failure");

      const ids = w.entries.map((entry) => entry.id);
      expect(new Set(ids).size, ids.length, "each entry once");
      check(!ids.some((id) => known.has(id)), "only entries the transcript gained since the watch started");
      const transcript = (await s.observe.transcript(conversation.conversationId, { limit: 500 }, s.ctx))?.items ?? [];
      for (const entry of w.entries) expect(transcript.find((each) => each.id === entry.id), entry, `entry ${entry.id}, as the transcript has it`);
      await w.stop();
    }),

    observeCase("a run that ends without an answer shows why, until the next run starts", async (s) => {
      const conversation = await s.conversation("conformance:failed", s.streaming);
      const w = await s.watch(conversation.conversationId);
      const ended = s.dispatch(conversation, "r-f1", "stream an answer to abort");
      ended.catch(() => {});
      await w.until(() => w.state.busy && w.state.partial !== undefined, "the run to be writing its answer");
      await s.abort(conversation);
      const result = await within(ended, "the aborted run to end");
      check(result.kind !== "completed", `the aborted run not to complete, got ${result.kind}`);
      await w.until(() => !w.state.busy, "the aborted run to end");
      check(typeof w.state.failure?.reason === "string" && w.state.failure.reason !== "", `a failure with a reason, got ${JSON.stringify(w.state)}`);
      expect([w.state.requests, w.state.partial, w.state.tools], [undefined, undefined, []], "no requests, partial or tools once it ended");

      const from = w.states.length;
      await s.send(conversation, "r-f2", "answer this one");
      await w.until(() => w.states.slice(from).some((state) => state.busy) && !w.state.busy, "the next run to start and end");
      const next = w.states.slice(from).filter((state) => state.requests?.includes("r-f2") === true);
      check(next.length > 0 && next.every((state) => state.failure === undefined), `no failure while the next run goes, saw ${JSON.stringify(next)}`);
      expect(w.state, { busy: false, tools: [] }, "the state once the next run answered");
      await w.stop();
    }),

    observeCase("a consumer that falls behind gets the newest state in a few events, and the same state as a new watch", async (s) => {
      const conversation = await s.conversation("conformance:behind", s.streaming);
      const w = await s.watch(conversation.conversationId);
      // Not read while two runs stream their answers: the provider folds what changed meanwhile.
      const answers = [(await s.send(conversation, "r-b1", "first while not read")).text ?? "", (await s.send(conversation, "r-b2", "second while not read")).text ?? ""];
      const held = () => answers.every((answer) => JSON.stringify(w.entries).includes(escaped(answer)));
      const taken = await w.until(() => !w.state.busy && (held() || w.log.some((event) => event.type === "transcript")), "the newest state");
      check(taken <= BEHIND_EVENTS, `at most ${BEHIND_EVENTS} events for what changed while the consumer was behind, got ${taken}: ${JSON.stringify(w.log.map((event) => event.type))}`);
      if (!held()) {
        const transcript = JSON.stringify((await s.observe.transcript(conversation.conversationId, { limit: 500 }, s.ctx))?.items);
        for (const answer of answers) check(transcript.includes(escaped(answer)), `the transcript a transcript event points to, to hold ${JSON.stringify(answer)}`);
      }
      const again = await s.watch(conversation.conversationId);
      expect(w.state, again.state, "the state the ops built, as a new watch starts with");
      await again.stop();
      await w.stop();
    }),

    observeCase("watch ends when its context is cancelled, and when its consumer stops", async (s) => {
      const conversation = await s.conversation("conformance:cancelled");
      const w = await s.watch(conversation.conversationId);
      await w.stop();

      const iterator = s.observe.watch(conversation.conversationId, s.ctx)[Symbol.asyncIterator]();
      expect((await within(iterator.next(), "the first event")).done, false, "a first event");
      const stopped: Promise<IteratorResult<ObservedEvent>> = iterator.return?.() ?? Promise.resolve({ done: true, value: undefined });
      expect((await within(stopped, "the stream to stop")).done, true, "the stream to stop when its consumer stops");
      expect((await within(iterator.next(), "the stopped stream")).done, true, "nothing after it stopped");
      // The runtime goes on: the conversation still answers.
      await s.send(conversation, "r-c1", "after watching");
    }),
  ];
}

/** How many events a consumer that fell behind may take to reach the newest state (the suite's bound for folding). */
const BEHIND_EVENTS = 12;

/** `text` as it shows inside JSON. */
function escaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** How long a start of `answer` the JSON of `partial` holds. */
function prefixHeld(partial: JsonValue, answer: string): number {
  const json = JSON.stringify(partial);
  for (let length = answer.length; length > 0; length--) if (json.includes(escaped(answer.slice(0, length)))) return length;
  return 0;
}

/** What is wrong with `value` as an `ObservedLive`, or `undefined`. */
function liveProblem(value: JsonValue): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const live = value as { [key: string]: JsonValue };
  const known = new Set(["busy", "requests", "partial", "tools", "failure"]);
  const unknown = Object.keys(live).find((key) => !known.has(key));
  if (unknown !== undefined) return `an unknown member ${unknown}`;
  if (typeof live.busy !== "boolean") return "busy not a boolean";
  if (live.requests !== undefined && (!Array.isArray(live.requests) || !live.requests.every((id) => typeof id === "string"))) return "requests not strings";
  if (live.busy === false && live.requests !== undefined) return "requests while idle";
  if (!Array.isArray(live.tools)) return "tools not an array";
  for (const tool of live.tools) {
    const call = tool as { [key: string]: JsonValue } | null;
    if (typeof call !== "object" || call === null || typeof call.callId !== "string" || typeof call.name !== "string") return `a tool without its call id and name: ${JSON.stringify(tool)}`;
    if (!["pending", "running", "done"].includes(call.status as string)) return `a tool's status ${JSON.stringify(call.status)}`;
    if (call.output !== undefined && typeof call.output !== "string") return "a tool's output not a string";
  }
  if (live.failure !== undefined) {
    const failure = live.failure as { [key: string]: JsonValue } | null;
    if (typeof failure !== "object" || failure === null || typeof failure.reason !== "string") return "a failure without a reason";
    if (failure.detail !== undefined && typeof failure.detail !== "string") return "a failure's detail not a string";
  }
  return undefined;
}

/** A usage's tokens. `Usage` is the runtime's type (pi-ai's with runtime-pi), opaque in the contracts. */
function tokensOf(usage: unknown): number | undefined {
  return (usage as { totalTokens?: number } | undefined)?.totalTokens;
}

/** Every listed conversation, page after page. */
async function allConversations(observe: AgentObserver, ctx: AppContext) {
  const all = [];
  let cursor: string | undefined;
  do {
    const page = await observe.conversations(cursor === undefined ? {} : { cursor }, ctx);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}

/** Follows `watch(conversationId)` as a view does (see `Watched`), its first event taken. */
async function follow(observe: AgentObserver, conversationId: string, ctx: AppContext, within: <T>(promise: Promise<T>, what: string) => Promise<T>): Promise<Watched> {
  const stop = new AbortController();
  const iterator = observe.watch(conversationId, ctx.derive((inner) => withAbortSignal(stop.signal, inner)))[Symbol.asyncIterator]();
  const first = await within(iterator.next(), "the first event");
  check(first.done !== true, "a first event");
  const opening = first.value as ObservedEvent;
  check(
    opening.type === "live" && opening.ops.length === 1 && opening.ops[0]?.[0] === "r",
    `the first event to be the whole live state, [["r", value]], got ${JSON.stringify(opening)}`,
  );
  let value = (opening as { ops: readonly JsonOp[] }).ops[0]?.[1] as JsonValue;
  const problem = liveProblem(value);
  check(problem === undefined, `the first state to be an ObservedLive (${problem}): ${JSON.stringify(value)}`);
  const states: ObservedLive[] = [value as unknown as ObservedLive];
  const log: Logged[] = [];
  const entries: TranscriptEntry[] = [];
  let done = false;

  const take = async (what: string): Promise<void> => {
    const next = await within(iterator.next(), what);
    check(next.done !== true, `the stream to go on until ${what}, saw ${JSON.stringify(log.map((event) => event.type))}`);
    const event = next.value as ObservedEvent;
    switch (event.type) {
      case "live": {
        check(event.ops.length > 0, "a live event to change something");
        value = applyOps(value, event.ops);
        const wrong = liveProblem(value);
        check(wrong === undefined, `every state to be an ObservedLive (${wrong}): ${JSON.stringify(value)} after ${JSON.stringify(event.ops)}`);
        states.push(value as unknown as ObservedLive);
        break;
      }
      case "entries":
        check(event.entries.length > 0, "an entries event to hold an entry");
        for (const entry of event.entries) check(typeof entry.id === "string" && typeof entry.kind === "string" && Array.isArray(entry.messages), `an entry, got ${JSON.stringify(entry)}`);
        entries.push(...event.entries);
        break;
      case "usage":
      case "transcript":
        break;
      default:
        check(false, `an event of the contract, got ${JSON.stringify(event)}`);
    }
    log.push({ ...event, after: value as unknown as ObservedLive });
  };

  return {
    get state() {
      return value as unknown as ObservedLive;
    },
    states,
    log,
    entries,
    async until(holds, what) {
      let taken = 0;
      while (!holds()) {
        await take(what);
        taken++;
      }
      return taken;
    },
    async stop() {
      if (done) return;
      done = true;
      stop.abort(new Error("conformance: done watching"));
      for (let i = 0; i < 10_000; i++) if ((await within(iterator.next(), "the stream to end once its context is cancelled")).done === true) return;
      check(false, "the stream to end once its context is cancelled");
    },
  };
}
