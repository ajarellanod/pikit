/**
 * `pikit tool-mcp-oauth`: the MCP servers' logins, from the operator's machine.
 *
 *   pikit tool-mcp-oauth login <server> [--port <n>]   log in with a browser, upload the login to the App
 *   pikit tool-mcp-oauth status                         every server in config: logged in or why not
 *   pikit tool-mcp-oauth logout <server>                drop the App's login of that server
 *
 * Every subcommand takes `--url <origin>`: the App it talks to. Without it, `PIKIT_PUBLIC_URL` (the
 * environment, or `.env`), else this machine's App (`pikit dev`): `http://127.0.0.1:8787` with
 * deployment-cloudflare (wrangler), else server-bun's port (3000 unless its config says otherwise). It
 * signs in with `PIKIT_ADMIN_TOKEN` (the environment, or `.env`).
 *
 * `login`, step by step:
 * 1. Asks the App's route (`GET /admin/api/tool-mcp-oauth`) first: an App that cannot be reached, or
 *    refuses the token, stops it before any browser opens.
 * 2. Listens on `127.0.0.1` (pi-mcp's `OAuthCallbackServer`; `--port`, else any free port) for the
 *    browser's redirect, at `/callback`.
 * 3. pi-mcp's flow (`authorizeMcp`): discovers the server's authorization server, registers a client
 *    (dynamic client registration, with `client_name` = the server's `clientName` in config,
 *    `"pikit"` by default) for that redirect, and builds the authorization URL with PKCE (S256) and a
 *    random `state`. The URL is printed (and opened, at a terminal).
 * 4. The browser comes back with a code; the flow exchanges it, with the PKCE verifier, for tokens.
 * 5. Uploads the login (`{ url, clientInformation, tokens, tokensExpireAt, discovery }`) with
 *    `PUT /admin/api/tool-mcp-oauth/<server>`. Nothing is written on this machine: a second copy
 *    that refreshed would revoke the App's rotating refresh token.
 *
 * component.json declares it (`"commands": { "tool-mcp-oauth": … }`): the CLI runs `command(io)` in a
 * child process in the project's directory, never in the App. No token is printed.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { authorizeMcp, McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore } from "@pikit/pi-adapter/mcp";
import { type OAuthCallback, OAuthCallbackServer } from "@pikit/pi-adapter/node";
import type { Login, ServerStatus } from "./calls.ts";

const USAGE = "pikit tool-mcp-oauth login <server> [--port <n>] | status | logout <server>   (any: --url <origin>)";
const TOKEN = "PIKIT_ADMIN_TOKEN";
const PUBLIC_URL = "PIKIT_PUBLIC_URL";
const ROUTE = "/admin/api/tool-mcp-oauth";
const DEFAULT_CLIENT_NAME = "pikit";
/** How long the browser has to come back. */
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** What the CLI gives a component's command (`component-command.ts`). */
export interface CommandIO {
  args: readonly string[];
  config(): Promise<Readonly<Record<string, unknown>>>;
  get(name: string): string | undefined;
  say(line: string): void;
}

/** What tests replace. */
export interface CommandOptions {
  /** The HTTP client of the flow and of the App's routes. */
  fetch?: typeof fetch;
  /** What is done with the authorization URL once printed: opened with the system's browser at a terminal, by default. */
  browse?: (url: URL) => void | Promise<void>;
  /** The origin of this machine's App, when neither `--url` nor `PIKIT_PUBLIC_URL` is given. */
  localOrigin?: () => Promise<string>;
  /** How long the browser has to come back, in ms. */
  timeoutMs?: number;
}

/** An answer of the App or a step of the login that stops the command, said for the operator. */
class Refused extends Error {}

type Parsed = { url?: string } & ({ sub: "login"; server: string; port?: number } | { sub: "status" } | { sub: "logout"; server: string });

export async function command(io: CommandIO, options: CommandOptions = {}): Promise<string[]> {
  const parsed = parse(io.args);
  if (typeof parsed === "string") return [parsed, `usage: ${USAGE}`];
  const token = io.get(TOKEN)?.trim();
  if (token === undefined || token === "") return [`${TOKEN} is not set: the operator's token, in .env or the environment (pikit configure --generate ${TOKEN})`];
  const origin = (parsed.url ?? (io.get(PUBLIC_URL)?.trim() || (await (options.localOrigin ?? localOrigin)()))).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) return [`"${origin}" is not an origin (https://bot.example.com): pass --url, or fix ${PUBLIC_URL}`];
  const fetcher = options.fetch ?? fetch;
  const client = new Client(origin, token, fetcher);
  try {
    switch (parsed.sub) {
      case "status":
        return status(io, await client.send<{ servers: ServerStatus[] }>("GET", ""));
      case "logout": {
        const { deleted } = await client.send<{ deleted: boolean }>("DELETE", `/${encodeURIComponent(parsed.server)}`);
        io.say(deleted ? `Logged out of "${parsed.server}" at ${origin}: its tools fail until \`pikit tool-mcp-oauth login ${parsed.server}\`.` : `"${parsed.server}" had no login at ${origin}.`);
        return [];
      }
      case "login":
        return await login(io, client, parsed.server, parsed.port, fetcher, options);
    }
  } catch (error) {
    if (error instanceof Refused) return [error.message];
    throw error;
  }
}

/** The subcommand and its arguments, or what is wrong with them. */
function parse(args: readonly string[]): Parsed | string {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--url" || arg === "--port") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) return `unknown option ${arg}`;
    else positional.push(arg);
  }
  const [sub, server, ...extra] = positional;
  const url = flags.url !== undefined ? { url: flags.url } : {};
  if (sub === undefined) return "which subcommand?";
  if (extra.length > 0) return `unexpected ${extra.join(" ")}`;
  if (flags.port !== undefined && sub !== "login") return `--port is an option of login only`;
  if (sub === "status") return server === undefined ? { sub, ...url } : `unexpected ${server}`;
  if (sub !== "login" && sub !== "logout") return `unknown subcommand ${sub}`;
  if (server === undefined) return `${sub} which server? its name in tool-mcp-oauth's config`;
  if (sub === "logout") return { sub, server, ...url };
  if (flags.port === undefined) return { sub, server, ...url };
  const port = Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return `--port is a port number (1-65535)`;
  return { sub, server, port, ...url };
}

async function login(io: CommandIO, client: Client, server: string, port: number | undefined, fetcher: typeof fetch, options: CommandOptions): Promise<string[]> {
  const servers = ((await io.config()).servers ?? {}) as Record<string, { url?: unknown; clientName?: unknown } | undefined>;
  const settings = Object.hasOwn(servers, server) ? servers[server] : undefined;
  if (settings === undefined || typeof settings.url !== "string") {
    return [`"${server}" is not a server in tool-mcp-oauth's config (it has: ${Object.keys(servers).join(", ") || "none"})`];
  }
  const url = settings.url;
  const clientName = typeof settings.clientName === "string" && settings.clientName !== "" ? settings.clientName : DEFAULT_CLIENT_NAME;

  // Before any browser: the App answers, and takes the token.
  await client.send("GET", "");

  const callback = await OAuthCallbackServer.listen({ host: "127.0.0.1", ...(port !== undefined && { port }), path: "/callback", timeoutMs: options.timeoutMs ?? CALLBACK_TIMEOUT_MS });
  try {
    const store = memoryStore();
    let waiting: Promise<OAuthCallback> | undefined;
    const provider = new McpOAuthProvider({
      serverUrl: url,
      redirectUrl: callback.redirectUrl,
      clientMetadata: { client_name: clientName },
      store,
      async onRedirect(authorization) {
        waiting = callback.waitForCallback(authorization.searchParams.get("state") ?? "");
        // Read below; a rejection before then (a timeout) must not go unhandled.
        waiting.catch(() => {});
        io.say(`Log in to the MCP server "${server}" (${url}) in a browser, and approve the access:`);
        io.say(`  ${authorization.href}`);
        io.say(`Waiting for the browser to come back to ${callback.redirectUrl} …`);
        await (options.browse ?? openInBrowser)(authorization);
      },
    });
    const flow = { serverUrl: url, fetch: (input: string | URL, init?: RequestInit) => fetcher(input, init) };
    try {
      const first = await authorizeMcp(provider, flow);
      if (first !== "REDIRECT" || waiting === undefined) throw new Refused(`the MCP server "${server}" gave no authorization step: nothing to upload`);
      const { code, iss } = await waiting;
      const second = await authorizeMcp(provider, { ...flow, authorizationCode: code, ...(iss !== undefined && { iss }) });
      if (second !== "AUTHORIZED") throw new Refused(`the authorization server of "${server}" refused the code: run the login again`);
    } catch (error) {
      if (error instanceof Refused) throw error;
      throw new Refused(failedLogin(server, clientName, error));
    }
    const state = store.load();
    if (state?.clientInformation === undefined || state.tokens === undefined || state.discovery === undefined) throw new Refused(`the login of "${server}" ended without tokens: run it again`);
    const uploaded: Login = {
      url,
      clientInformation: state.clientInformation,
      tokens: state.tokens,
      ...(state.tokensExpireAt !== undefined && { tokensExpireAt: state.tokensExpireAt }),
      discovery: state.discovery,
    };
    const status = await client.send<ServerStatus>("PUT", `/${encodeURIComponent(server)}`, uploaded);
    const until = status.expiresAt === undefined ? "" : ` (its token expires at ${new Date(status.expiresAt).toISOString()}; the App refreshes it)`;
    io.say(`✓ logged in to "${server}": the login is the App's at ${client.origin}${until}; nothing was kept on this machine.`);
    return [];
  } finally {
    await callback.close().catch(() => {});
  }
}

/** What a failed step of the flow says, with what to do about a refused registration. */
function failedLogin(server: string, clientName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const said = `the login of "${server}" failed: ${message}`;
  if (error instanceof Error && error.name === "OAuthRegistrationError") {
    return `${said}\nThe authorization server refused to register the client "${clientName}". Some servers register only the client names of their catalogue: set the server's clientName in tool-mcp-oauth's config to one it accepts (README, "Client name").`;
  }
  return said;
}

/** pi-mcp's state for the flow, in memory only: it is uploaded, never written here. */
interface MemoryStore extends McpOAuthStateStore {
  load(): McpOAuthState | undefined;
}

function memoryStore(): MemoryStore {
  let value: McpOAuthState | undefined;
  return {
    load: () => (value === undefined ? undefined : structuredClone(value)),
    save: (state) => void (value = structuredClone(state)),
  };
}

function status(io: CommandIO, answer: { servers: ServerStatus[] }): string[] {
  if (answer.servers.length === 0) {
    io.say("No server in tool-mcp-oauth's config.");
    return [];
  }
  for (const each of answer.servers) {
    const state = each.loggedIn ? `logged in${each.expiresAt === undefined ? "" : `, token until ${new Date(each.expiresAt).toISOString()}`}` : `not logged in (${each.reason ?? "no login"}): pikit tool-mcp-oauth login ${each.server}`;
    io.say(`${each.server}  ${each.url}  ${state}`);
  }
  return [];
}

/** The operator's routes of the App at `origin`, with the token; every refusal a `Refused` said plainly. */
class Client {
  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  async send<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.origin}${ROUTE}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Refused(`cannot reach ${this.origin} (${error instanceof Error ? error.message : String(error)}): is the App running? Pass --url <origin> to name another`);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (response.ok && json !== undefined) return json as T;
    const error = (json ?? {}) as { error?: unknown; message?: unknown };
    if (response.status === 401) throw new Refused(`${this.origin} refused ${TOKEN} (401): is it this App's token?`);
    if (response.status === 404) throw new Refused(`${this.origin} has no tool-mcp-oauth routes (404): is tool-mcp-oauth installed and deployed there, with an admin.auth (admin-auth-token)? Pass --url <origin> to name another App`);
    if (response.ok) throw new Refused(`${this.origin} answered ${response.status} with no JSON: is it a pikit App?`);
    const code = typeof error.error === "string" ? error.error : `http_${response.status}`;
    throw new Refused(`${this.origin} answered ${response.status} ${code}${typeof error.message === "string" ? `: ${error.message}` : ""}`);
  }
}

/** Opens `url` with the system's browser, at a terminal only; a failure leaves the printed URL. */
function openInBrowser(url: URL): void {
  if (process.stdout.isTTY !== true) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (opener === undefined) return;
  const child = spawn(opener, [url.href], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

/**
 * This machine's App (`pikit dev`): wrangler's `http://127.0.0.1:8787` with deployment-cloudflare,
 * else server-bun's port from `pikit.config.ts` (3000 unless its config says otherwise).
 */
export async function localOrigin(cwd = process.cwd()): Promise<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, "pikit.json"), "utf8")) as { components?: Record<string, unknown> };
    if (manifest.components?.["deployment-cloudflare"] !== undefined && manifest.components["server-bun"] === undefined) return "http://127.0.0.1:8787";
  } catch {
    // No pikit.json: below.
  }
  let port = 3000;
  const config = join(cwd, "pikit.config.ts");
  if (existsSync(config)) {
    try {
      const definition = ((await import(pathToFileURL(config).href)) as { default?: { config?: Record<string, { port?: unknown } | undefined> } }).default;
      const configured = definition?.config?.["server-bun"]?.port;
      if (typeof configured === "number" && Number.isInteger(configured) && configured > 0) port = configured;
    } catch {
      // A config that does not import: the default port.
    }
  }
  return `http://127.0.0.1:${port}`;
}
