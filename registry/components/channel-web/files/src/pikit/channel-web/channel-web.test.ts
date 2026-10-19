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
import { type ChatConfig, type ChatConversation, type ChatEvent, type ChatTranscriptEntry, MAX_DURABLE_IMAGE_BYTES, MAX_IMAGE_BYTES, PAGE_JSON_MAX, TITLE_MAX } from "./api.ts";
import { chatIdFor, cleanTitle, keyOf, parseKey } from "./chat.ts";
import { runEntryId } from "./entries.ts";
import channelWeb, { createChannelWeb, NAME } from "./index.ts";
import { avatarHosts, cspOf } from "./assets.ts";
import { maxBodyOf } from "./routes.ts";
import { adminAuth, answerOf, eventually, FakeAccounts, imageOf, kvOf, OPERATOR, PIXEL, Runtime, router, SECRETS, type Served, secretsOf, serve, sse } from "./runtime.test-support.ts";

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

/** `user`'s transcript of chat `id`, newest first. */
const transcriptOf = async (c: Chat, user: string, id: string, query = ""): Promise<ChatTranscriptEntry[]> =>
  ((await (await c.served.fetch(`${API}/conversations/${id}/transcript${query}`, as(user))).json()) as { items: ChatTranscriptEntry[] }).items;

type Shown = { role?: string; content?: unknown; toolName?: string };
/** A transcript, oldest first, a line per message: `user: <text> (<state>)`, `assistant: <text>`, `toolResult: <name>`. */
const linesOf = (entries: ChatTranscriptEntry[]): string[] =>
  [...entries].reverse().flatMap((entry) =>
    (entry.messages as Shown[]).map((message) => {
      const blocks = Array.isArray(message.content) ? (message.content as { type: string; text?: string; thinking?: string; name?: string }[]) : [];
      const text = blocks.map((block) => (block.type === "text" ? block.text : block.type === "thinking" ? `(thinking: ${block.thinking})` : block.type === "toolCall" ? `(${block.name})` : `(${block.type})`)).join(" ");
      if (message.role === "toolResult") return `toolResult: ${message.toolName}`;
      return `${message.role}: ${text}${entry.state === undefined ? "" : ` (${entry.state})`}`;
    }),
  );
const linesNow = async (c: Chat, user: string, id: string): Promise<string[]> => linesOf(await transcriptOf(c, user, id));

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
    visibility: { thinking: false, tools: "names", context: true },
    agents: [],
  } satisfies ChatConfig);
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
    ["POST", `/conversations/${id}/archive`],
    ["POST", `/conversations/${id}/unarchive`],
    ["DELETE", `/conversations/${id}`],
    ["GET", `/conversations/${id}/transcript`],
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

test("a conversation: started with its first message through admitInbound (the user its sender, the images with it), listed, read, renamed, its transcript; an unknown /chat/api path is a JSON 404", async () => {
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
  // The transcript names its images by URL, never their bytes; each URL serves one image, to its owner only.
  const [entry] = await transcriptOf(c, "ana", started.id);
  const url = `/chat/api/conversations/${started.id}/messages/${encodeURIComponent(sent)}/images/0`;
  expect(entry).toEqual({
    id: sent,
    kind: "message",
    messages: [{ role: "user", content: [{ type: "text", text: "  What is   the plan\nfor today?" }, { type: "image", url, mimeType: "image/png" }], timestamp: expect.any(Number) }],
    state: "pending",
  });
  expect(JSON.stringify(entry)).not.toContain(PIXEL);
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
  for (const path of ["", "/transcript", "/events"]) expect((await c.served.fetch(`${API}/conversations/${ids[1]}${path}`, as("ana"))).status).toBe(404);
  expect((await c.served.fetch(`${API}/conversations/${ids[1]}/messages`, post("ana", { text: "hi" }))).status).toBe(404);
  // Nothing of the runtime's is deleted.
  expect(c.runtime.conversations.size).toBe(3);
});

test("archive: listed apart (?archived=1), still read and written to; unarchive puts it back; new activity lists it again; a delete takes it from both lists", async () => {
  const c = await chat();
  const ids: string[] = [];
  for (const text of ["one", "two", "three"]) {
    ids.push((await start(c, "ana", text)).id);
    await Bun.sleep(3);
  }
  const [one, two, three] = ids as [string, string, string];
  const list = async (query = "") => ((await (await c.served.fetch(`${API}/conversations${query}`, as("ana"))).json()) as { items: ChatConversation[] }).items.map((each) => each.title);

  const archived = await c.served.fetch(`${API}/conversations/${two}/archive`, as("ana", { method: "POST" }));
  expect({ status: archived.status, body: await archived.json() }).toMatchObject({ status: 200, body: { id: two, title: "two", archived: true } });
  expect(await list()).toEqual(["three", "one"]);
  expect(await list("?archived=1")).toEqual(["two"]);
  expect(await list("?archived=0")).toEqual(["three", "one"]);
  expect((await c.served.fetch(`${API}/conversations?archived=yes`, as("ana"))).status).toBe(400);
  // Still the user's: read, and archiving twice is the same.
  expect(await (await c.served.fetch(`${API}/conversations/${two}`, as("ana"))).json()).toMatchObject({ id: two, archived: true });
  expect((await transcriptOf(c, "ana", two)).length).toBe(1);
  expect((await c.served.fetch(`${API}/conversations/${two}/archive`, as("ana", { method: "POST" }))).status).toBe(200);

  const back = await c.served.fetch(`${API}/conversations/${two}/unarchive`, as("ana", { method: "POST" }));
  expect(await back.json()).toMatchObject({ id: two, archived: false });
  expect(await list()).toEqual(["three", "two", "one"]);
  expect(await list("?archived=1")).toEqual([]);

  // A message in an archived conversation lists it again, at the top.
  await c.served.fetch(`${API}/conversations/${one}/archive`, as("ana", { method: "POST" }));
  expect(await list()).toEqual(["three", "two"]);
  await Bun.sleep(3);
  expect((await c.served.fetch(`${API}/conversations/${one}/messages`, post("ana", { text: "again" }))).status).toBe(202);
  expect(await list()).toEqual(["one", "three", "two"]);
  expect(await list("?archived=1")).toEqual([]);

  // Deleted while archived: gone from both.
  await c.served.fetch(`${API}/conversations/${three}/archive`, as("ana", { method: "POST" }));
  expect((await c.served.fetch(`${API}/conversations/${three}`, as("ana", { method: "DELETE" }))).status).toBe(204);
  expect(await list("?archived=1")).toEqual([]);
  expect((await c.served.fetch(`${API}/conversations/${three}/unarchive`, as("ana", { method: "POST" }))).status).toBe(404);
});

test("ISOLATION: user B naming user A's chat id gets 404 on every route, and A's conversation is untouched", async () => {
  const c = await chat();
  const { id } = await start(c, "ana", "my secret plan");
  const dispatched = c.runtime.dispatched.length;
  const attempts: [string, string, unknown?][] = [
    ["GET", ""],
    ["PATCH", "", { title: "mine now" }],
    ["POST", "/archive"],
    ["POST", "/unarchive"],
    ["DELETE", ""],
    ["GET", "/transcript"],
    ["GET", "/transcript?limit=1&cursor=1.0%3Aweb%3Ax"],
    ["POST", "/messages", { text: "hi" }],
    ["GET", "/events"],
    ["POST", "/abort"],
  ];
  for (const [method, path, body] of attempts) {
    const response = await c.served.fetch(`${API}/conversations/${id}${path}`, as("ben", { method, ...(body !== undefined && { body: JSON.stringify(body) }) }));
    expect({ method, path, status: response.status, body: await response.json() }).toEqual({ method, path, status: 404, body: { error: "not_found", message: "no such conversation" } });
  }
  // B's lists never show A's, archived or not, searched or not; A's stays in A's list, not archived.
  expect(await (await c.served.fetch(`${API}/conversations?archived=1`, as("ben"))).json()).toEqual({ items: [] });
  expect(await (await c.served.fetch(`${API}/conversations?q=secret`, as("ben"))).json()).toEqual({ items: [] });
  expect(await (await c.served.fetch(`${API}/conversations?q=secret`, as("ana"))).json()).toMatchObject({ items: [{ id }] });
  expect(await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()).toMatchObject({ items: [{ id, archived: false }] });
  // A path that is not a chat id is 404 too, before anything is read.
  for (const bad of ["..%2F..", encodeURIComponent(`ana:${id}`), id.toUpperCase()]) expect((await c.served.fetch(`${API}/conversations/${bad}`, as("ana"))).status).toBe(404);
  expect(c.runtime.dispatched.length).toBe(dispatched);
  expect(c.runtime.aborted).toEqual([]);
  expect(await (await c.served.fetch(`${API}/conversations/${id}`, as("ana"))).json()).toMatchObject({ id, title: "my secret plan" });
  expect((await transcriptOf(c, "ana", id)).length).toBe(1);
  // B starting a conversation never lands in A's: their keys differ even for the same request id.
  const theirs = await start(c, "ben", "hello", { requestId: "web:same" });
  const mine = await start(c, "ana", "hello", { requestId: "web:same" });
  expect(theirs.id).not.toBe(mine.id);
  expect(c.runtime.dispatched.slice(-2).map((each) => each.conversation.key)).toEqual([`web:ben:${theirs.id}`, `web:ana:${mine.id}`]);
});

/** A `settings` provider whose values the test sets: what the operator changes live. */
function liveSettings() {
  const values = new Map<string, Record<string, unknown>>();
  const declared: { component: string; schema: unknown }[] = [];
  const component = defineComponent({
    name: "settings-test",
    setup: (pikit) =>
      pikit.provide("settings", {
        declare: (name, schema, defaults) => {
          declared.push({ component: name, schema });
          values.set(name, defaults as Record<string, unknown>);
        },
        get: async (name) => values.get(name) as never,
      }),
  });
  const set = (change: Record<string, unknown>) => values.set(NAME, { ...values.get(NAME), ...change });
  return { component, values, declared, set };
}

/** The live events of `user`'s chat `id`, and a way to leave. */
async function follow(c: Chat, user: string, id: string) {
  const client = new AbortController();
  const response = await c.served.fetch(`${API}/conversations/${id}/events`, as(user, { signal: client.signal }));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = sse(response);
  return {
    take: (count: number) => events.take(count) as Promise<ChatEvent[]>,
    async close() {
      client.abort();
      await events.reader.cancel();
    },
  };
}

/** A run's tool round: a call (after some thinking, with its arguments) and its result. */
const call = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
    { type: "toolCall", id: "t1", name: "websearch", arguments: { query: "secret query" } },
  ],
  usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.25 } },
  stopReason: "toolUse",
  timestamp: 10,
};
const result = { role: "toolResult", toolCallId: "t1", toolName: "websearch", content: [{ type: "text", text: "secret result" }], details: { raw: "secret details" }, isError: false, timestamp: 11 };
/** What the runtime holds of the user's message (what a stage added to it): never shown. */
const prompt = { role: "user", content: "[sender: ana] hello", timestamp: 9 };

test("HISTORY: a run that answered a user's message is stored when it ends, with the message it answered: its tool round and its answer as the policy shows them, never the runtime's user message; ids stable; stored once", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.start(key, [requestId]);
  const written = [prompt, call, result, answerOf("Hi **there**", 12)];
  await c.runtime.end(key, [requestId], { text: "Hi **there**", messages: written });
  const lines = await eventually(async () => {
    const read = await linesNow(c, "ana", id);
    return read.length === 4 ? read : undefined;
  }, "the run's messages");
  // The defaults: no thinking, a tool by its name only.
  expect(lines).toEqual(["user: hello (answered)", "assistant: (websearch)", "toolResult: websearch", "assistant: Hi **there**"]);
  const entries = await transcriptOf(c, "ana", id);
  expect(entries.map((entry) => entry.id)).toEqual([runEntryId(requestId, written[3]), runEntryId(requestId, result), runEntryId(requestId, call), requestId]);
  expect(entries[1]).toEqual({ id: runEntryId(requestId, result), kind: "message", messages: [{ role: "toolResult", toolCallId: "t1", toolName: "websearch", isError: false, timestamp: 11, content: [] }] });
  expect(JSON.stringify(entries)).not.toMatch(/private|secret|sender|usage|cost|sig/);
  // Its end heard again (a restart re-announces it): stored once. Delivery wrote nothing: the run's messages are there.
  const conversation = c.runtime.pointers.get(key)!;
  await c.runtime.events!.emit("agent.settled", { conversation, requestId, requestIds: [requestId], kind: "completed", text: "Hi **there**", messages: written as never[] });
  await Bun.sleep(1_200);
  expect(await linesNow(c, "ana", id)).toEqual(lines);
  expect(await (await c.served.fetch(`${API}/conversations/${id}`, as("ana"))).json()).toMatchObject({ busy: false });

  // A failed run keeps what it wrote; its message is failed; the provider's words are never shown.
  const sent = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "and now?" }))).json()) as { requestId: string; admission: string };
  expect(sent.admission).toBe("started");
  const broken = { role: "assistant", content: [{ type: "text", text: "Half an ans" }], stopReason: "error", errorMessage: "provider 500: secret upstream", timestamp: 20 };
  await c.runtime.end(key, [sent.requestId], { kind: "failed", messages: [broken] });
  const after = await eventually(async () => {
    const read = await transcriptOf(c, "ana", id);
    return read.length === 6 ? read : undefined;
  }, "the failed run's message");
  expect(linesOf(after).slice(4)).toEqual(["user: and now? (failed)", "assistant: Half an ans"]);
  expect(JSON.stringify(after)).not.toContain("upstream");
  // Pages read on, newest first, by the cursor.
  const first = (await (await c.served.fetch(`${API}/conversations/${id}/transcript?limit=4`, as("ana"))).json()) as { items: ChatTranscriptEntry[]; next: string };
  const rest = await transcriptOf(c, "ana", id, `?limit=4&cursor=${encodeURIComponent(first.next)}`);
  expect([...first.items, ...rest].map((entry) => entry.id)).toEqual(after.map((entry) => entry.id));
  expect((await c.served.fetch(`${API}/conversations/${id}/transcript?cursor=forged`, as("ana"))).status).toBe(400);
});

test("a run's end whose event was lost: its message's state from agent.submissions when the transcript is read; its answer from delivery, replaced by the run's messages when its end is heard late", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.end(key, [requestId], { text: "the answer", quiet: true });
  const lines = await eventually(async () => {
    const read = await linesNow(c, "ana", id);
    return read.length === 2 ? read : undefined;
  }, "the delivered answer");
  expect(lines).toEqual(["user: hello (answered)", "assistant: the answer"]);
  expect((await transcriptOf(c, "ana", id))[0]?.id).toBe(`c1:${requestId}#0`);
  // Heard late (a re-announcement): the run's own messages, once.
  const conversation = c.runtime.pointers.get(key)!;
  await c.runtime.events!.emit("agent.settled", { conversation, requestId, requestIds: [requestId], kind: "completed", text: "the answer", messages: [prompt, answerOf("the answer")] as never[] });
  expect((await transcriptOf(c, "ana", id)).map((entry) => entry.id)).toEqual([runEntryId(requestId, answerOf("the answer")), requestId]);

  const aborted = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "stop" }))).json()) as { requestId: string };
  await c.runtime.end(key, [aborted.requestId], { kind: "aborted", quiet: true });
  expect((await transcriptOf(c, "ana", id))[0]).toMatchObject({ id: aborted.requestId, state: "aborted" });
});

// Found in a browser on a durable project with faux/scripted: the list said "Running" for good.
test("a run that ends before its admission returns (a quick model): the list and the conversation are not busy, its message answered, a first message and a next one alike", async () => {
  const c = await chat();
  c.runtime.runsAtOnce = true;
  const listed = async () => ((await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items;
  const { id, requestId } = await start(c, "ana", "hello");
  expect((await listed()).map((each) => each.busy)).toEqual([false]);
  expect(await (await c.served.fetch(`${API}/conversations/${id}`, as("ana"))).json()).toMatchObject({ busy: false });
  const sent = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "and now?" }))).json()) as { requestId: string };
  expect((await listed()).map((each) => each.busy)).toEqual([false]);
  const states = Object.fromEntries((await transcriptOf(c, "ana", id)).filter((each) => each.state !== undefined).map((each) => [each.id, each.state]));
  expect(states).toEqual({ [requestId]: "answered", [sent.requestId]: "answered" });
  // A run going (started, not ended) is still busy in the list.
  c.runtime.runsAtOnce = false;
  await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "a long one" }));
  expect((await listed()).map((each) => each.busy)).toEqual([true]);
});

test("an operator's follow-up (dashboard:) in a user's conversation and its run never appear in its transcript or its live events", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.start(key, [requestId]);
  await c.runtime.end(key, [requestId], { text: "the user's answer" });
  await eventually(async () => ((await transcriptOf(c, "ana", id)).length === 2 ? true : undefined), "the user's answer");

  const view = await follow(c, "ana", id);
  expect(await view.take(1)).toEqual([{ type: "snapshot", tools: [] }]);
  // What admin-api dispatches for an operator: a follow-up whose request id is the dashboard's.
  const conversation = c.runtime.pointers.get(key)!;
  await c.runtime.runtime.dispatch({ requestId: "dashboard:op-1", conversation, prompt: "[From the operator] how is it going?", whenBusy: "followUp" }, c.served.app.context());
  await c.runtime.start(key, ["dashboard:op-1"]);
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [] } });
  c.runtime.push({ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "secret operator answer" }] });
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  c.runtime.push({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" });
  c.runtime.push({ type: "message_end", entry: { id: 5, kind: "message", model: [answerOf("secret operator answer") as never] } });
  await c.runtime.end(key, ["dashboard:op-1"], { text: "secret operator answer", messages: [{ role: "user", content: "[From the operator] how is it going?" }, answerOf("secret operator answer")] });
  expect(await view.take(2)).toEqual([{ type: "run_start" }, { type: "run_end" }]);
  await view.close();
  await Bun.sleep(1_200);
  const entries = await transcriptOf(c, "ana", id);
  expect(entries.length).toBe(2);
  expect(JSON.stringify(entries)).not.toContain("operator");
});

test("LIVE: a snapshot first; the user's run in the dashboard's shapes, cut by the policy (no thinking, tools by name); message_end's entry is the transcript's, same id, same messages: nothing swapped when the run ends; the client leaving releases the watch", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  const view = await follow(c, "ana", id);
  expect(await view.take(1)).toEqual([{ type: "snapshot", tools: [] }]);
  await c.runtime.start(key, [requestId]);
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [], timestamp: 30, usage: { cost: { total: 1 } } } });
  c.runtime.push({
    type: "message_update",
    usage: { cost: { total: 1 } },
    changes: [
      { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
      { type: "thinking_delta", contentIndex: 0, delta: "private reasoning" },
      { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
      { type: "text_delta", contentIndex: 1, delta: "Hel" },
    ],
  });
  c.runtime.push({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 1, delta: "lo" }] });
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "websearch", args: { query: "secret args" } });
  c.runtime.push({ type: "tool_execution_update", toolCallId: "t1", toolName: "websearch", output: { append: "tool output" } });
  c.runtime.push({ type: "tool_execution_end", toolCallId: "t1", toolName: "websearch" });
  const final = { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Hello" }], stopReason: "stop", timestamp: 30, usage: { cost: { total: 1 } } };
  c.runtime.push({ type: "message_end", entry: { id: 77, kind: "message", model: [final] } });
  c.runtime.push({ type: "entry_appended", entry: { id: 78, kind: "message", model: [{ role: "system", content: "system prompt" }] } });
  c.runtime.push({ type: "usage_changed", usage: { cost: 1 } });
  const seen = await view.take(7);
  const shownEntry = { id: runEntryId(requestId, final), kind: "message", model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 30, stopReason: "stop" }] };
  expect(seen).toEqual([
    { type: "run_start" },
    { type: "message_start", message: { role: "assistant", content: [], timestamp: 30 } },
    {
      type: "message_update",
      changes: [
        { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
        { type: "text_delta", contentIndex: 0, delta: "Hel" },
      ],
    },
    { type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "websearch" },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "websearch" },
    { type: "message_end", entry: shownEntry },
  ]);
  await c.runtime.end(key, [requestId], { messages: [prompt, final] });
  // The run ends; what it wrote is stored: read the transcript again.
  expect(await view.take(2)).toEqual([{ type: "run_end" }, { type: "entry_appended" }]);
  const [stored, user] = await transcriptOf(c, "ana", id);
  expect(stored).toEqual({ id: shownEntry.id, kind: "message", messages: shownEntry.model });
  expect(user).toMatchObject({ id: requestId, state: "answered" });
  // A message sent: its entry, as the transcript has it.
  const sent = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "more" }))).json()) as { requestId: string };
  const [appended] = await view.take(1);
  const [read] = await transcriptOf(c, "ana", id);
  expect(appended).toEqual({ type: "entry_appended", entry: { id: sent.requestId, kind: "message", model: read?.messages } });
  expect(JSON.stringify(seen)).not.toMatch(/private|secret|tool output|system prompt|usage|cost/);
  await view.close();
  for (let i = 0; i < 50 && c.runtime.released < c.runtime.watching; i++) await Bun.sleep(5);
  expect([c.runtime.watching, c.runtime.released]).toEqual([1, 1]);
});

test("HELD: a message sent while a run goes is out of the transcript and the live view until that run ends, then after the run's messages; a state found by a read is told live", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "one");
  const key = `web:ana:${id}`;
  await c.runtime.start(key, [requestId]);
  const view = await follow(c, "ana", id);
  // The run going is the user's (its start heard): it streams.
  expect(await view.take(1)).toEqual([{ type: "snapshot", run: {}, tools: [] }]);
  const queued = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "two" }))).json()) as { requestId: string; admission: string };
  expect(queued.admission).toBe("queued");
  expect(await linesNow(c, "ana", id)).toEqual(["user: one (pending)"]);
  await c.runtime.end(key, [requestId], { text: "first" });
  const [ended, changed, released] = await view.take(3);
  expect([ended, changed]).toEqual([{ type: "run_end" }, { type: "entry_appended" }]);
  expect(released).toMatchObject({ type: "entry_appended", entry: { id: queued.requestId, kind: "message", model: [{ role: "user", content: [{ type: "text", text: "two" }] }] } });
  expect(await linesNow(c, "ana", id)).toEqual(["user: one (answered)", "assistant: first", "user: two (pending)"]);
  // Its run's end never heard: the read finds it, and the view hears the state changed.
  await c.runtime.end(key, [queued.requestId], { kind: "aborted", quiet: true });
  expect((await transcriptOf(c, "ana", id))[0]).toMatchObject({ id: queued.requestId, state: "aborted" });
  expect(await view.take(2)).toEqual([{ type: "run_end" }, { type: "entry_appended" }]);
  await view.close();
});

test("live: a run is the user's by its inputs' request ids: a fast run whose message is not stored streams; an operator's run streams nothing but its start and end, while the user waits; a run of both streams", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.end(key, [requestId], { text: "first" });
  const view = await follow(c, "ana", id);
  expect(await view.take(1)).toEqual([{ type: "snapshot", tools: [] }]);

  // A fast run: it starts (and could end) before its user's message is stored.
  const fast = "web:fast-1";
  await c.runtime.start(key, [fast], c.runtime.submit([fast]));
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [] } });
  c.runtime.push({ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Quick" }] });
  expect(await view.take(3)).toEqual([
    { type: "run_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Quick" }] },
  ]);
  await c.runtime.end(key, [fast], { kind: "aborted", messages: [] });
  expect(await view.take(1)).toEqual([{ type: "run_end" }]);

  // The user waits (a message pending), but the run going took only the operator's follow-up: nothing streams.
  const waiting = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "and?" }))).json()) as { requestId: string };
  expect(await view.take(1)).toMatchObject([{ type: "entry_appended", entry: { id: waiting.requestId } }]);
  await c.runtime.start(key, ["dashboard:op-1"], c.runtime.submit(["dashboard:op-1"]));
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "operator only" }] } });
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  c.runtime.push({ type: "run_end" });
  // A run of both, the operator's first: the user's.
  await c.runtime.start(key, ["dashboard:op-2", waiting.requestId], c.runtime.submit(["dashboard:op-2", waiting.requestId]));
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "both" }] } });
  expect(await view.take(4)).toEqual([{ type: "run_start" }, { type: "run_end" }, { type: "run_start" }, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "both" }] } }]);
  await view.close();
});

test("live: the page opens the view after its first message's run started (a snapshot names no inputs): the run streams, named by its agent.started; an operator's run so opened does not", async () => {
  const c = await chat();
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  // The run starts before the page follows it.
  await c.runtime.start(key, [requestId], null);
  const view = await follow(c, "ana", id);
  expect(await view.take(1)).toEqual([{ type: "snapshot", run: {}, tools: [] }]);
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } });
  expect(await view.take(1)).toEqual([{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }]);
  await c.runtime.end(key, [requestId], { text: "Hi" });
  await view.close();

  // The operator's follow-up starts a run; the page opens the view during it: nothing streams.
  await c.runtime.start(key, ["dashboard:op-1"], null);
  const more = await follow(c, "ana", id);
  expect(await more.take(1)).toEqual([{ type: "snapshot", run: {}, tools: [] }]);
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "operator only" }] } });
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  await c.runtime.end(key, ["dashboard:op-1"], { text: "operator only" });
  expect(await more.take(1)).toEqual([{ type: "run_end" }]);
  await more.close();
});

test("POLICY: visibility is a live setting, read at each request, applied to history and to live events alike", async () => {
  const settings = liveSettings();
  const c = await chat({ components: [settings.component], config: { visibility: { tools: "names" } } });
  expect(settings.declared.map((each) => each.component)).toEqual([NAME]);
  expect(settings.values.get(NAME)).toEqual({ signUp: { mode: "invite", allow: [] }, visibility: { thinking: false, tools: "names", context: true }, agents: [] });
  const { id, requestId } = await start(c, "ana", "hello");
  const key = `web:ana:${id}`;
  await c.runtime.start(key, [requestId]);
  await c.runtime.end(key, [requestId], { messages: [prompt, call, result, answerOf("done", 12)] });
  await eventually(async () => ((await transcriptOf(c, "ana", id)).length === 4 ? true : undefined), "the run");
  expect(await linesNow(c, "ana", id)).toEqual(["user: hello (answered)", "assistant: (websearch)", "toolResult: websearch", "assistant: done"]);

  settings.set({ visibility: { thinking: true, tools: "full", context: false } });
  expect(((await (await c.served.fetch(`${API}/config`)).json()) as ChatConfig).visibility).toEqual({ thinking: true, tools: "full", context: false });
  const full = await transcriptOf(c, "ana", id);
  expect(linesOf(full)).toEqual(["user: hello (answered)", "assistant: (thinking: private reasoning) (websearch)", "toolResult: websearch", "assistant: done"]);
  expect(JSON.stringify(full)).toContain("secret query");
  expect(JSON.stringify(full)).toContain("secret result");
  expect(JSON.stringify(full)).not.toMatch(/secret details|cost|sig"/);

  settings.set({ visibility: { thinking: false, tools: "none", context: true } });
  expect(await linesNow(c, "ana", id)).toEqual(["user: hello (answered)", "assistant: done"]);
  const view = await follow(c, "ana", id);
  expect(await view.take(1)).toEqual([{ type: "snapshot", tools: [] }]);
  const next = (await (await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: "again" }))).json()) as { requestId: string };
  await view.take(1);
  await c.runtime.start(key, [next.requestId]);
  c.runtime.push({ type: "tool_execution_start", toolCallId: "t2", toolName: "websearch", args: {} });
  c.runtime.push({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "websearch", arguments: {} }] } });
  expect(await view.take(2)).toEqual([{ type: "run_start" }, { type: "message_start", message: { role: "assistant", content: [] } }]);
  await view.close();
});

test("AGENTS: the operator's agents users may pick (those that exist, described); a new chat made with one keeps it, routing still decides; another is 400; a routing denial is 403 and makes nothing", async () => {
  const agents = defineComponent({
    name: "agents-test",
    setup: (pikit) => {
      pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "test/model" });
      pikit.provideKeyed("agent.definition", "helper", { name: "helper", model: "test/model" });
      const live = { name: "billing", description: "Answers about invoices", model: "test/model" };
      pikit.provide("agent.directory", { list: async () => [live], get: async (name) => (name === live.name ? live : undefined) });
    },
  });
  const deny = defineComponent({
    name: "deny-test",
    setup: (pikit) => pikit.pipeline("route.resolve", (value) => (value.message.text.includes("[deny]") ? { ...value, decision: { agent: "assistant", access: "deny", reason: "not now" } } : value), { priority: 10 }),
  });
  const settings = liveSettings();
  const c = await chat({ components: [agents, deny, settings.component], config: { agents: ["helper", "billing", "gone"] } });
  const config = (await (await c.served.fetch(`${API}/config`)).json()) as ChatConfig;
  expect(config.agents).toEqual([{ name: "helper" }, { name: "billing", description: "Answers about invoices" }]);

  const picked = await start(c, "ana", "hello", { agent: "billing" });
  expect(c.runtime.dispatched.at(-1)?.conversation).toMatchObject({ key: `web:ana:${picked.id}`, agent: "billing" });
  expect(await (await c.served.fetch(`${API}/conversations/${picked.id}`, as("ana"))).json()).toMatchObject({ id: picked.id, agent: "billing" });
  expect(c.served.logged.find((each) => each.message.includes("started a conversation"))?.fields).toMatchObject({ agent: "billing" });
  // A next message stays with it, whatever the router names.
  await c.served.fetch(`${API}/conversations/${picked.id}/messages`, post("ana", { text: "more" }));
  expect(c.runtime.dispatched.at(-1)?.conversation.agent).toBe("billing");
  // Not picked: the router's; its agent is none users may pick, so not said.
  const routed = await start(c, "ana", "hi");
  expect(c.runtime.dispatched.at(-1)?.conversation.agent).toBe("assistant");
  expect(await (await c.served.fetch(`${API}/conversations/${routed.id}`, as("ana"))).json()).not.toHaveProperty("agent");

  const dispatched = c.runtime.dispatched.length;
  for (const agent of ["assistant", "gone", "", "Helper"]) {
    const refused = await c.served.fetch(`${API}/conversations`, post("ana", { text: "x", agent }));
    expect({ agent, status: refused.status, error: ((await refused.json()) as { error: string }).error }).toEqual({ agent, status: 400, error: "invalid_request" });
  }
  // On a next message, an agent is no field at all.
  expect((await c.served.fetch(`${API}/conversations/${picked.id}/messages`, post("ana", { text: "x", agent: "helper" }))).status).toBe(400);
  const denied = await c.served.fetch(`${API}/conversations`, post("ana", { text: "[deny] hi", agent: "helper" }));
  expect({ status: denied.status, body: await denied.json() }).toEqual({ status: 403, body: { error: "denied", message: "not now" } });
  expect(c.runtime.dispatched.length).toBe(dispatched);
  const listed = ((await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()) as { items: ChatConversation[] }).items;
  expect(Object.fromEntries(listed.map((each) => [each.id, each.agent]))).toEqual({ [picked.id]: "billing", [routed.id]: undefined });

  // The operator takes the choice away: no agent may be picked, none is said.
  settings.set({ agents: [] });
  expect(((await (await c.served.fetch(`${API}/config`)).json()) as ChatConfig).agents).toEqual([]);
  expect((await c.served.fetch(`${API}/conversations`, post("ana", { text: "x", agent: "billing" }))).status).toBe(400);
  expect(await (await c.served.fetch(`${API}/conversations/${picked.id}`, as("ana"))).json()).not.toHaveProperty("agent");
});

test("SUGGESTED: /me says the agent Routing would choose for the user's new chat (a dry run of route.resolve: nothing dispatched or made), only when it is one users may pick", async () => {
  const agents = defineComponent({
    name: "agents-test",
    setup: (pikit) => {
      pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "test/model" });
      pikit.provideKeyed("agent.definition", "helper", { name: "helper", model: "test/model" });
    },
  });
  const seen: { channel: string; conversationId: string; actor: string; text: string; id: string }[] = [];
  let broken = false;
  // ana goes to helper; ben is refused; cy to assistant (not offered); anyone else to the default.
  const rules = defineComponent({
    name: "rules-test",
    setup: (pikit) =>
      pikit.pipeline(
        "route.resolve",
        (value) => {
          if (broken) throw new Error("settings unreadable");
          const { message } = value;
          seen.push({ channel: message.channel, conversationId: message.conversationId, actor: message.actor.id, text: message.text, id: message.id });
          if (message.actor.id === "ana") return { ...value, decision: { agent: "helper", access: "allow" } };
          if (message.actor.id === "ben") return { ...value, decision: { agent: "", access: "deny" } };
          if (message.actor.id === "cy") return { ...value, decision: { agent: "assistant", access: "allow" } };
          return value;
        },
        { priority: 10 },
      ),
  });
  const settings = liveSettings();
  const c = await chat({ components: [agents, rules, settings.component], config: { agents: ["assistant", "helper"] } });
  c.accounts.add("cy");
  const me = async (user: string) => (await (await c.served.fetch(`${API}/me`, as(user))).json()) as { suggestedAgent?: string };

  expect((await me("ana")).suggestedAgent).toBe("helper");
  // The message a new chat's first would be: the web channel, the user its actor, a new chat's conversation.
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ channel: "web", actor: "ana", text: "" });
  expect(seen[0]?.conversationId).toMatch(/^ana:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(seen[0]?.id).toMatch(/^web:/);
  // A dry run: nothing dispatched, no conversation made.
  expect(c.runtime.dispatched).toEqual([]);
  expect(((await (await c.served.fetch(`${API}/conversations`, as("ana"))).json()) as { items: unknown[] }).items).toEqual([]);
  // Denied: none. The default (router-test's assistant), offered: it.
  expect(await me("ben")).not.toHaveProperty("suggestedAgent");
  expect((await me("cy")).suggestedAgent).toBe("assistant");
  // Routed to an agent no longer offered: none.
  settings.set({ agents: ["helper"] });
  expect(await me("cy")).not.toHaveProperty("suggestedAgent");
  expect((await me("ana")).suggestedAgent).toBe("helper");
  // A router that fails: /me answers without it, logged.
  broken = true;
  const failed = await c.served.fetch(`${API}/me`, as("ana"));
  expect(failed.status).toBe(200);
  expect(await failed.json()).not.toHaveProperty("suggestedAgent");
  expect(c.served.logged.some((each) => each.message.includes("Routing would choose"))).toBe(true);
  broken = false;
  // No choice offered: no dry run at all.
  settings.set({ agents: [] });
  const runs = seen.length;
  expect(await me("ana")).not.toHaveProperty("suggestedAgent");
  expect(seen).toHaveLength(runs);
});

test("SEARCH: ?q= finds the user's own conversations whose title holds it, any case (accents too), paged, archived apart; never another user's; a wildcard is a character", async () => {
  const c = await chat({ config: { messagesPerMinute: 100 } });
  const ids: Record<string, string> = {};
  for (const text of ["Trip to Paris", "paris notes", "Groceries", "École plans", "100% done"]) {
    ids[text] = (await start(c, "ana", text)).id;
    await Bun.sleep(3);
  }
  await start(c, "ben", "Paris for ben");
  const titles = async (query: string, user = "ana") => ((await (await c.served.fetch(`${API}/conversations?${query}`, as(user))).json()) as { items: ChatConversation[] }).items.map((each) => each.title);
  expect(await titles("q=paris")).toEqual(["paris notes", "Trip to Paris"]);
  expect(await titles("q=%20PARIS%20")).toEqual(["paris notes", "Trip to Paris"]);
  expect(await titles(`q=${encodeURIComponent("école")}`)).toEqual(["École plans"]);
  expect(await titles(`q=${encodeURIComponent("%")}`)).toEqual(["100% done"]);
  expect(await titles(`q=${encodeURIComponent("_")}`)).toEqual([]);
  expect(await titles("q=")).toHaveLength(5);
  const first = (await (await c.served.fetch(`${API}/conversations?q=paris&limit=1`, as("ana"))).json()) as { items: ChatConversation[]; next: string };
  expect(first.items.map((each) => each.title)).toEqual(["paris notes"]);
  expect(await titles(`q=paris&limit=1&cursor=${encodeURIComponent(first.next)}`)).toEqual(["Trip to Paris"]);
  await c.served.fetch(`${API}/conversations/${ids["paris notes"]}/archive`, as("ana", { method: "POST" }));
  expect(await titles("q=paris")).toEqual(["Trip to Paris"]);
  expect(await titles("q=paris&archived=1")).toEqual(["paris notes"]);
  // A renamed one is found by its new title.
  await c.served.fetch(`${API}/conversations/${ids.Groceries}`, post("ana", { title: "Paris groceries" }, "PATCH"));
  expect(await titles("q=paris")).toEqual(["Paris groceries", "Trip to Paris"]);
  expect(await titles("q=paris", "ben")).toEqual(["Paris for ben"]);
  expect((await c.served.fetch(`${API}/conversations?q=${"x".repeat(201)}`, as("ana"))).status).toBe(400);
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

test("a page of the transcript holds at most PAGE_JSON_MAX of stored JSON (at least one entry); its cursor reads on from there", async () => {
  const c = await chat({ config: { messagesPerMinute: 100 } });
  const { id } = await start(c, "ana", "x".repeat(30_000));
  for (let i = 0; i < 40; i++) await c.served.fetch(`${API}/conversations/${id}/messages`, post("ana", { text: `${i}`.padEnd(30_000, "y") }));
  const page = (await (await c.served.fetch(`${API}/conversations/${id}/transcript?limit=100`, as("ana"))).json()) as { items: ChatTranscriptEntry[]; next?: string };
  expect(page.items.length).toBe(Math.floor(PAGE_JSON_MAX / 30_000));
  expect(page.next).toBeDefined();
  const rest = (await (await c.served.fetch(`${API}/conversations/${id}/transcript?limit=100&cursor=${encodeURIComponent(page.next ?? "")}`, as("ana"))).json()) as { items: ChatTranscriptEntry[]; next?: string };
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
  expect((await transcriptOf(c, "ana", first.id)).map((each) => each.id)).toEqual(["web:page-2", "web:page-1"]);
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
  const listed = (await (await c.served.fetch("/admin/api/channel-web/users?limit=1", { headers: OPERATOR })).json()) as { items: { id: string }[]; total: number };
  expect(listed.items.map((each) => each.id)).toEqual(["ben"]);
  expect(listed.total).toBe(2);

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
  const settings = liveSettings();
  const c = await chat({ components: [settings.component], config: { signUp: { mode: "open" } } });
  expect(settings.declared.map((each) => each.component)).toEqual([NAME]);
  expect(((await (await c.served.fetch(`${API}/config`)).json()) as { signUp: string }).signUp).toBe("open");
  settings.set({ signUp: { mode: "invite", allow: [] } });
  expect(((await (await c.served.fetch(`${API}/config`)).json()) as { signUp: string }).signUp).toBe("invite");
});

test("what setup declares", async () => {
  const app = await defineApp({ components: [secretsOf(), new Runtime().component(), kvOf(), sqliteStorage(), router, channelWeb], logger: silentLogger }).create();
  const described = app.describe().components.find((each) => each.name === NAME);
  expect(described).toMatchObject({
    name: NAME,
    provides: ["http.route"],
    requires: ["secrets", "conversations.registry", "agent.runtime", "agent.observe", "agent.submissions", "storage.kv", "storage.sql"],
    optional: ["wakeups", "outbound.queue", "actor.inbox", "actor.mailbox", "settings", "email.send", "admin.auth", "agent.definition", "agent.directory"],
  });
});

for (const c of createLifecycleConformance(() => {
  const runtime = new Runtime();
  return { component: createChannelWeb({ accounts: new FakeAccounts().wiring() }), providers: [secretsOf(), runtime.component(), kvOf(), sqliteStorage(), router] };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
