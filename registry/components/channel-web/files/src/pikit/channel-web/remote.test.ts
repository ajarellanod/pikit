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
  describeConversation,
  type JsonValue,
  streamResult,
} from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { type ChatConfig, type ChatConversation, type ChatEvent, type ChatTranscriptEntry, MAX_DURABLE_IMAGE_BYTES } from "./api.ts";
import { ACCOUNTS_KEY, CALL, SEEN } from "./calls.ts";
import { runEntryId } from "./entries.ts";
import { createChannelWeb, NAME } from "./index.ts";
import { adminAuth, answerOf, eventually, FakeAccounts, imageOf, kvOf, OPERATOR, PIXEL, Runtime, router, type Served, secretsOf, serve, sse } from "./runtime.test-support.ts";
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
  /** The `/rules` command each object's App has, as it ran: in which conversation and space, for whom. */
  readonly ran: { key: string; space?: string; args: string; sender?: string }[] = [];
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
    // The App's agents: users may pick `helper` when the config lets them.
    const agents = defineComponent({
      name: "agents-test",
      setup: (pikit) => {
        pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "test/model" });
        pikit.provideKeyed("agent.definition", "helper", { name: "helper", model: "test/model" });
        pikit.provideKeyed("agent.command", "rules", {
          description: "Your rules",
          run: async (conversation, args, _ctx, sender) => {
            this.ran.push({ key: conversation.key, ...(conversation.space !== undefined && { space: conversation.space }), args, ...(sender !== undefined && { sender: sender.id }) });
            return { text: `kept: ${args}` };
          },
        });
      },
    });
    const app = await defineApp({
      components: [secretsOf(), runtime.component(), kvOf(), sqliteStorage(), router, agents, platform, createChannelWeb({ accounts: this.accounts.wiring() })],
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
const transcriptOf = async (w: Served, user: string, id: string): Promise<ChatTranscriptEntry[]> =>
  ((await (await w.fetch(`${API}/conversations/${id}/transcript`, as(user))).json()) as { items: ChatTranscriptEntry[] }).items;

test("a conversation on the Worker: started by one call to its key's object, listed at once from the accounts actor's index (one call), read, renamed, its transcript from its object", async () => {
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
  expect(listed.items).toMatchObject([{ id: started.id, title: "Plan the trip", busy: true }]);
  // The index, and the policy (kept by the Worker `CONFIG_CACHE_MS`: the next lists ask the index only).
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.list}`, `${ACCOUNTS_KEY} ${CALL.config}`]);
  platform.calls.length = 0;
  await w.fetch(`${API}/conversations`, as("ana"));
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.list}`]);

  const renamed = await w.fetch(`${API}/conversations/${started.id}`, post("ana", { title: "Trip" }, "PATCH"));
  expect(await renamed.json()).toMatchObject({ id: started.id, title: "Trip" });
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items[0]?.title).toBe("Trip");

  await runtime.start(key, [started.requestId]);
  await runtime.end(key, [started.requestId], { text: "Here is a plan" });
  const entries = await eventually(async () => {
    const read = await transcriptOf(w, "ana", started.id);
    return read.length === 2 ? read : undefined;
  }, "the run's messages in the object");
  const url = `/chat/api/conversations/${started.id}/messages/${encodeURIComponent(started.requestId)}/images/0`;
  expect(entries).toEqual([
    { id: runEntryId(started.requestId, answerOf("Here is a plan")), kind: "message", messages: [{ role: "assistant", content: [{ type: "text", text: "Here is a plan" }], stopReason: "stop", timestamp: 1000 }] },
    { id: started.requestId, kind: "message", state: "answered", messages: [{ role: "user", content: [{ type: "text", text: "plan the trip" }, { type: "image", url, mimeType: "image/png" }], timestamp: expect.any(Number) }] },
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
  expect((await w.fetch(`${API}/conversations/${started.id}/transcript`, as("ana"))).status).toBe(404);
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
    ["GET", "/transcript"],
    ["POST", "/messages", { text: "hi" }],
    ["GET", "/events"],
    ["POST", "/abort"],
    ["GET", "/messages/web%3Ax/images/0"],
  ];
  for (const [method, path, body] of attempts) {
    const response = await w.fetch(`${API}/conversations/${id}${path}`, as("ben", { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
  }
  // Only ben's own key's object, and the accounts actor for the policy and the rate.
  expect(platform.calls.filter((each) => each !== `${ACCOUNTS_KEY} ${CALL.rate}` && each !== `${ACCOUNTS_KEY} ${CALL.config}`).every((each) => each.startsWith(`web:ben:${id} `))).toBe(true);
  expect(await (await w.fetch(`${API}/conversations?q=secret`, as("ben"))).json()).toEqual({ items: [] });
  expect((await platform.object(`web:ana:${id}`)).runtime.dispatched.length).toBe(1);
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id, archived: false }]);
  // An object answers only of itself: a call naming another conversation is refused.
  const other = await platform.mailbox.call(`web:ben:${id}`, CALL.conversation, { userId: "ana", chatId: id }, w.app.context()).catch((error: unknown) => error);
  expect((other as ActorCallError).code).toBe("invalid_request");
});

test("live events on the Worker: the object's stream, a snapshot first, the answer as written while the user waits, cut by the policy in the Worker; the client leaving closes it in the object", async () => {
  const { platform, worker: w } = await cloud();
  const { id, requestId } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${id}`;
  const { runtime } = await platform.object(key);
  const client = new AbortController();
  const events = sse(await w.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "snapshot", tools: [] }]);
  await runtime.start(key, [requestId]);
  runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "He" }], usage: { cost: 1 } } });
  runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "websearch", args: { q: "secret" } });
  expect(await events.take(3)).toEqual([
    { type: "run_start" },
    { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "He" }] } },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "websearch" },
  ]);
  client.abort();
  await events.reader.cancel();
  for (let i = 0; i < 50 && runtime.released < runtime.watching; i++) await Bun.sleep(5);
  expect([runtime.watching, runtime.released]).toEqual([1, 1]);
});

test("entries told live on the Worker come from the conversation's object: what a run stored, a message sent, a state a read found; ids the transcript's", async () => {
  const { platform, worker: w } = await cloud();
  const { id, requestId } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${id}`;
  const { runtime } = await platform.object(key);
  const client = new AbortController();
  const events = sse(await w.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "snapshot", tools: [] }]);
  await runtime.start(key, [requestId]);
  const answer = answerOf("Hello");
  runtime.push({ type: "message_end", entry: { id: 9, kind: "message", model: [answer as never] } });
  await runtime.end(key, [requestId], { messages: [answer] });
  const seen = (await events.take(4)) as ChatEvent[];
  expect(seen).toEqual([
    { type: "run_start" },
    { type: "message_end", entry: { id: runEntryId(requestId, answer), kind: "message", model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop", timestamp: 1000 }] } },
    { type: "run_end" },
    { type: "entry_appended" },
  ]);
  expect((await transcriptOf(w, "ana", id))[0]?.id).toBe(runEntryId(requestId, answer));

  const sent = (await (await w.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "again" }))).json()) as { requestId: string };
  expect(await events.take(1)).toMatchObject([{ type: "entry_appended", entry: { id: sent.requestId } }]);
  await runtime.end(key, [sent.requestId], { kind: "aborted", quiet: true });
  expect((await transcriptOf(w, "ana", id))[0]).toMatchObject({ id: sent.requestId, state: "aborted" });
  expect(await events.take(2)).toEqual([{ type: "run_end" }, { type: "entry_appended" }]);
  client.abort();
  await events.reader.cancel();
});

test("the policy, the agents and the search on the Worker: the accounts actor's config; an agent picked reaches the conversation's object, another is 400 before any call; ?q= is the index's", async () => {
  const { platform, worker: w } = await cloud({ visibility: { tools: "none" }, agents: ["helper"] });
  const config = (await (await w.fetch(`${API}/config`)).json()) as ChatConfig;
  expect([config.visibility, config.agents]).toEqual([{ thinking: false, tools: "none", context: true }, [{ name: "helper" }]]);
  const picked = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "Trip to Paris", agent: "helper" }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${picked.id}`;
  const { runtime } = await platform.object(key);
  expect(runtime.dispatched.at(-1)?.conversation.agent).toBe("helper");
  expect(await (await w.fetch(`${API}/conversations/${picked.id}`, as("ana"))).json()).toMatchObject({ agent: "helper" });
  const calls = platform.calls.length;
  expect((await w.fetch(`${API}/conversations`, post("ana", { text: "x", agent: "assistant" }))).status).toBe(400);
  expect(platform.calls.slice(calls).filter((each) => !each.startsWith(ACCOUNTS_KEY))).toEqual([]);

  // The policy (tools: none) cuts what the object stored, in the Worker.
  const call = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "websearch", arguments: {} }], stopReason: "toolUse", timestamp: 1 };
  const result = { role: "toolResult", toolCallId: "t1", toolName: "websearch", content: [{ type: "text", text: "found" }], isError: false, timestamp: 2 };
  await runtime.end(key, [picked.requestId], { messages: [call, result, answerOf("Paris it is")] });
  const entries = await eventually(async () => {
    const read = await transcriptOf(w, "ana", picked.id);
    return read.length === 2 ? read : undefined;
  }, "the run, cut");
  expect(JSON.stringify(entries)).not.toMatch(/websearch|found/);

  await w.fetch(`${API}/conversations`, post("ana", { text: "Groceries" }));
  await w.fetch(`${API}/conversations`, post("ben", { text: "paris too" }));
  platform.calls.length = 0;
  const found = (await (await w.fetch(`${API}/conversations?q=PARIS`, as("ana"))).json()) as { items: ChatConversation[] };
  expect(found.items.map((each) => each.title)).toEqual(["Trip to Paris"]);
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.list}`]);
});

test("SUGGESTED on the Worker: /me's suggestedAgent is the accounts actor's dry run of its App's route.resolve (the Worker's App has no router); no conversation's object is made; none when not offered", async () => {
  const { platform, worker: w } = await cloud({ agents: ["helper", "assistant"] });
  platform.calls.length = 0;
  const me = (await (await w.fetch(`${API}/me`, as("ana"))).json()) as { suggestedAgent?: string };
  // The objects' router names assistant, one users may pick.
  expect(me.suggestedAgent).toBe("assistant");
  expect(platform.calls).toContain(`${ACCOUNTS_KEY} ${CALL.routed}`);
  expect(platform.calls.every((each) => each.startsWith(`${ACCOUNTS_KEY} `))).toBe(true);
  expect([...platform.objects.keys()]).toEqual([ACCOUNTS_KEY]);
  expect((await platform.object(ACCOUNTS_KEY)).runtime.dispatched).toEqual([]);

  // Not offered: none, and no dry run is asked for.
  const { platform: other, worker: w2 } = await cloud({ agents: ["helper"] });
  other.calls.length = 0;
  expect(await (await w2.fetch(`${API}/me`, as("ana"))).json()).not.toHaveProperty("suggestedAgent");
  const { platform: none, worker: w3 } = await cloud();
  none.calls.length = 0;
  expect(await (await w3.fetch(`${API}/me`, as("ana"))).json()).not.toHaveProperty("suggestedAgent");
  expect(none.calls).not.toContain(`${ACCOUNTS_KEY} ${CALL.routed}`);
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
    [CALL.routed, { userId: "ana" }],
    [CALL.projects, { userId: "ana" }],
    [CALL.project, { userId: "ana", id: "a".repeat(32) }],
    [CALL.createProject, { userId: "ana", name: "x" }],
    [CALL.renameProject, { userId: "ana", id: "a".repeat(32), name: "x" }],
    [CALL.deleteProject, { userId: "ana", id: "a".repeat(32) }],
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
  const row = { key: `web:ana:${chatId}`, userId: "ana", chatId, agent: "assistant", project: "", title: "new", createdAt: 1, lastActivity: 5, hidden: false, archived: false, busy: false, version: 3 };
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

test("who a conversation is with, in its object: its user read from the accounts actor (the remote accounts: one call), never from accounts of its own", async () => {
  const accounts = new FakeAccounts();
  accounts.add("ana", "ana@example.com").name = "Ana";
  const made: string[] = [];
  const wiring = {
    local: () => {
      throw new Error("a conversation's object makes no accounts of its own");
    },
    remote: () => {
      made.push("remote");
      return accounts;
    },
    answer: () => {},
  };
  const objectActors = defineComponent({
    name: "actors-test",
    setup(pikit) {
      pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: () => {}, answerStream: () => {} });
      pikit.provide("actor.mailbox", { send: async () => {}, call: async () => null, stream: async () => (async function* () {})() });
    },
  });
  const app = await defineApp({
    components: [secretsOf(), new Runtime(String).component(), kvOf(), sqliteStorage(), router, createChannelWeb({ accounts: wiring }), objectActors],
    target: "durable",
    logger: silentLogger,
  }).create();
  await app.start();
  try {
    const chatId = crypto.randomUUID();
    const describe = (userId: string) => describeConversation(app.context(), `web:${userId}:${chatId}`);
    expect(await describe("ana")).toMatchObject({ name: "Ana", detail: "ana@example.com", link: { path: "/channel-web?user=ana" } });
    expect(await describe("ana")).toMatchObject({ name: "Ana" });
    // Made once, at the first description.
    expect(made).toEqual(["remote"]);
  } finally {
    await app.stop();
  }
});

type ProjectJson = { id: string; name: string; chats: number };

test("PROJECTS on the Worker: the accounts actor's (one call each); a chat made in one reaches its object with it, admitted in the project's space; the list by project from the index; deleted once empty (409 before)", async () => {
  const { platform, worker: w } = await cloud();
  platform.calls.length = 0;
  const made = await w.fetch(`${API}/projects`, post("ana", { name: "Work" }));
  expect(made.status).toBe(201);
  const work = (await made.json()) as ProjectJson;
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.createProject}`]);

  platform.calls.length = 0;
  const started = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "the report", project: work.id }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${started.id}`;
  // Counted, the project checked (the accounts actor's), then the conversation's object.
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.rate}`, `${ACCOUNTS_KEY} ${CALL.project}`, `${key} ${CALL.start}`, `${ACCOUNTS_KEY} ${SEEN}`]);
  const { runtime } = await platform.object(key);
  expect(runtime.pointers.get(key)?.space).toBe(`web:ana:project:${work.id}`);
  expect(runtime.dispatched.at(-1)?.conversation.space).toBe(`web:ana:project:${work.id}`);
  const other = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "another", project: work.id }))).json()) as { id: string };
  expect((await platform.object(`web:ana:${other.id}`)).runtime.pointers.get(`web:ana:${other.id}`)?.space).toBe(`web:ana:project:${work.id}`);
  const loose = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "loose" }))).json()) as { id: string };
  expect((await platform.object(`web:ana:${loose.id}`)).runtime.pointers.get(`web:ana:${loose.id}`)?.space).toBeUndefined();

  expect(await (await w.fetch(`${API}/conversations/${started.id}`, as("ana"))).json()).toMatchObject({ project: work.id });
  platform.calls.length = 0;
  const inWork = (await (await w.fetch(`${API}/conversations?project=${work.id}`, as("ana"))).json()) as { items: ChatConversation[] };
  expect(inWork.items.map((each) => each.title)).toEqual(["Another", "The report"]);
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.list}`]);
  expect(((await (await w.fetch(`${API}/conversations?project=none`, as("ana"))).json()) as { items: ChatConversation[] }).items.map((each) => each.title)).toEqual(["Loose"]);
  expect(await (await w.fetch(`${API}/projects`, as("ana"))).json()).toMatchObject({ items: [{ id: work.id, name: "Work", chats: 2 }] });
  expect(await (await w.fetch(`${API}/projects/${work.id}`, post("ana", { name: "Office" }, "PATCH"))).json()).toMatchObject({ id: work.id, name: "Office" });

  expect((await w.fetch(`${API}/projects/${work.id}`, as("ana", { method: "DELETE" }))).status).toBe(409);
  for (const id of [started.id, other.id]) expect((await w.fetch(`${API}/conversations/${id}`, as("ana", { method: "DELETE" }))).status).toBe(204);
  expect((await w.fetch(`${API}/projects/${work.id}`, as("ana", { method: "DELETE" }))).status).toBe(204);
  expect(await (await w.fetch(`${API}/projects`, as("ana"))).json()).toEqual({ items: [] });
});

test("PROJECT ISOLATION on the Worker: user B with user A's project id gets 404 on every route; no object is made for it; A's project untouched", async () => {
  const { platform, worker: w } = await cloud();
  const mine = (await (await w.fetch(`${API}/projects`, post("ana", { name: "Secret" }))).json()) as ProjectJson;
  await w.fetch(`${API}/conversations`, post("ana", { text: "inside", project: mine.id }));
  const objects = [...platform.objects.keys()];
  const attempts: [string, string, unknown?][] = [
    ["PATCH", `/projects/${mine.id}`, { name: "theirs" }],
    ["DELETE", `/projects/${mine.id}`],
    ["GET", `/conversations?project=${mine.id}`],
    ["POST", "/conversations", { text: "into yours", project: mine.id }],
  ];
  for (const [method, path, body] of attempts) {
    const response = await w.fetch(`${API}${path}`, as("ben", { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
    expect({ method, path, status: response.status, body: await response.json() }).toMatchObject({ method, path, status: 404, body: { error: "not_found" } });
  }
  expect([...platform.objects.keys()]).toEqual(objects);
  expect(await (await w.fetch(`${API}/projects`, as("ben"))).json()).toEqual({ items: [] });
  expect(await (await w.fetch(`${API}/projects`, as("ana"))).json()).toMatchObject({ items: [{ id: mine.id, name: "Secret", chats: 1 }] });
  // The index refuses a project id that is not one, before it reads anything.
  const forged = await platform.mailbox.call(ACCOUNTS_KEY, CALL.list, { userId: "ana", limit: 10, project: "x" }, w.app.context()).catch((error: unknown) => error);
  expect((forged as ActorCallError).code).toBe("invalid_request");
});

test("COMMANDS on the Worker: listed by the accounts actor's config; typed, it runs in the conversation's object (its space, the user as sender), nothing dispatched; the same request id runs once", async () => {
  const { platform, worker: w } = await cloud();
  expect(((await (await w.fetch(`${API}/config`)).json()) as ChatConfig).commands).toEqual([{ name: "rules", description: "Your rules" }]);
  const work = (await (await w.fetch(`${API}/projects`, post("ana", { name: "Work" }))).json()) as ProjectJson;
  const first = await w.fetch(`${API}/conversations`, post("ana", { text: "/rules be brief", project: work.id, requestId: "web:c1" }));
  expect(first.status).toBe(201);
  const made = (await first.json()) as { id: string; admission: string; command: unknown };
  expect(made).toMatchObject({ admission: "command", command: { name: "rules", outcome: "ran", text: "kept: be brief" } });
  const key = `web:ana:${made.id}`;
  expect(platform.ran).toEqual([{ key, space: `web:ana:project:${work.id}`, args: "be brief", sender: "ana" }]);
  expect((await platform.object(key)).runtime.dispatched).toEqual([]);
  expect(((await (await w.fetch(`${API}/conversations?project=${work.id}`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id: made.id, title: "New conversation" }]);
  expect(await transcriptOf(w, "ana", made.id)).toEqual([]);

  const again = await w.fetch(`${API}/conversations/${made.id}/messages`, post("ana", { text: "/rules be brief", requestId: "web:c1" }));
  expect(await again.json()).toMatchObject({ admission: "duplicate", command: { name: "rules", outcome: "ran" } });
  const next = await w.fetch(`${API}/conversations/${made.id}/messages`, post("ana", { text: "/rules no emojis" }));
  expect({ status: next.status, body: await next.json() }).toMatchObject({ status: 202, body: { admission: "command", command: { text: "kept: no emojis" } } });
  expect(platform.ran.map((each) => each.args)).toEqual(["be brief", "no emojis"]);
});
