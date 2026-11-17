/**
 * `memory` conformance: what every provider of `contract.ts` guarantees. Runner-independent:
 *
 *   for (const c of createMemoryConformance((clock) => myFixture(clock))) test(`${c.group}: ${c.name}`, () => c.run());
 *
 * A case starts an App of the fixture's components on the case's clock (a `ManualClock`: an owner in
 * another App, a Durable Object, must read the same time) and a consumer that uses `memory`; "a restart"
 * is a second App of the fixture's components (over the same storage). The change log's own cases
 * (`changeLogCases` of `@pikit/contracts/testing`, over a space's rules) are part of it.
 */

import { type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger, type Target } from "@pikit/core";
import { type ConformanceCase, createManualClock, type ManualClock } from "@pikit/core/testing";
import { type Author, type Change, type JsonValue, CHANGE_RETENTION_DAYS, CHANGE_TITLE_MAX } from "@pikit/contracts";
import { changeLogCases, type ChangeLogSubject } from "@pikit/contracts/testing";
import { type Memory, type MemoryKind, MEMORY_TEXT_MAX, type MemoryOwner, type MemoryStatus, type MemoryStore, type NewMemory } from "./contract.ts";

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
  /** Makes the store's next write fail inside its transaction, after the memory is written and before it commits: enables the log's crash case. */
  failNextCommit?(): void;
  dispose?(): Promise<void>;
}

const GROUP = "memory";
const DAY = 86_400_000;

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${GROUP}: ${what}`);
}
/** JSON with its keys sorted: two values the same whatever their keys' order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === "object" && !Array.isArray(field) ? Object.fromEntries(Object.entries(field as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : field,
  );
const same = (actual: unknown, expected: unknown, what: string) => check(canonical(actual) === canonical(expected), `${what}: expected ${canonical(expected)}, got ${canonical(actual)}`);

/** Who the cases' writes are by: a person typing a command in a Google Chat space. */
const BY: Author = { kind: "person", principal: { channel: "googlechat", id: "users/conformance" }, conversation: "googlechat:spaces/conformance" };
/** An agent's tool, answering a person. */
const AGENT: Author = { kind: "agent", agent: "trader", conversation: "googlechat:spaces/conformance:threads/t1", for: { channel: "googlechat", id: "users/42", name: "Juan" } };
const COMPONENT: Author = { kind: "component", name: "memory-summaries" };
const OPERATOR: Author = { kind: "operator", id: "dashboard" };

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
const item = (kind: MemoryKind, id: string, text: string, createdAt: number, status: MemoryStatus = "active", by: Author = BY): NewMemory => ({ id, kind, status, text, createdAt, by });
const fact = (id: string, text: string, createdAt: number): NewMemory => item("fact", id, text, createdAt);
const ids = (memories: readonly Memory[]) => memories.map((m) => m.id);
const FACTS = { kinds: ["fact"] } as const;
const DATA = { kinds: ["fact", "summary"] } as const;
const RULES = { kinds: ["rule"] } as const;

interface Running extends Owners {
  memory: MemoryStore;
  ctx: AppContext;
  clock: ManualClock;
  stop(): Promise<void>;
}

async function boot(fixture: MemoryFixture, who: Owners, clock: ManualClock): Promise<Running> {
  let handle: Handle<MemoryStore> | undefined;
  const consumer = defineComponent({ name: "memory-conformance", setup: (pikit) => void (handle = pikit.use("memory")) });
  const app = await defineApp({
    components: [...fixture.components(), consumer],
    logger: silentLogger,
    clock,
    ...(fixture.config !== undefined && { config: fixture.config }),
    ...(fixture.target !== undefined && { target: fixture.target }),
  }).create();
  await app.start();
  if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
  return { ...who, memory: handle.get(), ctx: app.context(), clock, stop: () => app.stop() };
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
/** The rejection's `code`, `"resolved"` when `work` resolved. */
async function codeOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return "resolved";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : String(error);
  }
}

/** Every entry of `owner`'s log, oldest first (every page read). */
async function wholeLog(memory: MemoryStore, owner: MemoryOwner, ctx: AppContext): Promise<Change[]> {
  const all: Change[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await memory.changes(owner, { limit: 50, ...(before !== undefined && { before }) }, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all.reverse();
    before = page.next;
  }
}
/** What an entry says, in short: `[n, action, item kind, item id, title]`. */
const brief = (entries: readonly Change[]) => entries.map((entry) => [entry.n, entry.action, entry.item.kind, entry.item.id, entry.item.title]);

export function createMemoryConformance(factory: (clock: ManualClock) => MemoryFixture | Promise<MemoryFixture>): readonly ConformanceCase[] {
  const memoryCase = (name: string, run: (fixture: MemoryFixture, who: Owners, clock: ManualClock) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const clock = createManualClock();
      const fixture = await factory(clock);
      try {
        await run(fixture, owners(), clock);
      } finally {
        await fixture.dispose?.();
      }
    },
  });
  const appCase = (name: string, run: (app: Running, fixture: MemoryFixture) => Promise<void>): ConformanceCase =>
    memoryCase(name, async (fixture, who, clock) => {
      const app = await boot(fixture, who, clock);
      try {
        await run(app, fixture);
      } finally {
        await app.stop();
      }
    });

  /** The log's cases over a space's rules, written as memory-recall and a project's page write them. */
  const ruleLog = async (): Promise<ChangeLogSubject> => {
    const clock = createManualClock();
    const fixture = await factory(clock);
    const app = await boot(fixture, owners(), clock);
    const { memory, ctx, TEAM } = app;
    let made = 0;
    const subject: ChangeLogSubject = {
      async add(by) {
        const id = `r-${++made}`;
        await memory.remember(TEAM, item("rule", id, `Rule number ${made}: answer in Spanish`, clock.now(), "active", by), ctx);
        return id;
      },
      async change(id, by) {
        const kept = await memory.get(TEAM, id, ctx);
        // A note's or rule's new words under the same id (a page's edit).
        await memory.replace(TEAM, id, item("rule", id, `${kept?.text ?? id}, and briefly (${++made})`, clock.now(), "active", by), ctx);
      },
      async remove(id, by) {
        await memory.forget(TEAM, id, RULES, by, ctx);
      },
      restore: (n, by) => memory.restore(TEAM, n, by, ctx),
      state: async (id) => ((await memory.get(TEAM, id, ctx)) ?? undefined) as JsonValue | undefined,
      changes: () => wholeLog(memory, TEAM, ctx),
      async repeat(id, by) {
        const kept = await memory.get(TEAM, id, ctx);
        if (kept !== undefined) await memory.remember(TEAM, { ...kept, by }, ctx);
      },
      expire: () => clock.advance((CHANGE_RETENTION_DAYS + 1) * DAY),
      redact: (n, by) => memory.redact(TEAM, n, by, ctx),
      ...(fixture.failNextCommit !== undefined && { failNextCommit: () => fixture.failNextCommit?.() }),
      async close() {
        await app.stop();
        await fixture.dispose?.();
      },
    };
    return subject;
  };

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
      same(ids(await memory.list(TEAM, RULES, 10, ctx)), ["r1", "r2"], "every rule");
      same(ids(await memory.list(TEAM, { kinds: ["rule"], status: "active" }, 10, ctx)), ["r1"], "the active rules");
      same(await memory.list(TEAM, { kinds: ["rule"], status: "pending" }, 10, ctx), [item("rule", "r2", "Use metric units", 6, "pending")], "the pending rules");
      same(await memory.get(TEAM, "r1", ctx), item("rule", "r1", "Answer in Spanish", 5), "one by id");
      same(await memory.get(TEAM, "nobody", ctx), undefined, "an unknown id");
    }),
    appCase("the same id twice is kept once, as it was first, text, status and author: a proposal never demotes an active rule", async ({ memory, ctx, TEAM, ANA }) => {
      await memory.remember(TEAM, fact("x", "likes tea", 1), ctx);
      await memory.remember(TEAM, { ...fact("x", "likes coffee", 2), by: AGENT }, ctx);
      same(await memory.list(TEAM, FACTS, 10, ctx), [fact("x", "likes tea", 1)], "the fact kept, by its first author");
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 3), ctx);
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 4, "pending", AGENT), ctx);
      same(await memory.get(TEAM, "r", ctx), item("rule", "r", "Answer in Spanish", 3), "the rule stays active");
      await memory.remember(ANA, item("preference", "p", "Short answers", 5, "pending"), ctx);
      await memory.remember(ANA, item("preference", "p", "Short answers", 6), ctx);
      same(await memory.get(ANA, "p", ctx), item("preference", "p", "Short answers", 5, "pending"), "the preference stays pending: only approve makes it active");
    }),
    appCase("approve makes a pending rule or preference active, once, with its updatedAt; an unknown id or another kind is false", async ({ memory, ctx, clock, TEAM, ANA }) => {
      await memory.remember(TEAM, item("rule", "r", "Use metric units", 1, "pending", AGENT), ctx);
      await memory.remember(TEAM, fact("f", "likes tea", 2), ctx);
      await memory.remember(ANA, item("preference", "p", "Short answers", 3, "pending"), ctx);
      same(await memory.approve(TEAM, "r", "fact", BY, ctx), false, "a pending rule approved as a fact");
      same((await memory.get(TEAM, "r", ctx))?.status, "pending", "the rule after that");
      await clock.advance(1_000);
      const approvedAt = clock.now();
      same(await memory.approve(TEAM, "r", "rule", BY, ctx), true, "approving the pending rule");
      await clock.advance(1_000);
      same(await memory.approve(TEAM, "r", "rule", BY, ctx), true, "approving it again");
      same(await memory.get(TEAM, "r", ctx), { ...item("rule", "r", "Use metric units", 1, "active", AGENT), updatedAt: approvedAt }, "the rule after approve: active, by its first author, updated once");
      same(await memory.approve(TEAM, "nobody", "rule", BY, ctx), false, "an unknown id");
      same(await memory.approve(TEAM, "f", "rule", BY, ctx), false, "a fact is no rule");
      same(await memory.approve(ANA, "p", "preference", BY, ctx), true, "approving the preference");
      same(await memory.list(ANA, { kinds: ["preference"], status: "active" }, 10, ctx), [{ ...item("preference", "p", "Short answers", 3), updatedAt: clock.now() }], "the preference after approve");
    }),
    appCase("forget removes one memory the filter takes; an unknown id, or one the filter leaves, is false and stays", async ({ memory, ctx, TEAM }) => {
      await memory.remember(TEAM, fact("a", "likes tea", 1), ctx);
      await memory.remember(TEAM, fact("b", "likes cake", 2), ctx);
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 3), ctx);
      await memory.remember(TEAM, item("rule", "p", "Use metric units", 4, "pending"), ctx);
      same(await memory.forget(TEAM, "a", DATA, BY, ctx), true, "forgetting a fact");
      same(await memory.forget(TEAM, "a", DATA, BY, ctx), false, "forgetting it again");
      same(await memory.forget(TEAM, "nobody", DATA, BY, ctx), false, "an unknown id");
      same(await memory.forget(TEAM, "r", DATA, BY, ctx), false, "a rule, with a filter of facts and summaries");
      same(await memory.forget(TEAM, "r", { kinds: ["rule"], status: "pending" }, BY, ctx), false, "an active rule, with a filter of pending ones");
      same(await memory.forget(TEAM, "p", { kinds: ["rule"], status: "pending" }, BY, ctx), true, "rejecting the pending rule");
      same(ids(await memory.list(TEAM, { kinds: ["fact", "rule"] }, 10, ctx)), ["b", "r"], "what is left");
    }),
    appCase("another owner's memories and log are never listed, got, searched, approved, forgotten, replaced or restored, even under the same id", async ({ memory, ctx, TEAM, OTHER, TRADER, ANA, BOB }) => {
      await memory.remember(TEAM, fact("a", "likes tea", 1), ctx);
      await memory.remember(OTHER, fact("b", "likes tea too", 2), ctx);
      await memory.remember(TRADER, fact("t", "tea for the trader", 3), ctx);
      await memory.remember(OTHER, item("rule", "r", "Other space's rule", 4, "pending"), ctx);
      await memory.remember(ANA, item("preference", "p", "Ana likes tea", 5, "pending"), ctx);
      same(ids(await memory.list(TEAM, FACTS, 10, ctx)), ["a"], "the team's list");
      same(ids(await memory.search(TEAM, "tea", 10, ctx)), ["a"], "the team's search");
      same(ids(await memory.search(TEAM, "rule", 10, ctx, RULES)), [], "the team's search of rules");
      same(ids(await memory.search(TRADER, "tea", 10, ctx)), ["t"], "the trader's search");
      same(ids(await memory.list(OTHER, FACTS, 10, ctx)), ["b"], "the other space's list");
      same(ids(await memory.list(TRADER, FACTS, 10, ctx)), ["t"], "the trader's list");
      same(await memory.get(TEAM, "b", ctx), undefined, "another space's fact, got from the team");
      same(await memory.approve(TEAM, "r", "rule", BY, ctx), false, "another space's rule, approved from the team");
      same((await memory.get(OTHER, "r", ctx))?.status, "pending", "the other space's rule after that");
      same(await memory.replace(TEAM, "b", fact("b", "likes coffee", 6), ctx), undefined, "another space's fact, replaced from the team");
      same((await memory.get(OTHER, "b", ctx))?.text, "likes tea too", "the other space's fact after that");
      same(await memory.approve(BOB, "p", "preference", BY, ctx), false, "Ana's preference, approved as Bob");
      same(await memory.list(BOB, { kinds: ["preference"] }, 10, ctx), [], "Bob's preferences");
      same(await memory.forget(BOB, "p", { kinds: ["preference"] }, BY, ctx), false, "Ana's preference, forgotten as Bob");
      same((await memory.changes(BOB, { limit: 10 }, ctx)).items, [], "Bob's log");
      same(await codeOf(memory.restore(BOB, 1, BY, ctx)), "not_found", "restoring Ana's first change as Bob");
      same(brief((await memory.changes(TEAM, { limit: 10 }, ctx)).items), [[1, "added", "note", "a", "likes tea"]], "the team's log: its own change only");
      // The same id in another owner is another memory: forgetting the team's leaves it.
      await memory.remember(OTHER, fact("a", "the other space's own a", 6), ctx);
      same(await memory.forget(TEAM, "a", DATA, BY, ctx), true, "forgetting the team's a");
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
      same((await memory.changes(TEAM, { limit: 10 }, ctx)).items, [], "nothing logged");
    }),
    appCase("search is full-text over facts and summaries by default: every word in any order and case, then any word; best first, with a snippet", async ({ memory, ctx, TEAM }) => {
      await memory.remember(TEAM, fact("a", "Ana LIKES green TEA in the morning", 1), ctx);
      await memory.remember(TEAM, item("summary", "s", "# Tea and cocoa\nTalked about tea, tea and 100% cocoa with Ana.", 2), ctx);
      await memory.remember(TEAM, fact("c", "Costs 1000 euros, invoice INV-2026-0042", 3), ctx);
      await memory.remember(TEAM, fact("d", "Café on Monday", 4), ctx);
      await memory.remember(TEAM, item("rule", "r", "Never talk about tea", 5), ctx);
      same(ids(await memory.search(TEAM, "tea", 10, ctx)), ["s", "a"], "facts and summaries, never rules by default, the most relevant first");
      same(ids(await memory.search(TEAM, "tea", 1, ctx)), ["s"], "`limit`");
      same(ids(await memory.search(TEAM, "tea ANA morning", 10, ctx)), ["a"], "every word, in any order and case");
      same(ids(await memory.search(TEAM, "morning cocoa", 10, ctx)).sort(), ["a", "s"], "no memory has every word: any of them");
      same(ids(await memory.search(TEAM, "inv-2026-0042", 10, ctx)), ["c"], "a hyphenated id");
      same(ids(await memory.search(TEAM, "cafe", 10, ctx)), ["d"], "diacritics ignored");
      const [match] = await memory.search(TEAM, "cocoa", 10, ctx);
      check(match !== undefined && match.snippet.includes("[cocoa]"), `the snippet marks the match: ${JSON.stringify(match?.snippet)}`);
      same(match?.text, "# Tea and cocoa\nTalked about tea, tea and 100% cocoa with Ana.", "a match carries its whole text");
      same(match?.by, BY, "a match carries its author");
      for (const query of ["ana@example.com", "https://example.com/a?b=c", '"unbalanced', "tea AND", "NOT tea", "tea*", "(tea", "a:b", "-tea", "^tea", "100%", "1_00"]) {
        const message = await refusal(memory.search(TEAM, query, 10, ctx));
        check(message === undefined, `search ${JSON.stringify(query)} failed: ${message}`);
      }
      same(await memory.search(TEAM, "?!", 10, ctx), [], "a query with no word finds nothing");
      same(await memory.search(TEAM, "pizza", 10, ctx), [], "a word nothing has");
      await memory.forget(TEAM, "s", DATA, BY, ctx);
      same(ids(await memory.search(TEAM, "tea", 10, ctx)), ["a"], "a forgotten memory is never found");
    }),
    appCase("search with a filter finds what it takes: rules too, by status; a person's preferences only when asked", async ({ memory, ctx, TEAM, ANA }) => {
      await memory.remember(TEAM, fact("a", "Budget in euros", 1), ctx);
      await memory.remember(TEAM, item("rule", "r1", "Quote every budget in euros", 2), ctx);
      await memory.remember(TEAM, item("rule", "r2", "Round euros up", 3, "pending"), ctx);
      await memory.remember(ANA, item("preference", "p", "Euros, never dollars", 4), ctx);
      same(ids(await memory.search(TEAM, "euros", 10, ctx, { kinds: ["fact", "summary", "rule"], status: "active" })).sort(), ["a", "r1"], "the active rules and notes");
      same(ids(await memory.search(TEAM, "euros", 10, ctx, RULES)).sort(), ["r1", "r2"], "every rule");
      same(ids(await memory.search(TEAM, "euros", 10, ctx, { kinds: ["rule"], status: "pending" })), ["r2"], "the pending rule");
      same(ids(await memory.search(TEAM, "euros", 10, ctx)), ["a"], "the default: no rule");
      same(ids(await memory.search(ANA, "euros", 10, ctx)), [], "a person's default: nothing");
      same(ids(await memory.search(ANA, "euros", 10, ctx, { kinds: ["preference"] })), ["p"], "a person's preferences, when asked");
      check((await refusal(memory.search(TEAM, "euros", 10, ctx, { kinds: ["preference"] }))) !== undefined, "a space's search of preferences to be refused");
      await memory.forget(TEAM, "r1", RULES, BY, ctx);
      same(ids(await memory.search(TEAM, "euros", 10, ctx, RULES)), ["r2"], "a forgotten rule is never found");
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
      await memory.remember(TEAM, fact("ok", "likes tea", 1), ctx);
      const replaced = await refusal(memory.replace(TEAM, "ok", fact("ok", `my key is ${CREDENTIAL}.`, 2), ctx));
      check(replaced !== undefined && !replaced.includes(CREDENTIAL), "replace with a credential to be refused without echoing it");
      same(await memory.list(TEAM, { kinds: ["fact", "rule"] }, 10, ctx), [fact("ok", "likes tea", 1)], "nothing kept but the fact");
      same(await memory.list(ANA, { kinds: ["preference"] }, 10, ctx), [], "nothing kept for the person");
      same(brief(await wholeLog(memory, TEAM, ctx)), [[1, "added", "note", "ok", "likes tea"]], "nothing refused is logged");
    }),
    appCase("every write keeps its author exactly as given: a person, an agent with its conversation and the person it answered, a component, an operator", async ({ memory, ctx, TEAM, ANA }) => {
      const authors: Author[] = [BY, AGENT, COMPONENT, OPERATOR, { kind: "person", principal: { channel: "web", id: "u-1" } }];
      for (const [i, by] of authors.entries()) await memory.remember(TEAM, { ...fact(`f${i}`, `fact ${i}`, i + 1), by }, ctx);
      same((await memory.list(TEAM, FACTS, 10, ctx)).map((m) => m.by), authors, "each memory's author");
      same((await wholeLog(memory, TEAM, ctx)).map((entry) => entry.by), authors, "each entry's author");
      await memory.remember(ANA, item("preference", "p", "Short answers", 9, "pending", AGENT), ctx);
      await memory.approve(ANA, "p", "preference", { kind: "person", principal: { channel: ANA.channel, id: ANA.id } }, ctx);
      same((await memory.get(ANA, "p", ctx))?.by, AGENT, "a memory's author is its first: approving does not change it");
      same((await wholeLog(memory, ANA, ctx)).map((entry) => [entry.action, entry.by]), [["added", AGENT], ["changed", { kind: "person", principal: { channel: ANA.channel, id: ANA.id } }]], "the approval's entry is the approver's");
    }),
    appCase("an author that is not one is refused as invalid, never quoted, and nothing changes or is logged", async ({ memory, ctx, TEAM }) => {
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 1, "pending"), ctx);
      const bad = [undefined, null, "ana", { kind: "robot" }, { kind: "person" }, { kind: "person", principal: { channel: "", id: CREDENTIAL } }, { kind: "agent", agent: "a" }, { kind: "operator" }];
      for (const by of bad) {
        const as = by as unknown as Author;
        for (const [what, work] of [
          ["remember", memory.remember(TEAM, { ...fact("f", "likes tea", 2), by: as }, ctx)],
          ["approve", memory.approve(TEAM, "r", "rule", as, ctx)],
          ["forget", memory.forget(TEAM, "r", RULES, as, ctx)],
          ["replace", memory.replace(TEAM, "r", { ...item("rule", "r", "Answer in French", 3), by: as }, ctx)],
          ["restore", memory.restore(TEAM, 1, as, ctx)],
        ] as const) {
          const message = await refusal(work);
          check(message !== undefined, `${what} by ${JSON.stringify(by)} was not refused`);
          check(!(message ?? "").includes(CREDENTIAL), `${what}'s refusal quotes the author`);
        }
        same(await codeOf(memory.approve(TEAM, "r", "rule", as, ctx)), "invalid", `approve by ${JSON.stringify(by)}`);
      }
      same(await memory.list(TEAM, { kinds: ["fact", "rule"] }, 10, ctx), [item("rule", "r", "Answer in Spanish", 1, "pending")], "the memory as it was");
      same(brief(await wholeLog(memory, TEAM, ctx)), [[1, "added", "rule", "r", "Answer in Spanish"]], "the log as it was");
    }),
    appCase("each write that changes something logs one entry (kind, id, title, author, time); a repeat logs nothing", async ({ memory, ctx, clock, TEAM, ANA }) => {
      const long = `Ana ${"likes very green tea ".repeat(12)}`;
      await memory.remember(TEAM, fact("f", long, 1), ctx);
      await memory.remember(TEAM, fact("f", long, 1), ctx);
      await clock.advance(5);
      await memory.remember(TEAM, item("summary", "s", "# Tea\nTalked about tea.", 2, "active", COMPONENT), ctx);
      await memory.remember(TEAM, item("rule", "r", "Answer  in\nSpanish", 3, "pending", AGENT), ctx);
      await memory.approve(TEAM, "r", "rule", BY, ctx);
      await memory.approve(TEAM, "r", "rule", BY, ctx);
      await memory.forget(TEAM, "f", DATA, BY, ctx);
      await memory.forget(TEAM, "f", DATA, BY, ctx);
      await memory.remember(ANA, item("preference", "p", "Short answers", 4, "pending", AGENT), ctx);
      const log = await wholeLog(memory, TEAM, ctx);
      const title = `Ana ${"likes very green tea ".repeat(12)}`.replace(/\s+/g, " ").trim();
      same(
        brief(log),
        [
          [1, "added", "note", "f", `${title.slice(0, CHANGE_TITLE_MAX - 3).trimEnd()}...`],
          [2, "added", "summary", "s", "# Tea Talked about tea."],
          [3, "added", "rule", "r", "Answer in Spanish"],
          [4, "changed", "rule", "r", "Answer in Spanish"],
          [5, "removed", "note", "f", `${title.slice(0, CHANGE_TITLE_MAX - 3).trimEnd()}...`],
        ],
        "one entry per change, none for a repeat, a fact's kind `note`, titles of one line",
      );
      same(log.map((entry) => [entry.by, entry.restorable]), [[BY, true], [COMPONENT, true], [AGENT, true], [BY, true], [BY, true]], "authors, restorable");
      same(log.map((entry) => entry.at), [clock.now() - 5, clock.now(), clock.now(), clock.now(), clock.now()], "times from the store's clock");
      same(brief(await wholeLog(memory, ANA, ctx)), [[1, "added", "preference", "p", "Short answers"]], "a person's log of their own, numbered from 1");
    }),
    appCase("changes pages newest first, `next` naming the page after; a malformed page is invalid", async ({ memory, ctx, TEAM }) => {
      for (let i = 1; i <= 5; i++) await memory.remember(TEAM, fact(`f${i}`, `fact ${i}`, i), ctx);
      const first = await memory.changes(TEAM, { limit: 2 }, ctx);
      same([first.items.map((entry) => entry.n), first.next], [[5, 4], 4], "the newest two");
      const second = await memory.changes(TEAM, { limit: 2, before: 4 }, ctx);
      same([second.items.map((entry) => entry.n), second.next], [[3, 2], 2], "the two before 4");
      const last = await memory.changes(TEAM, { limit: 2, before: 2 }, ctx);
      same([last.items.map((entry) => entry.n), last.next], [[1], undefined], "the last page");
      for (const page of [{ limit: 0 }, { limit: 201 }, { limit: 2, before: 0 }, { limit: 1.5 }]) same(await codeOf(memory.changes(TEAM, page, ctx)), "invalid", `the page ${JSON.stringify(page)}`);
    }),
    appCase("replace: new words as one change by the replacer, the old removed; one restore brings the old words back and removes the new", async ({ memory, ctx, clock, TEAM }) => {
      await memory.remember(TEAM, item("rule", "r-1", "Answer in Spanish", 1, "active", AGENT), ctx);
      const old = await memory.get(TEAM, "r-1", ctx);
      await clock.advance(1_000);
      const kept = await memory.replace(TEAM, "r-1", item("rule", "r-2", "Answer in French", 99, "pending"), ctx);
      const replacement = { id: "r-2", kind: "rule", status: "active", text: "Answer in French", createdAt: 1, updatedAt: clock.now(), by: BY };
      same(kept, replacement, "the kept memory: the old one's kind, status and place, the new words, by the replacer");
      same(ids(await memory.list(TEAM, RULES, 10, ctx)), ["r-2"], "only the new words");
      same(ids(await memory.search(TEAM, "french", 10, ctx, RULES)), ["r-2"], "found by its new words");
      same(ids(await memory.search(TEAM, "spanish", 10, ctx, RULES)), [], "never by the old");
      const [, changed] = await wholeLog(memory, TEAM, ctx);
      same(brief(changed === undefined ? [] : [changed]), [[2, "changed", "rule", "r-1", "Answer in French"]], "one entry, about the memory replaced");
      same(changed?.by, BY, "by the replacer");
      const restored = await memory.restore(TEAM, 2, AGENT, ctx);
      same(ids(await memory.list(TEAM, RULES, 10, ctx)), ["r-1"], "the old words back, the new removed");
      same(await memory.get(TEAM, "r-1", ctx), old, "exactly as it was, by its first author");
      same([restored.action, restored.restores, restored.by, restored.item], ["restored", 2, AGENT, changed?.item], "a restored entry by the restorer");
      // A note's words in place (same id); the same words again change nothing; an unknown id is undefined.
      await memory.remember(TEAM, fact("n", "Budget is 10k", 2), ctx);
      same((await memory.replace(TEAM, "n", fact("n", "Budget is 12k", 3), ctx))?.text, "Budget is 12k", "a note's new words, same id");
      const entries = (await wholeLog(memory, TEAM, ctx)).length;
      same((await memory.replace(TEAM, "n", fact("n", "Budget is 12k", 4), ctx))?.text, "Budget is 12k", "the same words again");
      same(await memory.replace(TEAM, "nobody", fact("nobody", "Anything", 5), ctx), undefined, "an unknown id");
      same((await wholeLog(memory, TEAM, ctx)).length, entries, "neither logged");
      await memory.remember(TEAM, fact("m", "Budget is 15k", 6), ctx);
      same(await codeOf(memory.replace(TEAM, "n", fact("m", "Budget is 20k", 7), ctx)), "invalid", "new words under an id another memory holds");
      same((await memory.get(TEAM, "m", ctx))?.text, "Budget is 15k", "the other memory untouched");
    }),
    appCase("restore is exact: a forgotten memory back under its id, words, status and first author; an approval undone pending; a restore restorable", async ({ memory, ctx, clock, TEAM }) => {
      await memory.remember(TEAM, item("rule", "r", "Use metric units", 1, "pending", AGENT), ctx);
      const pending = await memory.get(TEAM, "r", ctx);
      await clock.advance(10);
      await memory.approve(TEAM, "r", "rule", BY, ctx);
      const active = await memory.get(TEAM, "r", ctx);
      await memory.restore(TEAM, 2, BY, ctx);
      same(await memory.get(TEAM, "r", ctx), pending, "the approval undone: pending again, as it was");
      same(ids(await memory.search(TEAM, "metric", 10, ctx, { kinds: ["rule"], status: "active" })), [], "not found as active");
      await memory.restore(TEAM, 3, OPERATOR, ctx);
      same(await memory.get(TEAM, "r", ctx), active, "the restore restored: active again");
      await memory.forget(TEAM, "r", RULES, COMPONENT, ctx);
      await memory.restore(TEAM, 5, BY, ctx);
      same(await memory.get(TEAM, "r", ctx), active, "a forgotten rule back, exactly");
      same(ids(await memory.search(TEAM, "metric", 10, ctx, RULES)), ["r"], "and found again");
      await memory.restore(TEAM, 1, BY, ctx);
      same(await memory.get(TEAM, "r", ctx), undefined, "its addition restored: gone");
      same(
        brief(await wholeLog(memory, TEAM, ctx)).map(([n, action]) => [n, action]),
        [
          [1, "added"],
          [2, "changed"],
          [3, "restored"],
          [4, "restored"],
          [5, "removed"],
          [6, "restored"],
          [7, "restored"],
        ],
        "every restore appended",
      );
      same(await codeOf(memory.restore(TEAM, 99, BY, ctx)), "not_found", "a change never logged");
    }),
    appCase("redact is an operator's only: it blanks the title and the states, keeps who and when, and its restore is gone", async ({ memory, ctx, TEAM }) => {
      await memory.remember(TEAM, fact("f", "Ana's phone is 600 123 456", 1), ctx);
      await memory.forget(TEAM, "f", DATA, BY, ctx);
      for (const by of [BY, AGENT, COMPONENT]) same(await codeOf(memory.redact(TEAM, 1, by, ctx)), "forbidden", `a redaction by ${by.kind}`);
      const before = await wholeLog(memory, TEAM, ctx);
      same(before.map((entry) => entry.redacted), [undefined, undefined], "nothing redacted by them");
      await memory.redact(TEAM, 1, OPERATOR, ctx);
      await memory.redact(TEAM, 2, OPERATOR, ctx);
      await memory.redact(TEAM, 2, OPERATOR, ctx);
      const after = await wholeLog(memory, TEAM, ctx);
      same(after.map((entry) => [entry.n, entry.at, entry.by, entry.action, entry.item.kind, entry.item.id, entry.restorable, entry.redacted?.by]), before.map((entry) => [entry.n, entry.at, entry.by, entry.action, entry.item.kind, entry.item.id, false, OPERATOR]), "who, when and what stay; not restorable");
      check(after.every((entry) => !entry.item.title.includes("600")), "the titles blanked");
      same(await codeOf(memory.restore(TEAM, 2, BY, ctx)), "gone", "restoring a redacted removal");
      same(await memory.get(TEAM, "f", ctx), undefined, "nothing came back");
      same(await codeOf(memory.redact(TEAM, 9, OPERATOR, ctx)), "not_found", "redacting a change never logged");
    }),
    appCase("past retention an entry is not restorable (gone), the next write drops it, and numbers are never reused", async ({ memory, ctx, clock, TEAM }) => {
      await memory.remember(TEAM, fact("a", "likes tea", 1), ctx);
      await memory.forget(TEAM, "a", DATA, BY, ctx);
      await clock.advance((CHANGE_RETENTION_DAYS + 1) * DAY);
      same((await wholeLog(memory, TEAM, ctx)).map((entry) => [entry.n, entry.restorable]), [[1, false], [2, false]], "past retention: not restorable");
      same(await codeOf(memory.restore(TEAM, 2, BY, ctx)), "gone", "restoring one");
      await memory.remember(TEAM, fact("b", "likes cake", 2), ctx);
      same((await wholeLog(memory, TEAM, ctx)).map((entry) => [entry.n, entry.restorable]), [[3, true]], "dropped at the next write; the next number is 3");
      same(await codeOf(memory.restore(TEAM, 1, BY, ctx)), "gone", "restoring a dropped entry");
      same(await codeOf(memory.restore(TEAM, 4, BY, ctx)), "not_found", "restoring one never logged");
    }),
    appCase("purge deletes an owner's memories and log for good, and nothing of another owner's", async ({ memory, ctx, TEAM, OTHER }) => {
      await memory.remember(TEAM, fact("a", "likes tea", 1), ctx);
      await memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 2), ctx);
      await memory.remember(OTHER, fact("a", "likes tea too", 3), ctx);
      await memory.purge(TEAM, ctx);
      same(await memory.list(TEAM, { kinds: ["fact", "summary", "rule"] }, 10, ctx), [], "no memories");
      same(await memory.search(TEAM, "tea", 10, ctx), [], "nothing found");
      same((await memory.changes(TEAM, { limit: 10 }, ctx)).items, [], "no log");
      same(ids(await memory.list(OTHER, FACTS, 10, ctx)), ["a"], "the other space's memory");
      same((await memory.changes(OTHER, { limit: 10 }, ctx)).items.length, 1, "the other space's log");
      await memory.purge(TEAM, ctx);
    }),
    memoryCase("what is remembered survives a restart, searchable, with its authors and log", async (fixture, who, clock) => {
      const { TEAM, ANA } = who;
      const first = await boot(fixture, who, clock);
      try {
        await first.memory.remember(TEAM, fact("a", "likes tea", 1), first.ctx);
        await first.memory.remember(TEAM, item("rule", "r", "Answer in Spanish", 2, "pending", AGENT), first.ctx);
        await first.memory.approve(TEAM, "r", "rule", BY, first.ctx);
        await first.memory.remember(ANA, item("preference", "p", "Short answers", 3, "pending"), first.ctx);
      } finally {
        await first.stop();
      }
      const second = await boot(fixture, who, clock);
      try {
        same(await second.memory.list(TEAM, FACTS, 10, second.ctx), [fact("a", "likes tea", 1)], "the facts after the restart");
        same(ids(await second.memory.search(TEAM, "TEA", 10, second.ctx)), ["a"], "the search after the restart");
        same(await second.memory.get(TEAM, "r", second.ctx), { ...item("rule", "r", "Answer in Spanish", 2, "active", AGENT), updatedAt: clock.now() }, "the approved rule after the restart");
        same((await second.memory.get(ANA, "p", second.ctx))?.status, "pending", "the pending preference after the restart");
        same(brief(await wholeLog(second.memory, TEAM, second.ctx)).map(([n, action]) => [n, action]), [[1, "added"], [2, "added"], [3, "changed"]], "the log after the restart");
        await second.memory.restore(TEAM, 3, BY, second.ctx);
        same((await second.memory.get(TEAM, "r", second.ctx))?.status, "pending", "restored after the restart");
      } finally {
        await second.stop();
      }
    }),
    ...changeLogCases(GROUP, ruleLog),
  ];
}
