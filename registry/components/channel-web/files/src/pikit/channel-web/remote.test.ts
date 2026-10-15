/**
 * channel-web on Cloudflare, with a fake platform: every key is an "object", an App of its own running
 * the default export on the `durable` target (its runtime a double, its `storage.sql` SQLite), reached
 * through an `actor.mailbox` that calls its `actor.inbox` handlers with JSON copies, as actors-do's
 * RPC does. The Worker's half serves the routes over them; the accounts actor (`channel-web:accounts`)
 * keeps the users' index. The workerd lane runs the same on real Durable Objects, with the real
 * accounts (`tests/workerd/test/channel-web.workerd.ts`).
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import {
  ActorCallError,
  type ActorCallHandler,
  type ActorInboxHandler,
  type ActorMailbox,
  type ActorStreamHandler,
  answerCall,
  answerStream,
  callResult,
  type JsonValue,
  streamResult,
} from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { type ChatConversation, type ChatMessage, MAX_DURABLE_IMAGE_BYTES } from "./api.ts";
import { ACCOUNTS_KEY, CALL, SEEN } from "./calls.ts";
import { createChannelWeb, NAME } from "./index.ts";
import { adminAuth, eventually, FakeAccounts, imageOf, kvOf, OPERATOR, PIXEL, Runtime, router, type Served, secretsOf, serve, sse } from "./runtime.test-support.ts";
import { createChannelWebWorker } from "./worker.ts";

const copy = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

interface FakeObject {
  app: App;
  runtime: Runtime;
  answers: Map<string, ActorCallHandler>;
  handlers: Map<string, ActorInboxHandler>;
  streams: Map<string, ActorStreamHandler>;
  ctx: AppContext;
}

/** The objects, by key, each started at its first message or call, as Durable Objects are. */
class Platform {
  readonly objects = new Map<string, Promise<FakeObject>>();
  readonly calls: string[] = [];
  readonly unreachable = new Set<string>();
  /** Each object's runtime ends a started run before its dispatch returns (`Runtime.runsAtOnce`). */
  runsAtOnce = false;
  constructor(
    readonly accounts: FakeAccounts,
    /** channel-web's config in every object's App (the default App's). */
    readonly config: Record<string, unknown> = {},
  ) {}

  readonly mailbox: ActorMailbox = {
    send: async (key, type, message) => {
      this.calls.push(`${key} ${type}`);
      const object = await this.object(key);
      const handler = object.handlers.get(type);
      if (handler === undefined) throw new Error(`no handler for ${type}`);
      await handler(key, copy(message), object.ctx);
    },
    call: async (key, type, message) => {
      this.calls.push(`${key} ${type}`);
      if (this.unreachable.has(key)) throw new ActorCallError("unreachable", `the object of "${key}" could not be reached`);
      const object = await this.object(key);
      const handler = object.answers.get(type);
      if (handler === undefined) throw new ActorCallError("no_handler", `no answer handler for ${type}`);
      return callResult(await answerCall(handler, key, copy(message), object.ctx));
    },
    stream: async (key, type, message, ctx) => {
      this.calls.push(`${key} ${type}`);
      if (this.unreachable.has(key)) throw new ActorCallError("unreachable", `the object of "${key}" could not be reached`);
      const object = await this.object(key);
      const handler = object.streams.get(type);
      if (handler === undefined) throw new ActorCallError("no_handler", `no stream handler for ${type}`);
      return streamResult(await answerStream(handler, key, copy(message), object.ctx), ctx.abortSignal);
    },
  };

  object(key: string): Promise<FakeObject> {
    let found = this.objects.get(key);
    if (found === undefined) {
      found = this.start(key);
      this.objects.set(key, found);
    }
    return found;
  }

  private async start(_key: string): Promise<FakeObject> {
    const runtime = new Runtime(String);
    runtime.runsAtOnce = this.runsAtOnce;
    const answers = new Map<string, ActorCallHandler>();
    const handlers = new Map<string, ActorInboxHandler>();
    const streams = new Map<string, ActorStreamHandler>();
    const platform = defineComponent({
      name: "platform-test",
      setup: (pikit) => {
        pikit.provide("actor.inbox", {
          scope: "one",
          handle: (type, handler) => void handlers.set(type, handler),
          answer: (type, handler) => void answers.set(type, handler),
          answerStream: (type, handler) => void streams.set(type, handler),
        });
        pikit.provide("actor.mailbox", this.mailbox);
      },
    });
    const app = await defineApp({
      components: [secretsOf(), runtime.component(), kvOf(), sqliteStorage(), router, platform, createChannelWeb({ accounts: this.accounts.wiring() })],
      config: { [NAME]: this.config },
      target: "durable",
      logger: silentLogger,
    }).create();
    await app.start();
    return { app, runtime, answers, handlers, streams, ctx: app.context() };
  }

  async stop(): Promise<void> {
    for (const object of this.objects.values()) await (await object).app.stop();
  }
}

const platforms: Platform[] = [];
const workers: Served[] = [];
afterEach(async () => {
  for (const served of workers.splice(0)) await served.app.stop();
  for (const platform of platforms.splice(0)) await platform.stop();
});

async function cloud(config: Record<string, unknown> = {}): Promise<{ platform: Platform; worker: Served; accounts: FakeAccounts }> {
  const accounts = new FakeAccounts();
  accounts.add("ana");
  accounts.add("ben");
  const platform = new Platform(accounts, config);
  platforms.push(platform);
  const mailbox = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", platform.mailbox) });
  const served = await serve([secretsOf(), mailbox, adminAuth, createChannelWebWorker(accounts.wiring())], {}, "durable");
  workers.push(served);
  return { platform, worker: served, accounts };
}

const as = (user: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...FakeAccounts.session(user), "x-pikit-chat": "1", "content-type": "application/json" },
});
const post = (user: string, body: unknown, method = "POST"): RequestInit => as(user, { method, body: JSON.stringify(body) });
const API = "/chat/api";

test("a conversation on the Worker: started by one call to its key's object, listed at once from the accounts actor's index (one call), read, renamed, its messages from its object", async () => {
  const { platform, worker: w } = await cloud();
  const started = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "plan the trip", images: [{ mimeType: "image/png", data: PIXEL }] }))).json()) as { id: string; requestId: string; admission: string };
  const key = `web:ana:${started.id}`;
  expect(started.admission).toBe("started");
  // The user's message counted by the accounts actor first, then the conversation's object.
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.rate}`, `${key} ${CALL.start}`, `${ACCOUNTS_KEY} ${SEEN}`]);
  const { runtime } = await platform.object(key);
  expect(runtime.dispatched).toMatchObject([{ requestId: started.requestId, conversation: { key, conversationId: "1" }, sender: { channel: "web", id: "ana" }, images: [{ mimeType: "image/png", data: PIXEL }] }]);

  platform.calls.length = 0;
  const listed = (await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] };
  expect(listed.items).toMatchObject([{ id: started.id, title: "plan the trip", busy: true }]);
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.list}`]);

  const renamed = await w.fetch(`${API}/conversations/${started.id}`, post("ana", { title: "Trip" }, "PATCH"));
  expect(await renamed.json()).toMatchObject({ id: started.id, title: "Trip" });
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items[0]?.title).toBe("Trip");

  await runtime.start(key, [started.requestId]);
  await runtime.end(key, [started.requestId], { text: "Here is a plan" });
  const messages = await eventually(async () => {
    const read = (await (await w.fetch(`${API}/conversations/${started.id}/messages`, as("ana"))).json()) as { items: ChatMessage[] };
    return read.items.length === 2 ? read.items : undefined;
  }, "the answer in the object");
  const url = `/chat/api/conversations/${started.id}/messages/${encodeURIComponent(started.requestId)}/images/0`;
  expect(messages).toMatchObject([
    { role: "assistant", text: "Here is a plan" },
    { id: started.requestId, role: "user", state: "answered", images: [{ mimeType: "image/png", url }] },
  ]);
  // Its bytes one call to its object, apart from the page.
  platform.calls.length = 0;
  const image = await w.fetch(url, as("ana"));
  expect([image.status, image.headers.get("content-type"), Buffer.from(await image.arrayBuffer()).toString("base64")]).toEqual([200, "image/png", PIXEL]);
  expect(platform.calls).toEqual([`${key} ${CALL.image}`]);
  // The index was told the run ended and the answer came: busy no more.
  await eventually(async () => (((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items[0]?.busy === false ? true : undefined), "the index's busy flag");

  // Archived by one call to its object, which tells the index: listed apart; unarchived, back.
  platform.calls.length = 0;
  const archived = await w.fetch(`${API}/conversations/${started.id}/archive`, as("ana", { method: "POST" }));
  expect(await archived.json()).toMatchObject({ id: started.id, archived: true });
  expect(platform.calls).toEqual([`${key} ${CALL.archive}`, `${ACCOUNTS_KEY} ${SEEN}`]);
  expect(await (await w.fetch(`${API}/conversations`, as("ana"))).json()).toEqual({ items: [] });
  expect(((await (await w.fetch(`${API}/conversations?archived=1`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id: started.id, archived: true }]);
  expect(await (await w.fetch(`${API}/conversations/${started.id}/unarchive`, as("ana", { method: "POST" }))).json()).toMatchObject({ id: started.id, archived: false });
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id: started.id, archived: false }]);
  // Archived again, a message lists it again.
  await w.fetch(`${API}/conversations/${started.id}/archive`, as("ana", { method: "POST" }));
  expect((await w.fetch(`${API}/conversations/${started.id}/messages`, post("ana", { text: "more" }))).status).toBe(202);
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id: started.id, archived: false }]);

  expect((await w.fetch(`${API}/conversations/${started.id}`, as("ana", { method: "DELETE" }))).status).toBe(204);
  expect(await (await w.fetch(`${API}/conversations`, as("ana"))).json()).toEqual({ items: [] });
  expect((await w.fetch(`${API}/conversations/${started.id}/messages`, as("ana"))).status).toBe(404);
});

// Found in a browser on a durable project with faux/scripted: the list said "Running" for good.
test("a run that ends before its object's admission returns: the accounts actor's index says not busy", async () => {
  const { platform, worker: w } = await cloud();
  platform.runsAtOnce = true;
  const busy = async () => (((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items.map((each) => each.busy));
  const started = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "quick" }))).json()) as { id: string };
  expect(await busy()).toEqual([false]);
  await w.fetch(`${API}/conversations/${started.id}/messages`, post("ana", { text: "again" }));
  expect(await busy()).toEqual([false]);
});

test("ISOLATION on the Worker: user B with user A's chat id gets 404 on every route; A's object is never called", async () => {
  const { platform, worker: w } = await cloud();
  const { id } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "secret" }))).json()) as { id: string };
  platform.calls.length = 0;
  const attempts: [string, string, unknown?][] = [
    ["GET", ""],
    ["PATCH", "", { title: "mine" }],
    ["POST", "/archive"],
    ["POST", "/unarchive"],
    ["DELETE", ""],
    ["GET", "/messages"],
    ["POST", "/messages", { text: "hi" }],
    ["GET", "/events"],
    ["POST", "/abort"],
    ["GET", "/messages/web%3Ax/images/0"],
  ];
  for (const [method, path, body] of attempts) {
    const response = await w.fetch(`${API}/conversations/${id}${path}`, as("ben", { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
  }
  expect(platform.calls.filter((each) => each !== `${ACCOUNTS_KEY} ${CALL.rate}`).every((each) => each.startsWith(`web:ben:${id} `))).toBe(true);
  expect((await platform.object(`web:ana:${id}`)).runtime.dispatched.length).toBe(1);
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id, archived: false }]);
  // An object answers only of itself: a call naming another conversation is refused.
  const other = await platform.mailbox.call(`web:ben:${id}`, CALL.conversation, { userId: "ana", chatId: id }, w.app.context()).catch((error: unknown) => error);
  expect((other as ActorCallError).code).toBe("invalid_request");
});

test("live events on the Worker: the object's stream, state first, the answer as written while the user waits; the client leaving closes it in the object", async () => {
  const { platform, worker: w } = await cloud();
  const { id, requestId } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${id}`;
  const { runtime } = await platform.object(key);
  const client = new AbortController();
  const events = sse(await w.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "state", busy: false }]);
  await runtime.start(key, [requestId]);
  runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "He" }] } });
  expect(await events.take(2)).toEqual([
    { type: "state", busy: true },
    { type: "partial", text: "He", requests: [requestId] },
  ]);
  client.abort();
  await events.reader.cancel();
  for (let i = 0; i < 50 && runtime.released < runtime.watching; i++) await Bun.sleep(5);
  expect([runtime.watching, runtime.released]).toEqual([1, 1]);
});

test("message events on the Worker come from the conversation's object: its answer (naming the request it answers) and a run end found by the page's read", async () => {
  const { platform, worker: w } = await cloud();
  const { id, requestId } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${id}`;
  const { runtime } = await platform.object(key);
  const client = new AbortController();
  const events = sse(await w.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "state", busy: false }]);
  await runtime.end(key, [requestId], { text: "Hello" });
  const seen = await events.take(2);
  expect(seen).toContainEqual({ type: "message", id: requestId });
  expect(seen).toContainEqual({ type: "message", id: `1:${requestId}#0`, answers: requestId });

  const sent = (await (await w.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "again" }))).json()) as { requestId: string };
  expect(await events.take(1)).toEqual([{ type: "message", id: sent.requestId }]);
  await runtime.end(key, [sent.requestId], { kind: "aborted", quiet: true });
  expect(((await (await w.fetch(`${API}/conversations/${id}/messages`, as("ana"))).json()) as { items: ChatMessage[] }).items[0]).toMatchObject({ id: sent.requestId, state: "aborted" });
  expect(await events.take(1)).toEqual([{ type: "message", id: sent.requestId }]);
  client.abort();
  await events.reader.cancel();
});

test("on the Worker images over 1 MB in all are 413 before any call; an object that cannot be reached is 503", async () => {
  const { platform, worker: w } = await cloud();
  const big = await w.fetch(`${API}/conversations`, post("ana", { text: "x", images: [imageOf(MAX_DURABLE_IMAGE_BYTES / 2), imageOf(MAX_DURABLE_IMAGE_BYTES / 2 + 1)] }));
  expect(big.status).toBe(413);
  // Counted by the accounts actor (before its body is read), never sent to an object.
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.rate}`]);
  const { id } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string };
  platform.unreachable.add(`web:ana:${id}`);
  const down = await w.fetch(`${API}/conversations/${id}`, as("ana"));
  expect({ status: down.status, body: await down.json() }).toMatchObject({ status: 503, body: { error: "unavailable" } });
});

test("RATE on the Worker: a user's messages are counted by the accounts actor, every conversation together; one too many is 429 with retry-after; another user is not", async () => {
  const { platform, worker: w } = await cloud({ messagesPerMinute: 2 });
  const first = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "one" }))).json()) as { id: string };
  expect((await w.fetch(`${API}/conversations`, post("ana", { text: "two" }))).status).toBe(201);
  const calls = platform.calls.length;
  const third = await w.fetch(`${API}/conversations/${first.id}/messages`, post("ana", { text: "three" }));
  expect({ status: third.status, retry: Number(third.headers.get("retry-after")), body: await third.json() }).toMatchObject({ status: 429, retry: expect.any(Number), body: { error: "rate_limited" } });
  expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  // Refused before its conversation's object hears of it.
  expect(platform.calls.slice(calls)).toEqual([`${ACCOUNTS_KEY} ${CALL.rate}`]);
  expect((await platform.object(`web:ana:${first.id}`)).runtime.dispatched.length).toBe(1);
  expect((await w.fetch(`${API}/conversations`, post("ben", { text: "mine" }))).status).toBe(201);
});

test("only the accounts actor answers the index's calls: a conversation's object refuses them (no_handler) and reads nothing", async () => {
  const { platform, worker: w } = await cloud();
  const { id } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string };
  const key = `web:ana:${id}`;
  for (const [type, message] of [
    [CALL.list, { userId: "ana", limit: 10 }],
    [CALL.forget, { userId: "ana" }],
    [CALL.config, {}],
    [CALL.rate, { userId: "ana" }],
  ] as const) {
    const refused = await platform.mailbox.call(key, type, message, w.app.context()).catch((error: unknown) => error);
    expect({ type, code: (refused as ActorCallError).code }).toEqual({ type, code: "no_handler" });
  }
  const seen = await platform.mailbox.send(key, SEEN, { rows: [] }, w.app.context()).catch((error: unknown) => error);
  expect((seen as ActorCallError).code).toBe("no_handler");
  // The accounts actor answers them.
  expect(await platform.mailbox.call(ACCOUNTS_KEY, CALL.list, { userId: "ana", limit: 10 }, w.app.context())).toMatchObject({ items: [{ id }] });
});

test("the index keeps each conversation's newest version: a late or repeated one changes nothing; a row whose key is not its user's is refused", async () => {
  const { platform } = await cloud();
  const index = await platform.object(ACCOUNTS_KEY);
  const chatId = crypto.randomUUID();
  const row = { key: `web:ana:${chatId}`, userId: "ana", chatId, title: "new", createdAt: 1, lastActivity: 5, hidden: false, archived: false, busy: false, version: 3 };
  await platform.mailbox.send(ACCOUNTS_KEY, SEEN, { rows: [row] }, index.ctx);
  await platform.mailbox.send(ACCOUNTS_KEY, SEEN, { rows: [{ ...row, title: "old", version: 2 }] }, index.ctx);
  const listed = callResult(await answerCall(index.answers.get(CALL.list) as ActorCallHandler, ACCOUNTS_KEY, { userId: "ana", limit: 10 }, index.ctx)) as unknown as { items: ChatConversation[] };
  expect(listed.items).toMatchObject([{ id: chatId, title: "new" }]);
  const forged = await platform.mailbox.send(ACCOUNTS_KEY, SEEN, { rows: [{ ...row, userId: "ben", version: 9 }] }, index.ctx).catch((error: unknown) => error);
  expect((forged as ActorCallError).code).toBe("invalid_request");
});

test("an operator removing a user on the Worker: their accounts, then their conversations leave the index (one call to the accounts actor)", async () => {
  const { platform, worker: w, accounts } = await cloud();
  await w.fetch(`${API}/conversations`, post("ben", { text: "hi" }));
  platform.calls.length = 0;
  const removed = await w.fetch("/admin/api/channel-web/users/ben", { method: "DELETE", headers: OPERATOR });
  expect(removed.status).toBe(204);
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.forget}`]);
  accounts.add("ben");
  expect(await (await w.fetch(`${API}/conversations`, as("ben"))).json()).toEqual({ items: [] });
});

test("in an App that is one key's actor without actor.mailbox, its start says so", async () => {
  const inbox = defineComponent({ name: "inbox-test", setup: (pikit) => pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: () => {}, answerStream: () => {} }) });
  const app = await defineApp({
    components: [secretsOf(), new Runtime().component(), kvOf(), sqliteStorage(), router, inbox, createChannelWeb({ accounts: new FakeAccounts().wiring() })],
    config: { [NAME]: {} },
    logger: silentLogger,
  }).create();
  const failed = (await app.start().catch((error: unknown) => error)) as Error;
  expect(String(failed.cause)).toContain("needs actor.mailbox");
});

test("the Worker refuses to start without CHANNEL_WEB_AUTH_SECRET", async () => {
  const mailbox = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", new Platform(new FakeAccounts()).mailbox) });
  const app = await defineApp({ components: [secretsOf({}), mailbox, createChannelWebWorker(new FakeAccounts().wiring())], logger: silentLogger, target: "durable" }).create();
  const failed = (await app.start().catch((error: unknown) => error)) as Error;
  expect(String(failed.cause)).toContain("CHANNEL_WEB_AUTH_SECRET");
});
