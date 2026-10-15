/**
 * The real accounts wired in (better-auth, `wiring.ts`), end to end through the chat's routes: on a
 * server (the App's accounts), and on Cloudflare (the Worker forwarding to the accounts actor, its
 * cheap session check first). The accounts' own behaviour (sign-up modes, providers, links, bans) is
 * tested in `accounts/`; here, that the channel uses them, and that chat and admin sessions never open
 * each other's routes.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type ActorCallHandler, type ActorMailbox, ActorCallError, answerCall, CLIENT_ADDRESS_HEADER, callResult, type EmailMessage, type JsonValue } from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { fakeOidc, type Profile } from "./accounts/accounts.test-support.ts";
import { createChannelWeb, NAME } from "./index.ts";
import { adminAuth, kvOf, OPERATOR, Runtime, router, SECRETS, type Served, secretsOf, serve } from "./runtime.test-support.ts";
import { AUTH_CALL, BETTER_AUTH } from "./wiring.ts";
import { createChannelWebWorker } from "./worker.ts";

const served: Served[] = [];
const objects: App[] = [];
const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const each of served.splice(0)) await each.app.stop();
  for (const app of objects.splice(0)) await app.stop();
  for (const stop of stops.splice(0)) await stop();
});

/** The origin the test Apps serve: a loopback one (without PIKIT_PUBLIC_URL a server's accounts answer only this machine's). */
const ORIGIN = "http://localhost:3000";

type Send = {
  method?: string;
  json?: unknown;
  /** An `application/x-www-form-urlencoded` body (an OIDC platform's form_post). */
  form?: Record<string, string>;
  /** Over the browser's own; `""` leaves one out. */
  headers?: Record<string, string>;
  /** `false`: the cookies stay home (a cross-site POST, SameSite=Lax). */
  cookies?: boolean;
};

/** A browser: its cookies, sent back on every request, and the page's headers. */
function browser(fetch: (path: string, init?: RequestInit) => Promise<Response>, ip = "10.0.0.1") {
  const jar = new Map<string, string>();
  return {
    jar,
    /** `path` on the App, or a URL of it (where a redirect leads). */
    async send(path: string, init: Send = {}): Promise<Response> {
      const url = new URL(path, ORIGIN);
      const headers: Record<string, string> = { origin: ORIGIN, [CLIENT_ADDRESS_HEADER]: ip, "x-pikit-chat": "1", "user-agent": "pikit-test-browser" };
      if (jar.size > 0 && init.cookies !== false) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      if (init.json !== undefined) headers["content-type"] = "application/json";
      if (init.form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        if (value === "") delete headers[name];
        else headers[name] = value;
      }
      const body = init.json !== undefined ? JSON.stringify(init.json) : init.form !== undefined ? new URLSearchParams(init.form).toString() : undefined;
      const response = await fetch(`${url.pathname}${url.search}`, { method: init.method ?? (body === undefined ? "GET" : "POST"), headers, ...(body !== undefined && { body }) });
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

test("only the accounts actor answers the accounts' calls: any other object refuses each (no_handler) before the accounts are made", async () => {
  const answers = new Map<string, ActorCallHandler>();
  let made = 0;
  BETTER_AUTH.answer({ scope: "one", handle: () => {}, answer: (type, handler) => void answers.set(type, handler), answerStream: () => {} }, async () => {
    made++;
    throw new Error("the accounts are not made here");
  });
  const app = await defineApp({ components: [], logger: silentLogger }).create();
  const messages: Record<string, JsonValue> = {
    [AUTH_CALL.handle]: { method: "GET", url: "http://localhost:3000/chat/api/auth/get-session", headers: [] },
    [AUTH_CALL.user]: { url: "http://localhost:3000/chat/api/me", cookie: "x=1" },
    [AUTH_CALL.methods]: { userId: "ana" },
    [AUTH_CALL.list]: { limit: 10, offset: 0 },
    [AUTH_CALL.invite]: { email: "eve@example.com", origin: "http://localhost:3000" },
    [AUTH_CALL.reset]: { userId: "ana", origin: "http://localhost:3000" },
    [AUTH_CALL.ban]: { userId: "ana", banned: true },
    [AUTH_CALL.remove]: { userId: "ana" },
  };
  expect([...answers.keys()].sort()).toEqual(Object.values(AUTH_CALL).sort());
  for (const [type, handler] of answers) {
    const refused = await Promise.resolve()
      .then(() => answerCall(handler, `web:ana:${crypto.randomUUID()}`, messages[type] ?? {}, app.context()))
      .then(callResult)
      .catch((error: unknown) => error);
    expect({ type, code: (refused as ActorCallError).code }).toEqual({ type, code: "no_handler" });
  }
  expect(made).toBe(0);
  // In the accounts actor the same handler reaches the accounts.
  const list = answers.get(AUTH_CALL.list) as ActorCallHandler;
  const reached = await Promise.resolve()
    .then(() => answerCall(list, "channel-web:accounts", { limit: 10, offset: 0 }, app.context()))
    .then(callResult)
    .catch((error: unknown) => error);
  expect([made, String(reached)]).toEqual([1, expect.stringContaining("not made here")]);
});

test("on a server: a person signs up through /chat/api/auth (better-auth), then has a session for the chat's routes; it never opens the admin's, nor the admin's credential the chat's", async () => {
  const runtime = new Runtime();
  const app = await serve([secretsOf(), runtime.component(), kvOf(), sqliteStorage(), router, adminAuth, createChannelWeb()], OPEN, "server", ORIGIN);
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
  await pagedOnTheRoute(app.fetch);

  // Past the cookie cache, the session is read from the database, and the route renews the cache.
  ana.jar.delete("pikit_chat.session_data");
  const renewed = await ana.send("/chat/api/conversations");
  expect(renewed.status).toBe(200);
  expect(renewed.headers.getSetCookie().map((cookie) => cookie.split("=")[0])).toEqual(["pikit_chat.session_data"]);
  expect([...ana.jar.keys()]).toContain("pikit_chat.session_data");

  // Banned: every session revoked; the cookie cache vouches no more once read from the database.
  expect((await app.fetch(`/admin/api/channel-web/users/${me.user.id}/ban`, { method: "POST", headers: OPERATOR })).status).toBe(200);
  ana.jar.delete("pikit_chat.session_data");
  expect((await ana.send("/chat/api/me")).status).toBe(401);
});

/** Cloudflare: each key an App of its own (scope "one"), the Worker's App over them; `extra` in the objects' Apps (email.send). */
async function cloud(config: Record<string, unknown>, secrets: Record<string, string> = SECRETS, extra: ComponentDefinition[] = [], channel: () => ComponentDefinition = () => createChannelWeb()) {
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
            components: [secretsOf(secrets), new Runtime(String).component(), kvOf(), sqliteStorage(), router, platform, ...extra, channel()],
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
  const worker = await serve([secretsOf(secrets), defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", mailbox) }), adminAuth, createChannelWebWorker()], { "channel-web-worker": config[NAME] }, "durable", ORIGIN);
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
  // The actor's answer renewed the cookie cache, which the route sent back: the next request costs no call for the session.
  expect([...ana.jar.keys()]).toContain("pikit_chat.session_data");
  calls.length = 0;
  expect((await ana.send("/chat/api/conversations")).status).toBe(200);
  expect(calls).toEqual([`channel-web:accounts channel-web.list`]);

  const users = (await (await worker.fetch("/admin/api/channel-web/users", { headers: OPERATOR })).json()) as { items: { email: string }[] };
  expect(users.items.map((each) => each.email)).toEqual(["ana@example.com"]);
  calls.length = 0;
  await pagedOnTheRoute(worker.fetch);
  expect(new Set(calls)).toEqual(new Set([`channel-web:accounts ${AUTH_CALL.list}`, `channel-web:accounts ${AUTH_CALL.invite}`]));
  expect((await worker.fetch("/chat/api/me", { headers: OPERATOR })).status).toBe(401);
});

/**
 * The operator's list on the route, with Ana signed up (active): two invited, paged by offset, filtered by
 * state and search, the total and the counts the filter's; a parameter out of range is `400`.
 */
async function pagedOnTheRoute(fetch: (path: string, init?: RequestInit) => Promise<Response>) {
  for (const email of ["ben@example.com", "cy@example.com"]) {
    expect((await fetch("/admin/api/channel-web/invitations", { method: "POST", headers: { ...OPERATOR, "content-type": "application/json" }, body: JSON.stringify({ email }) })).status).toBe(201);
  }
  type Page = { items: { email: string }[]; total: number; counts: Record<string, number> };
  const page = async (query: string): Promise<Page> => {
    const response = await fetch(`/admin/api/channel-web/users?${query}`, { headers: OPERATOR });
    expect(response.status).toBe(200);
    return (await response.json()) as Page;
  };
  const all = await page("limit=2&offset=0");
  expect([all.items.length, all.total, all.counts]).toEqual([2, 3, { all: 3, active: 1, invited: 2, banned: 0 }]);
  expect((await page("limit=2&offset=2")).items.length).toBe(1);
  const invited = await page("limit=10&state=invited");
  expect([invited.items.map((each) => each.email).sort(), invited.total]).toEqual([["ben@example.com", "cy@example.com"], 2]);
  const searched = await page("limit=10&q=ANA");
  expect([searched.items.map((each) => each.email), searched.total, searched.counts.all]).toEqual([["ana@example.com"], 1, 1]);
  for (const query of ["limit=0", "limit=101", "limit=1e1", "offset=-1", "offset=x", "state=gone", `q=${"a".repeat(201)}`]) {
    expect([query, (await fetch(`/admin/api/channel-web/users?${query}`, { headers: OPERATOR })).status]).toEqual([query, 400]);
  }
}

// Every better-auth route the page uses (chat/src/lib/auth.ts, sign-in.tsx, set-password.tsx), on both
// targets: reachable through GET|POST /chat/api/auth/*, the headers better-auth reads kept on the way,
// its redirects and cookies back whole, its origin check on.

const OIDC_ID = "corp";
const PASSWORD = "a-long-password-1";
const SIGN_IN_CONFIG = {
  [NAME]: {
    name: "Ada",
    signUp: { mode: "open" },
    signIn: { password: true, magicLink: true, social: ["google"], oidc: [{ id: OIDC_ID, name: "Corp", discoveryUrl: "https://sso.example.com/.well-known/openid-configuration" }] },
  },
};

/**
 * The config and secrets of an App with every sign-in method, and its channel-web, whose OIDC platform
 * is found at `discoveryUrl` (the fake one, on http: the config takes https only).
 */
function everyMethod(discoveryUrl: string) {
  const config = SIGN_IN_CONFIG;
  const channel = () =>
    createChannelWeb({
      accounts: { ...BETTER_AUTH, local: (deps) => BETTER_AUTH.local({ ...deps, secrets: { ...deps.secrets, oidc: deps.secrets.oidc.map((each) => ({ ...each, discoveryUrl })) } }) },
    });
  const secrets = {
    ...SECRETS,
    CHANNEL_WEB_GOOGLE_CLIENT_ID: "google-client",
    CHANNEL_WEB_GOOGLE_CLIENT_SECRET: "google-secret",
    CHANNEL_WEB_OIDC_CORP_CLIENT_ID: "corp-client",
    CHANNEL_WEB_OIDC_CORP_CLIENT_SECRET: "corp-secret",
  };
  return { config, secrets, channel };
}

/** `email.send` that keeps what it is asked to send. */
function emailOf(sent: EmailMessage[]): ComponentDefinition {
  return defineComponent({ name: "email-test", setup: (pikit) => pikit.provide("email.send", { send: async (message: EmailMessage) => (sent.push(message), { id: `e${sent.length}` }) }) });
}

/** Both targets, each with every sign-in method and email: `fetch` its routes. */
async function targets(discoveryUrl: string): Promise<{ name: string; fetch: Served["fetch"] }[]> {
  const { config, secrets, channel } = everyMethod(discoveryUrl);
  const server = await serve([secretsOf(secrets), new Runtime().component(), kvOf(), sqliteStorage(), router, adminAuth, emailOf([]), channel()], config, "server", ORIGIN);
  served.push(server);
  const { worker } = await cloud(config, secrets, [emailOf([])], channel);
  return [
    { name: "server", fetch: server.fetch },
    { name: "cloudflare", fetch: worker.fetch },
  ];
}

const nameOf = (cookie: string): string => cookie.split("=")[0] ?? "";

/** A browser signed in as `email`, invited by the operator (verified), its password set from the invitation's link. */
async function signedIn(target: { fetch: Served["fetch"] }, email: string, ip: string) {
  const person = browser(target.fetch, ip);
  const invited = await target.fetch("/admin/api/channel-web/invitations", { method: "POST", headers: { ...OPERATOR, "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const { link } = (await invited.json()) as { link: string };
  const token = new URL(link.slice(link.indexOf("#") + 1), ORIGIN).searchParams.get("token");
  expect((await person.send("/chat/api/auth/reset-password", { json: { token, newPassword: PASSWORD } })).status).toBe(200);
  expect((await person.send("/chat/api/auth/sign-in/email", { json: { email, password: PASSWORD } })).status).toBe(200);
  expect(person.jar.has("pikit_chat.session_token")).toBe(true);
  return person;
}

test("every better-auth route the page uses is reachable through /chat/api/auth/* on both targets (never the API's 404)", async () => {
  const oidc = await fakeOidc("corp-client");
  stops.push(oidc.stop);
  for (const target of await targets(oidc.discoveryUrl)) {
    const ana = await signedIn(target, "ana@example.com", `10.1.0.${target.name === "server" ? 1 : 2}`);
    const routes: [string, string, unknown?][] = [
      ["POST", "/sign-in/email", { email: "ana@example.com", password: PASSWORD, callbackURL: "/chat/" }],
      ["POST", "/sign-up/email", { email: "bo@example.com", password: PASSWORD, name: "Bo", callbackURL: "/chat/" }],
      ["POST", "/sign-in/social", { provider: "google", callbackURL: "/chat/", disableRedirect: true }],
      ["POST", "/sign-in/social", { provider: OIDC_ID, callbackURL: "/chat/", disableRedirect: true }],
      ["POST", "/sign-in/magic-link", { email: "ana@example.com", callbackURL: "/chat/" }],
      ["GET", "/magic-link/verify?token=not-a-token&callbackURL=%2Fchat%2F"],
      ["GET", "/verify-email?token=not-a-token"],
      ["POST", "/send-verification-email", { email: "ana@example.com", callbackURL: "/chat/" }],
      ["POST", "/request-password-reset", { email: "ana@example.com", redirectTo: "/chat/#/set-password" }],
      ["POST", "/reset-password", { token: "not-a-token", newPassword: "another-long-password" }],
      ["POST", "/change-password", { currentPassword: "not-the-password", newPassword: "another-long-password" }],
      ["POST", "/update-user", { name: "Ana B" }],
      ["GET", "/list-accounts"],
      ["POST", "/link-social", { provider: "google", callbackURL: "/chat/#/account", disableRedirect: true }],
      ["POST", "/unlink-account", { accountId: "not-an-account" }],
      ["GET", "/list-sessions"],
      ["GET", "/get-session"],
      ["POST", "/revoke-session", { token: "not-a-token" }],
      ["POST", "/revoke-other-sessions", {}],
      ["GET", `/callback/${OIDC_ID}?code=not-a-code&state=not-a-state`],
      ["POST", "/revoke-sessions", {}],
      ["POST", "/sign-out", {}],
    ];
    for (const [method, path, json] of routes) {
      const response = await ana.send(`/chat/api/auth${path}`, { method, ...(json !== undefined && { json }) });
      const body = await response.text();
      expect({ target: target.name, method, path, status: response.status === 404 ? `404 ${body}` : "reachable" }).toEqual({ target: target.name, method, path, status: "reachable" });
    }
    const form = await ana.send(`/chat/api/auth/callback/${OIDC_ID}`, { form: { code: "c", state: "s" }, cookies: false, headers: { origin: oidc.base } });
    expect({ target: target.name, status: form.status }).toEqual({ target: target.name, status: 302 });
  }
});

test("an OIDC sign-in through the Worker: the platform's redirect back lands as better-auth made it (302, Location, both session cookies); form_post redirects to the GET callback", async () => {
  const oidc = await fakeOidc("corp-client");
  stops.push(oidc.stop);
  const { config, secrets, channel } = everyMethod(oidc.discoveryUrl);
  const { worker, calls } = await cloud(config, secrets, [emailOf([])], channel);
  const cy = browser(worker.fetch, "10.2.0.1");
  const profile: Profile = { sub: "cy", email: "cy@example.com", email_verified: true, name: "Cy" };

  const started = await cy.send("/chat/api/auth/sign-in/social", { json: { provider: OIDC_ID, callbackURL: "/chat/", errorCallbackURL: "/chat/#/sign-in" } });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  // The platform posts the code back (form_post): no cookies cross sites; better-auth sends the browser to the GET callback.
  const posted = await cy.send(`/chat/api/auth/callback/${OIDC_ID}`, { form: Object.fromEntries(new URL(oidc.approve(url, profile)).searchParams), cookies: false, headers: { origin: oidc.base } });
  expect(posted.status).toBe(302);
  const callback = new URL(posted.headers.get("location") ?? "");
  expect(`${callback.origin}${callback.pathname}`).toBe(`${ORIGIN}/chat/api/auth/callback/${OIDC_ID}`);

  calls.length = 0;
  const landed = await cy.send(callback.toString());
  expect(landed.status).toBe(302);
  expect(landed.headers.get("location")).toBe("/chat/");
  expect(await landed.text()).toBe("");
  const cookies = landed.headers.getSetCookie();
  expect(cookies.map(nameOf)).toEqual(expect.arrayContaining(["pikit_chat.session_token", "pikit_chat.session_data"]));
  for (const cookie of cookies) expect(cookie).toContain("Path=/chat/");
  expect(calls).toEqual([`channel-web:accounts ${AUTH_CALL.handle}`]);
  expect(((await (await cy.send("/chat/api/me")).json()) as { user: { email: string }; methods: string[] })).toMatchObject({ user: { email: "cy@example.com" }, methods: [OIDC_ID] });
});

test("better-auth's origin check holds through the forwarder: a change with the session's cookies from another site's page is 403, from the chat's own 200", async () => {
  const oidc = await fakeOidc("corp-client");
  stops.push(oidc.stop);
  for (const target of await targets(oidc.discoveryUrl)) {
    const ana = await signedIn(target, "ana@example.com", `10.3.0.${target.name === "server" ? 1 : 2}`);

    const foreign = await ana.send("/chat/api/auth/update-user", { json: { name: "Mallory" }, headers: { origin: "https://evil.example" } });
    expect({ target: target.name, status: foreign.status, code: ((await foreign.json()) as { code?: string }).code }).toEqual({ target: target.name, status: 403, code: "INVALID_ORIGIN" });
    const referred = await ana.send("/chat/api/auth/sign-out", { json: {}, headers: { origin: "", referer: "https://evil.example/page" } });
    expect({ target: target.name, status: referred.status }).toEqual({ target: target.name, status: 403 });
    const own = await ana.send("/chat/api/auth/update-user", { json: { name: "Ana B" } });
    expect({ target: target.name, status: own.status }).toEqual({ target: target.name, status: 200 });
    expect(((await (await ana.send("/chat/api/me")).json()) as { user: { name: string } }).user.name).toBe("Ana B");
  }
});
