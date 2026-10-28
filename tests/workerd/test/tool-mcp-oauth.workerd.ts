/**
 * tool-mcp-oauth on Cloudflare, through workerd's real `fetch` to the lane's fake MCP server behind
 * OAuth (`MCP_HOSTS.oauth`, `mcp-outbound.ts`: registration, PKCE, rotating refresh tokens).
 *
 * - The login as `pikit tool-mcp-oauth login` makes it (pi-mcp's `authorizeMcp`: discovery, the
 *   client registered with its `client_name`, PKCE), the browser played by following the
 *   authorization endpoint's redirect, uploaded through the Worker's route (tool-mcp-oauth's Worker
 *   half, deployment-cloudflare's server) to the owner object `tool-mcp-oauth`.
 * - Two conversations' `PlatformConversation` objects call the MCP server with `mcp.auth`: each asks
 *   the owner for the token; the access token expires and both are refused at once: one refresh, by
 *   the owner, and both answer with the new token.
 * - The owner evicted between two refreshes: the next instance serves the rotated tokens from its
 *   SQLite, and refreshes once more with the latest refresh token (the fake refuses any other).
 *
 * Not here: an owner evicted in the middle of a refresh (owner.ts says what is lost then: the server
 * needs a new login).
 */

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { ActorMailbox, AdminAuth } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { authorizeMcp, McpClient, McpOAuthProvider, type McpOAuthState, mcpHttpTransport } from "@pikit/pi-adapter/mcp";
import { afterEach, beforeEach, expect, it } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import toolMcpOauth, { OWNER_KEY, worker as toolMcpOauthWorker } from "../../../registry/components/tool-mcp-oauth/files/src/pikit/tool-mcp-oauth/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";
import { MCP_HOSTS } from "./mcp-outbound.ts";

const ORIGIN = `https://${MCP_HOSTS.oauth}`;
const URL_OF_MCP = `${ORIGIN}/mcp`;
const CONFIG = { "actors-do": { binding: PLATFORM_BINDING }, "tool-mcp-oauth": { servers: { figma: { url: URL_OF_MCP, clientName: "Codex" } } } };
const AUTH = { authorization: "Bearer workerd-operator" };
const owner = () => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(OWNER_KEY));

/** The fake's controls (`mcp-outbound.ts`). */
const control = (path: string, body?: string) => fetch(`${ORIGIN}/__oauth/${path}`, { method: body === undefined && path === "state" ? "GET" : "POST", ...(body !== undefined && { body }) });
type FakeState = { clientNames: string[]; refreshes: number; current: { access?: string; refresh?: string }; mcpAuthorizations: (string | null)[] };
const fakeState = async () => (await (await control("state")).json()) as FakeState;

beforeEach(async () => {
  await control("reset");
  await resetObjects();
});
afterEach(() => resetObjects());

const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** In each object: a call that asks the MCP server through `mcp.auth`'s "figma", answering the tool's text. */
const prober = defineComponent({
  name: "test-mcp-caller",
  setup(pikit) {
    const inbox = pikit.use("actor.inbox");
    const auths = pikit.useKeyed("mcp.auth");
    return {
      start() {
        inbox.get().answer("test.ask", async () => {
          const authProvider = auths.get("figma");
          if (authProvider === undefined) throw new Error("no mcp.auth figma");
          const client = new McpClient({ name: "pikit-workerd", version: "0.0.0" });
          await client.connect(mcpHttpTransport({ url: URL_OF_MCP, authProvider }));
          try {
            const result = await client.callTool("ask_question", { repoName: "pikit" });
            return (result.content[0] as { text: string }).text;
          } finally {
            await client.close();
          }
        });
      },
    };
  },
});

/** The Worker's App: the routes (tool-mcp-oauth's Worker half) and a mailbox to the objects. */
async function workerApp() {
  const server = createWorkerServer(silentLogger);
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "test-mailbox",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [actorsDo, auth, toolMcpOauthWorker, probe, server.component], config: { "actors-do": CONFIG["actors-do"] }, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    app,
    ask: (key: string) => (mailbox as ActorMailbox).call(key, "test.ask", {}, app.context()),
    route: (path: string, init: RequestInit = {}, operator = true) =>
      server.serve(new Request(`https://pikit.test/admin/api/tool-mcp-oauth${path}`, { ...init, headers: { ...(operator && AUTH), "content-type": "application/json" } })),
  };
}

/** The login `pikit tool-mcp-oauth login figma` makes, the browser approving at once: pi-mcp's state, as uploaded. */
async function login(): Promise<McpOAuthState> {
  let state: McpOAuthState | undefined;
  let code: string | undefined;
  const redirectUrl = "http://127.0.0.1:9/callback";
  const provider = new McpOAuthProvider({
    serverUrl: URL_OF_MCP,
    redirectUrl,
    clientMetadata: { client_name: "Codex" },
    store: { load: () => state, save: (next) => void (state = structuredClone(next)) },
    async onRedirect(authorization) {
      // The browser: the fake approves at once and redirects to the callback with the code.
      const answer = await fetch(authorization.href, { redirect: "manual" });
      code = new URL(answer.headers.get("location") ?? "").searchParams.get("code") ?? undefined;
    },
  });
  expect(await authorizeMcp(provider, { serverUrl: URL_OF_MCP })).toBe("REDIRECT");
  expect(await authorizeMcp(provider, { serverUrl: URL_OF_MCP, authorizationCode: code as string })).toBe("AUTHORIZED");
  return state as McpOAuthState;
}

it("a login uploaded through the Worker is the owner object's; two conversations use it, and both refused at once cause one refresh; an owner evicted after it serves the rotated tokens", async () => {
  composeObjects([storageDo, actorsDo, toolMcpOauth, prober], CONFIG);
  const worker = await workerApp();
  try {
    // Before a login: the call says how to log in.
    await expect(worker.ask("telegram:a")).rejects.toThrow("pikit tool-mcp-oauth login figma");

    const state = await login();
    const upload = { url: URL_OF_MCP, clientInformation: state.clientInformation, tokens: state.tokens, ...(state.tokensExpireAt !== undefined && { tokensExpireAt: state.tokensExpireAt }), discovery: state.discovery };
    const put = await worker.route("/figma", { method: "PUT", body: JSON.stringify(upload) });
    expect(put.status).toBe(200);
    expect(JSON.stringify(await put.json())).not.toContain(state.tokens?.access_token as string);
    expect((await fakeState()).clientNames).toEqual(["Codex"]);

    expect(await worker.ask("telegram:a")).toBe("pikit: it is a kit");
    expect(await worker.ask("telegram:b")).toBe("pikit: it is a kit");

    // Both conversations refused at once: one refresh, by the owner; both answer with the new token.
    await control("expire");
    await control("delay", "300");
    expect(await Promise.all([worker.ask("telegram:a"), worker.ask("telegram:b")])).toEqual(["pikit: it is a kit", "pikit: it is a kit"]);
    const afterOne = await fakeState();
    expect(afterOne.refreshes).toBe(1);
    expect(afterOne.mcpAuthorizations.at(-1)).toBe(`Bearer ${afterOne.current.access}`);

    // The owner evicted: its next instance serves the rotated tokens from its SQLite, and refreshes once more with the latest refresh token.
    await evictDurableObject(owner());
    await control("delay", "0");
    await control("expire");
    expect(await worker.ask("telegram:a")).toBe("pikit: it is a kit");
    expect((await fakeState()).refreshes).toBe(2);

    // The operator's list holds no token.
    const listed = await worker.route("");
    expect(listed.status).toBe(200);
    const body = JSON.stringify(await listed.json());
    expect(body).toContain('"loggedIn":true');
    expect(body).not.toContain((await fakeState()).current.access as string);
  } finally {
    await worker.app.stop();
  }
});

it("the upload route: 401 without the operator's token, 400 for a body that is no login; nothing reaches the owner", async () => {
  composeObjects([storageDo, actorsDo, toolMcpOauth, prober], CONFIG);
  const worker = await workerApp();
  try {
    expect((await worker.route("/figma", { method: "PUT", body: "{}" }, false)).status).toBe(401);
    expect((await worker.route("", {}, false)).status).toBe(401);
    expect((await worker.route("/figma", { method: "PUT", body: JSON.stringify({ url: URL_OF_MCP }) })).status).toBe(400);
    await expect(worker.ask("telegram:a")).rejects.toThrow("pikit tool-mcp-oauth login figma");
  } finally {
    await worker.app.stop();
  }
});
