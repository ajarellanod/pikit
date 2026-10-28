/**
 * tool-mcp-oauth's tests. They are copied with the component and keep running in your project.
 *
 * The MCP server and its authorization server are one local fake on a free port
 * (`fake-oauth.test-support.ts`: dynamic registration, PKCE, rotating refresh tokens). Logins are made
 * by the real command (`login.ts`), its browser a `fetch` that follows the redirect, uploaded to the
 * real routes. `mcp.auth` is used as tool-mcp uses it: pi-mcp's client over `mcpHttpTransport` with
 * the provider as `authProvider`.
 *
 * Cloudflare's objects are a double here (`Objects`): each App is one object, and a call reaches the
 * App of its key, as actors-do's RPC does; the owner's App and each conversation's have their own
 * `storage.sql`. On a server (`serverApp`) one App is every key's actor, as with mailbox-local.
 * Nothing reaches the network.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorCallHandler, type ActorMailbox, type AdminAuth, answerCall, callResult, type HealthRegistry, type HttpRoute, type JsonValue } from "@pikit/contracts";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import { type McpAuth, McpClient, mcpHttpTransport, McpOAuthAuthorizationRequiredError } from "@pikit/pi-adapter/mcp";
import { createFakeMcpServer, type FakeMcpTool } from "@pikit/pi-adapter/mcp/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { CALL, EARLY_MS, OWNER_KEY, REFUSAL } from "./calls.ts";
import { createFakeOAuthServer, type FakeOAuthServer, type FakeOAuthServerOptions } from "./fake-oauth.test-support.ts";
import toolMcpOauth, { worker } from "./index.ts";
import { command } from "./login.ts";

const OPERATOR = "operator-token-0123456789";
const APP = "http://app.test";

const TOOLS: FakeMcpTool[] = [
  {
    name: "whoami",
    description: "Who is logged in.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    call: () => ({ content: [{ type: "text", text: "ana" }] }),
  },
];

const apps: App[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.stop().catch(() => {});
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** The fake MCP server and its authorization server on a free port, and the MCP URL. */
function serveFake(options: Partial<FakeOAuthServerOptions> = {}): { fake: FakeOAuthServer; url: string } {
  const fake = createFakeOAuthServer({ mcp: createFakeMcpServer({ tools: TOOLS }), ...options });
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => fake.fetch(request) });
  stops.push(() => http.stop(true));
  return { fake, url: `http://127.0.0.1:${http.port}/mcp` };
}

const copy = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Cloudflare's objects, as far as tool-mcp-oauth goes: a call reaches the App of its key. */
class Objects {
  readonly calls: string[] = [];
  private readonly live = new Map<string, { answers: Map<string, ActorCallHandler>; ctx: () => AppContext }>();
  readonly mailbox: ActorMailbox = {
    send: async () => {
      throw new Error("tool-mcp-oauth sends nothing");
    },
    call: async (key, type, message) => {
      this.calls.push(`${key} ${type}`);
      const object = this.live.get(key);
      const handler = object?.answers.get(type);
      if (object === undefined || handler === undefined) throw new ActorCallError("unreachable", `no object ${key} answers ${type}`);
      return callResult(await answerCall(handler, key, copy(message), object.ctx()));
    },
    stream: async (_key, type) => {
      throw new ActorCallError("no_handler", `tool-mcp-oauth opens no stream (${type})`);
    },
  };
  /** The platform of the object `key`: its inbox and the mailbox. */
  platform(key: string): ComponentDefinition {
    const answers = new Map<string, ActorCallHandler>();
    const objects = this;
    return defineComponent({
      name: "platform-test",
      setup(pikit) {
        pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: (type, handler) => void answers.set(type, handler), answerStream: () => {} });
        pikit.provide("actor.mailbox", objects.mailbox);
        return {
          start(ctx) {
            const context = ctx.derive(() => BACKGROUND_CONTEXT);
            objects.live.set(key, { answers, ctx: () => context });
          },
          stop() {
            objects.live.delete(key);
          },
        };
      },
    });
  }
  /** How many calls of `type` reached the owner. */
  count(type: string): number {
    return this.calls.filter((call) => call === `${OWNER_KEY} ${type}`).length;
  }
}

/** A server's platform: one App is every key's actor, as with mailbox-local. */
function serverPlatform(): ComponentDefinition {
  return defineComponent({
    name: "platform-test",
    setup(pikit) {
      const answers = new Map<string, ActorCallHandler>();
      let ctx: AppContext | undefined;
      pikit.provide("actor.inbox", { scope: "all", handle: () => {}, answer: (type, handler) => void answers.set(type, handler), answerStream: () => {} });
      pikit.provide("actor.mailbox", {
        send: async () => {},
        call: async (key, type, message) => {
          const handler = answers.get(type);
          if (handler === undefined || ctx === undefined) throw new ActorCallError("no_handler", type);
          return callResult(await answerCall(handler, key, copy(message), ctx));
        },
        stream: async () => {
          throw new ActorCallError("no_handler", "no stream");
        },
      });
      return { start: (context) => void (ctx = context.derive(() => BACKGROUND_CONTEXT)) };
    },
  });
}

const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === `Bearer ${OPERATOR}` ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** `health` that keeps each component's last report. */
function healthOf(reports: Map<string, { status: string; reason?: string }>): ComponentDefinition {
  const registry: HealthRegistry = {
    reporter: (name) => ({
      up: () => void reports.set(name, { status: "up" }),
      degraded: (reason) => void reports.set(name, { status: "degraded", reason }),
      down: (reason) => void reports.set(name, { status: "down", reason }),
    }),
    snapshot: () => ({ status: "up", components: [] }),
  };
  return defineComponent({ name: "health-test", setup: (pikit) => pikit.provide("health", registry) });
}

interface Logged {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}
const recording = (logged: Logged[]): Logger => {
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void logged.push({ level, message, ...(fields !== undefined && { fields }) });
  return { ...silentLogger, debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
};

/** What an App provides that the tests read: its `mcp.auth` and `http.route`s. */
function reader(into: { auths: Map<string, McpAuth>; routes: Map<string, HttpRoute> }): ComponentDefinition {
  return defineComponent({
    name: "reader-test",
    setup(pikit) {
      const auths = pikit.useKeyed("mcp.auth");
      const routes = pikit.useKeyed("http.route");
      return {
        start() {
          for (const key of auths.keys()) into.auths.set(key, auths.get(key) as McpAuth);
          for (const key of routes.keys()) into.routes.set(key, routes.get(key) as HttpRoute);
        },
      };
    },
  });
}

/** Serves `request` with the route of `routes` whose key matches it (`:name` is any one segment). */
async function serveRoute(routes: Map<string, HttpRoute>, request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  for (const [key, route] of routes) {
    const [method, pattern = ""] = key.split(" ");
    const segments = pattern.split("/").filter((segment) => segment !== "");
    if (method !== request.method || segments.length !== path.length) continue;
    if (segments.every((segment, index) => segment.startsWith(":") || segment === path[index])) return route(request, ctx);
  }
  return new Response("no route", { status: 404 });
}

interface Deployment {
  objects: Objects;
  clock: ManualClock;
  logged: Logged[];
  health: Map<string, { status: string; reason?: string }>;
  /** The Worker's App: the operator's routes. */
  worker: App;
  /** A request to the Worker's routes. */
  fetchApp(path: string, init?: RequestInit): Promise<Response>;
  /** A conversation object's `mcp.auth` of `server`, in an App of its own. */
  conversation(server: string): Promise<McpAuth>;
  /** The owner evicted: a new App over the same storage (with `servers`, when the config changed). */
  restartOwner(servers?: Record<string, unknown>): Promise<void>;
  /** `pikit tool-mcp-oauth <args>` against the Worker, the browser following the redirect. */
  run(args: string[]): Promise<{ problems: string[]; said: string[] }>;
}

async function deployment(servers: Record<string, unknown>): Promise<Deployment> {
  const objects = new Objects();
  const clock = createManualClock(Date.now());
  const logged: Logged[] = [];
  const logger = recording(logged);
  const health = new Map<string, { status: string; reason?: string }>();
  const ownerStorage = sqliteStorage();
  let config = { "tool-mcp-oauth": { servers } };
  let owner: App | undefined;
  const startOwner = async () => {
    const app = await defineApp({ components: [ownerStorage, objects.platform(OWNER_KEY), toolMcpOauth], config, logger, clock, target: "durable" }).create();
    await app.start();
    apps.push(app);
    owner = app;
  };
  await startOwner();
  const routes = new Map<string, HttpRoute>();
  const workerApp = await defineApp({
    components: [objects.platform("worker"), auth, worker, reader({ auths: new Map(), routes })],
    logger,
    clock,
    target: "durable",
  }).create();
  await workerApp.start();
  apps.push(workerApp);
  const fetchApp = (path: string, init: RequestInit = {}) => serveRoute(routes, new Request(`${APP}${path}`, init), workerApp.context());
  const d: Deployment = {
    objects,
    clock,
    logged,
    health,
    worker: workerApp,
    fetchApp,
    async conversation(server) {
      const into = { auths: new Map<string, McpAuth>(), routes: new Map<string, HttpRoute>() };
      const app = await defineApp({ components: [sqliteStorage(), objects.platform(`telegram:${crypto.randomUUID()}`), healthOf(health), toolMcpOauth, reader(into)], config, logger, clock, target: "durable" }).create();
      await app.start();
      apps.push(app);
      return into.auths.get(server) as McpAuth;
    },
    async restartOwner(next) {
      await owner?.stop();
      if (next !== undefined) config = { "tool-mcp-oauth": { servers: next } };
      await startOwner();
    },
    run: (args) => runCommand(args, () => config["tool-mcp-oauth"], fetchApp),
  };
  return d;
}

/** `pikit tool-mcp-oauth <args>`: the App at `APP` is `fetchApp`; the browser approves at once and comes back. */
async function runCommand(args: string[], config: () => Record<string, unknown>, fetchApp: (path: string, init?: RequestInit) => Promise<Response>): Promise<{ problems: string[]; said: string[] }> {
  const said: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === APP) return fetchApp(`${url.pathname}${url.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
  const browse = async (authorization: URL) => {
    const approved = await fetch(authorization, { redirect: "manual" });
    const back = approved.headers.get("location");
    if (back === null) throw new Error(`the authorization page answered ${approved.status}`);
    await (await fetch(back)).text();
  };
  const problems = await command(
    { args, config: async () => config(), get: (name) => (name === "PIKIT_ADMIN_TOKEN" ? OPERATOR : undefined), say: (line) => void said.push(line) },
    { fetch: fetcher, browse, localOrigin: async () => APP, timeoutMs: 10_000 },
  );
  return { problems, said };
}

/** A client of the MCP server at `url` with `auth`, as tool-mcp connects. */
async function connect(url: string, auth: McpAuth): Promise<McpClient> {
  const client = new McpClient({ name: "pikit-test", version: "0.0.0" });
  await client.connect(mcpHttpTransport({ url, authProvider: auth }));
  stops.push(() => client.close().catch(() => {}));
  return client;
}

const text = async (client: McpClient) => ((await client.callTool("whoami", {})).content[0] as { text: string }).text;
const refreshes = (fake: FakeOAuthServer) => fake.tokenRequests.filter((form) => form.grant_type === "refresh_token").length;

/** What the owner keeps of `server`, read from its storage through a fresh owner's eyes: the stored login's JSON. */
async function stored(d: Deployment, server: string): Promise<string> {
  // The owner's App answers `token`; the stored row is what a restarted owner reads.
  await d.restartOwner();
  return JSON.stringify(await d.objects.mailbox.call(OWNER_KEY, CALL.token, { server }, d.worker.context()));
}

test("login: dynamic registration sends the configured client_name, PKCE checks out, and the login is uploaded, not kept", async () => {
  const { fake, url } = serveFake({ clientNames: ["Codex"] });
  const d = await deployment({ figma: { url, clientName: "Codex" } });
  const { problems, said } = await d.run(["login", "figma"]);

  expect(problems).toEqual([]);
  expect(fake.registrations).toEqual([expect.objectContaining({ client_name: "Codex", redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)] })]);
  // The fake refuses a verifier that does not hash to the challenge: the exchange succeeded with one.
  const exchange = fake.tokenRequests.find((form) => form.grant_type === "authorization_code");
  expect(exchange?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  expect(said.at(-1)).toContain('✓ logged in to "figma"');
  expect(said.at(-1)).toContain("nothing was kept on this machine");
  // The App holds it: a conversation's object gets the token the code was exchanged for.
  const client = await connect(url, await d.conversation("figma"));
  expect(await text(client)).toBe("ana");
  expect(fake.mcpAuthorizations.at(-1)).toBe(`Bearer ${fake.current.access}`);
  // Nothing printed holds a token.
  for (const secret of fake.issued) expect(said.join("\n")).not.toContain(secret);
});

test("login: a client name the server refuses to register says how to choose another, and uploads nothing", async () => {
  const { fake, url } = serveFake({ clientNames: ["Codex"] });
  const d = await deployment({ figma: { url } });
  const { problems } = await d.run(["login", "figma"]);

  expect(fake.registrations).toEqual([expect.objectContaining({ client_name: "pikit" })]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("refused to register the client \"pikit\"");
  expect(problems[0]).toContain("clientName");
  expect(await (await d.fetchApp("/admin/api/tool-mcp-oauth", { headers: { authorization: `Bearer ${OPERATOR}` } })).json()).toEqual({
    servers: [{ server: "figma", url, loggedIn: false, reason: "no login yet" }],
  });
});

test("a token is used, kept by the object, and refreshed once after a 401; the rotated tokens are the owner's", async () => {
  const { fake, url } = serveFake();
  const d = await deployment({ figma: { url } });
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  const first = { access: fake.current.access, refresh: fake.current.refresh };
  const client = await connect(url, await d.conversation("figma"));

  expect(await text(client)).toBe("ana");
  expect(await text(client)).toBe("ana");
  // Initialize, initialized, two calls: one token from the owner, kept since.
  expect(d.objects.count(CALL.token)).toBe(1);
  expect(fake.mcpAuthorizations.every((header) => header === `Bearer ${first.access}`)).toBe(true);

  fake.expireAccess();
  expect(await text(client)).toBe("ana");
  expect(refreshes(fake)).toBe(1);
  expect(fake.tokenRequests.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: first.refresh as string });
  expect(fake.mcpAuthorizations.at(-1)).toBe(`Bearer ${fake.current.access}`);
  expect(fake.current.access).not.toBe(first.access);
  // The owner stored the rotated pair: a restarted owner serves the new access token.
  expect(await stored(d, "figma")).toContain(fake.current.access as string);
});

test("five conversations refused at once cause one refresh; each gets the new token; an owner restarted after it refreshes nothing again", async () => {
  const { fake, url } = serveFake();
  const d = await deployment({ figma: { url } });
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  const old = fake.current.access as string;
  const clients = await Promise.all([1, 2, 3, 4, 5].map(async () => connect(url, await d.conversation("figma"))));
  // A sixth whose token is the old one, kept: it gets its 401 only after the owner restarted.
  const late = await connect(url, await d.conversation("figma"));

  fake.expireAccess();
  fake.refreshDelayMs = 50;
  expect(await Promise.all(clients.map(text))).toEqual(["ana", "ana", "ana", "ana", "ana"]);
  expect(refreshes(fake)).toBe(1);
  // Within one object too: five concurrent 401s, one refresh call to the owner.
  fake.expireAccess();
  const one = clients[0] as McpClient;
  expect(await Promise.all([1, 2, 3, 4, 5].map(() => text(one)))).toEqual(["ana", "ana", "ana", "ana", "ana"]);
  expect(refreshes(fake)).toBe(2);

  await d.restartOwner();
  const before = d.objects.count(CALL.refresh);
  expect(await text(late)).toBe("ana");
  // It named its old token: the restarted owner sees it is not current, and answers the stored one.
  expect(d.objects.count(CALL.refresh)).toBe(before + 1);
  expect(refreshes(fake)).toBe(2);
  expect(fake.mcpAuthorizations.filter((header) => header === `Bearer ${old}`).length).toBeGreaterThan(0);
});

test("invalid_grant: one clear 'log in again' error, no loop and no new request to the authorization server; health degraded until a new login", async () => {
  const { fake, url } = serveFake();
  const d = await deployment({ figma: { url } });
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  const client = await connect(url, await d.conversation("figma"));
  expect(await text(client)).toBe("ana");
  expect(d.health.get("tool-mcp-oauth:figma")).toEqual({ status: "up" });

  fake.expireAccess();
  fake.refuseRefreshes("invalid_grant");
  const failed = await text(client).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(McpOAuthAuthorizationRequiredError);
  expect((failed as Error).message).toBe(
    'tool-mcp-oauth: the MCP server "figma" is not logged in (the authorization server refused the refresh: invalid_grant): log in again: `pikit tool-mcp-oauth login figma`',
  );
  expect(refreshes(fake)).toBe(1);
  const mcpRequests = fake.mcpAuthorizations.length;

  // Again, from another conversation: refused at once by the owner, nothing reaches either server.
  const other = await d.conversation("figma");
  await expect(other.token()).rejects.toThrow("log in again: `pikit tool-mcp-oauth login figma`");
  await expect(text(client)).rejects.toThrow("log in again");
  expect(refreshes(fake)).toBe(1);
  expect(fake.mcpAuthorizations.length).toBe(mcpRequests);
  expect(d.health.get("tool-mcp-oauth:figma")).toMatchObject({ status: "degraded", reason: expect.stringContaining("pikit tool-mcp-oauth login figma") });

  // A new login ends it.
  fake.refuseRefreshes(undefined);
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  expect(await other.token()).toBe(fake.current.access as string);
  expect(d.health.get("tool-mcp-oauth:figma")).toEqual({ status: "up" });
});

test("a refresh that cannot be made now keeps the login: the call fails saying try again, the next one refreshes", async () => {
  const { fake, url } = serveFake();
  const d = await deployment({ figma: { url } });
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  const client = await connect(url, await d.conversation("figma"));
  expect(await text(client)).toBe("ana");

  fake.expireAccess();
  fake.failRefreshes(1);
  await expect(text(client)).rejects.toThrow('the token of the MCP server "figma" could not be refreshed now');
  expect(await text(client)).toBe("ana");
  expect(refreshes(fake)).toBe(2);
});

test("a token expiring within a minute is refreshed by the owner before it is served", async () => {
  const { fake, url } = serveFake({ expiresIn: 3600 });
  const d = await deployment({ figma: { url } });
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  const auth = await d.conversation("figma");
  const first = await auth.token();
  expect(first).toBe(fake.current.access as string);
  expect(await auth.token()).toBe(first);

  await d.clock.advance(3600_000 - EARLY_MS + 10_000);
  const next = await auth.token();
  expect(next).not.toBe(first);
  expect(next).toBe(fake.current.access as string);
  expect(refreshes(fake)).toBe(1);
});

test("a login is used only for its URL: an upload for another URL is refused, a config moved to another URL asks for a new login, two accounts of one URL never mix", async () => {
  const one = serveFake({ name: "one" });
  const two = serveFake({ name: "two" });
  const d = await deployment({ alice: { url: one.url }, bob: { url: one.url } });
  expect((await d.run(["login", "alice"])).problems).toEqual([]);
  const operator = { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" };

  // bob shares alice's URL, not her login.
  await expect((await d.conversation("bob")).token()).rejects.toThrow('the MCP server "bob" is not logged in (no login yet)');
  expect(await (await d.conversation("alice")).token()).toBe(one.fake.current.access as string);

  // An upload whose URL is not the server's in config.
  const login = {
    url: two.url,
    clientInformation: { client_id: "c" },
    tokens: { access_token: "two-access-x", token_type: "Bearer", refresh_token: "two-refresh-x" },
    discovery: { authorizationServerUrl: new URL(two.url).origin },
  };
  const refused = await d.fetchApp("/admin/api/tool-mcp-oauth/bob", { method: "PUT", headers: operator, body: JSON.stringify(login) });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "invalid_request", message: `tool-mcp-oauth: the login is for ${two.url}, and the server "bob" is ${one.url} in config` });

  // alice's config now names another URL: her login is not sent there.
  await d.restartOwner({ alice: { url: two.url }, bob: { url: one.url } });
  const moved = await d.conversation("alice");
  await expect(moved.token()).rejects.toThrow(`its login is for ${one.url}, and the server is now ${two.url}`);
  await expect(connect(two.url, moved)).rejects.toThrow("log in again");
  expect(two.fake.mcpAuthorizations.every((header) => header === null || !header.includes("one-access"))).toBe(true);
});

test("the upload route: 401 without an operator, 400 for a server not in config or a body that is no login; GET and errors hold no secret", async () => {
  const { fake, url } = serveFake();
  const d = await deployment({ figma: { url } });
  const operator = { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" };
  const login = { url, clientInformation: { client_id: "c", client_secret: "client-secret-xyz" }, tokens: { access_token: "fake-access-x", token_type: "Bearer" }, discovery: { authorizationServerUrl: new URL(url).origin } };

  const anonymous = await d.fetchApp("/admin/api/tool-mcp-oauth/figma", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(login) });
  expect(anonymous.status).toBe(401);
  expect((await d.fetchApp("/admin/api/tool-mcp-oauth")).status).toBe(401);
  const unknown = await d.fetchApp("/admin/api/tool-mcp-oauth/linear", { method: "PUT", headers: operator, body: JSON.stringify({ ...login }) });
  expect([unknown.status, await unknown.json()]).toEqual([400, { error: "invalid_request", message: `tool-mcp-oauth: "linear" is not a server in tool-mcp-oauth's config` }]);
  const shapeless = await d.fetchApp("/admin/api/tool-mcp-oauth/figma", { method: "PUT", headers: operator, body: JSON.stringify({ url, tokens: "fake-access-x" }) });
  expect(shapeless.status).toBe(400);
  expect(await shapeless.text()).not.toContain("fake-access-x");
  expect((await d.fetchApp("/admin/api/tool-mcp-oauth/figma", { method: "DELETE", headers: operator })).status).toBe(200);

  // A real login and its use, refresh and refusal, then everything the operator and the logs saw.
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  const client = await connect(url, await d.conversation("figma"));
  await text(client);
  fake.expireAccess();
  await text(client);
  fake.expireAccess();
  fake.refuseRefreshes("invalid_grant");
  const failure = await text(client).catch((error: unknown) => (error as Error).message);
  const listed = await (await d.fetchApp("/admin/api/tool-mcp-oauth", { headers: operator })).text();
  expect(JSON.parse(listed)).toEqual({ servers: [{ server: "figma", url, loggedIn: false, reason: "the authorization server refused the refresh: invalid_grant" }] });
  const status = await d.run(["status"]);
  const everything = [listed, failure, JSON.stringify(d.logged), status.said.join("\n"), JSON.stringify([...d.health.values()])].join("\n");
  expect(fake.issued.length).toBe(4);
  for (const secret of [...fake.issued, "client-secret-xyz"]) expect(everything).not.toContain(secret);
  expect(d.logged.some((line) => line.message.includes("refresh was refused"))).toBe(true);
});

test("on a server, the App is the owner: one not logged in starts anyway, reports health degraded, and its token says how to log in", async () => {
  const { fake, url } = serveFake();
  const health = new Map<string, { status: string; reason?: string }>();
  const into = { auths: new Map<string, McpAuth>(), routes: new Map<string, HttpRoute>() };
  const app = await defineApp({
    components: [sqliteStorage(), serverPlatform(), auth, healthOf(health), toolMcpOauth, reader(into)],
    config: { "tool-mcp-oauth": { servers: { figma: { url } } } },
    logger: silentLogger,
  }).create();
  await app.start();
  apps.push(app);

  expect(health.get("tool-mcp-oauth:figma")).toEqual({ status: "degraded", reason: 'the MCP server "figma" is not logged in (no login yet): log in again: `pikit tool-mcp-oauth login figma`' });
  await expect(connect(url, into.auths.get("figma") as McpAuth)).rejects.toThrow("log in again: `pikit tool-mcp-oauth login figma`");
  expect(fake.mcpAuthorizations).toEqual([]);

  // `pikit dev`'s login: the same command against this App's own routes.
  const { problems } = await runCommand(["login", "figma"], () => ({ servers: { figma: { url } } }), (path, init) => serveRoute(into.routes, new Request(`${APP}${path}`, init), app.context()));
  expect(problems).toEqual([]);
  expect(await text(await connect(url, into.auths.get("figma") as McpAuth))).toBe("ana");
  expect(health.get("tool-mcp-oauth:figma")).toEqual({ status: "up" });
});

test("only the owner's key is answered: a call that reached another actor is refused, and nothing is kept there", async () => {
  const { url } = serveFake();
  const d = await deployment({ figma: { url } });
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  const other = await defineApp({
    components: [sqliteStorage(), d.objects.platform("telegram:other"), toolMcpOauth],
    config: { "tool-mcp-oauth": { servers: { figma: { url } } } },
    logger: silentLogger,
    target: "durable",
  }).create();
  await other.start();
  apps.push(other);
  for (const [type, message] of [[CALL.token, { server: "figma" }], [CALL.list, {}], [CALL.delete, { server: "figma" }]] as const) {
    const refused = await d.objects.mailbox.call("telegram:other", type, message, d.worker.context()).catch((error: unknown) => error);
    expect([type, (refused as ActorCallError).code]).toEqual([type, REFUSAL.invalid]);
  }
  // The owner's login is untouched.
  expect(await d.objects.mailbox.call(OWNER_KEY, CALL.token, { server: "figma" }, d.worker.context())).toMatchObject({ token: expect.any(String) });
});

test("the command: usage, a server not in config, and an App that refuses the operator stop it before any browser", async () => {
  const { fake, url } = serveFake();
  const d = await deployment({ figma: { url } });
  expect((await d.run([])).problems).toEqual(["which subcommand?", expect.stringContaining("usage: pikit tool-mcp-oauth login <server>")]);
  expect((await d.run(["login", "linear"])).problems).toEqual(['"linear" is not a server in tool-mcp-oauth\'s config (it has: figma)']);
  const refused = await command(
    { args: ["login", "figma"], config: async () => ({ servers: { figma: { url } } }), get: (name) => (name === "PIKIT_ADMIN_TOKEN" ? "wrong" : undefined), say: () => {} },
    { fetch: ((input: string, init?: RequestInit) => d.fetchApp(new URL(input).pathname, init)) as typeof fetch, localOrigin: async () => APP, browse: () => Promise.reject(new Error("no browser")) },
  );
  expect(refused).toEqual([`${APP} refused PIKIT_ADMIN_TOKEN (401): is it this App's token?`]);
  expect(fake.registrations).toEqual([]);
  // logout drops the App's login.
  expect((await d.run(["login", "figma"])).problems).toEqual([]);
  expect((await d.run(["logout", "figma"])).said).toEqual([`Logged out of "figma" at ${APP}: its tools fail until \`pikit tool-mcp-oauth login figma\`.`]);
  await expect((await d.conversation("figma")).token()).rejects.toThrow("(no login yet)");
});
