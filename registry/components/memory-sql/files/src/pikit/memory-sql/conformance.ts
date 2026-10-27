/**
 * `memory` conformance: what every provider of `contract.ts` guarantees. Runner-independent:
 *
 *   for (const c of createMemoryConformance(() => myFixture())) test(`${c.group}: ${c.name}`, () => c.run());
 *
 * A case starts an App of the fixture's components and a consumer that uses `memory`; "a restart" is
 * a second App of the fixture's components (over the same storage).
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger, type Target } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import { type Memory, type MemoryKind, MEMORY_TEXT_MAX, type MemoryOwner, type MemoryStatus, type MemoryStore } from "./contract.ts";

export interface MemoryFixture {
  /** The components of one App over the case's storage: called again for each App of the case (a restart). */
  components(): ComponentDefinition[];
  config?: Record<string, unknown>;
  target?: Target;
  /**
   * The agents the fixture's config keeps apart (each with a memory of its own across spaces), when
   * any: `ownerOf` gives them their agent's owner, every other agent its space's.
   */
  agentScope?: readonly string[];
  dispose?(): Promise<void>;
}

const GROUP = "memory";

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${GROUP}: ${what}`);
}
const same = (actual: unknown, expected: unknown, what: string) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** A key in the shape of Anthropic's: what no memory may keep, and no refusal may echo. */
const CREDENTIAL = "sk-ant-api03-memoryconformance0123456789abcd";

/**
 * The owners of one case: names no other case uses, so a provider whose storage outlives a case (a
 * Durable Object per owner) runs the suite as one whose storage is new each time.
 */
const owners = () => {
  const id = crypto.randomUUID();
  return {
    /** A space: a Google Chat space, say. */
    TEAM: { type: "space", space: `googlechat:spaces/team-${id}` },
    /** Another space. */
    OTHER: { type: "space", space: `googlechat:spaces/other-${id}` },
    /** An agent with a memory of its own. */
    TRADER: { type: "agent", agent: `trader-${id}` },
    /** A person, and another. */
    ANA: { type: "person", channel: "googlechat", id: `users/ana-${id}` },
    BOB: { type: "person", channel: "googlechat", id: `users/bob-${id}` },
  } satisfies Record<string, MemoryOwner>;
};
type Owners = ReturnType<typeof owners>;
const item = (kind: MemoryKind, id: string, text: string, createdAt: number, status: MemoryStatus = "active"): Memory => ({ id, kind, status, text, createdAt });
const fact = (id: string, text: string, createdAt: number): Memory => item("fact", id, text, createdAt);
const ids = (memories: readonly Memory[]) => memories.map((m) => m.id);
const FACTS = { kinds: ["fact"] } as const;
const DATA = { kinds: ["fact", "summary"] } as const;

interface Running extends Owners {
  memory: MemoryStore;
  ctx: AppContext;
  stop(): Promise<void>;
}

async function boot(fixture: MemoryFixture, who: Owners): Promise<Running> {
  let handle: Handle<MemoryStore> | undefined;
  const consumer = defineComponent({ name: "memory-conformance", setup: (pikit) => void (handle = pikit.use("memory")) });
  const app = await defineApp({
    components: [...fixture.components(), consumer],
    logger: silentLogger,
    ...(fixture.config !== undefined && { config: fixture.config }),
    ...(fixture.target !== undefined && { target: fixture.target }),
  }).create();
  await app.start();
  if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
  return { ...who, memory: handle.get(), ctx: app.context(), stop: () => app.stop() };
}

/** The rejection's message, or `undefined` when `work` resolved. */
async function refusal(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function createMemoryConformance(factory: () => MemoryFixture | Promise<MemoryFixture>): readonly ConformanceCase[] {
  const memoryCase = (name: string, run: (fixture: MemoryFixture, who: Owners) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture, owners());
      } finally {
        await fixture.dispose?.();
      }
    },
  });
  const appCase = (name: string, run: (app: Running, fixture: MemoryFixture) => Promise<void>): ConformanceCase =>
    memoryCase(name, async (fixture, who) => {
      const app = await boot(fixture, who);
      try {
        await run(app, fixture);
      } finally {
        await app.stop();
      }
    });

  return [
    appCase("ownerOf: a conversation's space (its origin's for a delegated one), or its agent's own for an agent kept apart; never a person", async ({ memory }, fixture) => {
      const kept = new Set(fixture.agentScope ?? []);
      const shared = ["assistant", "researcher", "steward"].find((agent) => !kept.has(agent)) ?? "memory-conformance-agent";
      const thread = { key: "googlechat:spaces/A:threads/T", agent: shared, conversationId: "c1", space: "googlechat:spaces/A" };
      same(memory.ownerOf(thread), { type: "space", space: "googlechat:spaces/A" }, "a thread's owner is its space");
      same(memory.ownerOf({ ...thread, conversationId: "c2" }), memory.ownerOf(thread), "the same conversation after a reset");
      same(memory.ownerOf({ key: "telegram:1", agent: shared, conversationId: "c3" }), { type: "space", space: "telegram:1" }, "a private chat is its own space");
      const delegated = { key: "delegate:c1:1", agent: shared, conversationId: "c4", space: "ignored", origin: thread };
      same(memory.ownerOf(delegated), { type: "space", space: "googlechat:spaces/A" }, "a delegated conversation is in its origin's space");
      for (const agent of kept) {
        same(memory.ownerOf({ ...thread, agent }), { type: "agent", agent }, `${agent}, kept apart, has its own`);
        same(memory.ownerOf({ key: "telegram:1", agent, conversationId: "c5" }), { type: "agent", agent }, `${agent}'s own in another space`);
      }
    }),
    appCase("what is remembered is listed by kind and status, the newest `limit`, oldest first", async ({ memory, ctx, TEAM }) => {
      await memory.remember(TEAM, fact("b", "likes tea", 2), ctx);
      await memory.remember(TEAM, fact("a", "is called Ana", 1), ctx);
      await memory.remember(TEAM, fact("c", "works on pikit", 3), ctx);
      await memory.remember(TEAM, item("summary", "s", "Asked about tea.", 4), ctx);
      await memory.remember(TEAM, item("rule", "r1", "Answer in Spanish", 5), ctx);
      await memory.remember(TEAM, item("rule", "r2", "Use metric units", 6, "pending"), ctx);
      same(await memory.list(TEAM, FACTS, 10, ctx), [fact("a", "is called Ana", 1), fact("b", "likes tea", 2), fact("c", "works on pikit", 3)], "the facts");
      same(ids(await memory.list(TEAM, FACTS, 2, ctx)), ["b", "c"], "the newest two facts, oldest first");
      same(ids(await memory.list(TEAM, { kinds: ["summary"] }, 10, ctx)), ["s"], "the summaries");
      same(ids(await memory.list(TEAM, DATA, 10, ctx)), ["a", "b", "c", "s"], "facts and summaries together");
      same(ids(await memory.list(TEAM, { kinds: ["rule"] }, 10, ctx)), ["r1", "r2"], "every rule");
      same(ids(await memory.list(TEAM, { kinds: ["rule"], status: "active" }, 10, ctx)), ["r1"], "the active rules");
      same(await memory.list(TEAM, { kinds: ["rule"], status: "pending" }, 10, ctx), [item("rule", "r2", "Use metric units", 6, "pending")], "the pending rules");
      same(await memory.get(TEAM, "r1", ctx), item("rule", "r1", "Answer in Spanish", 5), "one by id");
      same(await memory.get(TEAM, "nobody", ctx), undefined, "an unknown id");
    }),
    appCase("the same id twice is kept once, as it was first, text and status: a proposal never demotes an active rule", async ({ memory, ctx, TEAM, ANA }) => {
      await memory.remember(TEAM, fact("x", "likes tea", 1), ctx);
      await memory.remember(TEAM, fact("x", "likes coffee", 2), ctx);
      same(await memory.list(TEAM, FACTS, 10, ctx), [fact("x", "likes tea", 1)], "the fact kept");
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 3), ctx);
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 4, "pending"), ctx);
      same(await memory.get(TEAM, "r", ctx), item("rule", "r", "Answer in Spanish", 3), "the rule stays active");
      await memory.remember(ANA, item("preference", "p", "Short answers", 5, "pending"), ctx);
      await memory.remember(ANA, item("preference", "p", "Short answers", 6), ctx);
      same(await memory.get(ANA, "p", ctx), item("preference", "p", "Short answers", 5, "pending"), "the preference stays pending: only approve makes it active");
    }),
    appCase("approve makes a pending rule or preference active, once; an unknown id or another kind is false", async ({ memory, ctx, TEAM, ANA }) => {
      await memory.remember(TEAM, item("rule", "r", "Use metric units", 1, "pending"), ctx);
      await memory.remember(TEAM, fact("f", "likes tea", 2), ctx);
      await memory.remember(ANA, item("preference", "p", "Short answers", 3, "pending"), ctx);
      same(await memory.approve(TEAM, "r", "fact", ctx), false, "a pending rule approved as a fact");
      same((await memory.get(TEAM, "r", ctx))?.status, "pending", "the rule after that");
      same(await memory.approve(TEAM, "r", "rule", ctx), true, "approving the pending rule");
      same(await memory.approve(TEAM, "r", "rule", ctx), true, "approving it again");
      same((await memory.get(TEAM, "r", ctx))?.status, "active", "the rule after approve");
      same(await memory.approve(TEAM, "nobody", "rule", ctx), false, "an unknown id");
      same(await memory.approve(TEAM, "f", "rule", ctx), false, "a fact is no rule");
      same(await memory.approve(ANA, "p", "preference", ctx), true, "approving the preference");
      same(await memory.list(ANA, { kinds: ["preference"], status: "active" }, 10, ctx), [item("preference", "p", "Short answers", 3)], "the preference after approve");
    }),
    appCase("forget removes one memory the filter takes; an unknown id, or one the filter leaves, is false and stays", async ({ memory, ctx, TEAM }) => {
      await memory.remember(TEAM, fact("a", "likes tea", 1), ctx);
      await memory.remember(TEAM, fact("b", "likes cake", 2), ctx);
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 3), ctx);
      await memory.remember(TEAM, item("rule", "p", "Use metric units", 4, "pending"), ctx);
      same(await memory.forget(TEAM, "a", DATA, ctx), true, "forgetting a fact");
      same(await memory.forget(TEAM, "a", DATA, ctx), false, "forgetting it again");
      same(await memory.forget(TEAM, "nobody", DATA, ctx), false, "an unknown id");
      same(await memory.forget(TEAM, "r", DATA, ctx), false, "a rule, with a filter of facts and summaries");
      same(await memory.forget(TEAM, "r", { kinds: ["rule"], status: "pending" }, ctx), false, "an active rule, with a filter of pending ones");
      same(await memory.forget(TEAM, "p", { kinds: ["rule"], status: "pending" }, ctx), true, "rejecting the pending rule");
      same(ids(await memory.list(TEAM, { kinds: ["fact", "rule"] }, 10, ctx)), ["b", "r"], "what is left");
    }),
    appCase("another owner's memories are never listed, got, searched, approved or forgotten, even under the same id", async ({ memory, ctx, TEAM, OTHER, TRADER, ANA, BOB }) => {
      await memory.remember(TEAM, fact("a", "likes tea", 1), ctx);
      await memory.remember(OTHER, fact("b", "likes tea too", 2), ctx);
      await memory.remember(TRADER, fact("t", "tea for the trader", 3), ctx);
      await memory.remember(OTHER, item("rule", "r", "Other space's rule", 4, "pending"), ctx);
      await memory.remember(ANA, item("preference", "p", "Ana likes tea", 5, "pending"), ctx);
      same(ids(await memory.list(TEAM, FACTS, 10, ctx)), ["a"], "the team's list");
      same(ids(await memory.search(TEAM, "tea", 10, ctx)), ["a"], "the team's search");
      same(ids(await memory.search(TRADER, "tea", 10, ctx)), ["t"], "the trader's search");
      same(ids(await memory.list(OTHER, FACTS, 10, ctx)), ["b"], "the other space's list");
      same(ids(await memory.list(TRADER, FACTS, 10, ctx)), ["t"], "the trader's list");
      same(await memory.get(TEAM, "b", ctx), undefined, "another space's fact, got from the team");
      same(await memory.approve(TEAM, "r", "rule", ctx), false, "another space's rule, approved from the team");
      same((await memory.get(OTHER, "r", ctx))?.status, "pending", "the other space's rule after that");
      same(await memory.approve(BOB, "p", "preference", ctx), false, "Ana's preference, approved as Bob");
      same(await memory.list(BOB, { kinds: ["preference"] }, 10, ctx), [], "Bob's preferences");
      same(await memory.forget(BOB, "p", { kinds: ["preference"] }, ctx), false, "Ana's preference, forgotten as Bob");
      // The same id in another owner is another memory: forgetting the team's leaves it.
      await memory.remember(OTHER, fact("a", "the other space's own a", 6), ctx);
      same(await memory.forget(TEAM, "a", DATA, ctx), true, "forgetting the team's a");
      same(ids(await memory.list(OTHER, FACTS, 10, ctx)), ["b", "a"], "the other space's list after the team's forget");
      same(ids(await memory.list(ANA, { kinds: ["preference"] }, 10, ctx)), ["p"], "Ana's preferences after all that");
    }),
    appCase("each owner keeps only its kinds, and a fact or summary is always active: anything else is refused and keeps nothing", async ({ memory, ctx, TEAM, ANA }) => {
      const refused = [
        refusal(memory.remember(ANA, fact("f", "likes tea", 1), ctx)),
        refusal(memory.remember(ANA, item("rule", "r", "Answer in Spanish", 1), ctx)),
        refusal(memory.remember(TEAM, item("preference", "p", "Short answers", 1), ctx)),
        refusal(memory.remember(TEAM, item("fact", "f", "likes tea", 1, "pending"), ctx)),
        refusal(memory.remember(TEAM, item("summary", "s", "Talked.", 1, "pending"), ctx)),
      ];
      for (const [i, message] of (await Promise.all(refused)).entries()) check(message !== undefined, `remember ${i} was not refused`);
      same(await memory.list(TEAM, { kinds: ["fact", "summary", "rule"] }, 10, ctx), [], "nothing kept in the space");
      same(await memory.list(ANA, { kinds: ["preference"] }, 10, ctx), [], "nothing kept for the person");
    }),
    appCase("search is full-text over facts and summaries: every word in any order and case, then any word; best first, with a snippet", async ({ memory, ctx, TEAM }) => {
      await memory.remember(TEAM, fact("a", "Ana LIKES green TEA in the morning", 1), ctx);
      await memory.remember(TEAM, item("summary", "s", "# Tea and cocoa\nTalked about tea, tea and 100% cocoa with Ana.", 2), ctx);
      await memory.remember(TEAM, fact("c", "Costs 1000 euros, invoice INV-2026-0042", 3), ctx);
      await memory.remember(TEAM, fact("d", "Café on Monday", 4), ctx);
      await memory.remember(TEAM, item("rule", "r", "Never talk about tea", 5), ctx);
      same(ids(await memory.search(TEAM, "tea", 10, ctx)), ["s", "a"], "facts and summaries, never rules, the most relevant first");
      same(ids(await memory.search(TEAM, "tea", 1, ctx)), ["s"], "`limit`");
      same(ids(await memory.search(TEAM, "tea ANA morning", 10, ctx)), ["a"], "every word, in any order and case");
      same(ids(await memory.search(TEAM, "morning cocoa", 10, ctx)).sort(), ["a", "s"], "no memory has every word: any of them");
      same(ids(await memory.search(TEAM, "inv-2026-0042", 10, ctx)), ["c"], "a hyphenated id");
      same(ids(await memory.search(TEAM, "cafe", 10, ctx)), ["d"], "diacritics ignored");
      const [match] = await memory.search(TEAM, "cocoa", 10, ctx);
      check(match !== undefined && match.snippet.includes("[cocoa]"), `the snippet marks the match: ${JSON.stringify(match?.snippet)}`);
      same(match?.text, "# Tea and cocoa\nTalked about tea, tea and 100% cocoa with Ana.", "a match carries its whole text");
      for (const query of ['ana@example.com', "https://example.com/a?b=c", '"unbalanced', "tea AND", "NOT tea", "tea*", "(tea", "a:b", "-tea", "^tea", "100%", "1_00"]) {
        const message = await refusal(memory.search(TEAM, query, 10, ctx));
        check(message === undefined, `search ${JSON.stringify(query)} failed: ${message}`);
      }
      same(await memory.search(TEAM, "?!", 10, ctx), [], "a query with no word finds nothing");
      same(await memory.search(TEAM, "pizza", 10, ctx), [], "a word nothing has");
      await memory.forget(TEAM, "s", DATA, ctx);
      same(ids(await memory.search(TEAM, "tea", 10, ctx)), ["a"], "a forgotten memory is never found");
    }),
    appCase("a text holding a credential, an empty one or one too long is refused, keeps nothing and is never echoed", async ({ memory, ctx, TEAM, ANA }) => {
      for (const text of [`my key is ${CREDENTIAL}.`, " ", "x".repeat(MEMORY_TEXT_MAX + 1)]) {
        for (const [owner, m] of [
          [TEAM, fact("bad", text, 1)],
          [TEAM, item("rule", "bad", text, 1, "pending")],
          [ANA, item("preference", "bad", text, 1, "pending")],
        ] as const) {
          const message = await refusal(memory.remember(owner, m, ctx));
          check(message !== undefined, `remember of a ${m.kind} ${JSON.stringify(text.slice(0, 20))} was not refused`);
          check(!(message ?? "").includes(CREDENTIAL), "the refusal echoes the credential");
        }
      }
      same(await memory.list(TEAM, { kinds: ["fact", "rule"] }, 10, ctx), [], "nothing kept");
      same(await memory.list(ANA, { kinds: ["preference"] }, 10, ctx), [], "nothing kept for the person");
    }),
    memoryCase("what is remembered survives a restart, searchable", async (fixture, who) => {
      const { TEAM, ANA } = who;
      const first = await boot(fixture, who);
      try {
        await first.memory.remember(TEAM, fact("a", "likes tea", 1), first.ctx);
        await first.memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 2, "pending"), first.ctx);
        await first.memory.approve(TEAM, "r", "rule", first.ctx);
        await first.memory.remember(ANA, item("preference", "p", "Short answers", 3, "pending"), first.ctx);
      } finally {
        await first.stop();
      }
      const second = await boot(fixture, who);
      try {
        same(await second.memory.list(TEAM, FACTS, 10, second.ctx), [fact("a", "likes tea", 1)], "the facts after the restart");
        same(ids(await second.memory.search(TEAM, "TEA", 10, second.ctx)), ["a"], "the search after the restart");
        same(await second.memory.get(TEAM, "r", second.ctx), item("rule", "r", "Answer in Spanish", 2), "the approved rule after the restart");
        same((await second.memory.get(ANA, "p", second.ctx))?.status, "pending", "the pending preference after the restart");
      } finally {
        await second.stop();
      }
    }),
  ];
}

