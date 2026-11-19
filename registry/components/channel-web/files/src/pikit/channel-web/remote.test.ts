/**
 * channel-web on Cloudflare, with a fake platform: every key is an "object", an App of its own running
 * the default export on the `durable` target (its runtime a double, its `storage.sql` SQLite), reached
 * through an `actor.mailbox` that calls its `actor.inbox` handlers with JSON copies, as actors-do's
 * RPC does. The Worker's half serves the routes over them; the accounts actor (`channel-web:accounts`)
 * holds the accounts. `conversations.directory` is one double every App shares (its provider's halves
 * share its actor), recorded from each object's runtime events. The workerd lane runs the same on real
 * Durable Objects, with the real accounts (`tests/workerd/test/channel-web.workerd.ts`).
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
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
  type SqlDatabase,
  streamResult,
} from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { type ChatConfig, type ChatConversation, type ChatTranscriptEntry, MAX_DURABLE_IMAGE_BYTES } from "./api.ts";
import { ACCOUNTS_KEY, CALL } from "./calls.ts";
import { type TestDirectory, testDirectory } from "./directory.test-support.ts";
import { runEntryId } from "./entries.ts";
import { createChannelWeb, NAME } from "./index.ts";
import { type ProjectDoubles, projectDoubles, projectsComponent } from "./projects.test-support.ts";
import { adminAuth, answerOf, eventually, FakeAccounts, imageOf, kvOf, liveReader, OPERATOR, PIXEL, Runtime, router, type Served, secretsOf, serve, tickingClock } from "./runtime.test-support.ts";
import { createChannelWebWorker } from "./worker.ts";

const copy = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

interface FakeObject {
  app: App;
  runtime: Runtime;
  answers: Map<string, ActorCallHandler>;
  handlers: Map<string, ActorInboxHandler>;
  streams: Map<string, ActorStreamHandler>;
  ctx: AppContext;
  /** Its `storage.sql`. */
  sql: SqlDatabase;
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
  /** Every App's clock: one, so their activities are ordered. */
  readonly clock = tickingClock();
  /** The directory every App shares; a key is reset in its own object. */
  readonly directory: TestDirectory = testDirectory(async (key) => (await this.object(key)).runtime.registry);
  constructor(
    readonly accounts: FakeAccounts,
    /** channel-web's config in every object's App (the default App's). */
    readonly config: Record<string, unknown> = {},
    /** More components in every object's App (the project store's default half). */
    readonly extra: ComponentDefinition[] = [],
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
          audience: "user",
          run: async (conversation, args, _ctx, sender) => {
            this.ran.push({ key: conversation.key, ...(conversation.space !== undefined && { space: conversation.space }), args, ...(sender !== undefined && { sender: sender.id }) });
            return { text: `kept: ${args}` };
          },
        });
      },
    });
    let sql: SqlDatabase | undefined;
    const probe = defineComponent({
      name: "sql-probe",
      setup(pikit) {
        const handle = pikit.use("storage.sql");
        return { start: () => void (sql = handle.get()) };
      },
    });
    const app = await defineApp({
      components: [
        secretsOf(),
        runtime.component(),
        kvOf(),
        sqliteStorage(),
        probe,
        router,
        agents,
        platform,
        this.directory.provider(),
        this.directory.recorder(),
        ...this.extra,
        createChannelWeb({ accounts: this.accounts.wiring() }),
      ],
      config: { [NAME]: this.config },
      target: "durable",
      logger: silentLogger,
      clock: this.clock,
    }).create();
    await app.start();
    return { app, runtime, answers, handlers, streams, ctx: app.context(), sql: sql as SqlDatabase };
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

/**
 * The Worker and its objects; with `doubles`, a project store (and the rest) both Apps reach, as the
 * stores' two halves give it: the Worker's routes use it, the accounts actor's migration too.
 */
async function cloud(config: Record<string, unknown> = {}, doubles?: ProjectDoubles): Promise<{ platform: Platform; worker: Served; accounts: FakeAccounts }> {
  const accounts = new FakeAccounts();
  accounts.add("ana");
  accounts.add("ben");
  const platform = new Platform(accounts, config, doubles === undefined ? [] : [projectsComponent(doubles)]);
  platforms.push(platform);
  const mailbox = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", platform.mailbox) });
  const served = await serve(
    [secretsOf(), mailbox, adminAuth, platform.directory.provider(), ...(doubles === undefined ? [] : [projectsComponent(doubles, "projects-worker-doubles")]), createChannelWebWorker(accounts.wiring())],
    {},
    "durable",
    undefined,
    platform.clock,
  );
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

test("a conversation on the Worker: started by one call to its key's object, listed from the directory (no object called), read, renamed for everyone, its transcript from its object", async () => {
  const { platform, worker: w } = await cloud();
  const started = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "plan the trip", images: [{ mimeType: "image/png", data: PIXEL }] }))).json()) as { id: string; requestId: string; admission: string };
  const key = `web:ana:${started.id}`;
  expect(started.admission).toBe("started");
  // The user's message counted by the accounts actor first, then the conversation's object: no index told.
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.rate}`, `${key} ${CALL.start}`]);
  const { runtime } = await platform.object(key);
  expect(runtime.dispatched).toMatchObject([{ requestId: started.requestId, conversation: { key, conversationId: "1", owner: { channel: "web", id: "ana" } }, sender: { channel: "web", id: "ana" }, images: [{ mimeType: "image/png", data: PIXEL }] }]);

  platform.calls.length = 0;
  await runtime.start(key, [started.requestId]);
  const listed = (await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] };
  // Its first message's title (given by its object), owner the user, a run going: the directory's.
  expect(listed.items).toMatchObject([{ id: started.id, title: "Plan the trip", busy: true, mine: true, userId: "ana", may: { rename: true, archive: true, delete: true } }]);
  // The policy only (kept by the Worker `CONFIG_CACHE_MS`: the next lists call nothing).
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.config}`]);
  platform.calls.length = 0;
  await w.fetch(`${API}/conversations`, as("ana"));
  expect(platform.calls).toEqual([]);

  const renamed = await w.fetch(`${API}/conversations/${started.id}`, post("ana", { title: "Trip" }, "PATCH"));
  expect(await renamed.json()).toMatchObject({ id: started.id, title: "Trip" });
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items[0]?.title).toBe("Trip");
  expect(platform.calls).toEqual([]);

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
  // The directory heard the run end: busy no more.
  await eventually(async () => (((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items[0]?.busy === false ? true : undefined), "the directory's busy flag");

  // Archived for everyone in the directory, no object called: listed apart; unarchived, back.
  platform.calls.length = 0;
  const archived = await w.fetch(`${API}/conversations/${started.id}/archive`, as("ana", { method: "POST" }));
  expect(await archived.json()).toMatchObject({ id: started.id, archived: true });
  expect(platform.calls).toEqual([]);
  expect(await (await w.fetch(`${API}/conversations`, as("ana"))).json()).toEqual({ items: [] });
  expect(((await (await w.fetch(`${API}/conversations?archived=1`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id: started.id, archived: true }]);
  expect(await (await w.fetch(`${API}/conversations/${started.id}/unarchive`, as("ana", { method: "POST" }))).json()).toMatchObject({ id: started.id, archived: false });
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id: started.id, archived: false }]);
  // Archived again, a message lists it again.
  await w.fetch(`${API}/conversations/${started.id}/archive`, as("ana", { method: "POST" }));
  expect((await w.fetch(`${API}/conversations/${started.id}/messages`, post("ana", { text: "more" }))).status).toBe(202);
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id: started.id, archived: false }]);

  // Deleted for everyone: its key reset in its own object, the chat gone there too.
  expect((await w.fetch(`${API}/conversations/${started.id}`, as("ana", { method: "DELETE" }))).status).toBe(204);
  expect(runtime.resets).toEqual([key]);
  expect(await (await w.fetch(`${API}/conversations`, as("ana"))).json()).toEqual({ items: [] });
  expect((await w.fetch(`${API}/conversations/${started.id}/transcript`, as("ana"))).status).toBe(404);
  expect((await w.fetch(`${API}/conversations/${started.id}`, as("ana"))).status).toBe(404);
});

// Found in a browser on a durable project with faux/scripted: the list said "Running" for good.
test("a run that ends before its object's admission returns: the directory says not busy", async () => {
  const { platform, worker: w } = await cloud();
  platform.runsAtOnce = true;
  const busy = async () => (((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items.map((each) => each.busy));
  const started = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "quick" }))).json()) as { id: string };
  expect(await busy()).toEqual([false]);
  await w.fetch(`${API}/conversations/${started.id}/messages`, post("ana", { text: "again" }));
  expect(await busy()).toEqual([false]);
});

test("ISOLATION on the Worker: user B with user A's chat id gets 404 on every route, by id or naming A (?user=); A's object is never called", async () => {
  const { platform, worker: w } = await cloud();
  const { id } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "secret" }))).json()) as { id: string };
  platform.calls.length = 0;
  const attempts: [string, string, unknown?][] = [
    ["GET", ""],
    ["PATCH", "", { title: "mine" }],
    ["POST", "/archive"],
    ["POST", "/unarchive"],
    ["POST", "/hide"],
    ["POST", "/unhide"],
    ["POST", "/read"],
    ["DELETE", ""],
    ["GET", "/transcript"],
    ["POST", "/messages", { text: "hi" }],
    ["GET", "/events"],
    ["POST", "/abort"],
    ["GET", "/messages/web%3Ax/images/0"],
  ];
  for (const [method, path, body] of attempts) {
    for (const user of ["", "?user=ana"]) {
      const response = await w.fetch(`${API}/conversations/${id}${path}${user}`, as("ben", { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
      expect({ method, path, user, status: response.status }).toEqual({ method, path, user, status: 404 });
    }
  }
  // Only ben's own key's object, and the accounts actor for the policy and the rate.
  expect(platform.calls.filter((each) => each !== `${ACCOUNTS_KEY} ${CALL.rate}` && each !== `${ACCOUNTS_KEY} ${CALL.config}`).every((each) => each.startsWith(`web:ben:${id} `))).toBe(true);
  expect(await (await w.fetch(`${API}/conversations?q=secret`, as("ben"))).json()).toEqual({ items: [] });
  expect((await platform.object(`web:ana:${id}`)).runtime.dispatched.length).toBe(1);
  expect(((await (await w.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items).toMatchObject([{ id, archived: false, hidden: false, title: "Secret" }]);
  // An object answers only of itself: a call naming another conversation is refused.
  const other = await platform.mailbox.call(`web:ben:${id}`, CALL.conversation, { userId: "ana", chatId: id }, w.app.context()).catch((error: unknown) => error);
  expect((other as ActorCallError).code).toBe("invalid_request");
});

test("live events on the Worker: the object's stream, the live value whole first, the answer as written while the user waits, cut by the policy in the Worker; the client leaving closes it in the object", async () => {
  const { platform, worker: w } = await cloud();
  const { id, requestId } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${id}`;
  const { runtime } = await platform.object(key);
  const client = new AbortController();
  const events = liveReader(await w.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "live", ops: [["r", { busy: false, tools: [] }]] }]);
  await runtime.start(key, [requestId]);
  runtime.partial(key, { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "He" }], usage: { cost: 1 } });
  runtime.live(key, (live) => ({ ...live, tools: [{ callId: "t1", name: "websearch", status: "running", output: "secret" }] }));
  await events.until({ busy: true, partial: { role: "assistant", content: [{ type: "text", text: "He" }] }, tools: [{ callId: "t1", name: "websearch", status: "running" }] });
  expect(JSON.stringify(events.seen)).not.toMatch(/private|secret|cost/);
  client.abort();
  await events.reader.cancel();
  for (let i = 0; i < 50 && runtime.released < runtime.watching; i++) await Bun.sleep(5);
  expect([runtime.watching, runtime.released]).toEqual([1, 1]);
});

test("entries told live on the Worker come from the conversation's object: what a run wrote, a message sent, a state a read found; ids the transcript's", async () => {
  const { platform, worker: w } = await cloud();
  const { id, requestId } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${id}`;
  const { runtime } = await platform.object(key);
  const client = new AbortController();
  const events = liveReader(await w.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "live", ops: [["r", { busy: false, tools: [] }]] }]);
  await runtime.start(key, [requestId]);
  const answer = answerOf("Hello");
  runtime.entries(key, [{ messages: [answer as never] }]);
  expect(await events.next("entries")).toEqual({
    type: "entries",
    entries: [{ id: runEntryId(requestId, answer), kind: "message", messages: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop", timestamp: 1000 }] }],
  });
  await runtime.end(key, [requestId], { messages: [answer] });
  await events.until({ busy: false, tools: [] });
  expect(await events.next("transcript")).toEqual({ type: "transcript" });
  expect((await transcriptOf(w, "ana", id))[0]?.id).toBe(runEntryId(requestId, answer));

  const sent = (await (await w.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "again" }))).json()) as { requestId: string };
  expect(await events.next("entries")).toMatchObject({ type: "entries", entries: [{ id: sent.requestId }] });
  await runtime.end(key, [sent.requestId], { kind: "aborted", quiet: true });
  expect((await transcriptOf(w, "ana", id))[0]).toMatchObject({ id: sent.requestId, state: "aborted" });
  expect(await events.next("transcript")).toEqual({ type: "transcript" });
  client.abort();
  await events.reader.cancel();
});

test("the policy, the agents and the search on the Worker: the accounts actor's config; an agent picked reaches the conversation's object, another is 400 before any call; ?q= is the directory's", async () => {
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
  expect(platform.calls).toEqual([]);
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
  // The directory still lists and describes it; what its object holds is 503.
  expect((await w.fetch(`${API}/conversations/${id}`, as("ana"))).status).toBe(200);
  const down = await w.fetch(`${API}/conversations/${id}/transcript`, as("ana"));
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

test("only the accounts actor answers the accounts' calls: a conversation's object refuses them (no_handler) and reads nothing; no call lists conversations", async () => {
  const { platform, worker: w } = await cloud();
  const { id } = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "hi" }))).json()) as { id: string };
  const key = `web:ana:${id}`;
  for (const [type, message] of [
    [CALL.config, {}],
    [CALL.rate, { userId: "ana" }],
    [CALL.routed, { userId: "ana" }],
    [CALL.migrateProjects, {}],
  ] as const) {
    const refused = await platform.mailbox.call(key, type, message, w.app.context()).catch((error: unknown) => error);
    expect({ type, code: (refused as ActorCallError).code }).toEqual({ type, code: "no_handler" });
  }
  // The accounts actor answers them; the index's calls are gone (the directory lists).
  expect(await platform.mailbox.call(ACCOUNTS_KEY, CALL.config, {}, w.app.context())).toMatchObject({ target: "durable" });
  for (const type of ["channel-web.list", "channel-web.forget", "channel-web.project.conversations", "channel-web.project.chats", "channel-web.rename", "channel-web.archive", "channel-web.hide"]) {
    const gone = await platform.mailbox.call(ACCOUNTS_KEY, type, {}, w.app.context()).catch((error: unknown) => error);
    expect({ type, code: (gone as ActorCallError).code }).toEqual({ type, code: "no_handler" });
  }
});

test("an operator removing a user on the Worker: their accounts, then their chats deleted for everyone in the directory, each key reset in its own object", async () => {
  const { platform, worker: w, accounts } = await cloud();
  const { id } = (await (await w.fetch(`${API}/conversations`, post("ben", { text: "hi" }))).json()) as { id: string };
  const key = `web:ben:${id}`;
  platform.calls.length = 0;
  const removed = await w.fetch("/admin/api/channel-web/users/ben", { method: "DELETE", headers: OPERATOR });
  expect(removed.status).toBe(204);
  expect(platform.calls).toEqual([]);
  expect((await platform.object(key)).runtime.resets).toEqual([key]);
  accounts.add("ben");
  expect(await (await w.fetch(`${API}/conversations`, as("ben"))).json()).toEqual({ items: [] });
  expect((await w.fetch(`${API}/conversations/${id}`, as("ben"))).status).toBe(404);
});

test("in an App that is one key's actor without actor.mailbox, its start says so", async () => {
  const inbox = defineComponent({ name: "inbox-test", setup: (pikit) => pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: () => {}, answerStream: () => {} }) });
  const app = await defineApp({
    components: [secretsOf(), new Runtime().component(), kvOf(), sqliteStorage(), router, inbox, testDirectory().provider(), createChannelWeb({ accounts: new FakeAccounts().wiring() })],
    config: { [NAME]: {} },
    logger: silentLogger,
  }).create();
  const failed = (await app.start().catch((error: unknown) => error)) as Error;
  expect(String(failed.cause)).toContain("needs actor.mailbox");
});

test("the Worker refuses to start without CHANNEL_WEB_AUTH_SECRET", async () => {
  const mailbox = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", new Platform(new FakeAccounts()).mailbox) });
  const app = await defineApp({ components: [secretsOf({}), mailbox, testDirectory().provider(), createChannelWebWorker(new FakeAccounts().wiring())], logger: silentLogger, target: "durable" }).create();
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
    components: [secretsOf(), new Runtime(String).component(), kvOf(), sqliteStorage(), router, testDirectory().provider(), createChannelWeb({ accounts: wiring }), objectActors],
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

test("PROJECTS on the Worker: the project store is the Worker's (its routes there); its chats and their counts are the directory's (no object called; the former projects carried over once first, in the accounts actor); a chat made in one reaches its object with the project's space; every member's chats listed, another's transcript from its object; the project's owner archives another's chat, never deletes it; removed once empty (409 before)", async () => {
  const doubles = projectDoubles();
  const { platform, worker: w } = await cloud({}, doubles);
  platform.calls.length = 0;
  const made = await w.fetch(`${API}/projects`, post("ana", { name: "Work" }));
  expect(made.status).toBe(201);
  const work = (await made.json()) as ProjectJson;
  // Made in the store; the migration asked once, of the accounts actor.
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.migrateProjects}`]);
  expect(await (await w.fetch(`${API}/projects/${work.id}/members`, post("ana", { email: "ben@example.com" }))).json()).toMatchObject({ principal: { channel: "web", id: "ben" } });

  platform.calls.length = 0;
  const started = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "the report", project: work.id }))).json()) as { id: string; requestId: string };
  const key = `web:ana:${started.id}`;
  // Counted, then the conversation's object (the project checked in the Worker's store).
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.rate}`, `${key} ${CALL.start}`]);
  const { runtime } = await platform.object(key);
  expect(runtime.pointers.get(key)?.space).toBe(`project:${work.id}`);
  expect(runtime.dispatched.at(-1)?.conversation.space).toBe(`project:${work.id}`);
  const bens = (await (await w.fetch(`${API}/conversations`, post("ben", { text: "another", project: work.id }))).json()) as { id: string; requestId: string };
  expect((await platform.object(`web:ben:${bens.id}`)).runtime.pointers.get(`web:ben:${bens.id}`)?.space).toBe(`project:${work.id}`);
  // Posting: the chat's project from the directory, then the store; one call to its object.
  platform.calls.length = 0;
  expect((await w.fetch(`${API}/conversations/${bens.id}/messages`, post("ben", { text: "more" }))).status).toBe(202);
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.rate}`, `web:ben:${bens.id} ${CALL.send}`]);

  platform.calls.length = 0;
  expect(await (await w.fetch(`${API}/projects`, as("ana"))).json()).toMatchObject({ items: [{ id: work.id, name: "Work", chats: 2 }] });
  expect(platform.calls).toEqual([]);
  const all = (await (await w.fetch(`${API}/projects/${work.id}/conversations`, as("ben"))).json()) as { items: { id: string; title: string; userId: string; mine: boolean; may: unknown }[] };
  expect(all.items.map((each) => [each.title, each.userId, each.mine]).sort()).toEqual([
    ["Another", "ben", true],
    ["The report", "ana", false],
  ]);
  // A member sees another's chat, and may do nothing to it for everyone.
  expect(all.items.find((each) => !each.mine)?.may).toEqual({ rename: false, archive: false, delete: false });
  expect(platform.calls).toEqual([`${ACCOUNTS_KEY} ${CALL.config}`]);
  platform.calls.length = 0;
  const read = await w.fetch(`${API}/projects/${work.id}/conversations/${started.id}/transcript?user=ana`, as("ben"));
  expect(read.status).toBe(200);
  expect(platform.calls).toEqual([`${key} ${CALL.transcript}`]);
  // Read only for ben; ana, the project's owner, archives ben's chat for everyone, never deletes it.
  expect((await w.fetch(`${API}/conversations/${started.id}/messages?user=ana`, post("ben", { text: "mine now" }))).status).toBe(403);
  expect((await w.fetch(`${API}/conversations/${started.id}/archive?user=ana`, as("ben", { method: "POST" }))).status).toBe(403);
  expect(await (await w.fetch(`${API}/conversations/${bens.id}/archive?user=ben`, as("ana", { method: "POST" }))).json()).toMatchObject({ id: bens.id, archived: true, mine: false });
  expect((await w.fetch(`${API}/conversations/${bens.id}?user=ben`, as("ana", { method: "DELETE" }))).status).toBe(403);

  expect((await w.fetch(`${API}/projects/${work.id}`, as("ana", { method: "DELETE" }))).status).toBe(409);
  expect((await w.fetch(`${API}/conversations/${started.id}`, as("ana", { method: "DELETE" }))).status).toBe(204);
  // Archived chats count: still not empty until ben deletes his.
  expect((await w.fetch(`${API}/projects/${work.id}`, as("ana", { method: "DELETE" }))).status).toBe(409);
  expect((await w.fetch(`${API}/conversations/${bens.id}`, as("ben", { method: "DELETE" }))).status).toBe(204);
  expect((await w.fetch(`${API}/projects/${work.id}`, as("ana", { method: "DELETE" }))).status).toBe(204);
  expect(await (await w.fetch(`${API}/projects`, as("ana"))).json()).toEqual({ items: [] });
});

test("PROJECT ISOLATION on the Worker: a non-member with a member's project id gets 404 on every route, its chats too (by id and author); no object is made", async () => {
  const doubles = projectDoubles();
  const { platform, worker: w } = await cloud({}, doubles);
  const mine = (await (await w.fetch(`${API}/projects`, post("ana", { name: "Secret" }))).json()) as ProjectJson;
  const inside = (await (await w.fetch(`${API}/conversations`, post("ana", { text: "inside", project: mine.id }))).json()) as { id: string };
  const objects = [...platform.objects.keys()];
  const attempts: [string, string, unknown?][] = [
    ["GET", `/projects/${mine.id}`],
    ["PATCH", `/projects/${mine.id}`, { name: "theirs" }],
    ["DELETE", `/projects/${mine.id}`],
    ["GET", `/projects/${mine.id}/memory`],
    ["GET", `/projects/${mine.id}/files`],
    ["GET", `/projects/${mine.id}/history`],
    ["GET", `/projects/${mine.id}/conversations`],
    ["GET", `/projects/${mine.id}/conversations/${inside.id}/transcript?user=ana`],
    ["GET", `/conversations?project=${mine.id}`],
    ["POST", "/conversations", { text: "into yours", project: mine.id }],
    ["GET", `/conversations/${inside.id}?user=ana`],
    ["GET", `/conversations/${inside.id}/transcript?user=ana`],
    ["POST", `/conversations/${inside.id}/hide?user=ana`],
  ];
  for (const [method, path, body] of attempts) {
    const response = await w.fetch(`${API}${path}`, as("ben", { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
    expect({ method, path, status: response.status, body: await response.json() }).toMatchObject({ method, path, status: 404, body: { error: "not_found" } });
  }
  expect([...platform.objects.keys()]).toEqual(objects);
  expect([doubles.files.calls, doubles.memory.calls]).toEqual([[], []]);
  expect(await (await w.fetch(`${API}/projects`, as("ben"))).json()).toEqual({ items: [] });
});

test("MIGRATION on Cloudflare: the accounts actor (whose table it is) carries the former projects over to its App's project store when the Worker first asks, then the table goes; asked again, nothing more", async () => {
  const doubles = projectDoubles();
  const { platform, worker: w } = await cloud({}, doubles);
  const accounts = await platform.object(ACCOUNTS_KEY);
  const id = "4".repeat(32);
  await accounts.sql.run("CREATE TABLE IF NOT EXISTS channel_web_projects (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, id))");
  await accounts.sql.run("INSERT INTO channel_web_projects (user_id, id, name, created_at) VALUES ('ana', ?, 'Old', 1)", [id]);
  expect(await (await w.fetch(`${API}/projects`, as("ana"))).json()).toMatchObject({ items: [{ id, name: "Old", role: "owner" }] });
  expect(doubles.projects.ids.get(id)).toBe(`web:ana:project:${id}`);
  expect(await accounts.sql.query("SELECT name FROM sqlite_master WHERE name = 'channel_web_projects'")).toEqual([]);
  expect(await platform.mailbox.call(ACCOUNTS_KEY, CALL.migrateProjects, {}, w.app.context())).toEqual({ made: 0 });
  // The Worker asks once: later project routes call no more.
  platform.calls.length = 0;
  await w.fetch(`${API}/projects/${id}`, as("ana"));
  expect(platform.calls).not.toContain(`${ACCOUNTS_KEY} ${CALL.migrateProjects}`);
});

test("COMMANDS on the Worker: listed by the accounts actor's config; typed, it runs in the conversation's object (its space, the user as sender), nothing dispatched; the same request id runs once", async () => {
  const { platform, worker: w } = await cloud({}, projectDoubles());
  expect(((await (await w.fetch(`${API}/config`)).json()) as ChatConfig).commands).toEqual([{ name: "rules", description: "Your rules", audience: "user" }]);
  const work = (await (await w.fetch(`${API}/projects`, post("ana", { name: "Work" }))).json()) as ProjectJson;
  const first = await w.fetch(`${API}/conversations`, post("ana", { text: "/rules be brief", project: work.id, requestId: "web:c1" }));
  expect(first.status).toBe(201);
  const made = (await first.json()) as { id: string; admission: string; command: unknown };
  expect(made).toMatchObject({ admission: "command", command: { name: "rules", outcome: "ran", text: "kept: be brief" } });
  const key = `web:ana:${made.id}`;
  expect(platform.ran).toEqual([{ key, space: `project:${work.id}`, args: "be brief", sender: "ana" }]);
  expect((await platform.object(key)).runtime.dispatched).toEqual([]);
  // Not listed before a message reaches it (the directory lists activity); read by its id, as its object says.
  expect(((await (await w.fetch(`${API}/conversations?project=${work.id}`, as("ana"))).json()) as { items: ChatConversation[] }).items).toEqual([]);
  expect(await (await w.fetch(`${API}/conversations/${made.id}`, as("ana"))).json()).toMatchObject({ id: made.id, title: "New conversation", project: work.id });
  expect(await transcriptOf(w, "ana", made.id)).toEqual([]);

  const again = await w.fetch(`${API}/conversations/${made.id}/messages`, post("ana", { text: "/rules be brief", requestId: "web:c1" }));
  expect(await again.json()).toMatchObject({ admission: "duplicate", command: { name: "rules", outcome: "ran" } });
  const next = await w.fetch(`${API}/conversations/${made.id}/messages`, post("ana", { text: "/rules no emojis" }));
  expect({ status: next.status, body: await next.json() }).toMatchObject({ status: 202, body: { admission: "command", command: { text: "kept: no emojis" } } });
  expect(platform.ran.map((each) => each.args)).toEqual(["be brief", "no emojis"]);
});
