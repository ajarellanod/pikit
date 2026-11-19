/**
 * conversations-directory's tests, copied with the component: the `conversations.directory` suite
 * (`createConversationDirectoryConformance`) on a server's layout (no `actor.inbox`: the directory in
 * the App, written at once) and on Cloudflare's (an inbox whose `scope` is `"one"`, in one process: the
 * outbox, the flush in `wakeups`, every directory call through `actor.mailbox`, a delete's reset asked of
 * the key's App), over `sqliteStorage()`, a registry and a runtime double that the suite drives as the
 * runtime would; then what only this provider promises: one `seen` per flush and none on a message's
 * path, the titler, and the start's backfill.
 */

import { expect, test } from "bun:test";
import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, type Pikit, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import type {
  ActorInbox,
  ActorMailbox,
  AgentObserver,
  ConversationDirectory,
  ConversationPlace,
  ConversationRef,
  ConversationRegistry,
  JsonValue,
  ModelComplete,
  ObservedConversation,
  SqlDatabase,
  WakeupHandler,
  Wakeups,
} from "@pikit/contracts";
import { createConversationDirectoryConformance, createMemoryMailbox, createMemoryWakeups, type ConversationDirectorySubject } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import conversationsDirectory, { FLUSH, INDEX_KEY, OUTBOX, SEEN } from "./index.ts";

type Layout = "all" | "one";

/** What outlives an App of a test: the registry's records, the runtime's conversations, the database. */
function world() {
  return {
    storage: sqliteStorage(),
    pointers: new Map<string, { conversationId: string; agent: string; place: ConversationPlace }>(),
    conversations: new Map<string, ObservedConversation & { key: string; agent: string }>(),
    origins: new Set<string>(),
    ids: 0,
    seen: [] as JsonValue[],
  };
}
type World = ReturnType<typeof world>;

/** `conversations.registry` over `w.pointers` (owner and space kept for good), emitting `conversation.reset`; and a runtime's `agent.observe`. */
function runtimeDouble(w: World): ComponentDefinition {
  return defineComponent({
    name: "runtime-double",
    setup(pikit) {
      const refOf = (key: string): ConversationRef | undefined => {
        const record = w.pointers.get(key);
        if (record === undefined) return undefined;
        const { channel, space, owner } = record.place;
        return { key, agent: record.agent, conversationId: record.conversationId, channel, ...(space !== undefined && { space }), ...(owner !== undefined && { owner }) };
      };
      const create = (key: string, agent: string) => {
        const conversationId = `c${++w.ids}`;
        w.conversations.set(conversationId, { conversationId, key, agent, busy: false, usage: {} as never });
        return conversationId;
      };
      const registry: ConversationRegistry = {
        async resolve(key, agent, place) {
          if (!w.pointers.has(key)) w.pointers.set(key, { conversationId: create(key, agent), agent, place: { ...place } });
          return refOf(key) as ConversationRef;
        },
        get: async (key) => refOf(key),
        async reset(key, agent, ctx) {
          const record = w.pointers.get(key);
          if (record === undefined) return undefined;
          const previousConversationId = record.conversationId;
          record.conversationId = create(key, agent ?? record.agent);
          const conversation = refOf(key) as ConversationRef;
          const reset = { conversation, previousConversationId, newConversationId: record.conversationId };
          await ctx.emit("conversation.reset", reset);
          return reset;
        },
      };
      const observe: AgentObserver = {
        async conversations() {
          return { items: [...w.conversations.values()].filter((each) => each.lastActivity !== undefined) };
        },
        conversation: async (id) => w.conversations.get(id),
        transcript: async () => undefined,
        usage: async () => undefined,
        watch: () => (async function* () {})(),
      };
      pikit.provide("conversations.registry", registry);
      pikit.provide("agent.observe", observe);
    },
  });
}

/** `component` with its `actor.inbox` reporting `scope` and its `actor.mailbox`'s sends of `seen` recorded in `w.seen`. */
function actorsAs(component: ComponentDefinition, scope: "all" | "one", w: World): ComponentDefinition {
  return defineComponent({
    name: component.name,
    setup(pikit) {
      const proxy = new Proxy(pikit, {
        get(target, property) {
          if (property === "provide")
            return (name: string, value: unknown) => {
              if (name === "actor.inbox") {
                const inbox = value as ActorInbox;
                return target.provide("actor.inbox", { scope, handle: inbox.handle.bind(inbox), answer: inbox.answer.bind(inbox), answerStream: inbox.answerStream.bind(inbox) });
              }
              if (name === "actor.mailbox") {
                const mailbox = value as ActorMailbox;
                return target.provide("actor.mailbox", {
                  send: (key, type, message, ctx) => {
                    if (type === SEEN) w.seen.push(message);
                    return mailbox.send(key, type, message, ctx);
                  },
                  call: mailbox.call.bind(mailbox),
                  stream: mailbox.stream.bind(mailbox),
                });
              }
              return target.provide(name as never, value as never);
            };
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return component.setup(proxy as Pikit, undefined as never);
    },
  });
}

/** `wakeups` that run only when the test fires them: what is asked, and by whom. */
function manualWakeups() {
  const handlers = new Map<string, WakeupHandler>();
  const asked = new Set<string>();
  let ctx: AppContext | undefined;
  const component = defineComponent({
    name: "manual-wakeups",
    setup(pikit) {
      pikit.provide("wakeups", {
        handle: (name, handler) => void handlers.set(name, handler),
        at: async (name) => void asked.add(name),
        cancel: async (name) => void asked.delete(name),
      } satisfies Wakeups);
      return { start: (startCtx) => void (ctx = startCtx) };
    },
  });
  return {
    component,
    asked,
    async fire(name: string) {
      asked.delete(name);
      await (handlers.get(name) as WakeupHandler)(ctx as AppContext);
    },
  };
}

interface Opened {
  app: App;
  ctx: AppContext;
  directory: ConversationDirectory;
  registry: ConversationRegistry;
  sql: SqlDatabase;
  mailbox?: ActorMailbox;
}

/** An App of conversations-directory in `layout` over `w`, with `extra` components. */
async function openApp(w: World, layout: Layout, clock: ReturnType<typeof createManualClock>, extra: readonly ComponentDefinition[] = [], options: { wakeups?: ComponentDefinition; config?: Record<string, unknown> } = {}): Promise<Opened> {
  const handles: { directory?: Handle<ConversationDirectory>; registry?: Handle<ConversationRegistry>; sql?: Handle<SqlDatabase>; mailbox?: Handle<ActorMailbox | undefined> } = {};
  const consumer = defineComponent({
    name: "directory-consumer",
    setup(pikit) {
      handles.directory = pikit.use("conversations.directory");
      handles.registry = pikit.use("conversations.registry");
      handles.sql = pikit.use("storage.sql");
      handles.mailbox = pikit.useOptional("actor.mailbox");
    },
  });
  const actors = layout === "one" ? [actorsAs(createMemoryMailbox(), "one", w), options.wakeups ?? createMemoryWakeups()] : [];
  const app = await defineApp({
    components: [w.storage, runtimeDouble(w), ...actors, ...extra, conversationsDirectory, consumer],
    config: options.config ?? {},
    clock,
    logger: silentLogger,
  }).create();
  await app.start();
  const mailbox = handles.mailbox?.get();
  return { app, ctx: app.context(), directory: handles.directory?.get() as ConversationDirectory, registry: handles.registry?.get() as ConversationRegistry, sql: handles.sql?.get() as SqlDatabase, ...(mailbox !== undefined && { mailbox }) };
}

/** Resolves once the outbox is empty: every update is with the directory (on a server, at once). */
async function flushed(opened: Opened, layout: Layout): Promise<void> {
  if (layout === "all") return;
  for (let tries = 0; tries < 2_000; tries++) {
    const rows = await opened.sql.query<{ n: number }>(`SELECT count(*) AS n FROM ${OUTBOX}`).catch(() => [{ n: 0 }]);
    if (Number(rows[0]?.n ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the outbox was never flushed");
}

/** The suite's subject over an App in `layout`. */
async function subjectOf(layout: Layout, components: readonly ComponentDefinition[]): Promise<ConversationDirectorySubject> {
  const w = world();
  const clock = createManualClock();
  let opened = await openApp(w, layout, clock, components);
  const conversationOf = (ref: { key: string; conversationId: string }): ConversationRef => {
    const known = w.conversations.get(ref.conversationId);
    const record = w.pointers.get(ref.key);
    const base: ConversationRef = { key: ref.key, agent: known?.agent ?? record?.agent ?? "assistant", conversationId: ref.conversationId, ...(record !== undefined && { channel: record.place.channel }) };
    return w.origins.has(ref.conversationId) ? { ...base, origin: { key: "web:origin", agent: base.agent, conversationId: "origin" } } : base;
  };
  const touch = (conversationId: string) => {
    const known = w.conversations.get(conversationId);
    if (known !== undefined) known.lastActivity = clock.now();
  };
  return {
    get directory() {
      return opened.directory;
    },
    ctx: opened.ctx,
    advance: (ms) => clock.advance(ms),
    async message(key, message) {
      const { agent, channel, space, owner, delegated } = message.place;
      const ref = await opened.registry.resolve(key, agent, { channel, ...(space !== undefined && { space }), ...(owner !== undefined && { owner }) }, opened.ctx);
      if (delegated === true) w.origins.add(ref.conversationId);
      touch(ref.conversationId);
      await opened.ctx.emit("agent.dispatched", {
        conversation: conversationOf(ref),
        admission: { kind: message.duplicate === true ? "duplicate" : "queued", requestId: message.requestId },
        ...(message.sender !== undefined && { sender: message.sender }),
      });
      await flushed(opened, layout);
      return { key, conversationId: ref.conversationId };
    },
    async started(ref, requestId) {
      await opened.ctx.emit("agent.started", { conversation: conversationOf(ref), requestId, resumed: false });
      await flushed(opened, layout);
    },
    async settled(ref, requestIds, kind = "completed") {
      touch(ref.conversationId);
      const result = { conversation: conversationOf(ref), requestId: requestIds[0] ?? "", requestIds: [...requestIds], messages: [] };
      if (kind === "failed") await opened.ctx.emit("agent.failed", { ...result, kind });
      else await opened.ctx.emit("agent.settled", { ...result, kind });
      await flushed(opened, layout);
    },
    async reset(key) {
      const reset = await opened.registry.reset(key, undefined, opened.ctx);
      if (reset === undefined) throw new Error(`no conversation for ${key}`);
      await flushed(opened, layout);
      return { key, conversationId: reset.newConversationId };
    },
    ...(layout === "one" && {
      // Every `seen` the flushes sent, again, newest first (and each one's updates newest first).
      async replay() {
        for (const message of [...w.seen].reverse()) {
          const updates = [...((message as { updates: JsonValue[] }).updates ?? [])].reverse();
          await (opened.mailbox as ActorMailbox).send(INDEX_KEY, SEEN, { updates }, opened.ctx);
        }
      },
    }),
    async restart() {
      await opened.app.stop();
      opened = await openApp(w, layout, clock, components);
      return opened.directory;
    },
    close: () => opened.app.stop(),
  };
}

for (const layout of ["all", "one"] as const) {
  for (const c of createConversationDirectoryConformance((options) => subjectOf(layout, options.components))) {
    test(`conversations-directory (${layout === "all" ? "a server" : "one key's actor"}) ${c.group}: ${c.name}`, () => c.run(), 30_000);
  }
}

const ANA = { channel: "web", id: "u-ana" };
const OPERATOR = { kind: "operator", id: "op-1" } as const;

/** A message to `key` (Ana's web chat), its run started and ended, emitted as the runtime does. */
async function talk(opened: Opened, w: World, key: string, requestId: string, options: { text?: string; operator?: boolean } = {}) {
  const ref = await opened.registry.resolve(key, "assistant", { channel: "web", owner: ANA }, opened.ctx);
  const known = w.conversations.get(ref.conversationId);
  if (known !== undefined) known.lastActivity = opened.ctx.clock.now();
  const sender = options.operator === true ? { channel: "dashboard", id: "op-1" } : ANA;
  await opened.ctx.emit("agent.dispatched", { conversation: ref, admission: { kind: "started", requestId }, sender });
  await opened.ctx.emit("agent.started", { conversation: ref, requestId, resumed: false });
  const messages = [{ role: "user", content: [{ type: "text", text: options.text ?? "hello" }] }] as never[];
  await opened.ctx.emit("agent.settled", { conversation: ref, requestId, requestIds: [requestId], kind: "completed", messages });
  return ref;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let tries = 0; tries < 2_000; tries++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("one key's actor: a message's events cost no seen on their path; the flush sends them as one seen, one merged update", async () => {
  const w = world();
  const wakeups = manualWakeups();
  const opened = await openApp(w, "one", createManualClock(), [], { wakeups: wakeups.component });
  try {
    const ref = await talk(opened, w, "web:u-ana:1", "r-1");
    expect(w.seen).toEqual([]);
    expect([...wakeups.asked]).toEqual([FLUSH]);
    expect(await opened.sql.query(`SELECT key, conversation FROM ${OUTBOX}`)).toEqual([{ key: ref.key, conversation: ref.conversationId }]);
    expect((await opened.directory.list(OPERATOR, {}, opened.ctx)).items).toEqual([]);

    await wakeups.fire(FLUSH);
    expect(w.seen.length).toBe(1);
    const [update] = (w.seen[0] as { updates: { busy: boolean; activity: { id: string; by: string }[]; place: { owner: unknown } }[] }).updates;
    expect(update?.busy).toBe(false);
    expect(update?.activity.map((each) => [each.id, each.by])).toEqual([
      ["m:r-1", "web:u-ana"],
      ["r:r-1", "agent"],
    ]);
    expect(update?.place.owner).toEqual(ANA);
    expect(await opened.sql.query(`SELECT key FROM ${OUTBOX}`)).toEqual([]);
    const [entry] = (await opened.directory.list({ kind: "people", principals: [ANA] }, {}, opened.ctx)).items;
    expect(entry).toMatchObject({ key: ref.key, conversationId: ref.conversationId, owner: ANA, busy: false, state: "listed", role: "owner" });

    // A flush with nothing in the outbox sends nothing.
    await wakeups.fire(FLUSH);
    expect(w.seen.length).toBe(1);
  } finally {
    await opened.app.stop();
  }
});

test("one key's actor: it refuses to start without wakeups (it could never tell the directory)", async () => {
  const w = world();
  const app = await defineApp({ components: [w.storage, runtimeDouble(w), actorsAs(createMemoryMailbox(), "one", w), conversationsDirectory], logger: silentLogger }).create();
  await expect(app.start()).rejects.toThrow("conversations-directory");
});

test("the titler: once, after the first completed run a person started, from the first title's text; never for an operator's run, nor over a rename", async () => {
  const w = world();
  const prompts: string[] = [];
  const model = defineComponent({
    name: "model-double",
    setup(pikit) {
      pikit.provide("model.complete", {
        async complete(request) {
          prompts.push(`${request.model} ${request.prompt}`);
          return 'Title: "Lisbon trip."';
        },
      } satisfies ModelComplete);
      pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "faux/agent", prompt: "" } as never);
    },
  });
  const opened = await openApp(w, "all", createManualClock(), [model]);
  try {
    // An operator's own run: no title.
    const quiet = await talk(opened, w, "web:u-ana:quiet", "dashboard:op-1:1", { operator: true });
    // A person's: the first title's text, given by the channel, is what the model titles.
    const ref = await opened.registry.resolve("web:u-ana:1", "assistant", { channel: "web", owner: ANA }, opened.ctx);
    await opened.directory.title(ref, { text: "plan the trip to Lisbon", source: "first" }, opened.ctx);
    await talk(opened, w, "web:u-ana:1", "r-1", { text: "[the channel's prefix] plan the trip" });
    const titled = await until(() => opened.directory.access(OPERATOR, ref, opened.ctx), (entry) => entry?.titleSource === "model", "the model's title");
    expect(titled?.title).toBe("Lisbon trip");
    expect(prompts).toEqual(["faux/agent plan the trip to Lisbon"]);
    await talk(opened, w, "web:u-ana:1", "r-2");
    // Renamed before its first run: no model call.
    const renamed = await opened.registry.resolve("web:u-ana:2", "assistant", { channel: "web", owner: ANA }, opened.ctx);
    await opened.ctx.emit("agent.dispatched", { conversation: renamed, admission: { kind: "started", requestId: "r-3" }, sender: ANA });
    await opened.directory.rename(OPERATOR, renamed, "Mine", opened.ctx);
    await talk(opened, w, "web:u-ana:2", "r-4");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual(["faux/agent plan the trip to Lisbon"]);
    expect((await opened.directory.access(OPERATOR, quiet, opened.ctx))?.title).toBeUndefined();
    expect((await opened.directory.access(OPERATOR, renamed, opened.ctx))?.title).toBe("Mine");
  } finally {
    await opened.app.stop();
  }
});

test("the start's backfill: a conversation the runtime holds and no event told is listed with its place; nothing new costs no seen", async () => {
  for (const layout of ["all", "one"] as const) {
    const w = world();
    w.pointers.set("web:u-ana:old", { conversationId: "c-old", agent: "assistant", place: { channel: "web", owner: ANA, space: "project:p1" } });
    w.conversations.set("c-old", { conversationId: "c-old", key: "web:u-ana:old", agent: "assistant", busy: false, lastActivity: 1_600_000_000_000, usage: {} as never });
    const clock = createManualClock();
    const first = await openApp(w, layout, clock);
    try {
      const [entry] = (await until(() => first.directory.list({ kind: "people", principals: [ANA] }, {}, first.ctx), (page) => page.items.length === 1, "the backfilled conversation")).items;
      expect(entry).toMatchObject({ key: "web:u-ana:old", conversationId: "c-old", channel: "web", space: "project:p1", owner: ANA, current: true, lastActivity: 1_600_000_000_000, role: "owner" });
      expect(entry?.mine?.unread).toBe(0);
    } finally {
      await first.app.stop();
    }
    const sent = w.seen.length;
    const second = await openApp(w, layout, clock);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await second.app.stop();
    expect({ layout, seen: w.seen.length }).toEqual({ layout, seen: sent });
  }
});
