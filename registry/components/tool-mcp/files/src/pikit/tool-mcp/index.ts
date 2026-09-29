/**
 * tool-mcp: the tools of remote MCP servers, for the agents that name them. Config lists each server
 * and the tools to take from it; each becomes the agent tool `<server>_<tool>`
 * (`deepwiki_ask_wiki_question`), and an agent gets one only by naming it
 * (`tools: ["deepwiki_ask_wiki_question"]`).
 *
 * - **Tools are named in config.** A keyed capability's keys are fixed at `setup`, before any server
 *   is reached, so the tools come from config and are provided then. At `start` each tool gets what
 *   only the server knows: its description and parameters, from the server's `tools/list`.
 * - **Strict at deploy, tolerant at run time.** `pikit doctor` (so `pikit up` and `pikit dev`) reaches
 *   every server and refuses one that cannot be reached or lacks a tool (`doctor.ts`); `pikit up` then
 *   writes what they listed into `seed.ts` (`deploy.ts`), which the build bundles. Once deployed, a
 *   start describes the tools from the freshest listing it has: this app's kept listing in
 *   `storage.kv`, else the bundled seed, else the server.
 *   - with `storage.kv` installed, each server's listing of the named tools is kept there (namespace
 *     `tool-mcp`, key `server/<name>`), and a start that finds it complete describes the tools from
 *     it and reaches no server: a cold start makes no MCP request, and a server that is down does not
 *     stop the app, only the calls to its tools fail. Each connection (the first call after such a
 *     start, or after the server forgot the session) lists the tools again and updates both the tools
 *     and the kept listing; a named tool the server no longer lists is logged as an error and its calls
 *     fail, naming the tools it has.
 *   - without a kept listing (or without `storage.kv`) but with a seed for the server's URL that holds
 *     every named tool, the start reaches no server either: a new conversation's first start on
 *     Cloudflare makes no MCP request. The first connection keeps its listing in `storage.kv`.
 *   - with neither, start reaches each server (`initialize`,
 *     `tools/list`), and one that cannot be reached, or lacks a named tool, stops the app (P5): the
 *     model would get a tool with no description or parameters.
 * - **Replay**: `"never"`, unless the server marks the tool read-only
 *   (`annotations.readOnlyHint`), then `"safe"`: a run resumed after a crash calls it again.
 * - **Credentials never in config.** `secret` names a secret, read through `secrets` at each request,
 *   holding a bearer token for the server. The model never sees it, nor any error that mentions it.
 * - **One client per server, in memory**, connected on first use. When the server forgets the session
 *   (it restarted, or it expires idle ones) the call connects again and is sent once more: the server
 *   ran nothing. On Cloudflare a Durable Object may lose its memory at any time; its next call
 *   connects again (SPEC K6).
 * - **A failure the server reports** (an MCP result with `isError`) fails the call with its text.
 *
 * Transport: Streamable HTTP over `fetch`, through Pi's MCP client (`@pikit/pi-adapter/mcp`), with no
 * long-lived server-to-client stream (SPEC §4.1, C4). Targets: `server` and `cloudflare`. A server run
 * as a local process (stdio) is not this component's.
 */

import type { JsonValue, KeyValueStore } from "@pikit/contracts";
import { type AppContext, defineComponent, type Logger } from "@pikit/core";
import {
  type CallToolResult,
  McpClient,
  type McpAgentTool,
  McpSessionExpiredError,
  mcpAgentTool,
  mcpHttpTransport,
  mcpToolName,
  type Tool,
} from "@pikit/pi-adapter/mcp";
import Type, { type Static } from "typebox";
import { seed } from "./seed.ts";

/** How long a request to a server may take, unless its config says otherwise. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** What a server's name in config may hold: it starts the names of its tools. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** How the client introduces itself to servers. */
export const CLIENT = { name: "pikit", version: "0.0.0" };
/** The `storage.kv` namespace of the kept listings: the component's name. */
const NAMESPACE = "tool-mcp";

const Server = Type.Object(
  {
    url: Type.String({ minLength: 1, description: "The server's Streamable HTTP endpoint, e.g. https://mcp.deepwiki.com/mcp." }),
    tools: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
      description: "The server's tools to give agents, by their MCP names; each is provided as <server>_<tool>.",
    }),
    secret: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        description: "The name of the secret (read through `secrets`) holding a bearer token for the server. Never the token itself.",
      }),
    ),
    headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra request headers. Not for credentials: config is not secret." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, description: `How long one request may take, in ms. Default: ${DEFAULT_TIMEOUT_MS}.` })),
  },
  { additionalProperties: false },
);

const Config = Type.Object(
  {
    /** Server name (letters, digits, `_`, `-`) → how to reach it and which of its tools to give. */
    servers: Type.Record(Type.String(), Server, { default: {} }),
  },
  {
    // A full config: `registry generate` describes setup with it, so the manifest lists the tools it provides.
    examples: [{ servers: { deepwiki: { url: "https://mcp.deepwiki.com/mcp", tools: ["ask_wiki_question", "read_wiki_structure"] } } }],
  },
);

export type ServerConfig = Static<typeof Server>;

export default defineComponent({
  name: "tool-mcp",
  config: Config,
  setup(pikit, config) {
    // Optional: only a server with a `secret` needs it, and start says so when it is missing.
    const secrets = pikit.useOptional("secrets");
    // Optional: with it, a start reads each server's listing from there instead of the server.
    const storage = pikit.useOptional("storage.kv");
    let cache: KeyValueStore | undefined;
    const servers: ServerEntry[] = [];
    const names = new Map<string, string>();

    for (const [name, settings] of Object.entries(config.servers)) {
      if (!SERVER_NAME.test(name)) {
        throw new Error(`tool-mcp: the server name "${name}" may hold only letters, digits, "_" and "-": it starts the names of its tools`);
      }
      const secret = settings.secret;
      const token =
        secret === undefined
          ? undefined
          : async (): Promise<string> => {
              const value = await secrets.get()?.get(secret);
              if (value === undefined || value === "") throw new Error(`tool-mcp: the secret ${secret}, the token of the MCP server "${name}", is not set`);
              return value;
            };
      const server: ServerEntry = {
        name,
        url: settings.url,
        secret,
        tools: [],
        started: false,
        // Each connection lists the tools: they and the kept listing follow what the server says now.
        connection: connectionTo(name, settings, token, (listed) => refreshed(server, listed, cache, pikit.logger)),
      };
      for (const remote of settings.tools) {
        const agentName = mcpToolName(name, remote);
        const other = names.get(agentName);
        if (other !== undefined) throw new Error(`tool-mcp: "${other}" and "${name}/${remote}" would both be the tool "${agentName}"`);
        names.set(agentName, `${name}/${remote}`);
        const mcp = mcpAgentTool({ name: agentName, label: `${name}: ${remote}`, call: (params, signal) => server.connection.call(remote, params, signal) });
        // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
        pikit.provideKeyed("agent.tool", agentName, mcp.tool);
        server.tools.push({ remote, mcp });
      }
      servers.push(server);
    }

    return {
      async start(ctx) {
        const missing = servers.find((server) => server.secret !== undefined && secrets.get() === undefined);
        if (missing !== undefined) {
          throw new Error(`tool-mcp: the MCP server "${missing.name}" needs the secret ${missing.secret}, but no component provides secrets (install one: secrets-env, secrets-cloudflare)`);
        }
        cache = storage.get()?.namespace(NAMESPACE);
        await Promise.all(servers.map((server) => describe(server, cache, ctx)));
        for (const server of servers) server.started = true;
      },
      async stop() {
        await Promise.all(servers.map((server) => server.connection.close()));
      },
    };
  },
});

interface ServerEntry {
  name: string;
  url: string;
  secret: string | undefined;
  connection: Connection;
  tools: { remote: string; mcp: McpAgentTool }[];
  /** Whether start is over: from then on a listing that lacks a named tool is logged (start throws instead). */
  started: boolean;
}

/** What `storage.kv` keeps of a server's `tools/list`: the named tools only, as the server described them. */
interface KeptListing {
  /** The URL listed: a listing kept for another URL is not used. */
  url: string;
  /** When the server listed them (ISO 8601). */
  listedAt: string;
  /** By MCP name. */
  tools: Record<string, KeptTool>;
}

type KeptTool = Pick<Tool, "name" | "title" | "description" | "inputSchema" | "annotations">;

/**
 * What `seed.ts` holds, as `beforeDeploy` (`deploy.ts`) writes it: by server name, a kept listing
 * without `listedAt` (so a deploy rewrites the file only when a server's tools change). Typed loosely,
 * so that whatever JSON a server sent type-checks in the generated file.
 */
export type McpSeed = Record<string, SeedListing>;

export interface SeedListing {
  /** The URL listed: a seed for another URL is not used. */
  url: string;
  /** By MCP name: the tools config names. */
  tools: Record<string, SeedTool>;
}

export interface SeedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const keyOf = (server: ServerEntry): string => `server/${server.name}`;

/**
 * Describes each tool of `server` at start, from the first listing for its URL that holds every named
 * tool, with no request: its kept listing in `storage.kv` (refreshed on each connection), else the
 * seed bundled at deploy (`seed.ts`). Else from the server (`initialize`, `tools/list`). Throws when
 * the server must be reached and cannot be, or lacks a named tool.
 */
async function describe(server: ServerEntry, cache: KeyValueStore | undefined, ctx: AppContext): Promise<void> {
  const known = complete(server, await read(cache, server, ctx.logger)) ?? complete(server, Object.hasOwn(seed, server.name) ? seed[server.name] : undefined);
  if (known !== undefined) {
    for (const { remote, mcp } of server.tools) describeTool(mcp, known[remote] as KeptTool);
    return;
  }
  let listed: Tool[];
  try {
    listed = await server.connection.list(ctx.abortSignal);
  } catch (error) {
    throw new Error(`tool-mcp: the MCP server "${server.name}" could not list its tools: ${messageOf(error)}`);
  }
  // The connection described the tools it found, and kept the listing when it was complete.
  const lacking = missingFrom(server, listed);
  if (lacking !== undefined) throw new Error(`tool-mcp: the MCP server "${server.name}" has no tool "${lacking}" (it has: ${namesOf(listed)})`);
}

/**
 * A new connection's `tools/list`: describes the named tools it holds and keeps the listing, merged
 * over the kept one (a tool the server stopped listing keeps its last description, so a later start
 * does not stop the app over it: its calls fail instead). Never throws.
 */
async function refreshed(server: ServerEntry, listed: Tool[], cache: KeyValueStore | undefined, logger: Logger): Promise<void> {
  const found: Record<string, KeptTool> = {};
  for (const { remote, mcp } of server.tools) {
    const tool = listed.find((candidate) => candidate.name === remote);
    if (tool === undefined) continue;
    describeTool(mcp, tool);
    found[remote] = keptTool(tool);
  }
  const lacking = missingFrom(server, listed);
  if (server.started && lacking !== undefined) {
    logger.error(`tool-mcp: the MCP server "${server.name}" no longer lists the tool "${lacking}": its calls fail`, { server: server.name, has: namesOf(listed) });
  }
  if (cache === undefined) return;
  try {
    const previous = await read(cache, server, logger);
    const tools = { ...previous?.tools, ...found };
    // Only a complete listing is kept: a start uses nothing less.
    if (!server.tools.every(({ remote }) => tools[remote] !== undefined)) return;
    const listing: KeptListing = { url: server.url, listedAt: new Date().toISOString(), tools };
    // JSON: what the server sent, parsed from JSON.
    await cache.set(keyOf(server), listing as unknown as JsonValue);
  } catch (error) {
    logger.warn(`tool-mcp: could not keep the tools of the MCP server "${server.name}" in storage.kv`, { error: messageOf(error) });
  }
}

/** The tools of `listing` when it is for the URL of `server` and holds each of its named tools. */
function complete(server: ServerEntry, listing: { url?: unknown; tools?: unknown } | undefined): Record<string, KeptTool> | undefined {
  if (typeof listing !== "object" || listing === null || listing.url !== server.url) return undefined;
  const tools = listing.tools;
  if (typeof tools !== "object" || tools === null) return undefined;
  return server.tools.every(({ remote }) => Object.hasOwn(tools, remote)) ? (tools as Record<string, KeptTool>) : undefined;
}

/** The kept listing of `server` for its URL, or `undefined` (none, another URL, unreadable). */
async function read(cache: KeyValueStore | undefined, server: ServerEntry, logger: Logger): Promise<KeptListing | undefined> {
  if (cache === undefined) return undefined;
  try {
    const listing = (await cache.get(keyOf(server))) as KeptListing | undefined;
    return listing?.url === server.url && typeof listing.tools === "object" && listing.tools !== null ? listing : undefined;
  } catch (error) {
    logger.warn(`tool-mcp: could not read the kept tools of the MCP server "${server.name}" from storage.kv`, { error: messageOf(error) });
    return undefined;
  }
}

function describeTool(mcp: McpAgentTool, tool: KeptTool): void {
  mcp.describe(tool, tool.annotations?.readOnlyHint === true ? "safe" : "never");
}

/** What is kept of `tool` (in `storage.kv` and the seed): JSON, without the fields the server left out. */
export function keptTool(tool: Tool): KeptTool {
  return {
    name: tool.name,
    ...(tool.title !== undefined && { title: tool.title }),
    ...(tool.description !== undefined && { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.annotations !== undefined && { annotations: tool.annotations }),
  };
}

/** The first named tool `listed` lacks, if any. */
function missingFrom(server: ServerEntry, listed: Tool[]): string | undefined {
  return server.tools.find(({ remote }) => !listed.some((tool) => tool.name === remote))?.remote;
}

function namesOf(listed: Tool[]): string {
  return listed.map((tool) => tool.name).join(", ") || "none";
}

interface Connection {
  /** The server's tools, as listed when the client in use connected (connecting first when needed). */
  list(signal: AbortSignal | undefined): Promise<Tool[]>;
  /** Calls `tool`, connecting (again) when needed. */
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult>;
  /** Closes every client (ending its session); a call after this fails. */
  close(): Promise<void>;
}

/** A connected client and what the server listed when it connected. */
interface Session {
  client: McpClient;
  tools: Tool[];
}

/**
 * One server's client, connected on first use and again when its session is gone. Each connection
 * lists the server's tools and hands them to `listed` before it is used.
 */
function connectionTo(
  server: string,
  settings: ServerConfig,
  token: (() => Promise<string>) | undefined,
  listed: (tools: Tool[]) => Promise<void>,
): Connection {
  /** The session in use, or being opened. */
  let current: Promise<Session> | undefined;
  /** Every client not closed yet, connecting ones included: `close` ends them all. */
  const clients = new Set<McpClient>();
  let closed = false;

  const open = async (): Promise<Session> => {
    const client = new McpClient({ ...CLIENT, requestTimeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    clients.add(client);
    client.onClose(() => clients.delete(client));
    await client.connect(transportTo(settings, token));
    const tools = await client.listTools();
    await listed(tools);
    return { client, tools };
  };

  const connected = (): Promise<Session> => {
    if (closed) return Promise.reject(new Error(`tool-mcp: the MCP server "${server}" is not connected: the app is stopping`));
    if (current === undefined) {
      const opening = open();
      current = opening;
      // A failed connection is forgotten: the next call tries again.
      opening.catch(() => forget(opening));
    }
    return current;
  };

  /** Drops `used` if it is still the session in use, and closes its client. */
  const forget = (used: Promise<Session>): void => {
    if (current !== used) return;
    current = undefined;
    used.then((session) => session.client.close()).catch(() => {});
  };

  return {
    async list(signal) {
      return (await untilAborted(connected(), signal)).tools;
    },
    async call(tool, args, signal) {
      for (let attempt = 0; ; attempt++) {
        const using = connected();
        let session: Session;
        try {
          session = await untilAborted(using, signal);
        } catch (error) {
          if (signal?.aborted === true) throw error;
          throw new Error(`tool-mcp: the MCP server "${server}" could not be reached: ${messageOf(error)}`);
        }
        if (!session.tools.some((listedTool) => listedTool.name === tool)) {
          throw new Error(`tool-mcp: the MCP server "${server}" no longer lists the tool "${tool}" (it has: ${namesOf(session.tools)})`);
        }
        try {
          return await session.client.callTool(tool, args, signal === undefined ? {} : { signal });
        } catch (error) {
          // The server forgot the session and ran nothing: connect again and send it once more.
          if (error instanceof McpSessionExpiredError && attempt === 0) {
            forget(using);
            continue;
          }
          if (signal?.aborted === true) throw error;
          throw new Error(`tool-mcp: the MCP server "${server}" failed the call: ${messageOf(error)}`);
        }
      }
    },
    async close() {
      closed = true;
      current = undefined;
      await Promise.all([...clients].map((client) => client.close().catch(() => {})));
    },
  };
}

/** The Streamable HTTP transport to a server, as `settings` say; `token` is asked before each request. */
export function transportTo(settings: ServerConfig, token: (() => Promise<string>) | undefined) {
  return mcpHttpTransport({
    url: settings.url,
    ...(settings.headers !== undefined && { headers: { ...settings.headers } }),
    // Asked before each request: a rotated secret is used at once.
    ...(token !== undefined && { authProvider: { token } }),
  });
}

/** `promise`, or the abort's reason as soon as `signal` aborts (what `promise` does goes on). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
