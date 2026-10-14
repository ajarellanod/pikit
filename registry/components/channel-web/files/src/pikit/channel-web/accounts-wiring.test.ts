/**
 * The real accounts wired in (better-auth, `wiring.ts`), end to end through the chat's routes: on a
 * server (the App's accounts), and on Cloudflare (the Worker forwarding to the accounts actor, its
 * cheap session check first). The accounts' own behaviour (sign-up modes, providers, links, bans) is
 * tested in `accounts/`; here, that the channel uses them, and that chat and admin sessions never open
 * each other's routes.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type ActorCallHandler, type ActorMailbox, ActorCallError, answerCall, callResult, type JsonValue } from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { createChannelWeb, NAME } from "./index.ts";
import { adminAuth, kvOf, OPERATOR, Runtime, router, type Served, secretsOf, serve } from "./runtime.test-support.ts";
import { AUTH_CALL } from "./wiring.ts";
import { createChannelWebWorker } from "./worker.ts";

const served: Served[] = [];
const objects: App[] = [];
afterEach(async () => {
  for (const each of served.splice(0)) await each.app.stop();
  for (const app of objects.splice(0)) await app.stop();
});

/** A browser: its cookies, sent back on every request, and the page's headers. */
function browser(fetch: (path: string, init?: RequestInit) => Promise<Response>, ip = "10.0.0.1") {
  const jar = new Map<string, string>();
  return {
    jar,
    async send(path: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
      const headers: Record<string, string> = { origin: "http://pikit.test", "x-forwarded-for": ip, "x-pikit-chat": "1" };
      if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      if (init.json !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(path, { method: init.method ?? (init.json === undefined ? "GET" : "POST"), headers, ...(init.json !== undefined && { body: JSON.stringify(init.json) }) });
      for (const cookie of response.headers.getSetCookie()) {
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

const OPEN = { [NAME]: { name: "Ada", signUp: { mode: "open" } } };

test("on a server: a person signs up through /chat/api/auth (better-auth), then has a session for the chat's routes; it never opens the admin's, nor the admin's credential the chat's", async () => {
  const runtime = new Runtime();
  const app = await serve([secretsOf(), runtime.component(), kvOf(), sqliteStorage(), router, adminAuth, createChannelWeb()], OPEN);
  served.push(app);
  const ana = browser(app.fetch);
  const signedUp = await ana.send("/chat/api/auth/sign-up/email", { json: { email: "ana@example.com", password: "a-long-password-1", name: "Ana" } });
  expect(signedUp.status).toBe(200);
  expect([...ana.jar.keys()]).toContain("pikit_chat.session_token");
  const me = (await (await ana.send("/chat/api/me")).json()) as { user: { id: string; email: string }; methods: string[] };
  expect(me).toMatchObject({ user: { email: "ana@example.com", name: "Ana" }, methods: ["password"] });
  const started = await ana.send("/chat/api/conversations", { json: { text: "hello" } });
  expect(started.status).toBe(201);
  expect(runtime.dispatched[0]?.sender).toEqual({ channel: "web", id: me.user.id });

  expect((await ana.send("/admin/api/channel-web/users")).status).toBe(401);
  expect((await app.fetch("/chat/api/me", { headers: OPERATOR })).status).toBe(401);
  const users = (await (await app.fetch("/admin/api/channel-web/users", { headers: OPERATOR })).json()) as { items: { id: string; email: string }[] };
  expect(users.items.map((each) => each.email)).toEqual(["ana@example.com"]);

  // Banned: every session revoked; the cookie cache vouches no more once read from the database.
  expect((await app.fetch(`/admin/api/channel-web/users/${me.user.id}/ban`, { method: "POST", headers: OPERATOR })).status).toBe(200);
  ana.jar.delete("pikit_chat.session_data");
  expect((await ana.send("/chat/api/me")).status).toBe(401);
});

/** Cloudflare: each key an App of its own (scope "one"), the Worker's App over them. */
async function cloud(config: Record<string, unknown>) {
  const apps = new Map<string, Promise<{ app: App; answers: Map<string, ActorCallHandler>; ctx: AppContext }>>();
  const calls: string[] = [];
  const mailbox: ActorMailbox = {
    send: async () => {},
    call: async (key, type, message) => {
      calls.push(`${key} ${type}`);
      let object = apps.get(key);
      if (object === undefined) {
        object = (async () => {
          const answers = new Map<string, ActorCallHandler>();
          const platform = defineComponent({
            name: "platform-test",
            setup: (pikit) => {
              pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: (type, handler) => void answers.set(type, handler), answerStream: () => {} });
              pikit.provide("actor.mailbox", mailbox);
            },
          });
          const app = await defineApp({
            components: [secretsOf(), new Runtime(String).component(), kvOf(), sqliteStorage(), router, platform, createChannelWeb()],
            config,
            target: "durable",
            logger: silentLogger,
          }).create();
          await app.start();
          objects.push(app);
          return { app, answers, ctx: app.context() };
        })();
        apps.set(key, object);
      }
      const { answers, ctx } = await object;
      const handler = answers.get(type);
      if (handler === undefined) throw new ActorCallError("no_handler", type);
      return callResult(await answerCall(handler, key, JSON.parse(JSON.stringify(message)) as JsonValue, ctx));
    },
    stream: async () => {
      throw new Error("no streams here");
    },
  };
  const worker = await serve([secretsOf(), defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", mailbox) }), adminAuth, createChannelWebWorker()], { "channel-web-worker": config[NAME] }, "durable");
  served.push(worker);
  return { worker, calls };
}

test("on Cloudflare: auth is forwarded to the accounts actor (every set-cookie kept); a session the cookie cache vouches for costs no call; past it, the actor is asked", async () => {
  const { worker, calls } = await cloud(OPEN);
  const ana = browser(worker.fetch);
  const signedUp = await ana.send("/chat/api/auth/sign-up/email", { json: { email: "ana@example.com", password: "a-long-password-1", name: "Ana" } });
  expect(signedUp.status).toBe(200);
  expect(calls).toEqual([`channel-web:accounts ${AUTH_CALL.handle}`]);
  expect([...ana.jar.keys()].sort()).toEqual(["pikit_chat.session_data", "pikit_chat.session_token"]);

  calls.length = 0;
  const me = (await (await ana.send("/chat/api/me")).json()) as { user: { email: string } };
  expect(me.user.email).toBe("ana@example.com");
  // The session from the cookie cache; only the methods are asked.
  expect(calls).toEqual([`channel-web:accounts ${AUTH_CALL.methods}`]);

  calls.length = 0;
  ana.jar.delete("pikit_chat.session_data");
  expect((await ana.send("/chat/api/conversations")).status).toBe(200);
  expect(calls).toEqual([`channel-web:accounts ${AUTH_CALL.user}`, `channel-web:accounts channel-web.list`]);

  const users = (await (await worker.fetch("/admin/api/channel-web/users", { headers: OPERATOR })).json()) as { items: { email: string }[] };
  expect(users.items.map((each) => each.email)).toEqual(["ana@example.com"]);
  expect((await worker.fetch("/chat/api/me", { headers: OPERATOR })).status).toBe(401);
});
