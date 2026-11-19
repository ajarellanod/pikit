/**
 * admin-api's tests. They are copied with the component and keep running in your project.
 *
 * Every contract it uses is a double here (the conversation directory is the contracts'
 * `createMemoryDirectory`, recorded from the runtime's events as conversations-directory does); the
 * routes are picked the way a server picks them (`compareHttpRoutes`), so the most specific key serves
 * each request.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { ADMIN_CLIENT_HEADER, type AgentCommand, type ConversationDescriber, type ConversationRef, describeStage, type DeliveryReceipt, type ObservedEvent, type OutboundQueue, type PendingPiece } from "@pikit/contracts";
import { createAgentCommandConformance } from "@pikit/contracts/testing";
import Type from "typebox";
import { type ApiCommands, type ApiConversation, MAX_IMAGE_BYTES, OPERATOR_NOTE, operatorPrompt } from "./api.ts";
import { CSP } from "./assets.ts";
import { conversationOfAnswer } from "./routes.ts";
import adminApi from "./index.ts";
import { agents, AUTH, auth, Directory, imageOf, PIXEL, Runtime, type Served, SESSION, serve, sse, ZERO } from "./runtime.test-support.ts";

type Subject = Served & {
  runtime: Runtime;
  directory: Directory;
  /** A conversation the runtime holds and the directory lists, its newest activity at `lastActivity` (else now). */
  hold(conversation: { conversationId: string; key: string; agent: string; lastActivity?: number; busy?: boolean }, current?: boolean): void;
};

const running: App[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop().catch(() => {});
});

/** admin-api on a server over `runtime` (empty when not given) and a directory of its own, which records its events. */
async function started(config: Record<string, unknown> = {}, extra: ComponentDefinition[] = [], runtime = new Runtime(), appConfig: Record<string, unknown> = {}): Promise<Subject> {
  const directory = new Directory(async (key, ctx) => void (await runtime.registry.reset(key, undefined, ctx)));
  const served = await serve([auth, agents, runtime.component(), directory.component(), adminApi, ...extra], { "admin-api": config, ...appConfig });
  running.push(served.app);
  runtime.pages.length = 0;
  return {
    ...served,
    runtime,
    directory,
    hold(conversation, current = true) {
      runtime.add(conversation, current);
      directory.dispatched(conversation, `m-${conversation.conversationId}`, { ...(conversation.lastActivity !== undefined && { at: conversation.lastActivity }) });
    },
  };
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { ...AUTH, "content-type": "application/json" },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

/** The API's id of `key`'s conversation `local`, and its path. */
const cid = (key: string, local: string) => `${key}~${local}`;
const at = (key: string, local: string, rest = "") => `/admin/api/conversations/${encodeURIComponent(cid(key, local))}${rest}`;

/** Who a conversation no channel describes is with: what its key says. */
const keyParty = (kind: string, label: string, chat: string, key: string, conversationId: string) => ({
  channel: { kind, label },
  ids: [
    { label: "Chat id", value: chat },
    { label: "Key", value: key },
    { label: "Conversation", value: conversationId },
  ],
});

/** The ids of the list's first page. */
const listed = async (s: Subject, query = ""): Promise<string[]> =>
  ((await (await s.fetch(`/admin/api/conversations${query}`, { headers: AUTH })).json()) as { items: { conversationId: string }[] }).items.map((each) => each.conversationId);

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const runtime = new Runtime();
  const directory = new Directory(async () => {});
  const app = await defineApp({ components: [auth, runtime.component(), directory.component(), adminApi], logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "admin-api")).toEqual({
    name: "admin-api",
    provides: ["http.route", "agent.command"],
    requires: ["admin.auth", "agent.observe", "agent.runtime", "conversations.registry", "conversations.directory"],
    optional: ["outbound.queue", "actor.inbox", "agent.definition", "agent.directory", "agent.tool", "agent.skill", "agent.command"],
  });
});

test("every API route answers 401 without an operator, and reads nothing", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  // The session's routes take the credential itself (below).
  const api = s.keys().filter((key) => key.includes("/admin/api") && !key.endsWith("/admin/api/session"));
  expect(api.length).toBeGreaterThan(9);

  for (const key of api) {
    const [method = "GET", pattern = "/"] = key.split(" ");
    const path = pattern.replace(":id", encodeURIComponent(cid("telegram:1", "c1"))).replace("*", "anything");
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const response = await s.fetch(path, { method, headers, ...(method === "POST" && { body: JSON.stringify({ text: "hi" }) }) });
      expect({ key, status: response.status }).toEqual({ key, status: 401 });
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
  }
  expect(s.runtime.dispatched).toEqual([]);
  expect(s.runtime.aborted).toEqual([]);
  expect(s.runtime.pages).toEqual([]);
  expect((await s.directory.memory.directory.access({ kind: "operator", id: "ops" }, { key: "telegram:1" }, s.app.context()))?.state).toBe("listed");
});

test("GET /admin/api/app: the composition the App describes, admin-api in it", async () => {
  const s = await started();

  const response = await s.fetch("/admin/api/app", { headers: AUTH });
  const body = (await response.json()) as { version: number; components: { name: string }[]; config: Record<string, unknown> };

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.version).toBe(1);
  expect(body.components.map((c) => c.name)).toContain("admin-api");
  expect(body.config["admin-api"]).toMatchObject({ heartbeatMs: 15_000 });
});

test("GET /admin/api/app never sends a config value that looks like a secret", async () => {
  const leaky = defineComponent({
    name: "leaky-test",
    config: Type.Object({ botToken: Type.String(), tokenSecret: Type.String(), url: Type.String(), retries: Type.Integer() }),
    setup() {},
  });
  const config = { botToken: "123456789:AAEabcdefghijklmnopqrstuvwxyz012345", tokenSecret: "TELEGRAM_BOT_TOKEN", url: "https://user:hunter2@example.com/", retries: 3 };
  const s = await started({}, [leaky], undefined, { "leaky-test": config });

  const text = await (await s.fetch("/admin/api/app", { headers: AUTH })).text();

  expect((JSON.parse(text) as { config: Record<string, unknown> }).config["leaky-test"]).toEqual({ botToken: "[redacted]", tokenSecret: "TELEGRAM_BOT_TOKEN", url: "[redacted]", retries: 3 });
  expect(text).not.toContain("AAEabcdef");
  expect(text).not.toContain("hunter2");
});

test("GET /admin/api/conversations: the directory's list as an operator sees it, newest activity first, each read from the runtime (busy, usage, whether its key points to it)", async () => {
  const s = await started();
  s.hold({ conversationId: "c0", key: "telegram:1", agent: "assistant", lastActivity: 1 }, false);
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant", busy: true, lastActivity: 5 });
  s.hold({ conversationId: "c2", key: "http:a", agent: "assistant", lastActivity: 3 });
  // The runtime holds it, the directory does not (no activity it recorded): not listed.
  s.runtime.add({ conversationId: "c3", key: "http:b", agent: "assistant" });

  const response = await s.fetch("/admin/api/conversations?limit=2", { headers: AUTH });
  const body = (await response.json()) as { items: Record<string, unknown>[]; next?: string };

  expect(response.status).toBe(200);
  const entry = { state: "listed", hidden: false };
  expect(body.items).toEqual([
    { conversationId: "telegram:1~c1", key: "telegram:1", agent: "assistant", busy: true, lastActivity: 5, usage: ZERO, current: true, ...entry, party: keyParty("telegram", "Telegram", "1", "telegram:1", "c1") },
    { conversationId: "http:a~c2", key: "http:a", agent: "assistant", busy: false, lastActivity: 3, usage: ZERO, current: true, ...entry, party: keyParty("http", "HTTP API", "a", "http:a", "c2") },
  ]);
  const last = (await (await s.fetch(`/admin/api/conversations?limit=2&cursor=${encodeURIComponent(body.next as string)}`, { headers: AUTH })).json()) as { items: Record<string, unknown>[]; next?: string };
  expect(last).toEqual({
    items: [
      {
        conversationId: "telegram:1~c0",
        key: "telegram:1",
        agent: "assistant",
        busy: false,
        lastActivity: 1,
        usage: ZERO,
        current: false,
        // Where its key points now: where `/new` went.
        currentId: "telegram:1~c1",
        ...entry,
        party: keyParty("telegram", "Telegram", "1", "telegram:1", "c0"),
      },
    ],
  });
  // Read by its id all the same.
  expect(await (await s.fetch(at("http:b", "c3"), { headers: AUTH })).json()).toMatchObject({ conversationId: "http:b~c3", current: true });
});

test("a listed conversation the runtime no longer has is left out of the page, and logged", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant", lastActivity: 1 });
  s.hold({ conversationId: "c2", key: "telegram:2", agent: "assistant", lastActivity: 2 });
  s.runtime.conversations.delete("c2");

  expect(await listed(s)).toEqual(["telegram:1~c1"]);
  expect(s.logged.some((each) => each.message.includes("left out of the list") && each.fields?.conversation === "telegram:2")).toBe(true);
});

test("who each conversation is with: its channel's stage of conversation.describe (cleaned, its instance), else what its key and recorded channel say; a failing describer is the key's; Key and Conversation last", async () => {
  const describers = defineComponent({
    name: "describers-test",
    setup(pikit) {
      const telegram: ConversationDescriber = {
        async describe(key) {
          const chat = /^telegram(?::ops)?:(\d+)$/.exec(key)?.[1];
          if (chat === undefined) return undefined;
          return { name: "  @ana ", detail: "Direct message", ids: [{ label: "Chat id", value: chat }], link: { label: "Bot", path: "/telegram" }, ...(key.includes(":ops:") && { instance: "ops" }) };
        },
      };
      pikit.pipeline("conversation.describe", describeStage(telegram), { id: "telegram-test" });
      pikit.pipeline("conversation.describe", describeStage({ describe: async (key) => (key.startsWith("http:") ? Promise.reject(new Error("down")) : undefined) }), { id: "http-test" });
    },
  });
  const s = await started({}, [describers]);
  s.hold({ conversationId: "c1", key: "telegram:ops:5", agent: "assistant", lastActivity: 4 });
  s.hold({ conversationId: "c2", key: "http:a", agent: "assistant", lastActivity: 3 });
  s.hold({ conversationId: "c3", key: "googlechat:ops:spaces/AAA", agent: "assistant", lastActivity: 2 });
  // The channel recorded with the key says its instance.
  s.runtime.pointers.set("googlechat:ops:spaces/AAA", { key: "googlechat:ops:spaces/AAA", agent: "assistant", conversationId: "c3", channel: "googlechat:ops" });
  s.hold({ conversationId: "c4", key: "telegram:9", agent: "assistant", lastActivity: 1 });

  const page = (await (await s.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: { conversationId: string; party?: unknown }[] };

  const own = (key: string, id: string) => [
    { label: "Key", value: key },
    { label: "Conversation", value: id },
  ];
  expect(Object.fromEntries(page.items.map((each) => [each.conversationId, each.party]))).toEqual({
    "telegram:ops:5~c1": { channel: { kind: "telegram", instance: "ops", label: "Telegram" }, name: "@ana", detail: "Direct message", ids: [{ label: "Chat id", value: "5" }, ...own("telegram:ops:5", "c1")], link: { label: "Bot", path: "/telegram" } },
    "http:a~c2": { channel: { kind: "http", label: "HTTP API" }, ids: [{ label: "Chat id", value: "a" }, ...own("http:a", "c2")] },
    "googlechat:ops:spaces/AAA~c3": { channel: { kind: "googlechat", instance: "ops", label: "Google Chat" }, ids: [{ label: "Chat id", value: "spaces/AAA" }, ...own("googlechat:ops:spaces/AAA", "c3")] },
    "telegram:9~c4": { channel: { kind: "telegram", label: "Telegram" }, name: "@ana", detail: "Direct message", ids: [{ label: "Chat id", value: "9" }, ...own("telegram:9", "c4")], link: { label: "Bot", path: "/telegram" } },
  });
  expect(s.logged.some((each) => each.message.includes("describer failed"))).toBe(true);
  // One conversation's page says it too.
  expect(((await (await s.fetch(at("telegram:9", "c4"), { headers: AUTH })).json()) as { party?: { name?: string } }).party?.name).toBe("@ana");
});

test("the list follows the directory's activity: a message dispatched, a run settled or failed move a conversation to the front; a duplicate does not; a reset's new one is listed once a message reaches it", async () => {
  const s = await started();
  for (const [id, when] of [["c1", 10], ["c2", 20], ["c3", 30]] as const) s.hold({ conversationId: id, key: `telegram:${id}`, agent: "assistant", lastActivity: when });
  expect(await listed(s)).toEqual(["telegram:c3~c3", "telegram:c2~c2", "telegram:c1~c1"]);
  const ctx = s.app.context();
  const ref = (id: string) => ({ key: `telegram:${id}`, agent: "assistant", conversationId: id });

  await ctx.emit("agent.dispatched", { conversation: ref("c1"), admission: { kind: "queued", requestId: "m1" } });
  expect(await listed(s)).toEqual(["telegram:c1~c1", "telegram:c3~c3", "telegram:c2~c2"]);
  await ctx.emit("agent.failed", { conversation: ref("c2"), requestId: "m2", requestIds: ["m2"], kind: "failed", messages: [], error: { code: "x", message: "x" } });
  expect((await listed(s))[0]).toBe("telegram:c2~c2");
  await ctx.emit("agent.settled", { conversation: ref("c3"), requestId: "m3", requestIds: ["m3"], kind: "completed", messages: [] });
  expect((await listed(s))[0]).toBe("telegram:c3~c3");
  // A duplicate admission is no activity.
  await ctx.emit("agent.dispatched", { conversation: ref("c2"), admission: { kind: "duplicate", requestId: "m2" } });
  expect((await listed(s))[0]).toBe("telegram:c3~c3");
  // A reset's new conversation: no activity yet, not listed; its first message lists it first.
  await s.fetch(at("telegram:c1", "c1", "/reset"), post());
  expect(await listed(s)).toEqual(["telegram:c3~c3", "telegram:c2~c2", "telegram:c1~c1"]);
  expect((await s.fetch(at("telegram:c1", "c100", "/messages"), post({ text: "again" }))).status).toBe(202);
  expect((await listed(s))[0]).toBe("telegram:c1~c100");
});

test("the list pages through thousands, newest first, a page at a time: at most DIRECTORY_PAGE_MAX a page, whatever limit asks", async () => {
  const s = await started();
  for (let i = 0; i < 1_200; i++) s.hold({ conversationId: `c${i}`, key: `http:${i}`, agent: "assistant", lastActivity: 1_000 + i });

  const first = (await (await s.fetch("/admin/api/conversations?limit=50", { headers: AUTH })).json()) as { items: { conversationId: string }[]; next: string };
  expect(first.items.length).toBe(50);
  expect(first.items[0]?.conversationId).toBe("http:1199~c1199");
  const seen = new Set(first.items.map((each) => each.conversationId));
  let cursor: string | undefined = first.next;
  while (cursor !== undefined) {
    const page = (await (await s.fetch(`/admin/api/conversations?limit=500&cursor=${encodeURIComponent(cursor)}`, { headers: AUTH })).json()) as { items: { conversationId: string }[]; next?: string };
    expect(page.items.length).toBeLessThanOrEqual(100);
    for (const each of page.items) seen.add(each.conversationId);
    cursor = page.next;
  }
  expect(seen.size).toBe(1_200);
});

test("a page's limit, cursor and state are checked: 400, never a 500", async () => {
  const s = await started();

  for (const limit of ["0", "501", "-1", "1.5", "ten"]) {
    const response = await s.fetch(`/admin/api/conversations?limit=${limit}`, { headers: AUTH });
    expect({ limit, status: response.status }).toEqual({ limit, status: 400 });
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
  }
  const forged = await s.fetch("/admin/api/conversations?cursor=forged", { headers: AUTH });
  expect(forged.status).toBe(400);
  expect(await forged.json()).toMatchObject({ error: "invalid_cursor" });
  for (const state of ["gone", "archived=1", ""]) expect((await s.fetch(`/admin/api/conversations?state=${state}`, { headers: AUTH })).status).toBe(400);
});

test("GET one conversation and its transcript; an unknown one, a malformed id or a key that is not its own is 404", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  s.runtime.transcripts.set("c1", [
    { id: "e2", kind: "message", messages: [{ role: "assistant", content: "hello" }] },
    { id: "e1", kind: "message", messages: [{ role: "user", content: "hi" }] },
  ]);

  const one = await s.fetch(at("telegram:1", "c1"), { headers: AUTH });
  expect(await one.json()).toMatchObject({ conversationId: "telegram:1~c1", current: true, state: "listed", hidden: false });

  const transcript = await s.fetch(at("telegram:1", "c1", "/transcript?limit=1"), { headers: AUTH });
  expect(await transcript.json()).toEqual({ items: [{ id: "e2", kind: "message", messages: [{ role: "assistant", content: "hello" }] }], next: "1" });

  for (const id of ["nope", "telegram:1~nope", "telegram:2~c1", "c1"]) {
    for (const rest of ["", "/transcript", "/events"]) {
      const response = await s.fetch(`/admin/api/conversations/${encodeURIComponent(id)}${rest}`, { headers: AUTH });
      expect({ id, rest, status: response.status }).toEqual({ id, rest, status: 404 });
    }
  }
  expect((await s.fetch("/admin/api/conversations/%E0/transcript", { headers: AUTH })).status).toBe(404);
});

test("GET …/events: the live state whole, then its changes, entries and hints, as server-sent events; the client leaving releases the watch", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  const client = new AbortController();

  const response = await s.fetch(at("telegram:1", "c1", "/events"), { headers: AUTH, signal: client.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const stream = sse(response);
  expect(await stream.take(1)).toEqual([{ type: "live", ops: [["r", { busy: false, tools: [] }]] }]);
  const entry = { id: "e1", kind: "message", messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }] };
  const events: ObservedEvent[] = [
    { type: "live", ops: [["s", ["busy"], true], ["s", ["partial"], { role: "assistant", content: [{ type: "text", text: "hel" }] }]] },
    { type: "live", ops: [["a", ["partial", "content", 0, "text"], "lo"]] },
    { type: "entries", entries: [entry] },
    { type: "live", ops: [["s", ["busy"], false], ["d", ["partial"]]] },
    { type: "usage" },
    { type: "transcript" },
  ];
  for (const event of events) s.runtime.push(event);
  // Verbatim: the ops as the runtime made them, every one.
  expect(await stream.take(events.length)).toEqual(events);

  client.abort();
  await stream.reader.cancel();
  await Bun.sleep(10);
  expect(s.runtime.released).toBe(1);
});

test("GET …/events: a quiet stream gets a heartbeat comment", async () => {
  const s = await started({ heartbeatMs: 1000 });
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  const client = new AbortController();
  const response = await s.fetch(at("telegram:1", "c1", "/events"), { headers: AUTH, signal: client.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let text = "";
  const deadline = Date.now() + 3000;
  while (!text.includes(": heartbeat") && Date.now() < deadline) text += decoder.decode((await reader.read()).value);

  expect(text).toContain(": heartbeat\n\n");
  client.abort();
  await reader.cancel();
});

test("POST …/messages to another channel's conversation: a follow-up, the dashboard's request id, marked for the agent, logged without its text", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant", busy: true });

  const response = await s.fetch(at("telegram:1", "c1", "/messages"), post({ text: "stop and summarise" }));
  const body = (await response.json()) as { requestId: string; admission: string };

  expect(response.status).toBe(202);
  expect(body.admission).toBe("queued");
  expect(body.requestId).toMatch(/^dashboard:[0-9a-f-]{36}$/);
  expect(s.runtime.dispatched).toEqual([
    {
      requestId: body.requestId,
      conversation: { key: "telegram:1", agent: "assistant", conversationId: "c1" },
      prompt: `${OPERATOR_NOTE}: the user of this conversation does not see this message or your answer to it.]\nstop and summarise`,
      whenBusy: "followUp",
      // Its sender is the operator, for the run's tools and hooks (RUN_REQUESTS).
      sender: { channel: "dashboard", id: "ops" },
    },
  ]);
  const log = s.logged.find((each) => each.message.includes("sent a message"));
  expect(log?.fields).toMatchObject({ operator: "ops", conversation: "telegram:1" });
  expect(JSON.stringify(s.logged)).not.toContain("summarise");
});

test("POST …/messages: the client's request id is kept, and must be the dashboard's", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  const response = await s.fetch(at("telegram:1", "c1", "/messages"), post({ text: "hi", requestId: "dashboard:ui-42" }));
  expect(await response.json()).toEqual({ requestId: "dashboard:ui-42", admission: "started" });
  expect(s.runtime.dispatched[0]).toMatchObject({ requestId: "dashboard:ui-42", whenBusy: "followUp" });

  // Another channel's request id, or a steer, are refused: what the dashboard says stays out of the chat.
  for (const body of [{ text: "hi", requestId: "ui:42" }, { text: "hi", requestId: "telegram:7" }, { text: "hi", whenBusy: "steer" }]) {
    expect({ body, status: (await s.fetch(at("telegram:1", "c1", "/messages"), post(body))).status }).toEqual({ body, status: 400 });
  }
  expect(s.runtime.dispatched.length).toBe(1);
});

test("POST /admin/api/conversations: a conversation of the dashboard's own (dashboard:<uuid>), in its operator's space and owned by them, with an agent of the App; its first message is its first title", async () => {
  const s = await started();

  const response = await s.fetch("/admin/api/conversations", post({ agent: "assistant", text: "what changed today?" }));
  const body = (await response.json()) as { conversationId: string; key: string; requestId: string; admission: string };

  expect(response.status).toBe(201);
  expect(body.key).toMatch(/^dashboard:[0-9a-f-]{36}$/);
  expect(body).toMatchObject({ conversationId: `${body.key}~c100`, admission: "started", requestId: expect.stringMatching(/^dashboard:/) });
  // The dashboard's conversation belongs to its channel, `dashboard`, to its operator's space, and to its operator.
  const place = { channel: "dashboard", space: "dashboard:operator:ops", owner: { channel: "dashboard", id: "ops" } };
  expect(s.runtime.pointers.get(body.key)).toEqual({ key: body.key, agent: "assistant", ...place, conversationId: "c100" });
  expect(s.runtime.dispatched).toEqual([
    {
      requestId: body.requestId,
      conversation: { key: body.key, agent: "assistant", ...place, conversationId: "c100" },
      prompt: `${OPERATOR_NOTE}.]\nwhat changed today?`,
      whenBusy: "followUp",
      sender: { channel: "dashboard", id: "ops" },
    },
  ]);
  expect(s.logged.find((each) => each.message.includes("started a conversation"))?.fields).toMatchObject({ operator: "ops", conversation: body.key, agent: "assistant" });
  expect(JSON.stringify(s.logged)).not.toContain("what changed");
  // It is the dashboard's: listed first, titled by what the operator wrote (not the note before it), the operator's own.
  const page = (await (await s.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: ApiConversation[] };
  expect(page.items.map(({ conversationId, title }) => ({ conversationId, title }))).toEqual([{ conversationId: body.conversationId, title: "What changed today?" }]);
  const own = await s.directory.memory.directory.list({ kind: "operator", id: "ops" }, { owned: true }, s.app.context());
  expect(own.items.map((each) => each.key)).toEqual([body.key]);
  // And continued from here.
  expect((await s.fetch(`/admin/api/conversations/${encodeURIComponent(body.conversationId)}/messages`, post({ text: "and yesterday?" }))).status).toBe(202);
  expect(s.runtime.dispatched[1]?.prompt).toBe(`${OPERATOR_NOTE}.]\nand yesterday?`);
});

test("POST /admin/api/conversations: an agent the App does not have, or a bad body, is 400 and makes nothing", async () => {
  const s = await started();

  const unknown = await s.fetch("/admin/api/conversations", post({ agent: "nobody", text: "hi" }));
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toMatchObject({ error: "unknown_agent", message: expect.stringContaining("assistant") });
  for (const body of [{}, { agent: "assistant" }, { agent: "assistant", text: "" }, { agent: "assistant", text: "hi", key: "telegram:1" }, { agent: "assistant", text: "hi", requestId: "x" }]) {
    expect({ body, status: (await s.fetch("/admin/api/conversations", post(body))).status }).toEqual({ body, status: 400 });
  }
  expect(s.runtime.pointers.size).toBe(0);
  expect(s.runtime.dispatched).toEqual([]);
});

test("an id with '.', '/', '@', ':' and '~' is one path segment, encoded, split on its last '~': read and acted on like any other", async () => {
  const s = await started();
  const key = "email:ana@empresa.com/in~box.1";
  s.runtime.add({ conversationId: "c1", key, agent: "assistant" });

  expect(await (await s.fetch(at(key, "c1"), { headers: AUTH })).json()).toMatchObject({ conversationId: `${key}~c1`, key, current: true });
  expect((await s.fetch(at(key, "c1", "/abort"), post())).status).toBe(200);
  expect(s.runtime.aborted[0]).toEqual({ key, agent: "assistant", conversationId: "c1" });
});

test("sessions: the credential once opens a cookie (POST /admin/api/session), which the API then takes; DELETE clears it", async () => {
  const s = await started();
  const client = { [ADMIN_CLIENT_HEADER]: "1" };

  const opened = await s.fetch("/admin/api/session", { method: "POST", headers: { ...AUTH, ...client } });
  expect(opened.status).toBe(200);
  expect(await opened.json()).toEqual({ operator: "ops" });
  expect(opened.headers.get("set-cookie")).toStartWith(SESSION);
  expect(opened.headers.get("cache-control")).toBe("no-store");
  expect(s.logged.some((each) => each.message.includes("signed in") && each.fields?.operator === "ops")).toBe(true);

  expect((await s.fetch("/admin/api/app", { headers: { cookie: SESSION } })).status).toBe(200);
  // Without the client's header the cookie changes nothing; with it, it does.
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  expect((await s.fetch(at("telegram:1", "c1", "/abort"), { method: "POST", headers: { cookie: SESSION } })).status).toBe(401);
  expect((await s.fetch(at("telegram:1", "c1", "/abort"), { method: "POST", headers: { cookie: SESSION, ...client } })).status).toBe(200);

  const closed = await s.fetch("/admin/api/session", { method: "DELETE", headers: client });
  expect(closed.status).toBe(204);
  expect(closed.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("sessions: a wrong credential is 401; without the client's header the session's routes refuse (a page of another site cannot sign in or out)", async () => {
  const s = await started();

  expect((await s.fetch("/admin/api/session", { method: "POST", headers: { authorization: "Bearer wrong", [ADMIN_CLIENT_HEADER]: "1" } })).status).toBe(401);
  expect((await s.fetch("/admin/api/session", { method: "POST", headers: { [ADMIN_CLIENT_HEADER]: "1" } })).status).toBe(401);
  for (const method of ["POST", "DELETE"]) {
    const response = await s.fetch("/admin/api/session", { method, headers: AUTH });
    expect({ method, status: response.status, cookie: response.headers.get("set-cookie") }).toEqual({ method, status: 400, cookie: null });
  }
});

test("GET /admin/api/agents: the App's agents by name, their model, the names of the tools they are defined with, and which is the steward", async () => {
  const s = await started();

  const response = await s.fetch("/admin/api/agents", { headers: AUTH });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    items: [
      { name: "assistant", model: "test/model", tools: [], steward: true },
      { name: "searcher", model: "test/search", tools: ["websearch", "lookup"], steward: false },
    ],
    // No agent.tool or agent.skill installed: only the tool object searcher holds, with no description.
    tools: [{ name: "lookup", summary: "" }],
    skills: [],
  });
});

test("GET /admin/api/agents: every tool and skill an agent may have, each with its one line (a tool's summary, else its description's first sentence)", async () => {
  const installed = defineComponent({
    name: "catalog-test",
    setup(pikit) {
      pikit.provideKeyed("agent.tool", "fetch", { name: "fetch", summary: "Reads a web page or an API at a URL, as text", description: "Makes one HTTP(S) request. Long text for the model." } as never);
      pikit.provideKeyed("agent.tool", "bash", { name: "bash", description: "Execute a bash command in the current working directory. Returns stdout." } as never);
      pikit.provideKeyed("agent.tool", "websearch", { name: "websearch", summary: "   ", description: "Searches the web\n  with Brave" } as never);
      pikit.provideKeyed("agent.skill", "email-writer", {
        name: "email-writer",
        description: "Writes a clear, friendly email from a few notes, in the tone the person asks for, ready to send to anyone at all. Use when asked to draft an email.",
        instructions: "",
      });
    },
  });
  const s = await started({}, [installed]);

  const read = (await (await s.fetch("/admin/api/agents", { headers: AUTH })).json()) as { tools: unknown; skills: unknown };

  expect(read.tools).toEqual([
    // The installed ones by name, then the tool object searcher holds itself.
    { name: "bash", summary: "Execute a bash command in the current working directory" },
    { name: "fetch", summary: "Reads a web page or an API at a URL, as text" },
    { name: "websearch", summary: "Searches the web with Brave" },
    { name: "lookup", summary: "" },
  ]);
  // A long first sentence is cut at a word, with an ellipsis, under 90 characters.
  expect(read.skills).toEqual([{ name: "email-writer", summary: "Writes a clear, friendly email from a few notes, in the tone the person asks for, ready…" }]);
  expect(((read.skills as { summary: string }[])[0]?.summary.length ?? 0) <= 90).toBe(true);
});

test("GET /admin/api/agents with agent.directory: the live agents after the code's, marked, with their description; one starts a conversation", async () => {
  const live = defineComponent({
    name: "live-agents-test",
    setup(pikit) {
      const support = { name: "support", description: "Answers customers", model: "test/model", tools: ["lookup"] };
      pikit.provide("agent.directory", { list: async () => [support], get: async (name) => (name === "support" ? support : undefined) });
    },
  });
  const s = await started({}, [live]);

  expect(await (await s.fetch("/admin/api/agents", { headers: AUTH })).json()).toEqual({
    items: [
      { name: "assistant", model: "test/model", tools: [], steward: true },
      { name: "searcher", model: "test/search", tools: ["websearch", "lookup"], steward: false },
      { name: "support", live: true, description: "Answers customers", model: "test/model", tools: ["lookup"], steward: false },
    ],
    tools: [{ name: "lookup", summary: "" }],
    skills: [],
  });
  const response = await s.fetch("/admin/api/conversations", post({ agent: "support", text: "hello" }));
  expect(response.status).toBe(201);
  expect(s.runtime.dispatched[0]?.conversation.agent).toBe("support");
});

test("POST …/messages with images: they reach the agent's request after the marked text; the text may be empty; the log counts them", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "dashboard:1", agent: "assistant" });
  const path = at("dashboard:1", "c1", "/messages");

  const response = await s.fetch(path, post({ text: "what is this?", attachments: [{ kind: "image", mimeType: "image/png", data: PIXEL }, imageOf(10, "image/webp")] }));
  expect(response.status).toBe(202);
  expect(s.runtime.dispatched[0]).toMatchObject({
    prompt: `${OPERATOR_NOTE}.]\nwhat is this?`,
    images: [{ mimeType: "image/png", data: PIXEL }, { mimeType: "image/webp", data: imageOf(10).data }],
  });
  expect(s.logged.find((each) => each.message.includes("sent a message"))?.fields).toMatchObject({ images: 2 });
  expect(JSON.stringify(s.logged)).not.toContain(PIXEL);

  expect((await s.fetch(path, post({ text: "", attachments: [imageOf(3)] }))).status).toBe(202);
  expect(s.runtime.dispatched[1]).toMatchObject({ prompt: `${OPERATOR_NOTE}.]\n`, images: [{ mimeType: "image/png" }] });
  // Without images the request has none.
  await s.fetch(path, post({ text: "plain" }));
  expect(s.runtime.dispatched[2]?.images).toBeUndefined();

  // A new conversation takes them too.
  const started2 = await s.fetch("/admin/api/conversations", post({ agent: "assistant", text: "", attachments: [imageOf(3, "image/gif")] }));
  expect(started2.status).toBe(201);
  expect(s.runtime.dispatched[3]?.images).toEqual([{ mimeType: "image/gif", data: imageOf(3).data }]);
});

test("images are checked: more than 4, a type that is not an image the API takes, or not base64 is 400; one over 5 MB, or a larger body, 413; nothing is dispatched", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "dashboard:1", agent: "assistant" });
  const send = (body: unknown) => s.fetch(at("dashboard:1", "c1", "/messages"), post(body));

  const cases: [unknown, number, string][] = [
    [{ text: "" }, 400, "invalid_request"],
    [{ text: "", attachments: [] }, 400, "invalid_request"],
    [{ text: "hi", attachments: Array.from({ length: 5 }, () => imageOf(3)) }, 400, "invalid_request"],
    [{ text: "hi", attachments: [imageOf(3, "image/svg+xml")] }, 400, "invalid_request"],
    [{ text: "hi", attachments: [imageOf(3, "application/pdf")] }, 400, "invalid_request"],
    [{ text: "hi", attachments: [{ kind: "image", mimeType: "image/png", data: "not base64!" }] }, 400, "invalid_request"],
    [{ text: "hi", attachments: [{ kind: "file", mimeType: "image/png", data: PIXEL }] }, 400, "invalid_request"],
    [{ text: "hi", attachments: [imageOf(MAX_IMAGE_BYTES + 1)] }, 413, "too_large"],
  ];
  for (const [body, status, error] of cases) {
    const response = await send(body);
    expect({ body: JSON.stringify(body).slice(0, 120), status: response.status, error: ((await response.json()) as { error: string }).error }).toEqual({ body: JSON.stringify(body).slice(0, 120), status, error });
  }
  // 4 of 5 MB each are taken.
  expect((await send({ text: "hi", attachments: Array.from({ length: 4 }, () => imageOf(MAX_IMAGE_BYTES)) })).status).toBe(202);
  // A body larger than any message can be is refused before it is read.
  const huge = await s.fetch(at("dashboard:1", "c1", "/messages"), { method: "POST", headers: { ...AUTH, "content-type": "application/json", "content-length": String(64 * 1024 * 1024) }, body: "{}" });
  expect(huge.status).toBe(413);
  // A new conversation is checked the same, and none is made.
  expect((await s.fetch("/admin/api/conversations", post({ agent: "assistant", text: "hi", attachments: [imageOf(MAX_IMAGE_BYTES + 1)] }))).status).toBe(413);
  expect(s.runtime.dispatched.length).toBe(1);
  expect([...s.runtime.pointers.keys()]).toEqual(["dashboard:1"]);
});

test("webSearch: the agent's first line asks it to search the web, for an agent with the websearch tool; another is 400 and nothing is made", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "searcher" });
  s.runtime.add({ conversationId: "c2", key: "telegram:2", agent: "assistant" });

  expect((await s.fetch(at("telegram:1", "c1", "/messages"), post({ text: "news?", webSearch: true }))).status).toBe(202);
  expect(s.runtime.dispatched[0]?.prompt).toBe(
    `${OPERATOR_NOTE}: the user of this conversation does not see this message or your answer to it; search the web for it with the websearch tool before you answer.]\nnews?`,
  );
  expect(s.logged.find((each) => each.message.includes("sent a message"))?.fields).toMatchObject({ webSearch: true });

  const refused = await s.fetch(at("telegram:2", "c2", "/messages"), post({ text: "news?", webSearch: true }));
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining("websearch") });
  // `false` is a message like any other.
  expect((await s.fetch(at("telegram:2", "c2", "/messages"), post({ text: "hi", webSearch: false }))).status).toBe(202);
  expect(s.runtime.dispatched[1]?.prompt).toBe(`${OPERATOR_NOTE}: the user of this conversation does not see this message or your answer to it.]\nhi`);

  const own = (await (await s.fetch("/admin/api/conversations", post({ agent: "searcher", text: "find it", webSearch: true }))).json()) as { key: string };
  expect(s.runtime.dispatched[2]?.prompt).toBe(`${OPERATOR_NOTE}: search the web for it with the websearch tool before you answer.]\nfind it`);
  expect(s.runtime.pointers.has(own.key)).toBe(true);
  expect((await s.fetch("/admin/api/conversations", post({ agent: "assistant", text: "find it", webSearch: true }))).status).toBe(400);
  expect(s.runtime.pointers.size).toBe(3);
  expect(s.runtime.dispatched.length).toBe(3);
});

test("POST …/messages: a bad body is 400 and dispatches nothing", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  for (const body of [{}, { text: "" }, { text: "hi", whenBusy: "followUp" }, { text: "hi", requestId: "dashboard:a b" }, { text: "hi", extra: 1 }, "x".repeat(10)]) {
    const response = await s.fetch(at("telegram:1", "c1", "/messages"), post(body));
    expect({ body, status: response.status }).toEqual({ body, status: 400 });
  }
  const notJson = await s.fetch(at("telegram:1", "c1", "/messages"), { method: "POST", headers: AUTH, body: "{" });
  expect(notJson.status).toBe(400);
  expect(s.runtime.dispatched).toEqual([]);
});

test("actions reach only a conversation's current one: 409 when a reset left it behind; 404 for one of no key's", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c0", key: "telegram:1", agent: "assistant" }, false);
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  // No message reached it and no key points to it: nobody's.
  s.runtime.add({ conversationId: "c2" });

  for (const action of ["messages", "abort", "reset"]) {
    const behind = await s.fetch(at("telegram:1", "c0", `/${action}`), post({ text: "hi" }));
    expect(await behind.json()).toMatchObject({ error: "not_current" });
    expect(behind.status).toBe(409);
    for (const [key, id] of [["telegram:1", "c2"], ["telegram:1", "c9"], ["telegram:2", "c1"]] as const) {
      expect({ key, id, action, status: (await s.fetch(at(key, id, `/${action}`), post({ text: "hi" }))).status }).toEqual({ key, id, action, status: 404 });
    }
  }
  expect(s.runtime.dispatched).toEqual([]);
  expect(s.runtime.aborted).toEqual([]);
  expect(s.runtime.pointers.get("telegram:1")?.conversationId).toBe("c1");
});

test("POST …/abort stops the run through agent.runtime", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant", busy: true });

  const response = await s.fetch(at("telegram:1", "c1", "/abort"), post());

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ conversationId: "telegram:1~c1" });
  expect(s.runtime.aborted).toEqual([{ key: "telegram:1", agent: "assistant", conversationId: "c1" }]);
});

test("POST …/reset points the key to a new conversation through conversations.registry", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  const response = await s.fetch(at("telegram:1", "c1", "/reset"), post());

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ key: "telegram:1", previousConversationId: "telegram:1~c1", conversationId: "telegram:1~c100" });
  expect(s.runtime.pointers.get("telegram:1")?.conversationId).toBe("c100");
});

test("a reset's new conversation is its key's current one, with the key's agent, before any message reaches it: read, pointed to by the one behind, and talked to at once", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "dashboard:1", agent: "assistant", lastActivity: 1 });
  await s.fetch(at("dashboard:1", "c1", "/reset"), post());
  // The runtime knows no key of it yet.
  expect(s.runtime.conversations.get("c100")?.key).toBeUndefined();

  const one = await s.fetch(at("dashboard:1", "c100"), { headers: AUTH });
  expect(await one.json()).toEqual({
    conversationId: "dashboard:1~c100",
    key: "dashboard:1",
    agent: "assistant",
    busy: false,
    usage: ZERO,
    current: true,
    // The directory holds it (the reset), with no activity yet.
    state: "listed",
    hidden: false,
    party: { channel: { kind: "dashboard", label: "Dashboard" }, name: "You", ids: [{ label: "Key", value: "dashboard:1" }, { label: "Conversation", value: "c100" }] },
  });
  expect(await (await s.fetch(at("dashboard:1", "c1"), { headers: AUTH })).json()).toMatchObject({ current: false, currentId: "dashboard:1~c100" });

  const sent = await s.fetch(at("dashboard:1", "c100", "/messages"), post({ text: "again", requestId: "dashboard:r1" }));
  expect(sent.status).toBe(202);
  expect(s.runtime.dispatched.map((each) => each.conversation)).toEqual([{ key: "dashboard:1", agent: "assistant", conversationId: "c100" }]);
  expect((await s.fetch(at("dashboard:1", "c1", "/messages"), post({ text: "hi" }))).status).toBe(409);
  expect(await listed(s)).toEqual(["dashboard:1~c100", "dashboard:1~c1"]);

  // Reset twice before any message: the one in between is nobody's (its key points elsewhere, no message reached it).
  await s.fetch(at("dashboard:1", "c100", "/reset"), post());
  expect((await s.fetch(at("dashboard:1", "c101", "/reset"), post())).status).toBe(200);
  expect((await s.fetch(at("dashboard:1", "c101"), { headers: AUTH })).status).toBe(404);
  expect((await s.fetch(at("dashboard:1", "c102", "/messages"), post({ text: "hi" }))).status).toBe(202);
});

test("a path under /admin/api/ that no route serves is the API's 404, never the dashboard's page", async () => {
  const s = await started();

  const response = await s.fetch("/admin/api/nothing/here", { headers: AUTH });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not_found" });
  expect((await s.fetch("/admin/api/nothing", { method: "DELETE", headers: AUTH })).status).toBe(404);
});

test("without a built dashboard the API still answers, and /admin/ says why there is no page", async () => {
  const s = await started();

  const page = await s.fetch("/admin/");
  expect(page.status).toBe(404);
  expect(await page.text()).toContain("no dashboard is built");
  expect(page.headers.get("content-security-policy")).toBe(CSP);
  expect((await s.fetch("/admin/api/app", { headers: AUTH })).status).toBe(200);
  expect(s.logged.some((each) => each.message.includes("no dashboard is built"))).toBe(true);
});

const PENDING: PendingPiece[] = [
  { idempotencyKey: "c1:m1", index: 0, channel: "telegram", conversationKey: "telegram:1", state: "retrying", attempts: 2, nextAttemptAt: 50, lastError: "rate_limited: wait", possibleDuplicate: false, storedAt: 10 },
  { idempotencyKey: "c1:m2", index: 0, channel: "telegram", conversationKey: "telegram:1", state: "queued", attempts: 0, possibleDuplicate: false, storedAt: 11 },
];
const RECEIPTS: DeliveryReceipt[] = [
  { idempotencyKey: "c1:m0", index: 0, channel: "telegram", conversationKey: "telegram:1", attempts: 1, outcome: { kind: "delivered", platformMessageId: "77", possibleDuplicate: true }, at: 5 },
  { idempotencyKey: "c2:m0", index: 0, channel: "telegram", conversationKey: "telegram:2", attempts: 3, outcome: { kind: "abandoned", reason: "permanent: chat not found" }, at: 6 },
];

/** An outbound queue holding PENDING and RECEIPTS, as admin-api reads it. */
const queue = defineComponent({
  name: "queue-test",
  setup(pikit) {
    const outbound: OutboundQueue = {
      enqueue: async () => {},
      attach: () => {},
      detach: async () => {},
      pending: async (page) => {
        if (page.cursor !== undefined && page.cursor !== "p2") throw new Error("not a cursor of this queue");
        return page.cursor === undefined ? { items: PENDING.slice(0, page.limit ?? 50), next: "p2" } : { items: [] };
      },
      receipts: {
        read: async (after, limit) => {
          if (after !== undefined && !/^r\d$/.test(after)) throw new Error("malformed cursor");
          const from = after === undefined ? 0 : Number(after.slice(1)) + 1;
          return { items: RECEIPTS.slice(from, from + limit).map((fact, i) => ({ cursor: `r${from + i}`, fact })), gap: false };
        },
      },
    };
    pikit.provide("outbound.queue", outbound);
  },
});

test("delivery: what is not delivered yet and what settled, read from outbound.queue, each with the conversation it answers (`<key>~<id>`); never a piece's text", async () => {
  const s = await started({}, [queue]);

  const pending = await s.fetch("/admin/api/delivery/pending?limit=10", { headers: AUTH });
  expect(pending.status).toBe(200);
  expect(await pending.json()).toEqual({ items: PENDING.map((piece) => ({ ...piece, conversationId: "telegram:1~c1" })), next: "p2" });

  const receipts = await s.fetch("/admin/api/delivery/receipts?limit=1", { headers: AUTH });
  expect(await receipts.json()).toEqual({ items: [{ cursor: "r0", ...RECEIPTS[0], conversationId: "telegram:1~c1" }], gap: false, next: "r0" });
  const after = await s.fetch("/admin/api/delivery/receipts?after=r0&limit=5", { headers: AUTH });
  expect(await after.json()).toEqual({ items: [{ cursor: "r1", ...RECEIPTS[1], conversationId: "telegram:2~c2" }], gap: false, next: "r1" });
  // Past the last one, the cursor stays where it was: read on from it later.
  const end = await s.fetch("/admin/api/delivery/receipts?after=r1", { headers: AUTH });
  expect(await end.json()).toEqual({ items: [], gap: false, next: "r1" });

  for (const path of ["/admin/api/delivery/pending?cursor=forged", "/admin/api/delivery/receipts?after=forged", "/admin/api/delivery/receipts?limit=0"]) {
    expect({ path, status: (await s.fetch(path, { headers: AUTH })).status }).toEqual({ path, status: 400 });
  }
  expect((await s.fetch("/admin/api/delivery/pending")).status).toBe(401);
});

test("a delivery's conversation is its answer key's first part: the runtime's id; none for a key of another shape", () => {
  expect(conversationOfAnswer("12:telegram:991")).toBe("12");
  expect(conversationOfAnswer("7:dashboard:5f0c")).toBe("7");
  expect(conversationOfAnswer("no-request")).toBeUndefined();
  expect(conversationOfAnswer(":m1")).toBeUndefined();
  expect(conversationOfAnswer("c1:")).toBeUndefined();
});

test("delivery without an outbound.queue: 404 not_installed, and the rest of the API as before", async () => {
  const s = await started();

  for (const path of ["/admin/api/delivery/pending", "/admin/api/delivery/receipts"]) {
    const response = await s.fetch(path, { headers: AUTH });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_installed" });
  }
});

// For everyone and for me: the directory's titles and states.

test("hide for me: this operator's list only, listed apart (state=hidden), back with new activity; another operator's list keeps it", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant", lastActivity: 1 });
  s.hold({ conversationId: "c2", key: "telegram:2", agent: "assistant", lastActivity: 2 });

  const hidden = await s.fetch(at("telegram:1", "c1", "/hide"), post());
  expect(hidden.status).toBe(200);
  expect(await hidden.json()).toEqual({ conversationId: "telegram:1~c1", state: "listed", hidden: true });
  expect(await listed(s)).toEqual(["telegram:2~c2"]);
  expect(await listed(s, "?state=hidden")).toEqual(["telegram:1~c1"]);
  expect(await (await s.fetch(at("telegram:1", "c1"), { headers: AUTH })).json()).toMatchObject({ hidden: true, state: "listed" });
  const other = await s.directory.memory.directory.list({ kind: "operator", id: "another" }, {}, s.app.context());
  expect(other.items.map((each) => each.key)).toEqual(["telegram:2", "telegram:1"]);
  expect(s.logged.find((each) => each.message.includes("operator's hide"))?.fields).toEqual({ operator: "ops", conversation: "telegram:1~c1" });

  // Shown again by hand, or by new activity.
  expect(await (await s.fetch(at("telegram:1", "c1", "/unhide"), post())).json()).toEqual({ conversationId: "telegram:1~c1", state: "listed", hidden: false });
  await s.fetch(at("telegram:2", "c2", "/hide"), post());
  await s.app.context().emit("agent.dispatched", { conversation: { key: "telegram:2", agent: "assistant", conversationId: "c2" }, admission: { kind: "started", requestId: "m9" } });
  expect(await listed(s)).toEqual(["telegram:2~c2", "telegram:1~c1"]);
});

test("archive for everyone: listed apart (state=archived), back with activity people see, never with an operator's; restore", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant", lastActivity: 1 });
  s.hold({ conversationId: "c2", key: "telegram:2", agent: "assistant", lastActivity: 2 });
  const ctx = s.app.context();
  const dispatched = (requestId: string) => ctx.emit("agent.dispatched", { conversation: { key: "telegram:1", agent: "assistant", conversationId: "c1" }, admission: { kind: "started", requestId } });

  const archived = await s.fetch(at("telegram:1", "c1", "/archive"), post());
  expect(await archived.json()).toEqual({ conversationId: "telegram:1~c1", state: "archived", hidden: false });
  expect(await listed(s)).toEqual(["telegram:2~c2"]);
  expect(await listed(s, "?state=archived")).toEqual(["telegram:1~c1"]);
  // For everyone: any viewer of the directory sees it archived.
  expect((await s.directory.memory.directory.access({ kind: "component", name: "test" }, { key: "telegram:1" }, ctx))?.state).toBe("archived");

  // An operator's follow-up keeps it archived; a message of its person lists it again.
  await dispatched("dashboard:x");
  expect(await listed(s, "?state=archived")).toEqual(["telegram:1~c1"]);
  await dispatched("m9");
  expect(await listed(s)).toEqual(["telegram:1~c1", "telegram:2~c2"]);

  await s.fetch(at("telegram:2", "c2", "/archive"), post());
  expect(await (await s.fetch(at("telegram:2", "c2", "/restore"), post())).json()).toEqual({ conversationId: "telegram:2~c2", state: "listed", hidden: false });
  expect(await listed(s, "?state=archived")).toEqual([]);
});

test("delete for everyone: listed only as deleted (state=deleted), whatever comes; its key starts a new conversation; restore; nothing of the runtime's deleted", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant", lastActivity: 1 });
  s.hold({ conversationId: "c2", key: "dashboard:2", agent: "assistant", lastActivity: 2 });

  const deleted = await s.fetch(at("dashboard:2", "c2", "/delete"), post());
  expect(await deleted.json()).toEqual({ conversationId: "dashboard:2~c2", state: "deleted", hidden: false });
  expect(await listed(s)).toEqual(["telegram:1~c1"]);
  expect(await listed(s, "?state=deleted")).toEqual(["dashboard:2~c2"]);
  // The key's next message goes to a new conversation; the deleted one is behind it.
  expect(s.runtime.pointers.get("dashboard:2")?.conversationId).toBe("c100");
  expect(await (await s.fetch(at("dashboard:2", "c2"), { headers: AUTH })).json()).toMatchObject({ state: "deleted", current: false, currentId: "dashboard:2~c100" });
  await s.app.context().emit("agent.settled", { conversation: { key: "dashboard:2", agent: "assistant", conversationId: "c2" }, requestId: "late", requestIds: ["late"], kind: "completed", messages: [] });
  expect(await listed(s, "?state=deleted")).toEqual(["dashboard:2~c2"]);
  expect(s.runtime.conversations.has("c2")).toBe(true);

  expect(await (await s.fetch(at("dashboard:2", "c2", "/restore"), post())).json()).toMatchObject({ state: "listed" });
  expect(await listed(s)).toEqual(["dashboard:2~c2", "telegram:1~c1"]);

  for (const path of [at("telegram:9", "c1", "/archive"), at("telegram:1", "c9", "/delete"), at("telegram:1", "c9", "/hide"), "/admin/api/conversations/c1/restore"]) {
    expect({ path, status: (await s.fetch(path, post())).status }).toEqual({ path, status: 404 });
  }
  expect((await s.fetch(at("telegram:1", "c1", "/delete"), { method: "POST" })).status).toBe(401);
});

test("rename: the title for everyone, cleaned, on any conversation the directory holds (archived, left behind by a reset); in the list too; logged without it; empty 400, unknown 404", async () => {
  const s = await started();
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant", lastActivity: 1 });
  const rename = (id: string, body: unknown) => s.fetch(at("telegram:1", id, "/rename"), post(body));
  const titleOf = async (id: string) => ((await (await s.fetch(at("telegram:1", id), { headers: AUTH })).json()) as { title?: string }).title;

  const renamed = await rename("c1", { title: '  "trip to Lisbon."  ' });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ conversationId: "telegram:1~c1", key: "telegram:1", title: "Trip to Lisbon" });
  expect(await titleOf("c1")).toBe("Trip to Lisbon");
  const page = (await (await s.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: { conversationId: string; title?: string }[] };
  expect(page.items.find((each) => each.conversationId === "telegram:1~c1")?.title).toBe("Trip to Lisbon");
  expect(s.logged.find((each) => each.message.includes("renamed"))?.fields).toEqual({ operator: "ops", conversation: "telegram:1" });
  expect(JSON.stringify(s.logged)).not.toContain("Lisbon");
  // The directory's title, the same for every view; a model's title never replaces it.
  await s.directory.memory.directory.title({ key: "telegram:1", conversationId: "c1" }, { text: "A model's", source: "model" }, s.app.context());
  expect((await s.directory.memory.directory.access({ kind: "people", principals: [{ channel: "telegram", id: "1" }] }, { key: "telegram:1" }, s.app.context()))?.title).toBe(undefined);
  expect((await s.directory.memory.directory.access({ kind: "component", name: "test" }, { key: "telegram:1" }, s.app.context()))?.title).toBe("Trip to Lisbon");

  // Archived, then left behind by a reset: still renamed (the list's rows, not an action on the key).
  expect((await s.fetch(at("telegram:1", "c1", "/archive"), post())).status).toBe(200);
  expect((await s.fetch(at("telegram:1", "c1", "/reset"), post())).status).toBe(200);
  expect(await (await rename("c1", { title: "Old trip" })).json()).toMatchObject({ current: false, title: "Old trip", state: "archived" });

  // Cut as any title is (`TITLE_MAX`).
  const long = "word ".repeat(40);
  expect(((await (await rename("c1", { title: long })).json()) as { title: string }).title.length).toBeLessThanOrEqual(60);

  for (const body of [{ title: "  " }, { title: '""' }, {}, { title: 5 }, { title: "x", more: 1 }, { title: "x".repeat(4_001) }]) {
    const refused = await rename("c1", body);
    expect({ body, status: refused.status }).toEqual({ body, status: 400 });
  }
  expect(await (await rename("c9", { title: "x" })).json()).toMatchObject({ error: "not_found" });
  expect((await rename("c9", { title: "x" })).status).toBe(404);
  expect((await s.fetch(at("telegram:1", "c1", "/rename"), { method: "POST", body: JSON.stringify({ title: "x" }) })).status).toBe(401);
  expect(await titleOf("c1")).not.toBe("X");
});

test("search (?q=): the directory's, over the title (a channel's first message, a model's, a rename or /name) and the key, any case; within one state; too long 400", async () => {
  const s = await started();
  for (const [n, key] of [[1, "telegram:1"], [2, "telegram:2"], [3, "dashboard:3"], [4, "http:ops-bot"], [5, "telegram:5"]] as const) s.hold({ conversationId: `c${n}`, key, agent: "assistant", lastActivity: n });
  const ctx = s.app.context();

  await s.directory.memory.directory.title({ key: "telegram:1", conversationId: "c1" }, { text: "Trip to Lisbon", source: "model" }, ctx);
  expect(await listed(s, "?q=LISBON")).toEqual(["telegram:1~c1"]);
  await s.directory.memory.directory.title({ key: "telegram:5", conversationId: "c5" }, { text: "groceries for sunday", source: "first" }, ctx);
  expect(await listed(s, "?q=Groceries")).toEqual(["telegram:5~c5"]);

  expect((await s.fetch(at("telegram:2", "c2", "/rename"), post({ title: "Ñandú notes" }))).status).toBe(200);
  expect(await listed(s, `?q=${encodeURIComponent("ñandú")}`)).toEqual(["telegram:2~c2"]);
  expect((await s.fetch(at("dashboard:3", "c3", "/commands/name"), post({ args: "Weekend in Porto" }))).status).toBe(200);
  expect(await listed(s, "?q=porto")).toEqual(["dashboard:3~c3"]);
  // The key.
  expect(await listed(s, "?q=ops-bot")).toEqual(["http:ops-bot~c4"]);

  expect((await s.fetch(at("dashboard:3", "c3", "/archive"), post())).status).toBe(200);
  expect(await listed(s, "?q=porto")).toEqual([]);
  expect(await listed(s, "?q=porto&state=archived")).toEqual(["dashboard:3~c3"]);
  expect((await listed(s, "?q=%20%20")).length).toBe(4);
  expect((await s.fetch(`/admin/api/conversations?q=${"x".repeat(201)}`, { headers: AUTH })).status).toBe(400);
});

// Slash commands (agent.command).

/** A command of the project's own, `/deploy <environment>`, recording where it ran; and one of a malformed name. */
function deployCommand(ran: { conversation: ConversationRef; args: string }[]) {
  return defineComponent({
    name: "deploy-test",
    setup(pikit) {
      const deploy: AgentCommand = {
        description: "Deploy the current branch",
        argumentHint: "<environment>",
        run: async (conversation, args) => {
          ran.push({ conversation, args });
          return { text: `Deploying to ${args}.` };
        },
      };
      pikit.provideKeyed("agent.command", "deploy", deploy);
      pikit.provideKeyed("agent.command", "Bad Name", deploy);
    },
  });
}

const command = (s: Subject, key: string, id: string, name: string, body?: unknown) => s.fetch(at(key, id, `/commands/${encodeURIComponent(name)}`), post(body));
const titleOf = async (s: Subject, key: string, id: string) => ((await (await s.fetch(at(key, id), { headers: AUTH })).json()) as { title?: string }).title;

test("GET /admin/api/commands: the App's slash commands by name (admin-api's /new and /name among them), with their hints and audience (operator when none); a malformed one is left out", async () => {
  const s = await started({}, [deployCommand([])]);

  const response = await s.fetch("/admin/api/commands", { headers: AUTH });

  expect(await response.json()).toEqual({
    items: [
      { name: "deploy", description: "Deploy the current branch", argumentHint: "<environment>", audience: "operator" },
      { name: "name", description: "Set the conversation's title", argumentHint: "<title>", audience: "operator" },
      { name: "new", description: "Start a new conversation: this one is kept, and its key starts again empty", audience: "operator" },
    ],
  });
});

test("POST …/commands/:name runs a command in the conversation, as an action: its note comes back; unknown 404, failing 422, left behind 409; logged by name, never its arguments", async () => {
  const ran: { conversation: ConversationRef; args: string }[] = [];
  const s = await started({}, [deployCommand(ran)]);
  s.hold({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  const deployed = await command(s, "telegram:1", "c1", "deploy", { args: "  staging  " });
  expect(deployed.status).toBe(200);
  expect(await deployed.json()).toEqual({ text: "Deploying to staging." });
  expect(ran).toEqual([{ conversation: { key: "telegram:1", agent: "assistant", conversationId: "c1" }, args: "staging" }]);
  expect(s.logged.find((each) => each.message.includes("ran a command"))?.fields).toEqual({ operator: "ops", conversation: "telegram:1", command: "deploy" });
  expect(JSON.stringify(s.logged)).not.toContain("staging");
  // Nothing reached the agent: a command is not a message.
  expect(s.runtime.dispatched).toEqual([]);

  expect(await (await command(s, "telegram:1", "c1", "nope")).json()).toMatchObject({ error: "unknown_command" });
  expect((await command(s, "telegram:1", "c1", "nope")).status).toBe(404);
  expect((await command(s, "telegram:1", "c1", "Bad Name")).status).toBe(404);
  const failing = await command(s, "telegram:1", "c1", "name", { args: "  " });
  expect(failing.status).toBe(422);
  expect(await failing.json()).toEqual({ error: "command_failed", message: "Write the title after the command: /name <title>" });
  expect((await command(s, "telegram:1", "c1", "name", { args: 5 })).status).toBe(400);
  expect((await command(s, "telegram:1", "c1", "name", { title: "x" })).status).toBe(400);
  expect((await s.fetch("/admin/api/conversations/nobody/commands/name", post({ args: "x" }))).status).toBe(404);

  // /name: the conversation's title for everyone (the directory's), in it and in the list.
  const named = await command(s, "telegram:1", "c1", "name", { args: '"Trip to Lisbon."' });
  expect(await named.json()).toEqual({ text: "Titled “Trip to Lisbon”." });
  expect(await titleOf(s, "telegram:1", "c1")).toBe("Trip to Lisbon");
  expect((await s.directory.memory.directory.access({ kind: "component", name: "test" }, { key: "telegram:1" }, s.app.context()))?.titleSource).toBe("rename");
  const page = (await (await s.fetch("/admin/api/conversations", { headers: AUTH })).json()) as { items: { conversationId: string; title?: string }[] };
  expect(page.items.find((each) => each.conversationId === "telegram:1~c1")?.title).toBe("Trip to Lisbon");

  // /new: the key starts again in a new conversation, with no title of its own yet; the old one is behind, with its title.
  const fresh = await command(s, "telegram:1", "c1", "new");
  expect(await fresh.json()).toEqual({ text: "A new conversation started; the previous one is kept, and can be read." });
  expect(s.runtime.pointers.get("telegram:1")?.conversationId).toBe("c100");
  const reset = (await (await s.fetch(at("telegram:1", "c100"), { headers: AUTH })).json()) as { title?: string };
  expect(reset).toMatchObject({ key: "telegram:1", current: true });
  expect(reset.title).toBeUndefined();
  expect(await (await s.fetch(at("telegram:1", "c1"), { headers: AUTH })).json()).toMatchObject({ title: "Trip to Lisbon", currentId: "telegram:1~c100" });
  const behind = await command(s, "telegram:1", "c1", "name", { args: "Too late" });
  expect(behind.status).toBe(409);
  expect(await behind.json()).toMatchObject({ error: "not_current" });
  // The new one is titled at once, before any message.
  expect(await (await command(s, "telegram:1", "c100", "name", { args: "Fresh start" })).json()).toEqual({ text: "Titled “Fresh start”." });
});

test("a command for some agents: listed with them; run in another agent's conversation, refused (422, saying so) without running", async () => {
  let runs = 0;
  const audit = defineComponent({
    name: "audit-test",
    setup: (pikit) => pikit.provideKeyed("agent.command", "audit", { description: "Audit", audience: "user", agents: ["trader"], run: async () => ({ text: `ran ${++runs}` }) }),
  });
  const s = await started({}, [audit]);
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  s.runtime.add({ conversationId: "c2", key: "telegram:2", agent: "trader" });

  const listedCommands = (await (await s.fetch("/admin/api/commands", { headers: AUTH })).json()) as ApiCommands;
  expect(listedCommands.items.find((each) => each.name === "audit")).toEqual({ name: "audit", description: "Audit", audience: "user", agents: ["trader"] });
  expect(listedCommands.items.find((each) => each.name === "new")?.agents).toBeUndefined();

  const refused = await command(s, "telegram:1", "c1", "audit");
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ error: "command_failed", message: '/audit is not a command of the agent "assistant"' });
  expect(runs).toBe(0);
  expect(await (await command(s, "telegram:2", "c2", "audit")).json()).toEqual({ text: "ran 1" });
});

test("POST …/commands/:name of a command that answers a prompt (a prompt template): the prompt goes to the agent as the operator's message, its answer the dashboard's", async () => {
  const review = defineComponent({
    name: "review-test",
    setup: (pikit) => pikit.provideKeyed("agent.command", "review", { description: "Review", audience: "user", run: async (_conversation, args) => ({ prompt: `Review ${args}.` }) }),
  });
  const s = await started({}, [review]);
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  const reviewed = await command(s, "telegram:1", "c1", "review", { args: "the API" });
  expect(reviewed.status).toBe(200);
  expect(await reviewed.json()).toEqual({});
  expect(s.runtime.dispatched).toEqual([expect.objectContaining({ requestId: expect.stringMatching(/^dashboard:/), prompt: operatorPrompt("telegram:1", "Review the API."), whenBusy: "followUp" })]);
});

// admin-api's own commands pass the agent.command suite: /name titles the conversation in the directory, /new resets its key.
for (const c of createAgentCommandConformance(() => {
  const runtime = new Runtime();
  const directory = new Directory(async () => {});
  return {
    components: [auth, agents, runtime.component(), directory.component(), adminApi],
    // A message reached it: the directory holds it.
    conversation: async (_app, ctx) => {
      const conversation = await runtime.registry.resolve("dashboard:suite", "assistant", { channel: "test" }, ctx);
      await runtime.runtime.dispatch({ requestId: "m1", conversation, prompt: "hi" }, ctx);
      return conversation;
    },
    runs: [
      {
        name: "name",
        args: "Weekend plans",
        check: async (outcome, conversation, _app, ctx) => {
          expect(outcome.text).toBe("Titled “Weekend plans”.");
          expect((await directory.memory.directory.access({ kind: "component", name: "suite" }, conversation, ctx))?.title).toBe("Weekend plans");
        },
      },
      {
        name: "new",
        check: async (_outcome, conversation) => {
          expect(runtime.pointers.get(conversation.key)?.conversationId).not.toBe(conversation.conversationId);
        },
      },
    ],
    failures: [{ name: "name", args: "" }],
  };
})) {
  test(`admin-api's commands ${c.group}: ${c.name}`, () => c.run());
}
