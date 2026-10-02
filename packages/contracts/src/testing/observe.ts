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
 */

import { type App, type AppContext, type AppEvents, type ComponentDefinition, defineApp, defineComponent, silentLogger, withAbortSignal } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import type { AgentConversations, AgentRuntime, ConversationRef } from "../agent.ts";
import type { AgentObserver, ObservedEvent } from "../observe.ts";
import { checker, expecter } from "./assert.ts";

export interface AgentObserveFixture {
  /** The runtime, providing `agent.runtime`, `agent.conversations` and `agent.observe`, and what it uses. */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** An agent of `components` that answers every message with some text. */
  agent: string;
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

interface Running {
  app: App;
  ctx: AppContext;
  observe: AgentObserver;
  /** A new conversation of the fixture's agent, under `key`. */
  conversation(key: string): Promise<ConversationRef>;
  /** Sends `prompt` and resolves with the run's end. */
  send(conversation: ConversationRef, requestId: string, prompt: string): Promise<Result>;
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
        await run({
          app,
          ctx,
          observe: observe(),
          conversation: async (key) => ({ key, agent: fixture.agent, conversationId: await conversations().create(ctx) }),
          async send(conversation, requestId, prompt) {
            const result = new Promise<Result>((resolve) => {
              const done = ended.get(requestId);
              if (done !== undefined) resolve(done);
              else results.set(requestId, resolve);
            });
            await runtime().dispatch({ requestId, conversation, prompt }, ctx);
            const settled = await within(result, `the answer to ${requestId}`);
            check(settled.kind === "completed", `the run of ${requestId} to complete, got ${settled.kind} ${JSON.stringify(settled.error)}`);
            return settled;
          },
        });
      } finally {
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
      if (result.usage !== undefined) expect(found?.usage.totalTokens, result.usage.totalTokens, "its tokens: its one run's");
      expect(await s.observe.conversation(conversation.conversationId, s.ctx), found, "conversation(id), as the list says");
    }),

    observeCase("a conversation no message reached has no key, no agent, no cost", async (s) => {
      const conversation = await s.conversation("conformance:empty");
      const found = await s.observe.conversation(conversation.conversationId, s.ctx);

      check(found !== undefined, "the new conversation to be found");
      expect([found?.key, found?.agent, found?.busy, found?.usage.totalTokens], [undefined, undefined, false, 0], "its key, agent, busy and tokens");
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

    observeCase("watch starts with a snapshot, follows a run to its answer, and ends when its context is cancelled", async (s) => {
      const conversation = await s.conversation("conformance:watched");
      await s.send(conversation, "r-w0", "before watching");
      const stop = new AbortController();
      const events = s.observe.watch(conversation.conversationId, s.ctx.derive((inner) => withAbortSignal(stop.signal, inner)))[Symbol.asyncIterator]();

      const first = await within(events.next(), "the first event");
      expect(first.done, false, "a first event");
      expect((first.value as ObservedEvent).type, "snapshot", "the first event's type");
      check(JSON.stringify(first.value).includes("before watching"), "the snapshot to hold what the conversation said before");

      const answered = s.send(conversation, "r-w1", "while watching");
      const seen: ObservedEvent[] = [];
      const answer = (await answered).text ?? "";
      const needle = JSON.stringify(answer).slice(1, -1);
      // Every event is JSON with a type; some of them carry the answer (streamed, or as an entry).
      while (!seen.some((event) => JSON.stringify(event).includes(needle))) {
        const next = await within(events.next(), `an event carrying the answer ${JSON.stringify(answer)}`);
        check(next.done !== true, `the stream to go on until the answer, saw ${JSON.stringify(seen.map((e) => e.type))}`);
        const event = next.value as ObservedEvent;
        check(typeof event.type === "string", `every event to have a type, got ${JSON.stringify(event)}`);
        seen.push(event);
      }

      stop.abort(new Error("conformance: done watching"));
      for (let i = 0; i < 10_000; i++) {
        const next = await within(events.next(), "the stream to end once its context is cancelled");
        if (next.done === true) return;
      }
      check(false, "the stream to end once its context is cancelled");
    }),
  ];
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
