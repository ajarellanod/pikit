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
import { type Memory, MEMORY_TEXT_MAX, type MemoryScope, type MemoryStore } from "./contract.ts";

export interface MemoryFixture {
  /** The components of one App over the case's storage: called again for each App of the case (a restart). */
  components(): ComponentDefinition[];
  config?: Record<string, unknown>;
  target?: Target;
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
 * The people of one case: names no other case uses, so a provider whose storage outlives a case (a
 * Durable Object per person) runs the suite as one whose storage is new each time.
 */
const people = () => {
  const id = crypto.randomUUID();
  return { ANA: { agent: "assistant", person: `telegram:ana-${id}` }, BOB: { agent: "assistant", person: `telegram:bob-${id}` } } satisfies Record<string, MemoryScope>;
};
type People = ReturnType<typeof people>;
const fact = (id: string, text: string, createdAt: number): Memory => ({ id, kind: "fact", text, createdAt });
const ids = (memories: readonly Memory[]) => memories.map((m) => m.id);

interface Running extends People {
  memory: MemoryStore;
  ctx: AppContext;
  stop(): Promise<void>;
}

async function boot(fixture: MemoryFixture, who: People): Promise<Running> {
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
  const memoryCase = (name: string, run: (fixture: MemoryFixture, who: People) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture, people());
      } finally {
        await fixture.dispose?.();
      }
    },
  });
  const appCase = (name: string, run: (app: Running) => Promise<void>): ConformanceCase =>
    memoryCase(name, async (fixture, who) => {
      const app = await boot(fixture, who);
      try {
        await run(app);
      } finally {
        await app.stop();
      }
    });

  return [
    appCase("what is remembered is listed by kind, the newest `limit`, oldest first", async ({ memory, ctx, ANA }) => {
      await memory.remember(ANA, fact("b", "likes tea", 2), ctx);
      await memory.remember(ANA, fact("a", "is called Ana", 1), ctx);
      await memory.remember(ANA, fact("c", "works on pikit", 3), ctx);
      await memory.remember(ANA, { id: "s", kind: "summary", text: "Asked about tea.", createdAt: 4 }, ctx);
      same(await memory.list(ANA, "fact", 10, ctx), [fact("a", "is called Ana", 1), fact("b", "likes tea", 2), fact("c", "works on pikit", 3)], "the facts");
      same(ids(await memory.list(ANA, "fact", 2, ctx)), ["b", "c"], "the newest two facts, oldest first");
      same(ids(await memory.list(ANA, "summary", 10, ctx)), ["s"], "the summaries");
    }),
    appCase("the same id twice is kept once, as it was first", async ({ memory, ctx, ANA }) => {
      await memory.remember(ANA, fact("x", "likes tea", 1), ctx);
      await memory.remember(ANA, fact("x", "likes coffee", 2), ctx);
      same(await memory.list(ANA, "fact", 10, ctx), [fact("x", "likes tea", 1)], "the memory kept");
    }),
    appCase("forget removes one memory; an unknown id is fine", async ({ memory, ctx, ANA }) => {
      await memory.remember(ANA, fact("a", "likes tea", 1), ctx);
      await memory.remember(ANA, fact("b", "likes cake", 2), ctx);
      await memory.forget(ANA, "a", ctx);
      await memory.forget(ANA, "a", ctx);
      await memory.forget(ANA, "nobody", ctx);
      same(ids(await memory.list(ANA, "fact", 10, ctx)), ["b"], "what is left");
    }),
    appCase("another person's or agent's memories are never listed, searched or forgotten", async ({ memory, ctx, ANA, BOB: bob }) => {
      const other: MemoryScope = { agent: "other", person: ANA.person };
      await memory.remember(ANA, fact("a", "likes tea", 1), ctx);
      await memory.remember(bob, fact("b", "likes tea too", 2), ctx);
      await memory.remember(other, fact("o", "tea for another agent", 3), ctx);
      same(ids(await memory.list(ANA, "fact", 10, ctx)), ["a"], "Ana's list");
      same(ids(await memory.search(ANA, "tea", 10, ctx)), ["a"], "Ana's search");
      same(ids(await memory.list(bob, "fact", 10, ctx)), ["b"], "Bob's list");
      same(ids(await memory.list(other, "fact", 10, ctx)), ["o"], "the other agent's list");
      // The same id in another scope is another memory: forgetting Ana's leaves it.
      await memory.remember(bob, fact("a", "Bob's own a", 4), ctx);
      await memory.forget(ANA, "a", ctx);
      same(ids(await memory.list(bob, "fact", 10, ctx)), ["b", "a"], "Bob's list after Ana's forget");
    }),
    appCase("search finds the text, ASCII case ignored, newest first, its wildcards literal, `limit` honoured", async ({ memory, ctx, ANA }) => {
      await memory.remember(ANA, fact("a", "Likes TEA", 1), ctx);
      await memory.remember(ANA, { id: "s", kind: "summary", text: "Talked about tea and 100% cocoa.", createdAt: 2 }, ctx);
      await memory.remember(ANA, fact("c", "costs 1000 euros", 3), ctx);
      same(ids(await memory.search(ANA, "tea", 10, ctx)), ["s", "a"], "both kinds, newest first");
      same(ids(await memory.search(ANA, "tea", 1, ctx)), ["s"], "the newest one");
      same(ids(await memory.search(ANA, "100%", 10, ctx)), ["s"], "% taken literally");
      same(ids(await memory.search(ANA, "1_00", 10, ctx)), [], "_ taken literally");
    }),
    appCase("a text holding a credential, an empty one or one too long is refused, keeps nothing and is never echoed", async ({ memory, ctx, ANA }) => {
      for (const text of [`my key is ${CREDENTIAL}.`, " ", "x".repeat(MEMORY_TEXT_MAX + 1)]) {
        const message = await refusal(memory.remember(ANA, fact("bad", text, 1), ctx));
        check(message !== undefined, `remember of ${JSON.stringify(text.slice(0, 20))} was not refused`);
        check(!(message ?? "").includes(CREDENTIAL), "the refusal echoes the credential");
      }
      same(await memory.list(ANA, "fact", 10, ctx), [], "nothing kept");
    }),
    memoryCase("what is remembered survives a restart", async (fixture, who) => {
      const { ANA } = who;
      const first = await boot(fixture, who);
      try {
        await first.memory.remember(ANA, fact("a", "likes tea", 1), first.ctx);
      } finally {
        await first.stop();
      }
      const second = await boot(fixture, who);
      try {
        same(await second.memory.list(ANA, "fact", 10, second.ctx), [fact("a", "likes tea", 1)], "after the restart");
      } finally {
        await second.stop();
      }
    }),
  ];
}
