/**
 * conversations-directory on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation`
 * class, as `PlatformConversation`, `src/platform.ts`): the directory in the object
 * `conversations-directory:index`, each conversation in the object of its key, reached through
 * actors-do's `actor.mailbox` by RPC.
 *
 * - The `conversations.directory` suite from the Worker's App (actors-do and the Worker half, with the
 *   suite's `conversation.audience` stage there, where a people viewer's grants are computed): every
 *   call crosses to the index object. Each conversation's object (storage-do, storage-kv-sql, actors-do,
 *   conversations-kv over a runtime double, the default export, and a driver that resolves keys and
 *   emits the runtime's events as the suite says) records into its own `_outbox`; its flush is the
 *   object's alarm (actors-do's `wakeups`), fired by the test (`runDurableObjectAlarm`): the case's
 *   clock starts a day ahead, so no alarm fires on its own. Deleting a key's current conversation resets
 *   the key in its object, called by the index object. `replay` sends every `seen` the objects sent again,
 *   newest first; a restart is a new Worker App and new object instances over the same storage.
 * - A message in its object costs no `seen` (counted at the objects' mailbox) and leaves one outbox row;
 *   the object's alarm sends it as one `seen`; the directory's rows are in the index object only.
 */

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Handle, type Pikit, silentLogger, withContextValue } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import type { ActorMailbox, ConversationDirectory, ConversationRef, JsonValue } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { type ConversationDirectorySubject, createConversationDirectoryConformance, type DirectoryMessage } from "@pikit/contracts/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import conversationsDirectory, { ENTRIES, INDEX_KEY, OUTBOX, SEEN, worker as directoryWorker } from "../../../registry/components/conversations-directory/files/src/pikit/conversations-directory/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const ACTORS = { "actors-do": { binding: PLATFORM_BINDING } };
const object = (key: string) => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));

/** Every `seen` the conversations' objects sent (the objects share the tests' isolate). */
const sentSeen: JsonValue[] = [];
/** The keys a case's conversations used: their objects are emptied before the next case. */
const touched = new Set<string>();

/** actors-do with its `actor.mailbox`'s sends of `seen` recorded in `sentSeen`. */
const recordingActors = defineComponent({
  name: actorsDo.name,
  ...(actorsDo.config !== undefined && { config: actorsDo.config }),
  setup(pikit, config) {
    const proxy = new Proxy(pikit, {
      get(target, property) {
        if (property === "provide")
          return (name: string, value: unknown) => {
            if (name !== "actor.mailbox") return target.provide(name as never, value as never);
            const mailbox = value as ActorMailbox;
            return target.provide("actor.mailbox", {
              send: (key, type, message, ctx) => {
                if (type === SEEN) sentSeen.push(message);
                return mailbox.send(key, type, message, ctx);
              },
              call: mailbox.call.bind(mailbox),
              stream: mailbox.stream.bind(mailbox),
            });
          };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return actorsDo.setup(proxy as Pikit, config as never);
  },
});

/**
 * The runtime's part a conversation's object needs here: new conversations, and an `agent.observe` with
 * none to backfill. Ids unique across objects: the suite's "a key with another's conversation id" case
 * assumes it, where runtime-pi numbers each object's own (`"1"`, `"2"`…), unique only with their key.
 */
const runtimeDouble = defineComponent({
  name: "runtime-double",
  setup(pikit) {
    pikit.provide("agent.conversations", { create: async () => crypto.randomUUID() });
    pikit.provide("agent.observe", {
      conversations: async () => ({ items: [] }),
      conversation: async () => undefined,
      transcript: async () => undefined,
      usage: async () => undefined,
      watch: () => (async function* () {})(),
    });
  },
});

/** In each conversation's object: what the suite drives, as a channel and the runtime would. */
const driver = defineComponent({
  name: "directory-driver",
  setup(pikit) {
    const inbox = pikit.use("actor.inbox");
    const registry = pikit.use("conversations.registry");
    const refOf = async (key: string, conversationId: string, ctx: AppContext): Promise<ConversationRef> => {
      const record = await registry.get().get(key, ctx);
      return { key, conversationId, agent: record?.agent ?? "assistant", ...(record?.channel !== undefined && { channel: record.channel }) };
    };
    return {
      start() {
        const calls = inbox.get();
        calls.answer("dir-test.message", async (key, message, ctx) => {
          const { requestId, sender, place, duplicate } = message as unknown as DirectoryMessage;
          const ref = await registry.get().resolve(key, place.agent, { channel: place.channel, ...(place.space !== undefined && { space: place.space }), ...(place.owner !== undefined && { owner: place.owner }) }, ctx);
          const conversation = place.delegated === true ? { ...ref, origin: { key: "web:origin", agent: ref.agent, conversationId: "origin" } } : ref;
          await ctx.emit("agent.dispatched", { conversation, admission: { kind: duplicate === true ? "duplicate" : "queued", requestId }, ...(sender !== undefined && { sender }) });
          return { conversationId: ref.conversationId };
        });
        calls.answer("dir-test.started", async (key, message, ctx) => {
          const { conversationId, requestId } = message as { conversationId: string; requestId: string };
          await ctx.emit("agent.started", { conversation: await refOf(key, conversationId, ctx), requestId, resumed: false });
          return {};
        });
        calls.answer("dir-test.settled", async (key, message, ctx) => {
          const { conversationId, requestIds, kind } = message as { conversationId: string; requestIds: string[]; kind: "completed" | "aborted" | "failed" };
          const result = { conversation: await refOf(key, conversationId, ctx), requestId: requestIds[0] ?? "", requestIds, messages: [] };
          if (kind === "failed") await ctx.emit("agent.failed", { ...result, kind });
          else await ctx.emit("agent.settled", { ...result, kind });
          return {};
        });
        calls.answer("dir-test.reset", async (key, _message, ctx) => {
          const reset = await registry.get().reset(key, undefined, ctx);
          if (reset === undefined) throw new Error(`no conversation for ${key}`);
          return { conversationId: reset.newConversationId };
        });
      },
    };
  },
});

const OBJECTS: ComponentDefinition[] = [storageDo, storageKvSql, recordingActors, runtimeDouble, conversationsKv, conversationsDirectory, driver];

/** The rows of `sql` in `key`'s object (none when its table is not made yet). */
const rows = (key: string, sql: string) =>
  runInDurableObject(object(key), (_instance, state) => {
    try {
      return state.storage.sql.exec(sql).toArray();
    } catch {
      return [];
    }
  });

/** Fires `key`'s object's alarm until its outbox is empty: everything it recorded is with the directory. */
async function flushed(key: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const [row] = await rows(key, `SELECT count(*) AS n FROM ${OUTBOX}`);
    if (Number((row as { n?: number } | undefined)?.n ?? 0) === 0) return;
    await runDurableObjectAlarm(object(key));
  }
  throw new Error(`the outbox of ${key} was never flushed`);
}

/** Empties the index object and every object the last case used, then resets every instance. */
async function emptied(): Promise<void> {
  for (const key of [INDEX_KEY, ...touched]) {
    await runInDurableObject(object(key), async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  }
  touched.clear();
  sentSeen.length = 0;
  await resetObjects();
}

beforeEach(() => emptied());
afterEach(() => emptied());

/** The Worker's App: the Worker half, the suite's components, a mailbox to drive the objects. */
async function workerApp(components: readonly ComponentDefinition[], clock: ReturnType<typeof createManualClock>) {
  const handles: { directory?: Handle<ConversationDirectory>; mailbox?: Handle<ActorMailbox> } = {};
  const consumer = defineComponent({
    name: "directory-consumer",
    setup(pikit) {
      handles.directory = pikit.use("conversations.directory");
      handles.mailbox = pikit.use("actor.mailbox");
    },
  });
  const app = await defineApp({ components: [actorsDo, directoryWorker, ...components, consumer], config: ACTORS, clock, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return { app, ctx: app.context(), directory: (handles.directory as Handle<ConversationDirectory>).get(), mailbox: (handles.mailbox as Handle<ActorMailbox>).get() };
}

async function subjectOf(components: readonly ComponentDefinition[]): Promise<ConversationDirectorySubject> {
  // A day ahead: actors-do sets each object's alarm on this clock, so none fires before the test fires it.
  const clock = createManualClock(Date.now() + 86_400_000);
  composeObjects(OBJECTS, ACTORS, { clock });
  let worker = await workerApp(components, clock);
  const call = async <T>(key: string, type: string, message: Record<string, unknown>): Promise<T> => {
    touched.add(key);
    const answer = (await worker.mailbox.call(key, type, JSON.parse(JSON.stringify(message)) as JsonValue, worker.ctx)) as T;
    await flushed(key);
    return answer;
  };
  return {
    get directory() {
      return worker.directory;
    },
    ctx: worker.ctx,
    advance: (ms) => clock.advance(ms),
    async message(key, message) {
      const { conversationId } = await call<{ conversationId: string }>(key, "dir-test.message", message as unknown as Record<string, unknown>);
      return { key, conversationId };
    },
    async started(ref, requestId) {
      await call(ref.key, "dir-test.started", { conversationId: ref.conversationId, requestId });
    },
    async settled(ref, requestIds, kind = "completed") {
      await call(ref.key, "dir-test.settled", { conversationId: ref.conversationId, requestIds, kind });
    },
    async reset(key) {
      const { conversationId } = await call<{ conversationId: string }>(key, "dir-test.reset", {});
      return { key, conversationId };
    },
    async replay() {
      for (const message of [...sentSeen].reverse()) {
        const updates = [...((message as { updates: JsonValue[] }).updates ?? [])].reverse();
        await worker.mailbox.send(INDEX_KEY, SEEN, { updates }, worker.ctx);
      }
    },
    async restart() {
      await worker.app.stop();
      await resetObjects();
      composeObjects(OBJECTS, ACTORS, { clock });
      worker = await workerApp(components, clock);
      return worker.directory;
    },
    async close() {
      for (const key of touched) await flushed(key);
      await worker.app.stop();
    },
  };
}

for (const c of createConversationDirectoryConformance((options) => subjectOf(options.components))) {
  it(`conversations-directory (the Worker half against the index object) ${c.group}: ${c.name}`, () => c.run());
}

it("a message costs no seen in its object; the object's alarm sends it as one seen; the directory's rows are in the index object only", async () => {
  const clock = createManualClock(Date.now() + 86_400_000);
  composeObjects(OBJECTS, ACTORS, { clock });
  const worker = await workerApp([], clock);
  try {
    const key = `web:u-ana:${crypto.randomUUID()}`;
    touched.add(key);
    const ana = { channel: "web", id: "u-ana" };
    // Straight to the object, no alarm fired: what a message's path costs.
    const place = { agent: "assistant", channel: "web", owner: ana };
    const { conversationId } = (await worker.mailbox.call(key, "dir-test.message", { requestId: "r-1", sender: ana, place }, worker.ctx)) as { conversationId: string };
    await worker.mailbox.call(key, "dir-test.started", { conversationId, requestId: "r-1" }, worker.ctx);
    await worker.mailbox.call(key, "dir-test.settled", { conversationId, requestIds: ["r-1"], kind: "completed" }, worker.ctx);
    expect(sentSeen).toEqual([]);
    expect(await rows(key, `SELECT key, conversation FROM ${OUTBOX}`)).toEqual([{ key, conversation: conversationId }]);
    expect(await worker.directory.access({ kind: "operator", id: "op" }, { key }, worker.ctx)).toBeUndefined();

    expect(await runDurableObjectAlarm(object(key))).toBe(true);
    expect(sentSeen.length).toBe(1);
    const updates = (sentSeen[0] as { updates: { busy: boolean; activity: { id: string }[] }[] }).updates;
    expect(updates.map((update) => [update.busy, update.activity.map((each) => each.id)])).toEqual([[false, ["m:r-1", "r:r-1"]]]);
    expect(await rows(key, `SELECT key FROM ${OUTBOX}`)).toEqual([]);
    expect(await rows(INDEX_KEY, `SELECT key, conversation, owner FROM ${ENTRIES}`)).toEqual([{ key, conversation: conversationId, owner: "web:u-ana" }]);
    expect(await rows(key, `SELECT key FROM ${ENTRIES}`)).toEqual([]);
    const entry = await worker.directory.access({ kind: "people", principals: [ana] }, { key }, worker.ctx);
    expect(entry).toMatchObject({ key, conversationId, owner: ana, busy: false, role: "owner" });
  } finally {
    await worker.app.stop();
  }
});
