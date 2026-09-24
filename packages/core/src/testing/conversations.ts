/**
 * `conversations.registry` conformance (SPEC §7.4, §7.6, §14): what every conversation registry
 * must do, wherever it keeps its pointers. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createConversationRegistryConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite reaches the registry through the capability and `conversation.reset`, as a channel
 * would. When the fixture can list the sessions of its store, the suite also checks that every
 * pointer names a real session and that a reset deletes nothing.
 */

import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent } from "../app.ts";
import type { ConversationRef } from "../agent.ts";
import type { ConversationRegistry, ConversationReset } from "../contracts/conversations.ts";
import { silentLogger } from "../contracts/logger.ts";
import { checker, expecter } from "./assert.ts";
import type { ConformanceCase } from "./lifecycle.ts";

/** Fresh records (pointers and sessions), built for one case. */
export interface ConversationRegistryFixture {
  /**
   * One worker: the component providing `conversations.registry` and everything it uses. The
   * suite may create several apps from them over the same records, one after the other, so the
   * records live outside the components' setup (in the fixture: a directory, a shared store).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The ids of every session in the store, when the fixture can list them. */
  sessionIds?(): Promise<string[]>;
  /** Release what the fixture holds (temporary directories). */
  dispose?(): Promise<void>;
}

const GROUP = "conversations.registry";
const expect = expecter(GROUP);
const check = checker(GROUP);

export function createConversationRegistryConformance(
  factory: () => ConversationRegistryFixture | Promise<ConversationRegistryFixture>,
): readonly ConformanceCase[] {
  const registryCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const workers: App[] = [];
      try {
        await run(createSubject(fixture, workers));
      } finally {
        for (const app of workers) await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    registryCase("the first resolve creates a conversation on a session of its own", async (s) => {
      const w = await s.worker();
      const before = await s.sessionIds();

      const created = await w.registry.resolve("test:c1", "support", w.ctx);

      expect([created.key, created.agent], ["test:c1", "support"], "the conversation");
      check(typeof created.sessionId === "string" && created.sessionId.length > 0, "a session id");
      if (before !== undefined) {
        const after = (await s.sessionIds()) ?? [];
        check(after.includes(created.sessionId), `session ${created.sessionId} to exist in the store`);
        expect(after.length - before.length, 1, "sessions created");
      }
    }),

    registryCase("resolving again returns the same conversation, and get finds it", async (s) => {
      const w = await s.worker();
      const created = await w.registry.resolve("test:c1", "support", w.ctx);

      same(await w.registry.resolve("test:c1", "support", w.ctx), created, "the second resolve");
      same(await w.registry.get("test:c1", w.ctx), created, "get");
    }),

    registryCase("each key has its own session", async (s) => {
      const w = await s.worker();

      const one = await w.registry.resolve("test:c1", "support", w.ctx);
      const two = await w.registry.resolve("test:c2", "support", w.ctx);

      check(one.sessionId !== two.sessionId, "two keys to point to two sessions");
    }),

    registryCase("concurrent first resolves of one key create one session", async (s) => {
      const w = await s.worker();
      const before = await s.sessionIds();

      const all = await Promise.all(Array.from({ length: 5 }, () => w.registry.resolve("test:c1", "support", w.ctx)));

      expect(new Set(all.map((ref) => ref.sessionId)).size, 1, "distinct sessions for one key");
      if (before !== undefined) expect(((await s.sessionIds()) ?? []).length - before.length, 1, "sessions created");
    }),

    registryCase("get of an unknown key is undefined and creates nothing", async (s) => {
      const w = await s.worker();
      const before = await s.sessionIds();

      expect(await w.registry.get("test:unknown", w.ctx), undefined, "get");
      if (before !== undefined) expect(await s.sessionIds(), before, "sessions after get");
      expect(await w.registry.get("test:unknown", w.ctx), undefined, "get after get");
    }),

    registryCase("a conversation keeps the agent it was created with", async (s) => {
      const w = await s.worker();
      await w.registry.resolve("test:c1", "support", w.ctx);

      expect((await w.registry.resolve("test:c1", "sales", w.ctx)).agent, "support", "the agent after another route");
    }),

    registryCase("any string is a key: keys are opaque", async (s) => {
      const w = await s.worker();
      const keys = ["http:a/b", 'http:"quoted" ñandú ✓', "http:../../etc", "http:a.b:c"];

      const refs = await Promise.all(keys.map((key) => w.registry.resolve(key, "support", w.ctx)));

      expect(
        refs.map((ref) => ref.key),
        keys,
        "the keys as given",
      );
      expect(new Set(refs.map((ref) => ref.sessionId)).size, keys.length, "distinct sessions");
      for (const ref of refs) same(await w.registry.get(ref.key, w.ctx), ref, `get("${ref.key}")`);
    }),

    registryCase("reset points the key to a new session, keeps the old one and emits conversation.reset", async (s) => {
      const w = await s.worker();
      const created = await w.registry.resolve("test:c1", "support", w.ctx);

      const reset = await w.registry.reset("test:c1", w.ctx);

      if (reset === undefined) throw new Error(`${GROUP}: reset of a known key returned undefined`);
      expect([reset.previousSessionId, reset.newSessionId], [created.sessionId, reset.conversation.sessionId], "the reset");
      check(reset.newSessionId !== created.sessionId, "a new session");
      expect([reset.conversation.key, reset.conversation.agent], ["test:c1", "support"], "the conversation after reset");
      same(await w.registry.get("test:c1", w.ctx), reset.conversation, "get after reset");
      same(await w.registry.resolve("test:c1", "support", w.ctx), reset.conversation, "resolve after reset");
      expect(w.resets(), [reset], "conversation.reset events");
      const ids = await s.sessionIds();
      if (ids !== undefined) {
        check(ids.includes(created.sessionId), "the previous session to be kept");
        check(ids.includes(reset.newSessionId), "the new session to exist in the store");
      }
    }),

    registryCase("reset of an unknown key is undefined and emits nothing", async (s) => {
      const w = await s.worker();

      expect(await w.registry.reset("test:unknown", w.ctx), undefined, "reset");
      expect(w.resets(), [], "conversation.reset events");
      expect(await w.registry.get("test:unknown", w.ctx), undefined, "get after reset");
    }),

    registryCase("pointers are records: a new worker finds them", async (s) => {
      const first = await s.worker();
      const kept = await first.registry.resolve("test:c1", "support", first.ctx);
      await first.registry.resolve("test:c2", "support", first.ctx);
      const reset = await first.registry.reset("test:c2", first.ctx);
      await first.app.stop();

      const second = await s.worker();

      same(await second.registry.get("test:c1", second.ctx), kept, "the pointer after a restart");
      if (reset === undefined) throw new Error(`${GROUP}: reset of a known key returned undefined`);
      same(await second.registry.get("test:c2", second.ctx), reset.conversation, "the reset pointer after a restart");
    }),
  ];
}

interface Worker {
  app: App;
  registry: ConversationRegistry;
  ctx: AppContext;
  resets(): ConversationReset[];
}

interface Subject {
  /** A new worker (app) over the fixture's records, started. */
  worker(): Promise<Worker>;
  sessionIds(): Promise<string[] | undefined>;
}

function createSubject(fixture: ConversationRegistryFixture, workers: App[]): Subject {
  return {
    sessionIds: async () => (fixture.sessionIds === undefined ? undefined : [...(await fixture.sessionIds())].sort()),
    async worker() {
      const resets: ConversationReset[] = [];
      let registry: ConversationRegistry | undefined;
      const observer = defineComponent({
        name: "conversations-conformance",
        setup(pikit) {
          const handle = pikit.use("conversations.registry");
          pikit.on("conversation.reset", (payload) => void resets.push(payload));
          return {
            start() {
              registry = handle.get();
            },
          };
        },
      });
      const app = await defineApp({
        components: [...fixture.components, observer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      workers.push(app);
      await app.start();
      if (registry === undefined) throw new Error(`${GROUP}: conversations.registry was not resolved`);
      return { app, registry, ctx: app.context(), resets: () => [...resets] };
    },
  };
}

function same(actual: ConversationRef | undefined, expected: ConversationRef, what: string): void {
  expect(
    actual === undefined ? undefined : { key: actual.key, agent: actual.agent, sessionId: actual.sessionId },
    { key: expected.key, agent: expected.agent, sessionId: expected.sessionId },
    what,
  );
}
