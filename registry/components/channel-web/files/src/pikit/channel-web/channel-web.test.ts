/**
 * channel-web on a server: every route of the chat API and the operator's, over the runtime's doubles
 * (`runtime.test-support.ts`), the accounts' double, and a real `storage.sql` (SQLite). Isolation is
 * adversarial: a user with another user's chat id gets `404` on every route, and an operator's
 * follow-up in a user's conversation never reaches that user.
 */

import { afterEach, expect, test } from "bun:test";
import { type ComponentDefinition, defineApp, defineComponent, halt, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { type ChatConversation, type ChatMessage, MAX_DURABLE_IMAGE_BYTES, MAX_IMAGE_BYTES, PAGE_TEXT_MAX, TITLE_MAX } from "./api.ts";
import { chatIdFor, cleanTitle, keyOf, parseKey } from "./chat.ts";
import channelWeb, { createChannelWeb, NAME } from "./index.ts";
import { avatarHosts, cspOf } from "./assets.ts";
import { maxBodyOf } from "./routes.ts";
import { adminAuth, eventually, FakeAccounts, imageOf, kvOf, OPERATOR, PIXEL, Runtime, router, SECRETS, type Served, secretsOf, serve, sse } from "./runtime.test-support.ts";

const apps: Served[] = [];
afterEach(async () => {
  for (const served of apps.splice(0)) await served.app.stop();
});

interface Chat {
  served: Served;
  runtime: Runtime;
  accounts: FakeAccounts;
}

async function chat(options: { admin?: boolean; config?: Record<string, unknown>; components?: ComponentDefinition[]; secrets?: Record<string, string> } = {}): Promise<Chat> {
  const runtime = new Runtime();
  const accounts = new FakeAccounts();
  accounts.add("ana");
  accounts.add("ben");
  const served = await serve(
    [
      secretsOf(options.secrets),
      runtime.component(),
      kvOf(),
      sqliteStorage(),
      router,
      ...(options.admin === true ? [adminAuth] : []),
      ...(options.components ?? []),
      createChannelWeb({ accounts: accounts.wiring() }),
    ],
    { [NAME]: options.config ?? {} },
  );
  apps.push(served);
  return { served, runtime, accounts };
}

const as = (user: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...FakeAccounts.session(user), "x-pikit-chat": "1", "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
});
const post = (user: string, body: unknown, method = "POST"): RequestInit => as(user, { method, body: JSON.stringify(body) });
const API = "/chat/api";

/** `user` starts a conversation with `text`: its chat id and request id. */
async function start(c: Chat, user: string, text = "hello", extra: Record<string, unknown> = {}): Promise<{ id: string; requestId: string; admission: string }> {
  const response = await c.served.fetch(`${API}/conversations`, post(user, { text, ...extra }));
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; requestId: string; admission: string };
}

const messagesOf = async (c: Chat, user: string, id: string): Promise<ChatMessage[]> =>
  ((await (await c.served.fetch(`${API}/conversations/${id}/messages`, as(user))).json()) as { items: ChatMessage[] }).items;

test("keys: web:<user>:<chat id>, the chat id a UUID; parsed back; nothing else is a key of the channel", async () => {
  const id = crypto.randomUUID();
  expect(keyOf("ana", id)).toBe(`web:ana:${id}`);
  expect(parseKey(`web:ana:${id}`)).toEqual({ userId: "ana", chatId: id });
  expect(parseKey(`web:a:b:${id}`)).toEqual({ userId: "a:b", chatId: id });
  for (const key of ["telegram:1", "web:ana", `web::${id}`, "web:ana:not-a-uuid", `dashboard:${id}`]) expect({ key, parsed: parseKey(key) }).toEqual({ key, parsed: undefined });
  expect(() => keyOf("ana", "../x")).toThrow();
  expect(await chatIdFor("ana", "web:1")).toBe(await chatIdFor("ana", "web:1"));
  expect(await chatIdFor("ana", "web:1")).not.toBe(await chatIdFor("ben", "web:1"));
  expect(await chatIdFor("ana", "web:1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(cleanTitle("  \n hello   there \n more")).toBe("hello there");
  expect(cleanTitle("x".repeat(100))?.length).toBe(TITLE_MAX);
});

test("GET /chat/api/config needs no session: the name, the target, the methods the config offers, the sign-up mode, whether email is sent", async () => {
  const c = await chat({
    config: { name: "Ada", signIn: { magicLink: false, social: ["google", "github"], oidc: [{ id: "corp", name: "Corp SSO", discoveryUrl: "https://sso.example.com/.well-known/openid-configuration" }] }, signUp: { mode: "allowlist", allow: ["@example.com"] } },
    secrets: { ...SECRETS, CHANNEL_WEB_GOOGLE_CLIENT_ID: "g", CHANNEL_WEB_GOOGLE_CLIENT_SECRET: "gs", CHANNEL_WEB_GITHUB_CLIENT_ID: "h", CHANNEL_WEB_GITHUB_CLIENT_SECRET: "hs", CHANNEL_WEB_OIDC_CORP_CLIENT_ID: "c", CHANNEL_WEB_OIDC_CORP_CLIENT_SECRET: "cs" },
  });
  const response = await c.served.fetch(`${API}/config`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    name: "Ada",
    target: "server",
    methods: [{ kind: "password" }, { kind: "social", id: "google", name: "Google" }, { kind: "social", id: "github", name: "GitHub" }, { kind: "oidc", id: "corp", name: "Corp SSO" }],
    signUp: "allowlist",
    email: false,
  });
});

test("it refuses to start without CHANNEL_WEB_AUTH_SECRET, with a short one, with a provider's client missing (named, never a value), with magicLink and no email.send", async () => {
  const failing = async (secrets: Record<string, string>, config: Record<string, unknown> = {}) => {
    const runtime = new Runtime();
    const app = await defineApp({
      components: [secretsOf(secrets), runtime.component(), kvOf(), sqliteStorage(), router, createChannelWeb({ accounts: new FakeAccounts().wiring() })],
      config: { [NAME]: config },
      logger: silentLogger,
    }).create();
    const error = (await app.start().catch((e: unknown) => e)) as Error;
    return String(error.cause ?? error);
  };
  expect(await failing({})).toContain("set CHANNEL_WEB_AUTH_SECRET");
  expect(await failing({ CHANNEL_WEB_AUTH_SECRET: "short" })).toContain("at least 32 characters");
  const missing = await failing({ ...SECRETS, CHANNEL_WEB_GITLAB_CLIENT_ID: "the-id-value" }, { signIn: { social: ["gitlab"], oidc: [{ id: "my-sso", name: "SSO", discoveryUrl: "https://x.example/.well-known/openid-configuration" }] } });
  expect(missing).toContain("CHANNEL_WEB_GITLAB_CLIENT_SECRET, CHANNEL_WEB_OIDC_MY_SSO_CLIENT_ID, CHANNEL_WEB_OIDC_MY_SSO_CLIENT_SECRET");
  expect(missing).not.toContain("the-id-value");
  expect(await failing(SECRETS, { signIn: { magicLink: true } })).toContain("install an email.send provider");
  expect(await failing(SECRETS, { signIn: { password: false } })).toContain("signIn has no method");
});

test("every route but config and auth needs a session (401); every change also needs x-pikit-chat (400); auth is forwarded as it comes, every set-cookie kept", async () => {
  const c = await chat();
  const id = crypto.randomUUID();
  const routes: [string, string][] = [
    ["GET", "/me"],
    ["GET", "/conversations"],
    ["POST", "/conversations"],
    ["GET", `/conversations/${id}`],
    ["PATCH", `/conversations/${id}`],
    ["DELETE", `/conversations/${id}`],
    ["GET", `/conversations/${id}/messages`],
    ["POST", `/conversations/${id}/messages`],
    ["GET", `/conversations/${id}/events`],
    ["POST", `/conversations/${id}/abort`],
  ];
  for (const [method, path] of routes) {
    const anonymous = await c.served.fetch(`${API}${path}`, { method, headers: { "x-pikit-chat": "1" }, ...(method !== "GET" && { body: "{}" }) });
    expect({ method, path, status: anonymous.status }).toEqual({ method, path, status: 401 });
    const stranger = await c.served.fetch(`${API}${path}`, { method, headers: { ...FakeAccounts.session("nobody"), "x-pikit-chat": "1" } });
    expect({ method, path, status: stranger.status }).toEqual({ method, path, status: 401 });
    if (method !== "GET") {
      const forged = await c.served.fetch(`${API}${path}`, { method, headers: FakeAccounts.session("ana"), body: "{}" });
      expect({ method, path, status: forged.status, body: await forged.json() }).toMatchObject({ method, path, status: 400, body: { error: "invalid_request" } });
    }
  }
  expect(c.runtime.dispatched).toEqual([]);

  const auth = await c.served.fetch(`${API}/auth/sign-in/email`, { method: "POST", body: "{}" });
  expect(await auth.json()).toEqual({ path: "/chat/api/auth/sign-in/email" });
  expect(auth.headers.getSetCookie()).toEqual(["pikit_chat_a=1; Path=/chat/", "pikit_chat_b=2; Path=/chat/"]);
  await c.served.fetch(`${API}/auth/callback/google?code=x`);
  expect(c.accounts.handled).toEqual(["POST /chat/api/auth/sign-in/email", "GET /chat/api/auth/callback/google"]);

  const me = await c.served.fetch(`${API}/me`, as("ana"));
  expect(await me.json()).toEqual({ user: { id: "ana", name: "ana", email: "ana@example.com" }, methods: ["password"] });
  // A banned user's session is no session.
  c.accounts.users.get("ana")!.banned = true;
  expect((await c.served.fetch(`${API}/me`, as("ana"))).status).toBe(401);
});

test("a conversation: started with its first message through admitInbound (the user its sender, the images with it), listed, read, renamed, its messages; an unknown /chat/api path is a JSON 404", async () => {
  const c = await chat();
  const started = await start(c, "ana", "  What is   the plan\nfor today?", { images: [{ mimeType: "image/png", data: PIXEL }] });
  const sent = started.requestId;
  expect({ ...started }).toMatchObject({ admission: "started", requestId: expect.stringMatching(/^web:[0-9a-f-]{36}$/) });
  const key = `web:ana:${started.id}`;
  expect(c.runtime.dispatched).toEqual([
    {
      requestId: started.requestId,
      conversation: { key, agent: "assistant", channel: "web", conversationId: "c1" },
      prompt: "  What is   the plan\nfor today?",
      images: [{ mimeType: "image/png", data: PIXEL }],
      sender: { channel: "web", id: "ana" },
    },
  ]);
  expect(c.served.logged.find((each) => each.message.includes("started a conversation"))?.fields).toEqual({ user: "ana", chat: started.id, requestId: started.requestId, admission: "started", images: 1 });
  expect(JSON.stringify(c.served.logged)).not.toContain("plan");

  const one = (await (await c.served.fetch(`${API}/conversations/${started.id}`, as("ana"))).json()) as ChatConversation;
  expect(one).toMatchObject({ id: started.id, title: "What is the plan", busy: false });
  // A page names its images by URL, never their bytes; each URL serves one image, to its owner only.
  const [message] = await messagesOf(c, "ana", started.id);
  const url = `/chat/api/conversations/${started.id}/messages/${encodeURIComponent(sent)}/images/0`;
  expect(message).toMatchObject({ id: sent, role: "user", state: "pending", images: [{ mimeType: "image/png", url }] });
  expect(message).not.toHaveProperty("conversation");
  expect(JSON.stringify(message)).not.toContain(PIXEL);
  const image = await c.served.fetch(url, as("ana"));
  expect([image.status, image.headers.get("content-type"), image.headers.get("x-content-type-options"), image.headers.get("cache-control")]).toEqual([200, "image/png", "nosniff", "private, max-age=31536000, immutable"]);
  expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(PIXEL);
  for (const [who, path] of [
    ["ben", url],
    ["ana", url.replace(/0$/, "1")],
    ["ana", url.replace(/0$/, "x")],
    ["ana", url.replace(encodeURIComponent(sent), "web%3Anone")],
  ] as const) {
    expect({ who, path, status: (await c.served.fetch(path, as(who))).status }).toEqual({ who, path, status: 404 });
  }
  expect((await c.served.fetch(url)).status).toBe(401);

  const renamed = await c.served.fetch(`${API}/conversations/${started.id}`, post("ana", { title: "  Plans  " }, "PATCH"));
  expect(await renamed.json()).toMatchObject({ id: started.id, title: "Plans" });
  expect((await c.served.fetch(`${API}/conversations/${started.id}`, post("ana", { title: "x".repeat(TITLE_MAX + 1) }, "PATCH"))).status).toBe(400);

  const listed = (await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] };
  expect(listed.items.map((each) => ({ id: each.id, title: each.title }))).toEqual([{ id: started.id, title: "Plans" }]);
  expect(await (await c.served.fetch(`${API}/conversations`, as("ben"))).json()).toEqual({ items: [] });

  const unknown = await c.served.fetch(`${API}/nothing/here`, as("ana"));
  expect({ status: unknown.status, body: await unknown.json() }).toEqual({ status: 404, body: { error: "not_found" } });
});

test("the list: newest activity first, paged with a cursor; a forged cursor is 400; a deleted conversation leaves it and is gone for its user", async () => {
  const c = await chat();
  const ids: string[] = [];
  for (const text of ["one", "two", "three"]) {
    ids.push((await start(c, "ana", text)).id);
    await Bun.sleep(3);
  }
  await c.served.fetch(`${API}/conversations/${ids[0]}/messages`, post("ana", { text: "again" }));
  const first = (await (await c.served.fetch(`${API}/conversations?limit=2`, as("ana"))).json()) as { items: ChatConversation[]; next: string };
  expect(first.items.map((each) => each.title)).toEqual(["one", "three"]);
  const second = (await (await c.served.fetch(`${API}/conversations?limit=2&cursor=${encodeURIComponent(first.next)}`, as("ana"))).json()) as { items: ChatConversation[]; next?: string };
  expect(second.items.map((each) => each.title)).toEqual(["two"]);
  expect(second.next).toBeUndefined();
  for (const query of ["?cursor=forged", "?limit=0", "?limit=101", "?limit=x"]) expect({ query, status: (await c.served.fetch(`${API}/conversations${query}`, as("ana"))).status }).toEqual({ query, status: 400 });

  const deleted = await c.served.fetch(`${API}/conversations/${ids[1]}`, as("ana", { method: "DELETE" }));
  expect(deleted.status).toBe(204);
  const after = (await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] };
  expect(after.items.map((each) => each.id)).toEqual([ids[0] as string, ids[2] as string]);
  for (const path of ["", "/messages", "/events"]) expect((await c.served.fetch(`${API}/conversations/${ids[1]}${path}`, as("ana"))).status).toBe(404);
  expect((await c.served.fetch(`${API}/conversations/${ids[1]}/messages`, post("ana", { text: "hi" }))).status).toBe(404);
  // Nothing of the runtime's is deleted.
  expect(c.runtime.conversations.size).toBe(3);
});

test("ISOLATION: user B naming user A's chat id gets 404 on every route, and A's conversation is untouched", async () => {
  const c = await chat();
  const { id } = await start(c, "ana", "my secret plan");
  const dispatched = c.runtime.dispatched.length;
  const attempts: [string, string, unknown?][] = [
    ["GET", ""],
    ["PATCH", "", { title: "mine now" }],
    ["DELETE", ""],
    ["GET", "/messages"],
    ["POST", "/messages", { text: "hi" }],
    ["GET", "/events"],
    ["POST", "/abort"],
  ];
  for (const [method, path, body] of attempts) {
    const response = await c.served.fetch(`${API}/conversations/${id}${path}`, as("ben", { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
    expect({ method, path, status: response.status, body: await response.json() }).toEqual({ method, path, status: 404, body: { error: "not_found", message: "no such conversation" } });
  }
  // A path that is not a chat id is 404 too, before anything is read.
  for (const bad of ["..%2F..", encodeURIComponent(`ana:${id}`), id.toUpperCase()]) expect((await c.served.fetch(`${API}/conversations/${bad}`, as("ana"))).status).toBe(404);
  expect(c.runtime.dispatched.length).toBe(dispatched);
  expect(c.runtime.aborted).toEqual([]);
  expect(await (await c.served.fetch(`${API}/conversations/${id}`, as("ana"))).json()).toMatchObject({ id, title: "my secret plan" });
  expect((await messagesOf(c, "ana", id)).length).toBe(1);
  // B starting a conversation never lands in A's: their keys differ even for the same request id.
  const theirs = await start(c, "ben", "hello", { requestId: "web:same" });
  const mine = await start(c, "ana", "hello", { requestId: "web:same" });
  expect(theirs.id).not.toBe(mine.id);
  expect(c.runtime.dispatched.slice(-2).map((each) => each.conversation.key)).toEqual([`web:ben:${theirs.id}`, `web:ana:${mine.id}`]);
});

test("an answer is delivered into the conversation: its message answered, the answer stored once (idempotent), a failed run's message failed with no answer", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.start(key, [requestId]);
  await c.runtime.end(key, [requestId], { text: "Hi **there**" });
  const messages = await eventually(async () => {
    const read = await messagesOf(c, "ana", id);
    return read.length === 2 ? read : undefined;
  }, "the answer");
  expect(messages).toMatchObject([
    { role: "assistant", text: "Hi **there**", id: `c1:${requestId}#0` },
    { id: requestId, role: "user", state: "answered" },
  ]);
  expect(await (await c.served.fetch(`${API}/conversations/${id}`, as("ana"))).json()).toMatchObject({ busy: false });

  const sent = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "and now?" }))).json()) as { requestId: string; admission: string };
  expect(sent.admission).toBe("started");
  await c.runtime.end(key, [sent.requestId], { kind: "failed" });
  await eventually(async () => ((await messagesOf(c, "ana", id))[0]?.state === "failed" ? true : undefined), "the failed state");
  await Bun.sleep(50);
  expect((await messagesOf(c, "ana", id)).length).toBe(3);
});

test("a run's end whose event was lost: the message's state comes from agent.submissions when the page reads it", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  await c.runtime.end(`web:ana:${id}`, [requestId], { kind: "aborted", quiet: true });
  const [message] = await messagesOf(c, "ana", id);
  expect(message).toMatchObject({ id: requestId, state: "aborted" });
});

test("an operator's follow-up (dashboard:) in a user's conversation never appears in its messages or its live events", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.start(key, [requestId]);
  await c.runtime.end(key, [requestId], { text: "the user's answer" });
  await eventually(async () => ((await messagesOf(c, "ana", id)).length === 2 ? true : undefined), "the user's answer");

  const client = new AbortController();
  const events = sse(await c.served.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "state", busy: false }]);
  // What admin-api dispatches for an operator: a follow-up whose request id is the dashboard's.
  const conversation = c.runtime.pointers.get(key)!;
  await c.runtime.runtime.dispatch({ requestId: "dashboard:op-1", conversation, prompt: "[From the operator] how is it going?", whenBusy: "followUp" }, c.served.app.context());
  await c.runtime.start(key, ["dashboard:op-1"]);
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [] } });
  c.runtime.push({ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "secret operator answer" }] });
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  c.runtime.push({ type: "tool_execution_end", toolCallId: "t1", result: "files" });
  await c.runtime.end(key, ["dashboard:op-1"], { text: "secret operator answer" });
  expect(await events.take(2)).toEqual([
    { type: "state", busy: true },
    { type: "state", busy: false },
  ]);
  client.abort();
  await events.reader.cancel();
  await Bun.sleep(100);
  const messages = await messagesOf(c, "ana", id);
  expect(messages.length).toBe(2);
  expect(JSON.stringify(messages)).not.toContain("operator");
});

test("live events: state first; while the user waits, the answer as written (text only, no thinking) and the tools' names; a message stored; the client leaving releases the watch", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  const client = new AbortController();
  const response = await c.served.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal }));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = sse(response);
  expect(await events.take(1)).toEqual([{ type: "state", busy: false }]);
  await c.runtime.start(key, [requestId]);
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [] } });
  c.runtime.push({
    type: "message_update",
    changes: [
      { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
      { type: "thinking_delta", contentIndex: 0, delta: "private reasoning" },
      { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
      { type: "text_delta", contentIndex: 1, delta: "Hel" },
    ],
  });
  c.runtime.push({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 1, delta: "lo" }] });
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "websearch", args: { query: "secret args" } });
  c.runtime.push({ type: "tool_execution_update", toolCallId: "t1", output: { append: "tool output" } });
  c.runtime.push({ type: "tool_execution_end", toolCallId: "t1", result: { content: "tool result" } });
  c.runtime.push({ type: "entry_appended", entry: { id: "e1", kind: "message", model: [{ role: "system", content: "system prompt" }] } });
  const seen = await events.take(6);
  expect(seen).toEqual([
    { type: "state", busy: true },
    { type: "partial", text: "", requests: [requestId] },
    { type: "partial", text: "Hel", requests: [requestId] },
    { type: "partial", text: "Hello", requests: [requestId] },
    { type: "tool", name: "websearch", state: "running" },
    { type: "tool", name: "websearch", state: "done" },
  ]);
  await c.runtime.end(key, [requestId], { text: "Hello" });
  // The run ends (its state), its message is answered, its answer stored: in an order the delivery makes.
  const rest = await events.take(3);
  expect(rest).toContainEqual({ type: "state", busy: false });
  expect(rest).toContainEqual({ type: "message", id: requestId });
  const answer = rest.some((each) => (each as { id?: string }).id === `c1:${requestId}#0`) ? [] : await events.take(1);
  // The answer's event names the request its run answered: the page swaps its live text for it.
  expect([...rest, ...answer]).toContainEqual({ type: "message", id: `c1:${requestId}#0`, answers: requestId });
  expect(JSON.stringify([...seen, ...rest, ...answer])).not.toMatch(/private|secret|tool output|tool result|system prompt/);
  client.abort();
  await events.reader.cancel();
  for (let i = 0; i < 50 && c.runtime.released < c.runtime.watching; i++) await Bun.sleep(5);
  expect([c.runtime.watching, c.runtime.released]).toEqual([1, 1]);
});

test("live: a user's message changing state is a message event, at its run's end and when the page's read finds a run end no event brought", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  const client = new AbortController();
  const events = sse(await c.served.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "state", busy: false }]);
  // Its end announced by no event: the page's read finds it (agent.submissions), and the live view hears it.
  await c.runtime.end(key, [requestId], { kind: "aborted", quiet: true });
  expect((await messagesOf(c, "ana", id))[0]).toMatchObject({ id: requestId, state: "aborted" });
  expect(await events.take(1)).toEqual([{ type: "message", id: requestId }]);

  const sent = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "again" }))).json()) as { requestId: string };
  expect(await events.take(1)).toEqual([{ type: "message", id: sent.requestId }]);
  await c.runtime.end(key, [sent.requestId], { kind: "failed" });
  expect(await events.take(1)).toEqual([{ type: "message", id: sent.requestId }]);
  expect((await messagesOf(c, "ana", id))[0]).toMatchObject({ id: sent.requestId, state: "failed" });
  client.abort();
  await events.reader.cancel();
});

test("live: a run is the user's by its inputs' request ids: a fast run whose message is not stored yet streams, with its requests; an operator's run streams nothing while the user waits", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.end(key, [requestId], { text: "first" });
  await eventually(async () => ((await messagesOf(c, "ana", id)).length === 2 ? true : undefined), "the first answer");
  const client = new AbortController();
  const events = sse(await c.served.fetch(`${API}/conversations/${id}/events`, as("ana", { signal: client.signal })));
  expect(await events.take(1)).toEqual([{ type: "state", busy: false }]);

  // A fast run: it starts (and could end) before its user's message is stored; nothing of the user's is pending.
  const fast = "web:fast-1";
  await c.runtime.start(key, [fast], c.runtime.submit([fast]));
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [] } });
  c.runtime.push({ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Quick" }] });
  expect(await events.take(3)).toEqual([
    { type: "state", busy: true },
    { type: "partial", text: "", requests: [fast] },
    { type: "partial", text: "Quick", requests: [fast] },
  ]);
  c.runtime.push({ type: "run_end" });
  expect(await events.take(1)).toEqual([{ type: "state", busy: false }]);

  // The user waits (a message pending), but the run going took only the operator's follow-up: nothing streams.
  const waiting = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "and?" }))).json()) as { requestId: string };
  expect(await events.take(1)).toEqual([{ type: "message", id: waiting.requestId }]);
  await c.runtime.start(key, ["dashboard:op-1"], c.runtime.submit(["dashboard:op-1"]));
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "operator only" }] } });
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  c.runtime.push({ type: "run_end" });
  // A run of both, the operator's first: the user's.
  await c.runtime.start(key, ["dashboard:op-2", waiting.requestId], c.runtime.submit(["dashboard:op-2", waiting.requestId]));
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "both" }] } });
  expect(await events.take(4)).toEqual([
    { type: "state", busy: true },
    { type: "state", busy: false },
    { type: "state", busy: true },
    { type: "partial", text: "both", requests: ["dashboard:op-2", waiting.requestId] },
  ]);
  client.abort();
  await events.reader.cancel();
});

test("RATE: a user's messages a minute (messagesPerMinute), every conversation together; one too many is 429 with retry-after, before anything is admitted; another user is not", async () => {
  const c = await chat({ config: { messagesPerMinute: 2 } });
  const first = await start(c, "ana", "one");
  await start(c, "ana", "two");
  const third = await c.served.fetch(`${API}/conversations/${first.id}/messages`, post("ana", { text: "three" }));
  expect({ status: third.status, body: await third.json() }).toMatchObject({ status: 429, body: { error: "rate_limited" } });
  expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await c.served.fetch(`${API}/conversations`, post("ana", { text: "four" }))).status).toBe(429);
  expect(c.runtime.dispatched.length).toBe(2);
  expect((await start(c, "ben", "mine")).admission).toBe("started");
});

test("a page of messages holds at most PAGE_TEXT_MAX of text (at least one message); its cursor reads on from there", async () => {
  const c = await chat({ config: { messagesPerMinute: 100 } });
  const { id } = await start(c, "ana", "x".repeat(30_000));
  for (let i = 0; i < 40; i++) await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: `${i}`.padEnd(30_000, "y") }));
  const page = (await (await c.served.fetch(`${API}/conversations/${id}/messages?limit=100`, as("ana"))).json()) as { items: ChatMessage[]; next?: string };
  expect(page.items.length).toBe(Math.floor(PAGE_TEXT_MAX / 30_000));
  expect(page.next).toBeDefined();
  const rest = (await (await c.served.fetch(`${API}/conversations/${id}/messages?limit=100&cursor=${encodeURIComponent(page.next ?? "")}`, as("ana"))).json()) as { items: ChatMessage[]; next?: string };
  expect(page.items.length + rest.items.length).toBe(41);
  expect(rest.next).toBeUndefined();
});

test("stop: the run of the key's current conversation is aborted", async () => {
  const c = await chat();
  const { id } = await start(c, "ana", "hello");
  const aborted = await c.served.fetch(`${API}/conversations/${id}/abort`, post("ana", {}));
  expect(await aborted.json()).toEqual({ id });
  expect(c.runtime.aborted).toEqual([{ key: `web:ana:${id}`, agent: "assistant", channel: "web", conversationId: "c1" }]);
  expect(c.served.logged.find((each) => each.message.includes("stopped a run"))?.fields).toEqual({ user: "ana", chat: id });
});

test("duplicates: the same request id runs once and is stored once; a retried start reaches the same conversation", async () => {
  const c = await chat();
  const first = await start(c, "ana", "hello", { requestId: "web:page-1" });
  const again = await start(c, "ana", "hello", { requestId: "web:page-1" });
  expect(again).toEqual({ ...first, admission: "duplicate" });
  const sent = await c.served.fetch(`${API}/conversations/${first.id}/messages`, post("ana", { text: "more", requestId: "web:page-2" }));
  const twice = await c.served.fetch(`${API}/conversations/${first.id}/messages`, post("ana", { text: "more", requestId: "web:page-2" }));
  expect([(await sent.json()) as unknown, (await twice.json()) as unknown]).toEqual([
    { requestId: "web:page-2", admission: "started" },
    { requestId: "web:page-2", admission: "duplicate" },
  ]);
  expect((await messagesOf(c, "ana", first.id)).map((each) => each.id)).toEqual(["web:page-2", "web:page-1"]);
  expect((await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()) as unknown).toMatchObject({ items: [{ id: first.id }] });
});

test("request ids: web: and 1 to 118 of A-Z a-z 0-9 . _ ~ : -; a dashboard: id or anything else is 400 and dispatches nothing", async () => {
  const c = await chat();
  for (const requestId of ["dashboard:x", "web:", `web:${"x".repeat(119)}`, "web:a b", "web:é", "x"]) {
    const response = await c.served.fetch(`${API}/conversations`, post("ana", { text: "hi", requestId }));
    expect({ requestId, status: response.status }).toEqual({ requestId, status: 400 });
  }
  expect(c.runtime.dispatched).toEqual([]);
  expect((await start(c, "ana", "hi", { requestId: `web:a.B_~:-${"9".repeat(100)}` })).admission).toBe("started");
});

test("images and bodies: at most 4, of the image types, base64, 5 MB each (413); something written or attached; a body past the limit is 413 before it is read", async () => {
  const c = await chat();
  const cases: [unknown, number][] = [
    [{ text: "", images: [] }, 400],
    [{ text: "   " }, 400],
    [{ text: "x", images: Array.from({ length: 5 }, () => ({ mimeType: "image/png", data: PIXEL })) }, 400],
    [{ text: "x", images: [{ mimeType: "image/svg+xml", data: PIXEL }] }, 400],
    [{ text: "x", images: [{ mimeType: "image/png", data: "not base64!" }] }, 400],
    [{ text: "x", images: [imageOf(MAX_IMAGE_BYTES + 3)] }, 413],
    [{ text: "x", extra: true }, 400],
    [{ text: "x".repeat(32_001) }, 400],
  ];
  for (const [body, status] of cases) {
    const response = await c.served.fetch(`${API}/conversations`, post("ana", body));
    expect({ status: response.status }).toEqual({ status });
  }
  const max = maxBodyOf("server");
  // What 4 images of 5 MB in base64 and 32,000 characters each escaped need, and under 4 KiB of JSON around them.
  expect(max - (4 * Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32_000 * 6)).toBeLessThan(4 * 1024);
  expect(maxBodyOf("durable")).toBeLessThan(Math.ceil(MAX_DURABLE_IMAGE_BYTES / 3) * 4 + 32_000 * 6 + 4 * 1024);
  const huge = await c.served.fetch(`${API}/conversations`, as("ana", { method: "POST", headers: { "content-length": String(max + 1) }, body: "{}" }));
  expect(huge.status).toBe(413);
  const streamed = await c.served.fetch(`${API}/conversations`, as("ana", { method: "POST", body: "x".repeat(max + 1) }));
  expect(streamed.status).toBe(413);
  expect(c.runtime.dispatched).toEqual([]);
  // On a server 4 images of 1 MB pass (Cloudflare's limit is the Worker's and the object's).
  const many = await start(c, "ana", "", { images: Array.from({ length: 4 }, () => imageOf(MAX_DURABLE_IMAGE_BYTES)) });
  expect(many.admission).toBe("started");
  expect(await (await c.served.fetch(`${API}/conversations/${many.id}`, as("ana"))).json()).toMatchObject({ title: "Image" });
});

test("refusals: the router's deny is 403, a stage's halt 422, no router 500; nothing stored, no conversation made; a runtime that cannot take the message is 503, and the same request later is taken once", async () => {
  const stages = defineComponent({
    name: "stages-test",
    setup: (pikit) => {
      pikit.pipeline("inbound.normalize", (message) => (message.text.includes("[halt]") ? halt("a policy stops it") : message), { id: "policy-test" });
      pikit.pipeline("route.resolve", (value) => (value.message.text.includes("[deny]") ? { ...value, decision: { agent: "assistant", access: "deny", reason: "not you" } } : value), { priority: 10 });
    },
  });
  const c = await chat({ components: [stages] });
  const denied = await c.served.fetch(`${API}/conversations`, post("ana", { text: "[deny]" }));
  expect({ status: denied.status, body: await denied.json() }).toEqual({ status: 403, body: { error: "denied", message: "not you" } });
  const halted = await c.served.fetch(`${API}/conversations`, post("ana", { text: "[halt]" }));
  expect({ status: halted.status, body: await halted.json() }).toEqual({ status: 422, body: { error: "rejected", message: "a policy stops it" } });
  expect(await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()).toEqual({ items: [] });

  c.runtime.failing = 1;
  const failing = await c.served.fetch(`${API}/conversations`, post("ana", { text: "hello", requestId: "web:r1" }));
  expect({ status: failing.status, body: await failing.json() }).toMatchObject({ status: 503, body: { error: "unavailable" } });
  expect(c.served.logged.some((each) => each.level === "warn" && each.message.includes("could not be served"))).toBe(true);
  const retried = await start(c, "ana", "hello", { requestId: "web:r1" });
  expect(retried.admission).toBe("started");

  const noRouter = new Runtime();
  const accounts = new FakeAccounts();
  accounts.add("ana");
  const bare = await serve([secretsOf(), noRouter.component(), kvOf(), sqliteStorage(), createChannelWeb({ accounts: accounts.wiring() })]);
  apps.push(bare);
  const none = await bare.fetch(`${API}/conversations`, post("ana", { text: "hi" }));
  expect({ status: none.status, body: await none.json() }).toMatchObject({ status: 500, body: { error: "no_route" } });
});

test("the page's files: /chat redirects to /chat/, which says no page is built (the kit's empty module), under the chat's CSP", async () => {
  const c = await chat();
  const bare = await c.served.fetch("/chat");
  expect([bare.status, bare.headers.get("location")]).toEqual([308, "/chat/"]);
  const page = await c.served.fetch("/chat/");
  expect(page.status).toBe(404);
  expect(await page.text()).toContain("no chat page is built");
  expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
  // Images of its own only: an answer's image of another site loads nothing (no https: at large).
  expect(page.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:;");
  // With providers, their avatars' hosts, and only theirs: an OIDC platform's (an unknown id) none.
  expect(cspOf(avatarHosts(["google", "github", "corp"]))).toContain("img-src 'self' data: blob: https://*.googleusercontent.com https://avatars.githubusercontent.com;");
});

test("the operator's routes: absent without admin.auth (404); with it 401 without an operator; list, invite (the link answered once, never logged), ban, unban, reset, remove (their conversations leave the list)", async () => {
  const without = await chat();
  expect((await without.served.fetch("/admin/api/channel-web/users", { headers: OPERATOR })).status).toBe(404);

  const c = await chat({ admin: true });
  const { id } = await start(c, "ben", "hello");
  expect((await c.served.fetch("/admin/api/channel-web/users")).status).toBe(401);
  const listed = (await (await c.served.fetch("/admin/api/channel-web/users?limit=1", { headers: OPERATOR })).json()) as { items: { id: string }[]; next?: string };
  expect(listed.items.map((each) => each.id)).toEqual(["ben"]);
  expect(listed.next).toBe("1");

  // Without PIKIT_PUBLIC_URL a server makes links only for a loopback host: any other Host (a client
  // writes it) is 400, and nothing is made.
  const spoofed = (path: string, init: RequestInit = {}) => c.served.fetch(`http://evil.example/admin/api/channel-web${path}`, { ...init, headers: { ...OPERATOR, "content-type": "application/json" } });
  for (const [path, body] of [
    ["/invitations", { email: "cleo@example.com" }],
    ["/users/ben/password-reset", undefined],
  ] as const) {
    const refused = await spoofed(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });
    expect({ path, status: refused.status, error: ((await refused.json()) as { error: string }).error }).toEqual({ path, status: 400, error: "public_url_required" });
  }
  expect(c.accounts.invited).toEqual([]);
  const admin = (path: string, init: RequestInit = {}) => c.served.fetch(`http://localhost:3000/admin/api/channel-web${path}`, { ...init, headers: { ...OPERATOR, "content-type": "application/json" } });
  const invited = await admin("/invitations", { method: "POST", body: JSON.stringify({ email: " Cleo@Example.com ", name: "Cleo" }) });
  expect(invited.status).toBe(201);
  expect(await invited.json()).toEqual({ userId: "u3", link: "http://localhost:3000/chat/invite?token=secret-token", expiresAt: 1_000, emailed: false });
  expect(c.accounts.invited).toEqual([{ email: "cleo@example.com", name: "Cleo", origin: "http://localhost:3000" }]);
  // With PIKIT_PUBLIC_URL every link is under it, whatever the Host.
  const pub = await chat({ admin: true, secrets: { ...SECRETS, PIKIT_PUBLIC_URL: "https://chat.example.com/" } });
  const made = await pub.served.fetch("http://evil.example/admin/api/channel-web/users/ana/password-reset", { method: "POST", headers: OPERATOR });
  expect(((await made.json()) as { link: string }).link).toBe("https://chat.example.com/chat/reset?token=secret-token");
  expect((await admin("/invitations", { method: "POST", body: JSON.stringify({ email: "cleo@example.com" }) })).status).toBe(409);
  expect((await admin("/invitations", { method: "POST", body: JSON.stringify({ email: "nope" }) })).status).toBe(400);

  expect(await (await admin("/users/ben/ban", { method: "POST" })).json()).toEqual({ id: "ben", banned: true });
  expect((await c.served.fetch(`${API}/conversations`, as("ben"))).status).toBe(401);
  expect(await (await admin("/users/ben/unban", { method: "POST" })).json()).toEqual({ id: "ben", banned: false });
  expect((await c.served.fetch(`${API}/conversations`, as("ben"))).status).toBe(200);
  expect(await (await admin("/users/ben/password-reset", { method: "POST" })).json()).toMatchObject({ link: expect.stringContaining("token") });
  expect((await admin("/users/nobody/password-reset", { method: "POST" })).status).toBe(404);

  expect((await admin("/users/ben", { method: "DELETE" })).status).toBe(204);
  expect(c.accounts.users.has("ben")).toBe(false);
  // Signed up again with the same id, they would find no conversation listed; the runtime keeps it.
  c.accounts.add("ben");
  expect(await (await c.served.fetch(`${API}/conversations`, as("ben"))).json()).toEqual({ items: [] });
  expect((await c.served.fetch(`${API}/conversations/${id}`, as("ben"))).status).toBe(404);
  expect(c.runtime.conversations.size).toBe(1);

  const logged = c.served.logged.filter((each) => each.message.includes("an operator"));
  expect(logged.map((each) => each.fields?.operator)).toEqual(["ops", "ops", "ops", "ops", "ops"]);
  expect(JSON.stringify(c.served.logged)).not.toContain("token");
});

test("signUp is a live setting when settings is installed: declared with the config's value, read at each request", async () => {
  const values = new Map<string, Record<string, unknown>>();
  const declared: { component: string; schema: unknown }[] = [];
  const settings = defineComponent({
    name: "settings-test",
    setup: (pikit) =>
      pikit.provide("settings", {
        declare: (component, schema, defaults) => {
          declared.push({ component, schema });
          values.set(component, defaults as Record<string, unknown>);
        },
        get: async (component) => values.get(component) as never,
      }),
  });
  const c = await chat({ components: [settings], config: { signUp: { mode: "open" } } });
  expect(declared.map((each) => each.component)).toEqual([NAME]);
  expect(((await (await c.served.fetch(`${API}/config`)).json()) as { signUp: string }).signUp).toBe("open");
  values.set(NAME, { signUp: { mode: "invite", allow: [] } });
  expect(((await (await c.served.fetch(`${API}/config`)).json()) as { signUp: string }).signUp).toBe("invite");
});

test("what setup declares", async () => {
  const app = await defineApp({ components: [secretsOf(), new Runtime().component(), kvOf(), sqliteStorage(), router, channelWeb], logger: silentLogger }).create();
  const described = app.describe().components.find((each) => each.name === NAME);
  expect(described).toMatchObject({
    name: NAME,
    provides: ["http.route"],
    requires: ["secrets", "conversations.registry", "agent.runtime", "agent.observe", "agent.submissions", "storage.kv", "storage.sql"],
    optional: ["wakeups", "outbound.queue", "actor.inbox", "actor.mailbox", "settings", "email.send", "admin.auth"],
  });
});

for (const c of createLifecycleConformance(() => {
  const runtime = new Runtime();
  return { component: createChannelWeb({ accounts: new FakeAccounts().wiring() }), providers: [secretsOf(), runtime.component(), kvOf(), sqliteStorage(), router] };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
