/**
 * memory-summaries' tests, copied with the component. The runtime's side is doubles: the answers feed
 * and pending requests (`createMemorySubmissions`), a transcript per conversation (`agent.observe`), a
 * model that records its prompts (`model.complete`) and a `memory` that keeps by id, as memory-sql
 * does (owners by space, `trader` kept apart), and `conversations.registry` with each key's space; `wakeups` in memory and the App's clock are the test's (`createManualClock`), and `storage.sql`
 * is `sqliteStorage()`, so a second App over it is a restart. The component in a real App (runtime-pi,
 * memory-sql, a faux model) is `app.test.ts` beside `files/` in the registry.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { type AgentObserver, type ConversationRef, type ConversationRegistry, spaceOf, type TranscriptEntry } from "@pikit/contracts";
import { createMemorySubmissions, createMemoryWakeups } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import type { Memory, MemoryOwner, MemoryStore } from "./contract.ts";
import memorySummaries, { REDACTED, redact, SUMMARY_SYSTEM, transcriptText } from "./index.ts";

const MINUTE = 60_000;
const ANTHROPIC_KEY = "sk-ant-api03-summariesfixture0123456789abcd";
const GITHUB_TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ0123";

const SPACE = "googlechat:spaces/A";
const ana: ConversationRef = { key: `${SPACE}:threads/1`, agent: "assistant", conversationId: "c1" };

/** `memory` with nothing kept: what a test that keeps nothing provides. */
const noMemory: MemoryStore = {
  ownerOf: (conversation) => ({ type: "space", space: spaceOf(conversation) }),
  list: async () => [],
  get: async () => undefined,
  search: async () => [],
  approve: async () => false,
  forget: async () => false,
  remember: async () => {},
};
/** The registry's record of each key: its space, as a channel gave it. */
const registryOf = (spaces: Map<string, string>) =>
  ({ get: async (key: string) => ({ key, agent: "assistant", conversationId: "x", channel: "googlechat", ...(spaces.has(key) && { space: spaces.get(key) }) }) }) as Partial<ConversationRegistry> as ConversationRegistry;
const said = (id: string, role: "user" | "assistant", text: string): TranscriptEntry => ({
  id,
  kind: "message",
  messages: [role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] }],
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The world one test runs in: what outlives each App (the feed, the transcripts, the memory, the database). */
function world() {
  const clock = createManualClock();
  const recorded = createMemorySubmissions();
  const transcripts = new Map<string, TranscriptEntry[]>(); // newest first, as `transcript` pages them
  const prompts: string[] = [];
  const kept = new Map<string, { owner: MemoryOwner; memory: Memory }>();
  const spaces = new Map([[ana.key, SPACE]]);
  const warnings: string[] = [];
  const state = { answer: (prompt: string) => `Summary: ${prompt}`, failRemember: 0, during: undefined as (() => Promise<void>) | undefined };
  const storage = sqliteStorage();
  const wakeups = createMemoryWakeups();

  const runtime = defineComponent({
    name: "runtime-test",
    setup(pikit) {
      pikit.provide("agent.submissions", recorded.submissions);
      pikit.provide("agent.observe", {
        transcript: async (conversationId, page) => {
          const entries = transcripts.get(conversationId);
          if (entries === undefined) return undefined;
          const from = Number(page.cursor ?? 0);
          const to = from + (page.limit ?? 50);
          return { items: entries.slice(from, to), ...(to < entries.length && { next: String(to) }) };
        },
      } as Partial<AgentObserver> as AgentObserver);
      pikit.provide("model.complete", {
        complete: async ({ model, prompt }) => {
          expect(model).toBe("faux/echo");
          prompts.push(prompt);
          const during = state.during;
          state.during = undefined;
          await during?.();
          return state.answer(prompt);
        },
      });
      pikit.provide("conversations.registry", registryOf(spaces));
      pikit.provide("memory", {
        ...noMemory,
        ownerOf: (conversation) => (conversation.agent === "trader" ? { type: "agent", agent: "trader" } : { type: "space", space: spaceOf(conversation) }),
        remember: async (owner, memory) => {
          const id = `${JSON.stringify(owner)}\0${memory.id}`;
          if (!kept.has(id)) kept.set(id, { owner, memory });
          // A crash after the memory was kept, before the component recorded it.
          if (state.failRemember > 0 && state.failRemember--) throw new Error("the process died here");
        },
      });
    },
  });
  const logger: Logger = { ...silentLogger, warn: (message) => void warnings.push(message) };
  const components: ComponentDefinition[] = [storage, wakeups, runtime, memorySummaries];

  let app: App | undefined;
  cleanup.push(() => w.stop());
  const w = {
    clock,
    prompts,
    warnings,
    state,
    transcripts,
    spaces,
    recorded,
    memories: () => [...kept.values()],
    async start() {
      app = await defineApp({ components, logger, clock, config: { "memory-summaries": { model: "faux/echo", agents: ["assistant", "trader"], idleMinutes: 30 } } }).create();
      await app.start();
      await w.settle();
    },
    async stop() {
      const running = app;
      app = undefined;
      await running?.stop();
    },
    /** Lets what is due run: the wakeup's loop and its handler's awaits. */
    async settle() {
      for (let i = 0; i < 20; i++) await clock.advance(0);
    },
    async advance(ms: number) {
      await clock.advance(ms);
      await w.settle();
    },
    /** A run of `conversation` settles with `requestId`: in the feed, and announced. */
    async settled(conversation: ConversationRef, requestId: string) {
      const run = { conversation, requestId, requestIds: [requestId], kind: "completed" as const, text: "ok" };
      const ctx = (app as App).context();
      await recorded.submissions.settled(run, ctx);
      await ctx.emit("agent.settled", { ...run, messages: [], usage: undefined } as never);
      await w.settle();
    },
  };
  return w;
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const described = await defineApp({
    components: [sqliteStorage(), createMemoryWakeups(), memoryProvider(), memorySummaries],
    config: { "memory-summaries": { model: "faux/echo", agents: ["assistant"] } },
    logger: silentLogger,
  }).create();
  expect(described.describe().components.find((component) => component.name === "memory-summaries")).toEqual({
    name: "memory-summaries",
    provides: [],
    requires: ["storage.sql", "wakeups", "agent.submissions", "agent.observe", "model.complete", "memory", "conversations.registry"],
    optional: [],
  });
});

/** Every capability memory-summaries uses but `storage.sql` and `wakeups`, unused. */
function memoryProvider() {
  return defineComponent({
    name: "capabilities-test",
    setup(pikit) {
      pikit.provide("agent.submissions", createMemorySubmissions().submissions);
      pikit.provide("agent.observe", {} as AgentObserver);
      pikit.provide("model.complete", { complete: async () => "" });
      pikit.provide("memory", noMemory);
      pikit.provide("conversations.registry", registryOf(new Map()));
    },
  });
}

test("a conversation quiet for idleMinutes is summarized once into its space's memory, though its wakeup runs again and the App restarts", async () => {
  const w = world();
  w.transcripts.set("c1", [said("e2", "assistant", "Tea it is."), said("e1", "user", "I like tea")]);
  await w.start();
  await w.settled(ana, "r1");

  await w.advance(29 * MINUTE);
  expect(w.memories()).toEqual([]);
  await w.advance(MINUTE);
  expect(w.prompts).toEqual(["Person: I like tea\nAssistant: Tea it is."]);
  expect(w.memories()).toEqual([
    {
      owner: { type: "space", space: SPACE },
      memory: { id: "summary:c1:e2", kind: "summary", status: "active", text: "Summary: Person: I like tea\nAssistant: Tea it is.", createdAt: w.clock.now() },
    },
  ]);

  // The wakeup runs again (another conversation's run settling wakes it), and a restart re-reads the feed.
  await w.settled({ ...ana, agent: "other", conversationId: "c9" }, "x1");
  await w.stop();
  await w.start();
  await w.advance(120 * MINUTE);
  expect(w.prompts).toHaveLength(1);
  expect(w.memories()).toHaveLength(1);
});

test("a restart before the conversation went quiet still summarizes it: start asks for its wakeup again", async () => {
  const w = world();
  w.transcripts.set("c1", [said("e1", "user", "I like tea")]);
  await w.start();
  await w.settled(ana, "r1");
  await w.stop(); // the in-memory wakeups keep no request, as wakeups-timers

  await w.start();
  await w.advance(30 * MINUTE);
  expect(w.memories().map((each) => each.memory.id)).toEqual(["summary:c1:e1"]);
});

test("a crash after the summary was kept, before it was recorded, keeps it once: the retry has the same id", async () => {
  const w = world();
  w.transcripts.set("c1", [said("e1", "user", "I like tea")]);
  w.state.failRemember = 1;
  await w.start();
  await w.settled(ana, "r1");

  await w.advance(30 * MINUTE);
  expect(w.warnings).toContain("memory-summaries: a conversation could not be summarized; it is tried again later");
  await w.advance(30 * MINUTE);
  expect(w.prompts).toHaveLength(2);
  expect(w.memories().map((each) => each.memory.id)).toEqual(["summary:c1:e1"]);
  await w.advance(120 * MINUTE);
  expect(w.prompts).toHaveLength(2);
});

test("new activity postpones the summary: a run settling, or a request still pending", async () => {
  const w = world();
  w.transcripts.set("c1", [said("e1", "user", "I like tea")]);
  await w.start();
  await w.settled(ana, "r1");
  await w.advance(20 * MINUTE);
  w.transcripts.set("c1", [said("e2", "user", "and cake"), said("e1", "user", "I like tea")]);
  await w.settled(ana, "r2");

  await w.advance(15 * MINUTE); // 35 minutes after r1, 15 after r2
  expect(w.prompts).toEqual([]);
  await w.recorded.submissions.admitted(ana, "r3", { clock: w.clock } as never);
  await w.advance(15 * MINUTE); // due, but r3 is pending
  expect(w.prompts).toEqual([]);

  w.transcripts.set("c1", [said("e3", "assistant", "Noted."), said("e2", "user", "and cake"), said("e1", "user", "I like tea")]);
  await w.settled(ana, "r3");
  await w.advance(30 * MINUTE);
  expect(w.prompts).toEqual(["Person: I like tea\nPerson: and cake\nAssistant: Noted."]);
  expect(w.memories().map((each) => each.memory.id)).toEqual(["summary:c1:e3"]);
});

test("a run settling while a summary is written is read at once, not at the next due time", async () => {
  const w = world();
  const bob = { key: "telegram:2", agent: "assistant", conversationId: "c2" };
  const cleo = { key: "telegram:3", agent: "assistant", conversationId: "c3" };
  for (const id of ["c1", "c2", "c3"]) w.transcripts.set(id, [said("e1", "user", `hello from ${id}`)]);
  await w.start();
  await w.settled(ana, "r1");
  await w.advance(10 * MINUTE);
  await w.settled(cleo, "r3"); // due 40 minutes from the start
  w.state.during = () => w.settled(bob, "r2"); // while Ana's summary is written, 30 minutes from the start
  await w.advance(20 * MINUTE);

  await w.advance(30 * MINUTE); // Bob's run settled 30 minutes ago
  expect(w.memories().map((each) => each.memory.id)).toEqual(["summary:c1:e1", "summary:c3:e1", "summary:c2:e1"]);
});

test("a later quiet period summarizes only what was said since the last summary", async () => {
  const w = world();
  w.transcripts.set("c1", [said("e1", "user", "I like tea")]);
  await w.start();
  await w.settled(ana, "r1");
  await w.advance(30 * MINUTE);

  w.transcripts.set("c1", [said("e3", "assistant", "Noted."), said("e2", "user", "and cake"), said("e1", "user", "I like tea")]);
  await w.settled(ana, "r2");
  await w.advance(30 * MINUTE);

  expect(w.prompts).toEqual(["Person: I like tea", "Person: and cake\nAssistant: Noted."]);
  expect(w.memories().map((each) => each.memory.id)).toEqual(["summary:c1:e1", "summary:c1:e3"]);
});

test("a credential in the transcript or in the model's answer never reaches the memory; an answer still holding one is not kept", async () => {
  const w = world();
  w.transcripts.set("c1", [said("e1", "user", `my key is ${ANTHROPIC_KEY}, keep it`)]);
  w.state.answer = (prompt) => `The person shared a key (${GITHUB_TOKEN}). ${prompt}`;
  await w.start();
  await w.settled(ana, "r1");
  await w.advance(30 * MINUTE);

  expect(w.prompts).toEqual([`Person: my key is ${REDACTED} keep it`]);
  const [summary] = w.memories();
  expect(summary?.memory.text).toBe(`The person shared a key ${REDACTED} Person: my key is ${REDACTED} keep it`);
  expect(JSON.stringify(w.memories())).not.toContain("sk-ant-");
  expect(JSON.stringify(w.memories())).not.toContain("ghp_");

  w.state.answer = () => "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
  w.transcripts.set("c1", [said("e2", "user", "more"), said("e1", "user", "my key is …")]);
  await w.settled(ana, "r2");
  await w.advance(30 * MINUTE);
  expect(w.prompts).toHaveLength(2);
  expect(w.memories()).toHaveLength(1);
  expect(w.warnings).toContain("memory-summaries: the summary still looked like it held a credential; nothing kept");
});

test("only the configured agents' conversations are summarized; one with nothing said keeps nothing", async () => {
  const w = world();
  w.transcripts.set("c9", [said("e1", "user", "hello")]);
  w.transcripts.set("c1", [{ id: "e1", kind: "pi.reset", messages: [] }]);
  await w.start();
  await w.settled({ key: "telegram:9", agent: "other", conversationId: "c9" }, "x1");
  await w.settled(ana, "r1");
  await w.advance(60 * MINUTE);

  expect(w.prompts).toEqual([]);
  expect(w.memories()).toEqual([]);
});

test("runs pruned before it read them are logged once", async () => {
  const w = world();
  const other = { key: "telegram:9", agent: "other", conversationId: "c9" };
  await w.start();
  await w.settled(other, "x1");
  await w.recorded.submissions.settled({ conversation: ana, requestId: "r1", requestIds: ["r1"], kind: "completed" }, { clock: w.clock } as never);
  w.recorded.prune();
  await w.settled(other, "x2");
  await w.settled(other, "x3");

  expect(w.warnings.filter((each) => each.includes("pruned"))).toHaveLength(1);
});

test("redact replaces each word shaped like a known credential; prose stays", () => {
  expect(redact(`key: "${ANTHROPIC_KEY}". token ${GITHUB_TOKEN}\nsha 0123456789abcdef0123456789abcdef01234567`)).toBe(
    `key: ${REDACTED} token ${REDACTED}\nsha 0123456789abcdef0123456789abcdef01234567`,
  );
  expect(transcriptText([said("e1", "user", "hi"), { id: "e2", kind: "message", messages: [{ role: "toolResult", content: [{ type: "text", text: "secret output" }] }] }])).toBe("Person: hi");
});

test("each summary goes to the owner memory decides: the space the registry recorded for the key, the key when none, an agent kept apart's own", async () => {
  const w = world();
  const dm = { key: "googlechat:dm/ana", agent: "assistant", conversationId: "c2" };
  const trader = { key: `${SPACE}:threads/2`, agent: "trader", conversationId: "c3" };
  for (const id of ["c1", "c2", "c3"]) w.transcripts.set(id, [said("e1", "user", `hello from ${id}`)]);
  w.spaces.set(trader.key, SPACE);
  await w.start();
  for (const [i, conversation] of [ana, dm, trader].entries()) await w.settled(conversation, `r${i}`);
  await w.advance(30 * MINUTE);

  expect(w.memories().map(({ owner, memory }) => [owner, memory.id])).toEqual([
    [{ type: "space", space: SPACE }, "summary:c1:e1"],
    [{ type: "space", space: "googlechat:dm/ana" }, "summary:c2:e1"],
    [{ type: "agent", agent: "trader" }, "summary:c3:e1"],
  ]);
});

test("the model is asked for a summary made to be found: a title, topics, entities, keywords, decisions, action items, facts, open questions", () => {
  for (const part of ["# <a short descriptive title>", "Topics:", "Entities:", "Keywords:", "## Decisions and outcomes", "## Action items", "## Facts for future conversations", "## Open questions", "language of the conversation", "Never include passwords"]) {
    expect(SUMMARY_SYSTEM).toContain(part);
  }
});
