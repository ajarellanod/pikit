/**
 * admin-api on Cloudflare, with a fake platform: every key is an "object", an App of its own running
 * admin-api's default export on the `durable` target (its runtime a double), reached through an
 * `actor.mailbox` that calls its `actor.inbox` handlers with JSON copies, as actors-do's RPC does. The
 * Worker's half serves the routes over them and the conversation directory, one the Worker and every
 * object share (the contracts' `createMemoryDirectory`, recorded from each object's runtime events, as
 * conversations-directory does). The workerd lane runs the same on real Durable Objects.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import {
  type ActorCallHandler,
  ActorCallError,
  type ActorInboxHandler,
  type ActorMailbox,
  type ActorStreamHandler,
  answerCall,
  answerStream,
  callResult,
  describeStage,
  type JsonValue,
  streamResult,
} from "@pikit/contracts";
import { type ApiConversation, MAX_DURABLE_IMAGE_BYTES, OPERATOR_NOTE } from "./api.ts";
import { qualify, unqualify } from "./backend.ts";
import adminApi, { worker } from "./index.ts";
import { APP_KEY, CONVERSATIONS_PER_PAGE } from "./remote.ts";
import { ANSWER_CHARS } from "./calls.ts";
import { agents, AUTH, auth, Directory, imageOf, PIXEL, Runtime, type Served, serve, sse } from "./runtime.test-support.ts";

const copy = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** One key's object: its App, its runtime, and the handlers its components registered. */
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
  /** Every call, as `key type`: what the Worker spent in subrequests. */
  readonly calls: string[] = [];
  /** Keys whose object cannot be reached. */
  readonly unreachable = new Set<string>();
  /** What the objects' Apps warned about. */
  readonly warnings: string[] = [];
  /** More components in every object's App (a channel's object half). */
  readonly extra: ComponentDefinition[] = [];
  /** The conversation directory: the Worker's and every object's; a delete for everyone resets the key in its object. */
  readonly directory = new Directory(async (key) => {
    const object = await this.object(key);
    await object.runtime.registry.reset(key, undefined, object.ctx);
  });

  readonly mailbox: ActorMailbox = {
    send: async (key, type, message) => {
      const object = await this.object(key);
      const handler = object.handlers.get(type);
      if (handler === undefined) throw new Error(`no handler for ${type}`);
      await handler(key, copy(message), object.ctx);
    },
    call: async (key, type, message) => {
      this.calls.push(`${key} ${type}`);
      if (this.unreachable.has(key)) throw new ActorCallError("unreachable", `the conversation object of "${key}" could not be reached`);
      const object = await this.object(key);
      const handler = object.answers.get(type);
      if (handler === undefined) throw new ActorCallError("no_handler", `no answer handler for ${type}`);
      return callResult(await answerCall(handler, key, copy(message), object.ctx));
    },
    stream: async (key, type, message, ctx) => {
      this.calls.push(`${key} ${type}`);
      if (this.unreachable.has(key)) throw new ActorCallError("unreachable", `the conversation object of "${key}" could not be reached`);
      const object = await this.object(key);
      const handler = object.streams.get(type);
      if (handler === undefined) throw new ActorCallError("no_handler", `no stream handler for ${type}`);
      return streamResult(await answerStream(handler, key, copy(message), object.ctx), ctx.abortSignal);
    },
  };

  object(key: string): Promise<FakeObject> {
    let found = this.objects.get(key);
    if (found === undefined) {
      found = this.start();
      this.objects.set(key, found);
    }
    return found;
  }

  private async start(): Promise<FakeObject> {
    const runtime = new Runtime(String);
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
    const logger = { ...silentLogger, warn: (message: string) => void this.warnings.push(message) };
    const app = await defineApp({ components: [auth, agents, runtime.component(), platform, this.directory.component(), adminApi, ...this.extra], target: "durable", logger }).create();
    await app.start();
    return { app, runtime, answers, handlers, streams, ctx: app.context() };
  }

  /** What the directory records of `key`'s conversation `conversationId` active at `at` (as its object's events would). */
  active(key: string, at: number, conversationId = "1"): void {
    this.directory.dispatched({ key, conversationId, agent: "assistant" }, `m-${at}`, { at });
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

/** The platform and the Worker's App: admin-api's Worker half, with admin.auth and the mailbox. */
async function cloud(): Promise<{ platform: Platform; worker: Served }> {
  const platform = new Platform();
  platforms.push(platform);
  const mailbox = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", platform.mailbox) });
  const served = await serve([auth, mailbox, platform.directory.component(), worker], {}, "durable");
  workers.push(served);
  return { platform, worker: served };
}

/** `key`'s object, with conversation `1` (left behind by a reset when `reset`) and `2`. */
async function chat(platform: Platform, key: string, reset = false): Promise<Runtime> {
  const { runtime } = await platform.object(key);
  runtime.add({ conversationId: "1", key, agent: "assistant", lastActivity: 10 }, !reset);
  if (reset) runtime.add({ conversationId: "2", key, agent: "assistant", lastActivity: 20 });
  return runtime;
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { ...AUTH, "content-type": "application/json" },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

test("ids: <key>~<the object's id>, split on the last ~; anything else names no conversation", () => {
  expect(qualify("telegram:1", "2")).toBe("telegram:1~2");
  expect(unqualify("telegram:1~2")).toEqual({ key: "telegram:1", local: "2" });
  expect(unqualify("http:a~b~12")).toEqual({ key: "http:a~b", local: "12" });
  for (const id of ["", "telegram:1", "~2", "telegram:1~"]) expect({ id, found: unqualify(id) }).toEqual({ id, found: undefined });
});

test("the Worker's list: the directory's, newest activity first, each read from its object with a qualified id", async () => {
  const { platform, worker: w } = await cloud();
  await chat(platform, "telegram:1", true);
  await chat(platform, "telegram:2");
  platform.active("telegram:1", 100, "1");
  platform.active("telegram:1", 150, "2");
  platform.active("telegram:2", 200);
  platform.calls.length = 0;

  const response = await w.fetch("/admin/api/conversations", { headers: AUTH });
  const body = (await response.json()) as { items: ApiConversation[]; next?: string };

  expect(response.status).toBe(200);
  expect(body.items.map(({ conversationId, current, currentId, lastActivity, state }) => ({ conversationId, current, currentId, lastActivity, state }))).toEqual([
    { conversationId: "telegram:2~1", current: true, currentId: undefined, lastActivity: 200, state: "listed" },
    { conversationId: "telegram:1~2", current: true, currentId: undefined, lastActivity: 150, state: "listed" },
    { conversationId: "telegram:1~1", current: false, currentId: "telegram:1~2", lastActivity: 100, state: "listed" },
  ]);
  expect(body.next).toBeUndefined();
  // The directory's page (its Worker half), then one call per conversation to its key's object.
  expect(platform.calls).toEqual(["telegram:2 admin-api.conversation", "telegram:1 admin-api.conversation", "telegram:1 admin-api.conversation"]);
  // The object the Worker asks for the App is not a conversation, and was given none.
  const none = await platform.mailbox.call(APP_KEY, "admin-api.conversation", { conversationId: "1" }, w.app.context()).catch((error: unknown) => error);
  expect((none as ActorCallError).code).toBe("not_found");
});

test("who each conversation is with is its object's: the channel's stage there (no call of its own), else what the key says", async () => {
  const { platform, worker: w } = await cloud();
  // A channel's object half, which knows only its own object's chat.
  platform.extra.push(
    defineComponent({
      name: "describer-test",
      setup(pikit) {
        const describer = { describe: async (key: string) => (key === "telegram:1" ? { name: "@ana", detail: "Direct message", ids: [{ label: "Chat id", value: "1" }] } : undefined) };
        pikit.pipeline("conversation.describe", describeStage(describer), { id: "describer-test" });
      },
    }),
  );
  await chat(platform, "telegram:1");
  await chat(platform, "http:b");
  platform.active("telegram:1", 100);
  platform.active("http:b", 200);
  platform.calls.length = 0;

  const body = (await (await w.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: ApiConversation[] };

  expect(body.items.map(({ conversationId, party }) => ({ conversationId, party }))).toEqual([
    { conversationId: "http:b~1", party: { channel: { kind: "http", label: "HTTP API" }, ids: [{ label: "Chat id", value: "b" }, { label: "Key", value: "http:b" }, { label: "Conversation", value: "1" }] } },
    {
      conversationId: "telegram:1~1",
      party: { channel: { kind: "telegram", label: "Telegram" }, name: "@ana", detail: "Direct message", ids: [{ label: "Chat id", value: "1" }, { label: "Key", value: "telegram:1" }, { label: "Conversation", value: "1" }] },
    },
  ]);
  expect(platform.calls).toEqual(["http:b admin-api.conversation", "telegram:1 admin-api.conversation"]);
  expect(((await (await w.fetch("/admin/api/conversations/telegram%3A1~1", { headers: AUTH })).json()) as ApiConversation).party?.name).toBe("@ana");
});

test("the Worker's list pages, at most CONVERSATIONS_PER_PAGE whatever limit asks; an object that does not answer is left out and logged", async () => {
  const { platform, worker: w } = await cloud();
  const count = CONVERSATIONS_PER_PAGE + 3;
  for (let i = 0; i < count; i++) {
    await chat(platform, `telegram:${i}`);
    platform.active(`telegram:${i}`, 1_000 + i);
  }
  platform.unreachable.add(`telegram:${count - 1}`);
  platform.calls.length = 0;

  const first = (await (await w.fetch("/admin/api/conversations?limit=100", { headers: AUTH })).json()) as { items: ApiConversation[]; next?: string };
  expect(platform.calls.length).toBe(CONVERSATIONS_PER_PAGE);
  expect(first.items.length).toBe(CONVERSATIONS_PER_PAGE - 1);
  expect(first.items[0]?.conversationId).toBe(`telegram:${count - 2}~1`);
  expect(w.logged.some((each) => each.message.includes("left out of the list") && each.fields?.conversation === `telegram:${count - 1}`)).toBe(true);

  const second = (await (await w.fetch(`/admin/api/conversations?cursor=${encodeURIComponent(first.next as string)}`, { headers: AUTH })).json()) as { items: ApiConversation[]; next?: string };
  expect(second.items.map((each) => each.conversationId)).toEqual(["telegram:2~1", "telegram:1~1", "telegram:0~1"]);
  expect(second.next).toBeUndefined();

  const forged = await w.fetch("/admin/api/conversations?cursor=forged", { headers: AUTH });
  expect(forged.status).toBe(400);
  expect(await forged.json()).toMatchObject({ error: "invalid_cursor" });
});

test("one conversation and its transcript from its object; an unknown or malformed id is 404; an object that cannot be reached is 503", async () => {
  const { platform, worker: w } = await cloud();
  const runtime = await chat(platform, "telegram:1");
  runtime.transcripts.set("1", [{ id: "e1", kind: "pikit.input", messages: [{ role: "user", content: "hi" }], requestId: "m1", sender: { channel: "telegram", id: "1" } }]);

  const one = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}`, { headers: AUTH });
  expect(await one.json()).toMatchObject({ conversationId: "telegram:1~1", key: "telegram:1", current: true });
  const transcript = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/transcript?limit=5`, { headers: AUTH });
  expect(await transcript.json()).toEqual({ items: [{ id: "e1", kind: "pikit.input", messages: [{ role: "user", content: "hi" }], requestId: "m1", sender: { channel: "telegram", id: "1" } }] });
  expect(runtime.pages).toContainEqual({ limit: 5 });

  for (const id of ["telegram:1~9", "telegram:1", "telegram:1~x", "telegram:2~1", "%E0"]) {
    for (const path of ["", "/transcript", "/events"]) {
      const response = await w.fetch(`/admin/api/conversations/${id.startsWith("%") ? id : encodeURIComponent(id)}${path}`, { headers: AUTH });
      expect({ id, path, status: response.status }).toEqual({ id, path, status: 404 });
    }
  }

  platform.unreachable.add("telegram:1");
  const down = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}`, { headers: AUTH });
  expect(down.status).toBe(503);
  expect(await down.json()).toMatchObject({ error: "unavailable" });
});

test("actions reach the object of the key, with its own id and the operator as the message's sender; its refusals cross the call; a reset answers qualified ids", async () => {
  const { platform, worker: w } = await cloud();
  const runtime = await chat(platform, "telegram:1", true);

  const sent = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~2")}/messages`, post({ text: "stop and summarise", requestId: "dashboard:1" }));
  expect(sent.status).toBe(202);
  expect(await sent.json()).toEqual({ requestId: "dashboard:1", admission: "started" });
  expect(runtime.dispatched).toEqual([
    {
      requestId: "dashboard:1",
      conversation: { key: "telegram:1", agent: "assistant", conversationId: "2" },
      prompt: `${OPERATOR_NOTE}: the user of this conversation does not see this message or your answer to it.]\nstop and summarise`,
      whenBusy: "followUp",
      // The operator crosses the call: the run's sender, as on a server.
      sender: { channel: "dashboard", id: "ops" },
    },
  ]);
  expect(w.logged.find((each) => each.message.includes("sent a message"))?.fields).toMatchObject({ operator: "ops", conversation: "telegram:1" });
  expect(JSON.stringify(w.logged)).not.toContain("summarise");

  for (const action of ["messages", "abort", "reset"]) {
    const behind = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/${action}`, post({ text: "hi" }));
    expect({ action, status: behind.status, body: await behind.json() }).toMatchObject({ action, status: 409, body: { error: "not_current" } });
  }

  const aborted = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~2")}/abort`, post());
  expect(await aborted.json()).toEqual({ conversationId: "telegram:1~2" });
  expect(runtime.aborted).toEqual([{ key: "telegram:1", agent: "assistant", conversationId: "2" }]);

  const reset = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~2")}/reset`, post());
  expect(await reset.json()).toEqual({ key: "telegram:1", previousConversationId: "telegram:1~2", conversationId: "telegram:1~100" });
  expect(runtime.pointers.get("telegram:1")?.conversationId).toBe("100");

  // The new one: no message reached it, and it is the key's current one, with the key's agent (its object's key).
  expect(runtime.conversations.get("100")?.key).toBeUndefined();
  const fresh = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~100")}`, { headers: AUTH });
  expect(await fresh.json()).toMatchObject({ conversationId: "telegram:1~100", key: "telegram:1", agent: "assistant", current: true });
  runtime.dispatched.length = 0;
  const again = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~100")}/messages`, post({ text: "go on", requestId: "dashboard:2" }));
  expect(again.status).toBe(202);
  expect(runtime.dispatched.map((each) => each.conversation)).toEqual([{ key: "telegram:1", agent: "assistant", conversationId: "100" }]);
});

test("an object's message call with an operator that is not a non-empty string is refused (invalid_request), nothing dispatched", async () => {
  const platform = new Platform();
  platforms.push(platform);
  const runtime = await chat(platform, "telegram:1");
  const { ctx } = await platform.object("telegram:1");
  for (const operator of ["", 7, null]) {
    await expect(platform.mailbox.call("telegram:1", "admin-api.message", { conversationId: "1", text: "hi", requestId: "dashboard:x", operator }, ctx)).rejects.toMatchObject({ code: "invalid_request" });
  }
  expect(runtime.dispatched).toEqual([]);
});

test("a conversation of the dashboard's own on the Worker: one call to the object of its new key (in its operator's space and owned by them, the operator its sender), listed first at once, titled by its first message", async () => {
  const { platform, worker: w } = await cloud();
  await chat(platform, "telegram:1");
  platform.active("telegram:1", 100);
  platform.calls.length = 0;

  const response = await w.fetch("/admin/api/conversations", post({ agent: "assistant", text: "what changed today?" }));
  const body = (await response.json()) as { conversationId: string; key: string; requestId: string; admission: string };

  expect(response.status).toBe(201);
  expect(body.key).toMatch(/^dashboard:[0-9a-f-]{36}$/);
  expect(body).toMatchObject({ conversationId: `${body.key}~100`, admission: "started" });
  expect(platform.calls).toEqual([`${body.key} admin-api.start`]);
  const { runtime } = await platform.object(body.key);
  expect(runtime.dispatched).toEqual([
    {
      requestId: body.requestId,
      // In the operator's space, and from the operator: both cross the call to the object.
      conversation: { key: body.key, agent: "assistant", channel: "dashboard", space: "dashboard:operator:ops", owner: { channel: "dashboard", id: "ops" }, conversationId: "100" },
      prompt: `${OPERATOR_NOTE}.]\nwhat changed today?`,
      whenBusy: "followUp",
      sender: { channel: "dashboard", id: "ops" },
    },
  ]);
  // Recorded when the message was dispatched, before any run; its first title the operator's words.
  const page = (await (await w.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: ApiConversation[] };
  expect(page.items.map(({ conversationId, title }) => ({ conversationId, title }))).toEqual([
    { conversationId: body.conversationId, title: "What changed today?" },
    { conversationId: "telegram:1~1", title: undefined },
  ]);

  const unknown = await w.fetch("/admin/api/conversations", post({ agent: "nobody", text: "hi" }));
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toMatchObject({ error: "unknown_agent" });
});

test("the agents on the Worker are an object's App's (APP_KEY's), one call", async () => {
  const { platform, worker: w } = await cloud();

  const response = await w.fetch("/admin/api/agents", { headers: AUTH });

  expect(await response.json()).toEqual({
    items: [
      { name: "assistant", model: "test/model", tools: [], steward: true },
      { name: "searcher", model: "test/search", tools: ["websearch", "lookup"], steward: false },
    ],
    tools: [{ name: "lookup", summary: "" }],
    skills: [],
  });
  expect(platform.calls).toEqual([`${APP_KEY} admin-api.agents`]);
});

test("images and a web search cross the call to the object; images over 1 MB in all are 413 before any call; a web search the agent cannot do is the object's 400", async () => {
  const { platform, worker: w } = await cloud();
  const runtime = await chat(platform, "telegram:1");
  const path = `/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/messages`;

  const sent = await w.fetch(path, post({ text: "look", attachments: [{ kind: "image", mimeType: "image/png", data: PIXEL }] }));
  expect(sent.status).toBe(202);
  expect(runtime.dispatched[0]).toMatchObject({ prompt: `${OPERATOR_NOTE}: the user of this conversation does not see this message or your answer to it.]\nlook`, images: [{ mimeType: "image/png", data: PIXEL }] });

  platform.calls.length = 0;
  const big = await w.fetch(path, post({ text: "look", attachments: [imageOf(MAX_DURABLE_IMAGE_BYTES / 2), imageOf(MAX_DURABLE_IMAGE_BYTES / 2 + 1)] }));
  expect(big.status).toBe(413);
  expect(await big.json()).toMatchObject({ error: "too_large", message: expect.stringContaining("Cloudflare") });
  const started = await w.fetch("/admin/api/conversations", post({ agent: "assistant", text: "look", attachments: [imageOf(MAX_DURABLE_IMAGE_BYTES + 1)] }));
  expect(started.status).toBe(413);
  expect(platform.calls).toEqual([]);

  const search = await w.fetch(path, post({ text: "news?", webSearch: true }));
  expect(search.status).toBe(400);
  expect(await search.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining("websearch") });
  expect(runtime.dispatched.length).toBe(1);

  const own = (await (await w.fetch("/admin/api/conversations", post({ agent: "searcher", text: "find it", webSearch: true, attachments: [imageOf(8, "image/jpeg")] }))).json()) as { key: string };
  const { runtime: theirs } = await platform.object(own.key);
  expect(theirs.dispatched[0]).toMatchObject({
    conversation: { agent: "searcher" },
    prompt: `${OPERATOR_NOTE}: search the web for it with the websearch tool before you answer.]\nfind it`,
    images: [{ mimeType: "image/jpeg", data: imageOf(8).data }],
  });
});

test("a transcript page too long for a call's answer (images inline) is answered shorter, until it fits", async () => {
  const { platform, worker: w } = await cloud();
  const runtime = await chat(platform, "telegram:1");
  const image = "A".repeat(Math.ceil(ANSWER_CHARS / 2.5));
  runtime.transcripts.set(
    "1",
    ["e3", "e2", "e1"].map((id) => ({ id, kind: "message", messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: image }] }] })),
  );

  const page = (await (await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/transcript?limit=4`, { headers: AUTH })).json()) as { items: { id: string }[] };

  expect(page.items.map((each) => each.id)).toEqual(["e3", "e2"]);
  expect(runtime.pages.slice(-2)).toEqual([{ limit: 4 }, { limit: 2 }]);
});

test("live events on the Worker: the object's stream, as server-sent events, each event as it happens; the client leaving closes it in the object", async () => {
  const { platform, worker: w } = await cloud();
  const runtime = await chat(platform, "telegram:1");
  const client = new AbortController();

  const response = await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/events`, { headers: AUTH, signal: client.signal });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const stream = sse(response);
  expect(await stream.take(1)).toEqual([{ type: "live", ops: [["r", { busy: false, tools: [] }]] }]);
  // Not polled: what the object's runtime emits arrives, every part of it, over the one stream.
  runtime.push({ type: "live", ops: [["s", ["partial"], { role: "assistant", content: [{ type: "text", text: "hel" }] }]] });
  runtime.push({ type: "live", ops: [["a", ["partial", "content", 0, "text"], "lo"]] });
  const input = { id: "e0", kind: "pikit.input", messages: [{ role: "user", content: "hi" }], requestId: "m1", sender: { channel: "telegram", id: "1" } };
  runtime.push({ type: "entries", entries: [input] });
  expect(await stream.take(3)).toEqual([
    { type: "live", ops: [["s", ["partial"], { role: "assistant", content: [{ type: "text", text: "hel" }] }]] },
    { type: "live", ops: [["a", ["partial", "content", 0, "text"], "lo"]] },
    { type: "entries", entries: [input] },
  ]);
  expect(platform.calls.filter((each) => each.startsWith("telegram:1 "))).toEqual(["telegram:1 admin-api.live"]);
  client.abort();
  await stream.reader.cancel();
  for (let i = 0; i < 50 && runtime.released < runtime.watching; i++) await Bun.sleep(5);
  expect([runtime.watching, runtime.released]).toEqual([1, 1]);
});

test("live events on the Worker: an unknown conversation is a 404 before any stream, an object that cannot be reached a 503", async () => {
  const { platform, worker: w } = await cloud();
  await chat(platform, "telegram:1");
  expect((await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~9")}/events`, { headers: AUTH })).status).toBe(404);
  platform.unreachable.add("telegram:1");
  expect((await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/events`, { headers: AUTH })).status).toBe(503);
});

test("the composition is an object's App (APP_KEY's); delivery is not listed on the Worker", async () => {
  const { worker: w } = await cloud();

  const app = (await (await w.fetch("/admin/api/app", { headers: AUTH })).json()) as { target: string; components: { name: string }[] };
  expect(app.target).toBe("durable");
  expect(app.components.map((c) => c.name)).toEqual(expect.arrayContaining(["admin-api", "runtime-test"]));

  const delivery = await w.fetch("/admin/api/delivery/pending", { headers: AUTH });
  expect(delivery.status).toBe(404);
  expect(await delivery.json()).toMatchObject({ error: "not_installed", message: expect.stringContaining("Durable Object") });
});

test("every Worker route answers 401 without an operator, and calls no object", async () => {
  const { platform, worker: w } = await cloud();
  // The session's routes take the credential itself (admin-api.test.ts).
  const api = w.keys().filter((key) => key.includes("/admin/api") && !key.endsWith("/admin/api/session"));
  expect(api.length).toBeGreaterThan(9);

  for (const key of api) {
    const [method = "GET", pattern = "/"] = key.split(" ");
    const response = await w.fetch(pattern.replace(":id", "telegram%3A1~1").replace("*", "x"), { method, ...(method === "POST" && { body: "{}" }) });
    expect({ key, status: response.status }).toEqual({ key, status: 401 });
  }
  expect(platform.calls).toEqual([]);
  expect(platform.objects.size).toBe(0);
});

test("in an App that is one key's actor the default export answers the Worker's calls (no actor.mailbox needed) and serves nothing itself", async () => {
  const runtime = new Runtime();
  const answers: string[] = [];
  const inbox = defineComponent({
    name: "inbox-test",
    setup: (pikit) => pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: (type) => void answers.push(type), answerStream: (type) => void answers.push(type) }),
  });
  const app = await defineApp({ components: [auth, runtime.component(), inbox, new Directory(async () => {}).component(), adminApi], logger: silentLogger }).create();
  await app.start();
  expect(answers.sort()).toEqual(["admin-api.abort", "admin-api.agents", "admin-api.app", "admin-api.command", "admin-api.commands", "admin-api.conversation", "admin-api.live", "admin-api.message", "admin-api.reset", "admin-api.start", "admin-api.transcript", "admin-api.usage"]);
  await app.stop();
});

test("slash commands on the Worker: listed from an object's App, run in the conversation's object (refusals cross the call); /name is the directory's title, in the list too", async () => {
  const { platform, worker: w } = await cloud();
  const runtime = await chat(platform, "telegram:1");
  platform.active("telegram:1", 100);
  platform.calls.length = 0;

  const listedCommands = (await (await w.fetch("/admin/api/commands", { headers: AUTH })).json()) as { items: { name: string }[] };
  expect(listedCommands.items.map((each) => each.name)).toEqual(["name", "new"]);
  expect(platform.calls).toEqual([`${APP_KEY} admin-api.commands`]);

  const path = (name: string) => `/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/commands/${name}`;
  platform.calls.length = 0;
  const named = await w.fetch(path("name"), post({ args: "Weekend plans" }));
  expect(await named.json()).toEqual({ text: "Titled “Weekend plans”." });
  expect(platform.calls).toEqual(["telegram:1 admin-api.command"]);
  const page = (await (await w.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: ApiConversation[] };
  expect(page.items).toMatchObject([{ conversationId: "telegram:1~1", title: "Weekend plans" }]);
  expect(w.logged.find((each) => each.message.includes("ran a command"))?.fields).toEqual({ operator: "ops", conversation: "telegram:1", command: "name" });

  expect((await w.fetch(path("nope"), post())).status).toBe(404);
  const failing = await w.fetch(path("name"), post({ args: "" }));
  expect({ status: failing.status, body: await failing.json() }).toMatchObject({ status: 422, body: { error: "command_failed" } });

  const fresh = await w.fetch(path("new"), post());
  expect(fresh.status).toBe(200);
  expect(runtime.pointers.get("telegram:1")?.conversationId).toBe("100");
  const behind = await w.fetch(path("name"), post({ args: "Too late" }));
  expect({ status: behind.status, body: await behind.json() }).toMatchObject({ status: 409, body: { error: "not_current" } });
  // The reset's new conversation has no title yet; the one behind keeps its own, and points to it.
  const reset = (await (await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~100")}`, { headers: AUTH })).json()) as ApiConversation;
  expect(reset).toMatchObject({ current: true });
  expect(reset.title).toBeUndefined();
  expect(await (await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}`, { headers: AUTH })).json()).toMatchObject({ current: false, currentId: "telegram:1~100", title: "Weekend plans" });
});

test("rename on the Worker: the directory's (the Worker's half), then the conversation read from its object; the list shows it; refusals", async () => {
  const { platform, worker: w } = await cloud();
  await chat(platform, "telegram:1", true);
  platform.active("telegram:1", 100, "1");
  const path = (id: string) => `/admin/api/conversations/${encodeURIComponent(id)}/rename`;
  platform.calls.length = 0;

  // Left behind by a reset (`chat`'s `reset`): renamed all the same.
  const renamed = await w.fetch(path("telegram:1~1"), post({ title: "  weekend plans.  " }));
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ conversationId: "telegram:1~1", current: false, title: "Weekend plans" });
  expect(platform.calls).toEqual(["telegram:1 admin-api.conversation"]);
  expect(w.logged.find((each) => each.message.includes("renamed"))?.fields).toEqual({ operator: "ops", conversation: "telegram:1" });
  const page = (await (await w.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: ApiConversation[] };
  expect(page.items).toMatchObject([{ conversationId: "telegram:1~1", title: "Weekend plans" }]);

  const empty = await w.fetch(path("telegram:1~1"), post({ title: " \"\" " }));
  expect({ status: empty.status, body: await empty.json() }).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  expect((await w.fetch(path("telegram:1~9"), post({ title: "x" }))).status).toBe(404);
  expect((await w.fetch(path("telegram:1"), post({ title: "x" }))).status).toBe(404);
});

test("hide, archive and delete on the Worker: the directory's, no object asked; a delete for everyone resets the key in its object", async () => {
  const { platform, worker: w } = await cloud();
  await chat(platform, "telegram:1", true);
  const runtime = await chat(platform, "telegram:2");
  await chat(platform, "telegram:3");
  platform.active("telegram:1", 100, "1");
  platform.active("telegram:2", 200);
  platform.active("telegram:3", 300);
  const ids = async (state = "listed") =>
    ((await (await w.fetch(`/admin/api/conversations?state=${state}`, { headers: AUTH })).json()) as { items: ApiConversation[] }).items.map((each) => each.conversationId);
  const act = (id: string, action: string) => w.fetch(`/admin/api/conversations/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { ...AUTH, "x-pikit-admin": "1" } });
  platform.calls.length = 0;

  expect(await (await act("telegram:1~1", "archive")).json()).toEqual({ conversationId: "telegram:1~1", state: "archived", hidden: false });
  expect(await (await act("telegram:3~1", "hide")).json()).toEqual({ conversationId: "telegram:3~1", state: "listed", hidden: true });
  expect(platform.calls).toEqual([]);
  expect(await (await act("telegram:2~1", "delete")).json()).toEqual({ conversationId: "telegram:2~1", state: "deleted", hidden: false });
  // Reset where the conversation is: its key's next message starts a new one.
  expect(runtime.pointers.get("telegram:2")?.conversationId).toBe("100");

  expect(await ids()).toEqual([]);
  expect(await ids("archived")).toEqual(["telegram:1~1"]);
  expect(await ids("hidden")).toEqual(["telegram:3~1"]);
  expect(await ids("deleted")).toEqual(["telegram:2~1"]);
  expect((await act("telegram:9~1", "archive")).status).toBe(404);
});

test("search on the Worker (?q=): the directory's, over the titles (a rename, /name, a channel's first message) and the keys; only what it finds is read", async () => {
  const { platform, worker: w } = await cloud();
  for (const [n, when] of [[1, 100], [2, 200], [3, 300]] as const) {
    await chat(platform, `telegram:${n}`);
    platform.active(`telegram:${n}`, when);
  }
  const ids = async (query: string) =>
    ((await (await w.fetch(`/admin/api/conversations${query}`, { headers: AUTH })).json()) as { items: ApiConversation[] }).items.map((each) => each.conversationId);

  expect((await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:1~1")}/rename`, post({ title: "Weekend plans" }))).status).toBe(200);
  await w.fetch(`/admin/api/conversations/${encodeURIComponent("telegram:2~1")}/commands/name`, post({ args: "Ñandú notes" }));
  platform.calls.length = 0;
  expect(await ids("?q=WEEKEND")).toEqual(["telegram:1~1"]);
  expect(platform.calls).toEqual(["telegram:1 admin-api.conversation"]);
  expect(await ids(`?q=${encodeURIComponent("ñandú")}`)).toEqual(["telegram:2~1"]);
  expect(await ids("?q=telegram:3")).toEqual(["telegram:3~1"]);
  expect(await ids("?q=nothing")).toEqual([]);
  // Activity keeps the title.
  platform.active("telegram:1", 400);
  expect(await ids("?q=weekend")).toEqual(["telegram:1~1"]);
  expect((await w.fetch(`/admin/api/conversations?q=${"x".repeat(201)}`, { headers: AUTH })).status).toBe(400);
});
