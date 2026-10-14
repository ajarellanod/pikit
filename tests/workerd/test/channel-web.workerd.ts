/**
 * channel-web on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation` class, as
 * `PlatformConversation`, `src/platform.ts`), through the Worker's `fetch` (deployment-cloudflare's
 * `createWorkerHost`, which boots the Worker's App at its first request). Each conversation's object
 * and the accounts actor (`channel-web:accounts`) run the objects' App, composed as a project's: storage-do,
 * storage-kv-sql, actors-do (mailbox, inbox, wakeups), runtime-pi with provider-faux (`faux/echo`),
 * conversations-kv, router-basic, outbound-durable, admin-auth-token, admin-api and channel-web; the
 * Worker's App runs actors-do, admin-auth-token, admin-api's and channel-web's Worker halves.
 *
 * - A user signs up (`open`) and in with a password (better-auth in the accounts actor: its bundle,
 *   AsyncLocalStorage, scrypt from `node:crypto` under the `workerd` condition, Web Crypto), gets the
 *   `pikit_chat` cookies (path `/chat/`, `Secure` only on https), talks to the agent and reads the
 *   answer, follows the live view (`state`, `partial`, `message`). Another user with the first's chat
 *   id gets `404` on every route; an operator's follow-up (admin-api, the admin token) never reaches
 *   the user's messages or live view. The accounts' tables are only in the accounts actor.
 * - An invitation's link sets a password (`/chat/api/auth/reset-password`), then signs in; a ban is
 *   refused once the signed cookie cache expired (`Date` faked past it), the actor asked then.
 * - With `email.send` in the objects' App only (a fake), `GET /chat/api/config` says email is sent and
 *   offers the magic link, which signs a new user in; a password sign-up verifies its email first.
 */

import { type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { EmailMessage, EmailSender } from "@pikit/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import adminApi, { worker as adminApiWorker } from "../../../registry/components/admin-api/files/src/pikit/admin-api/index.ts";
import { INDEX_KEY } from "../../../registry/components/admin-api/files/src/pikit/admin-api/conversation-index.ts";
import adminAuthToken from "../../../registry/components/admin-auth-token/files/src/pikit/admin-auth-token/index.ts";
import type { ChatConfig, ChatEvent, ChatMessage, ChatPage } from "../../../registry/components/channel-web/files/src/pikit/channel-web/api.ts";
import channelWeb, { ACCOUNTS_KEY, worker as channelWebWorker } from "../../../registry/components/channel-web/files/src/pikit/channel-web/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import { createWorkerHost } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import outboundDurable from "../../../registry/components/outbound-durable/files/src/pikit/outbound-durable/index.ts";
import providerFaux from "../../../registry/components/provider-faux/files/src/pikit/provider-faux/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

const ADMIN_TOKEN = "workerd-operator-token-0123456789abcdef";
const OPERATOR = { authorization: `Bearer ${ADMIN_TOKEN}` };
const SECRETS: Record<string, string> = { CHANNEL_WEB_AUTH_SECRET: "workerd-chat-secret-0123456789abcdefghijklmnop", PIKIT_ADMIN_TOKEN: ADMIN_TOKEN };

const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => SECRETS[name] }) });
const agent = defineComponent({
  name: "agents-fixture",
  setup: (pikit) => pikit.provideKeyed("agent.definition", "echo", { name: "echo", model: "faux/echo", tools: [] }),
});

/** `email.send`, recording what it sends: in the objects' App only (the accounts actor sends). */
function fakeEmail() {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    send: async (message) => {
      sent.push(message);
      return { id: `email-${sent.length}` };
    },
  };
  return { sent, component: defineComponent({ name: "email-test", setup: (pikit) => pikit.provide("email.send", sender) }) };
}

/** The objects' App and the Worker's, with channel-web's config in both; the Worker's `fetch`. */
function compose(chat: Record<string, unknown>, extra: ComponentDefinition[] = []) {
  composeObjects(
    [storageDo, storageKvSql, actorsDo, secrets, agent, providerFaux, runtimePi, conversationsKv, routerBasic, outboundDurable, adminAuthToken, adminApi, ...extra, channelWeb],
    { "router-basic": { defaultAgent: "echo" }, "channel-web": chat },
  );
  const worker = defineApp({
    components: [actorsDo, secrets, adminAuthToken, adminApiWorker, channelWebWorker],
    config: { "actors-do": { binding: PLATFORM_BINDING }, "channel-web-worker": chat },
    target: "durable",
    logger: silentLogger,
  });
  const host = createWorkerHost(worker, { logger: silentLogger });
  return (url: string, init: RequestInit = {}) => host.fetch(new Request(url, init), workerEnv);
}

type Fetch = ReturnType<typeof compose>;

/** A browser at `origin`: its cookies sent back on every request, the page's header, its own address. */
function browser(fetch: Fetch, origin: string, ip: string) {
  const jar = new Map<string, string>();
  const cookies: string[] = [];
  return {
    jar,
    /** Every `set-cookie` it got, as sent. */
    cookies,
    async send(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
      const headers: Record<string, string> = { origin, "cf-connecting-ip": ip, "x-pikit-chat": "1", ...init.headers };
      if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      if (init.json !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`${origin}${path}`, {
        method: init.method ?? (init.json === undefined ? "GET" : "POST"),
        headers,
        redirect: "manual",
        ...(init.json !== undefined && { body: JSON.stringify(init.json) }),
      });
      for (const cookie of response.headers.getSetCookie()) {
        cookies.push(cookie);
        const [pair = ""] = cookie.split(";");
        const at = pair.indexOf("=");
        const value = pair.slice(at + 1);
        if (value === "" || /max-age=0/i.test(cookie)) jar.delete(pair.slice(0, at));
        else jar.set(pair.slice(0, at), value);
      }
      return response;
    },
  };
}
type Browser = ReturnType<typeof browser>;

const HTTPS = "https://pikit.test";
const HTTP = "http://pikit.test";
const PASSWORD = "a-long-password-1";

async function signUp(who: Browser, email: string, name: string): Promise<void> {
  const response = await who.send("/chat/api/auth/sign-up/email", { json: { email, password: PASSWORD, name } });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function signIn(who: Browser, email: string, password = PASSWORD): Promise<void> {
  const response = await who.send("/chat/api/auth/sign-in/email", { json: { email, password } });
  expect(response.status, await response.clone().text()).toBe(200);
}
const meOf = async (who: Browser) => (await (await who.send("/chat/api/me")).json()) as { user: { id: string; email: string; name: string }; methods: string[] };

/** A user's messages, newest first. */
const messagesOf = async (who: Browser, chat: string) => {
  const response = await who.send(`/chat/api/conversations/${chat}/messages`);
  expect(response.status).toBe(200);
  return ((await response.json()) as ChatPage<ChatMessage>).items;
};

/** A user's conversation answered: its messages, oldest first, as `role: text (state)`. */
async function answered(who: Browser, chat: string, count: number): Promise<string[]> {
  return await vi.waitFor(
    async () => {
      const items = await messagesOf(who, chat);
      const lines = items.reverse().map((m) => `${m.role}: ${m.text}${m.state === undefined ? "" : ` (${m.state})`}`);
      expect(lines).toHaveLength(count);
      expect(lines.at(-1)).toMatch(/^assistant: /);
      expect(lines.filter((line) => line.endsWith("(pending)"))).toEqual([]);
      return lines;
    },
    { timeout: 15_000, interval: 100 },
  );
}

/** The server-sent events of a live view, read as they come. */
function live(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: ChatEvent[] = [];
  let text = "";
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  return {
    events,
    /** Reads until `done(events)` holds; rejects past `ms`. */
    async until(done: (seen: ChatEvent[]) => boolean, ms = 15_000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the live view did not get there in ${ms} ms: ${JSON.stringify(events)}`)), ms);
      });
      try {
        while (!done(events)) {
          reading ??= reader.read();
          const { value, done: ended } = await Promise.race([reading, late]);
          reading = undefined;
          if (ended) throw new Error(`the live view ended: ${JSON.stringify(events)}`);
          text += decoder.decode(value, { stream: true });
          for (let end = text.indexOf("\n\n"); end !== -1; end = text.indexOf("\n\n")) {
            const frame = text.slice(0, end);
            text = text.slice(end + 2);
            for (const line of frame.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ChatEvent);
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => reader.cancel(),
  };
}

const id = (value: string) => encodeURIComponent(value);
/** The tables of channel-web in the object of `key`. */
const tablesOf = (key: string) =>
  runInDurableObject(env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key)), (_instance, state) =>
    state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'channel_web_%' ORDER BY name")
      .toArray()
      .map((row) => row.name as string),
  );
const ACCOUNT_TABLES = ["channel_web_account", "channel_web_session", "channel_web_user", "channel_web_verification"];

it("a user signs up and in, talks to the agent and follows it live; another user's every route on that chat is 404; an operator's follow-up never reaches the user; the accounts live in the accounts actor only", async () => {
  const fetch = compose({ name: "Ada", signUp: { mode: "open" } });

  const config = await fetch(`${HTTPS}/chat/api/config`);
  expect(await config.json()).toEqual({ name: "Ada", target: "durable", methods: [{ kind: "password" }], signUp: "open", email: false } satisfies ChatConfig);

  // Signed up over https: the `__Secure-` cookies, path /chat/, HttpOnly, SameSite=Lax, Secure.
  const ana = browser(fetch, HTTPS, "10.0.0.1");
  await signUp(ana, "ana@example.com", "Ana");
  expect([...ana.jar.keys()].sort()).toEqual(["__Secure-pikit_chat.session_data", "__Secure-pikit_chat.session_token"]);
  for (const cookie of ana.cookies) {
    expect(cookie).toMatch(/; Path=\/chat\/(;|$)/);
    expect(cookie).toMatch(/; Secure(;|$)/);
    expect(cookie).toMatch(/; HttpOnly(;|$)/);
    expect(cookie).toMatch(/; SameSite=Lax(;|$)/i);
  }
  // Signed in with the password on another device, over http: no `Secure`, no `__Secure-`.
  const phone = browser(fetch, HTTP, "10.0.0.2");
  await signIn(phone, "ana@example.com");
  expect([...phone.jar.keys()].sort()).toEqual(["pikit_chat.session_data", "pikit_chat.session_token"]);
  expect(phone.cookies.filter((cookie) => /; Secure(;|$)/.test(cookie))).toEqual([]);
  expect((await meOf(phone)).user.email).toBe("ana@example.com");
  expect((await phone.send("/admin/api/channel-web/users")).status).toBe(401);
  const me = await meOf(ana);
  expect(me).toMatchObject({ user: { email: "ana@example.com", name: "Ana" }, methods: ["password"] });

  // A message and its answer, in the conversation's object.
  const started = await ana.send("/chat/api/conversations", { json: { text: "hello" } });
  expect(started.status).toBe(201);
  const { id: chat } = (await started.json()) as { id: string };
  expect(await answered(ana, chat, 2)).toEqual(["user: hello (answered)", "assistant: faux: hello"]);
  const key = `web:${me.user.id}:${chat}`;
  const listed = (await (await ana.send("/chat/api/conversations")).json()) as ChatPage<{ id: string }>;
  expect(listed.items.map((each) => each.id)).toEqual([chat]);

  // Live: a state first; the next answer as written, then stored.
  const view = live(await ana.send(`/chat/api/conversations/${chat}/events`));
  await view.until((seen) => seen.length > 0);
  expect(view.events[0]).toEqual({ type: "state", busy: false });
  expect((await ana.send(`/chat/api/conversations/${chat}/messages`, { json: { text: "second" } })).status).toBe(202);
  await view.until((seen) => seen.some((e) => e.type === "partial" && e.text === "faux: second") && seen.filter((e) => e.type === "message").length >= 2);
  expect(view.events.filter((e) => e.type === "state")).toContainEqual({ type: "state", busy: true });
  expect(view.events.filter((e) => e.type === "partial").every((e) => e.type === "partial" && "faux: second".startsWith(e.text))).toBe(true);
  expect(await answered(ana, chat, 4)).toEqual(["user: hello (answered)", "assistant: faux: hello", "user: second (answered)", "assistant: faux: second"]);
  await view.until((seen) => seen.filter((e) => e.type === "message").length >= 3);

  // Another user, with Ana's chat id: 404 on every route, as a chat that never was.
  const ben = browser(fetch, HTTPS, "10.0.0.3");
  await signUp(ben, "ben@example.com", "Ben");
  const theirs = `/chat/api/conversations/${chat}`;
  const tries: [string, { method?: string; json?: unknown }][] = [
    [theirs, {}],
    [theirs, { method: "PATCH", json: { title: "mine" } }],
    [`${theirs}/messages`, {}],
    [`${theirs}/messages`, { json: { text: "let me in" } }],
    [`${theirs}/events`, {}],
    [`${theirs}/abort`, { method: "POST" }],
    [theirs, { method: "DELETE" }],
  ];
  for (const [path, init] of tries) {
    const response = await ben.send(path, init);
    expect([path, init.method ?? (init.json === undefined ? "GET" : "POST"), response.status]).toEqual([path, init.method ?? (init.json === undefined ? "GET" : "POST"), 404]);
  }
  expect(((await (await ben.send("/chat/api/conversations")).json()) as ChatPage<unknown>).items).toEqual([]);
  const own = (await (await ben.send("/chat/api/conversations", { json: { text: "ben here" } })).json()) as { id: string };
  expect(await answered(ben, own.id, 2)).toEqual(["user: ben here (answered)", "assistant: faux: ben here"]);
  const benView = live(await ben.send(`/chat/api/conversations/${own.id}/events`));
  await benView.until((seen) => seen.length > 0);

  // The operator's follow-up in Ana's conversation (admin-api, the admin token): answered there, never shown to her.
  const before = view.events.length;
  const followUp = await fetch(`${HTTPS}/admin/api/conversations/${id(`${key}~1`)}/messages`, {
    method: "POST",
    headers: { ...OPERATOR, "content-type": "application/json" },
    body: JSON.stringify({ text: "operator only" }),
  });
  expect(followUp.status).toBe(202);
  await vi.waitFor(
    async () => {
      const transcript = (await (await fetch(`${HTTPS}/admin/api/conversations/${id(`${key}~1`)}/transcript`, { headers: OPERATOR })).json()) as {
        items: { messages: { role: string; content: unknown }[] }[];
      };
      const answers = transcript.items.flatMap((entry) => entry.messages).filter((m) => m.role === "assistant");
      expect(JSON.stringify(answers)).toContain("operator only");
    },
    { timeout: 15_000, interval: 100 },
  );
  // Her next message is answered after it: had the operator's answer been delivered, it would be there first.
  expect((await ana.send(`/chat/api/conversations/${chat}/messages`, { json: { text: "third" } })).status).toBe(202);
  const lines = await answered(ana, chat, 6);
  expect(lines.slice(4)).toEqual(["user: third (answered)", "assistant: faux: third"]);
  expect(JSON.stringify(lines)).not.toContain("operator only");
  await view.until((seen) => seen.slice(before).some((e) => e.type === "partial" && e.text === "faux: third"));
  const since = view.events.slice(before);
  expect(since.filter((e) => e.type === "partial" && e.text !== "" && !"faux: third".startsWith(e.text))).toEqual([]);
  expect(JSON.stringify(since)).not.toContain("operator only");
  expect(JSON.stringify(benView.events)).not.toContain("operator only");
  expect(JSON.stringify(await messagesOf(ben, own.id))).not.toContain("operator only");
  await view.close();
  await benView.close();

  // The accounts' tables: in the accounts actor, never in a conversation's object or admin-api's index.
  expect(await tablesOf(ACCOUNTS_KEY)).toEqual(expect.arrayContaining(ACCOUNT_TABLES));
  expect((await tablesOf(key)).filter((name) => ACCOUNT_TABLES.includes(name))).toEqual([]);
  expect(await tablesOf(key)).toEqual(expect.arrayContaining(["channel_web_conversations", "channel_web_messages"]));
  expect((await tablesOf(INDEX_KEY)).filter((name) => ACCOUNT_TABLES.includes(name))).toEqual([]);
});

it("an invitation's link sets a password and signs in; a ban takes effect once the cookie cache expired, the accounts actor asked then", async () => {
  const fetch = compose({ name: "Ada", signUp: { mode: "invite" } });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${HTTPS}/admin/api/channel-web${path}`, { ...init, headers: { ...OPERATOR, "content-type": "application/json", ...(init.headers as Record<string, string>) } });

  // Under `invite`, nobody signs up alone.
  const stranger = browser(fetch, HTTPS, "10.1.0.1");
  expect((await stranger.send("/chat/api/auth/sign-up/email", { json: { email: "eve@example.com", password: PASSWORD, name: "Eve" } })).status).toBe(403);

  const invited = await admin("/invitations", { method: "POST", body: JSON.stringify({ email: "Cleo@Example.com", name: "Cleo" }) });
  expect(invited.status).toBe(201);
  const invitation = (await invited.json()) as { userId: string; link: string; emailed: boolean };
  expect(invitation.emailed).toBe(false);
  expect(invitation.link.startsWith(`${HTTPS}/chat/#/set-password?`)).toBe(true);
  const token = new URLSearchParams(new URL(invitation.link).hash.split("?")[1]).get("token");
  expect(token).toBeTruthy();

  const cleo = browser(fetch, HTTPS, "10.1.0.2");
  const set = await cleo.send("/chat/api/auth/reset-password", { json: { token, newPassword: "cleo-sets-her-own-1" } });
  expect(set.status, await set.clone().text()).toBe(200);
  await signIn(cleo, "cleo@example.com", "cleo-sets-her-own-1");
  expect(await meOf(cleo)).toMatchObject({ user: { id: invitation.userId, email: "cleo@example.com", name: "Cleo" }, methods: ["password"] });
  // The link works once.
  expect((await stranger.send("/chat/api/auth/reset-password", { json: { token, newPassword: "someone-else-1" } })).status).toBe(400);

  const dan = browser(fetch, HTTPS, "10.1.0.3");
  const danInvite = (await (await admin("/invitations", { method: "POST", body: JSON.stringify({ email: "dan@example.com" }) })).json()) as { userId: string; link: string };
  const danToken = new URLSearchParams(new URL(danInvite.link).hash.split("?")[1]).get("token");
  expect((await dan.send("/chat/api/auth/reset-password", { json: { token: danToken, newPassword: "dan-password-12" } })).status).toBe(200);
  await signIn(dan, "dan@example.com", "dan-password-12");
  const users = (await (await admin("/users")).json()) as { items: { email: string; banned: boolean }[] };
  // The accounts actor's storage is the file's: users of the tests before are there too.
  expect(users.items.map((each) => each.email)).toEqual(expect.arrayContaining(["cleo@example.com", "dan@example.com"]));

  // Banned: the actor deletes her sessions; the signed cookie cache still vouches in the Worker until it expires.
  expect((await admin(`/users/${invitation.userId}/ban`, { method: "POST" })).status).toBe(200);
  expect((await cleo.send("/chat/api/me")).status).toBe(200);
  // Without the cache, the Worker asks the accounts actor: no session.
  const uncached = browser(fetch, HTTPS, "10.1.0.4");
  for (const [name, value] of cleo.jar) if (!name.endsWith("session_data")) uncached.jar.set(name, value);
  expect((await uncached.send("/chat/api/me")).status).toBe(401);
  // Past `sessionCacheSeconds` (300 s by default): the cache vouches no more, and the actor refuses her.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000, shouldAdvanceTime: true });
  expect((await cleo.send("/chat/api/me")).status).toBe(401);
  expect((await cleo.send("/chat/api/conversations", { json: { text: "hello?" } })).status).toBe(401);
  // Dan's cache expired too: the actor vouches for his session.
  expect((await meOf(dan)).user.email).toBe("dan@example.com");
  // Signing in again is refused while she is banned.
  const again = await browser(fetch, HTTPS, "10.1.0.5").send("/chat/api/auth/sign-in/email", { json: { email: "cleo@example.com", password: "cleo-sets-her-own-1" } });
  expect(again.status).toBe(403);
});

it("email.send in the objects' App only: the config says email is sent and offers the magic link, which signs a new user in; a password sign-up verifies its email first; an invitation is emailed", async () => {
  const email = fakeEmail();
  const fetch = compose({ name: "Ada", signIn: { password: true, magicLink: true }, signUp: { mode: "open" } }, [email.component]);

  // The Worker has no email.send: it asks the accounts actor, whose App sends.
  const config = await fetch(`${HTTPS}/chat/api/config`);
  expect(await config.json()).toEqual({ name: "Ada", target: "durable", methods: [{ kind: "password" }, { kind: "magic-link" }], signUp: "open", email: true } satisfies ChatConfig);

  const linkIn = (message: EmailMessage | undefined) => /https?:\/\/\S+/.exec(message?.text ?? "")?.[0] as string;
  const pathOf = (link: string) => {
    const url = new URL(link);
    return `${url.pathname}${url.search}`;
  };

  // A magic link: emailed by the accounts actor, opened through the Worker: a session.
  const dana = browser(fetch, HTTPS, "10.2.0.1");
  const asked = await dana.send("/chat/api/auth/sign-in/magic-link", { json: { email: "dana@example.com", callbackURL: "/chat/" } });
  expect(asked.status, await asked.clone().text()).toBe(200);
  expect(email.sent.map(({ to, subject }) => ({ to, subject }))).toEqual([{ to: "dana@example.com", subject: "Sign in to Ada" }]);
  expect(dana.jar.size).toBe(0);
  const opened = await dana.send(pathOf(linkIn(email.sent[0])));
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).toBe(`${HTTPS}/chat/`);
  expect((await meOf(dana)).user.email).toBe("dana@example.com");

  // A password sign-up: no session until the email is verified, by the link it was sent.
  const eli = browser(fetch, HTTPS, "10.2.0.2");
  expect((await eli.send("/chat/api/auth/sign-up/email", { json: { email: "eli@example.com", password: PASSWORD, name: "Eli" } })).status).toBe(200);
  expect((await eli.send("/chat/api/me")).status).toBe(401);
  const verification = email.sent.at(-1);
  expect(verification).toMatchObject({ to: "eli@example.com", subject: "Confirm your email for Ada" });
  const verified = await eli.send(pathOf(linkIn(verification)));
  expect(verified.status).toBe(302);
  expect((await meOf(eli)).user.email).toBe("eli@example.com");

  // The operator's invitation is emailed too.
  const invited = await fetch(`${HTTPS}/admin/api/channel-web/invitations`, { method: "POST", headers: { ...OPERATOR, "content-type": "application/json" }, body: JSON.stringify({ email: "fay@example.com" }) });
  expect(await invited.json()).toMatchObject({ emailed: true });
  expect(email.sent.at(-1)).toMatchObject({ to: "fay@example.com", subject: "You are invited to Ada" });
});
