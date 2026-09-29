/**
 * tool-mcp: the tools of remote MCP servers, for the agents that name them. Config lists each server
 * and the tools to take from it; each becomes the agent tool `<server>_<tool>`
 * (`deepwiki_ask_wiki_question`), and an agent gets one only by naming it
 * (`tools: ["deepwiki_ask_wiki_question"]`).
 *
 * - **Tools are named in config.** A keyed capability's keys are fixed at `setup`, before any server
 *   is reached, so the tools come from config and are provided then. At `start` each server is
 *   reached once (`initialize`, `tools/list`) and each tool gets what only the server knows: its
 *   description and parameters. A server that cannot be reached, or that lacks a tool named here,
 *   stops the app (P5): an agent would otherwise lose a tool it names without anyone knowing.
 * - **Replay** (SPEC §8.4): `"never"`, unless the server marks the tool read-only
 *   (`annotations.readOnlyHint`), then `"safe"`: a run resumed after a crash calls it again.
 * - **Credentials never in config.** `secret` names a secret, read through `secrets` at each request,
 *   holding a bearer token for the server. The model never sees it, nor any error that mentions it.
 * - **One client per server, in memory**, connected at start. When the server forgets the session (it
 *   restarted, or it expires idle ones) the call connects again and is sent once more: the server ran
 *   nothing. On Cloudflare a Durable Object may lose its memory at any time; its next start connects
 *   again (SPEC K6).
 * - **A failure the server reports** (an MCP result with `isError`) fails the call with its text.
 *
 * Transport: Streamable HTTP over `fetch`, through Pi's MCP client (`@pikit/pi-adapter/mcp`), with no
 * long-lived server-to-client stream (SPEC §4.1, C4). Targets: `server` and `cloudflare`. A server run
 * as a local process (stdio) is not this component's.
 */

import { type AppContext, defineComponent } from "@pikit/core";
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

/** How long a request to a server may take, unless its config says otherwise. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** What a server's name in config may hold: it starts the names of its tools. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** How the client introduces itself to servers. */
const CLIENT = { name: "pikit", version: "0.0.0" };

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

const Config = Type.Object({
  /** Server name (letters, digits, `_`, `-`) → how to reach it and which of its tools to give. */
  servers: Type.Record(Type.String(), Server, { default: {} }),
});

type ServerConfig = Static<typeof Server>;

export default defineComponent({
  name: "tool-mcp",
  config: Config,
  setup(pikit, config) {
    // Optional: only a server with a `secret` needs it, and start says so when it is missing.
    const secrets = pikit.useOptional("secrets");
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
      const connection = connectionTo(name, settings, token);
      const tools = settings.tools.map((remote) => {
        const agentName = mcpToolName(name, remote);
        const other = names.get(agentName);
        if (other !== undefined) throw new Error(`tool-mcp: "${other}" and "${name}/${remote}" would both be the tool "${agentName}"`);
        names.set(agentName, `${name}/${remote}`);
        const mcp = mcpAgentTool({ name: agentName, label: `${name}: ${remote}`, call: (params, signal) => connection.call(remote, params, signal) });
        // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
        pikit.provideKeyed("agent.tool", agentName, mcp.tool);
        return { remote, mcp };
      });
      servers.push({ name, secret, connection, tools });
    }

    return {
      async start(ctx) {
        const missing = servers.find((server) => server.secret !== undefined && secrets.get() === undefined);
        if (missing !== undefined) {
          throw new Error(`tool-mcp: the MCP server "${missing.name}" needs the secret ${missing.secret}, but no component provides secrets (install one: secrets-env, secrets-cloudflare)`);
        }
        await Promise.all(servers.map((server) => describe(server, ctx)));
      },
      async stop() {
        await Promise.all(servers.map((server) => server.connection.close()));
      },
    };
  },
});

interface ServerEntry {
  name: string;
  secret: string | undefined;
  connection: Connection;
  tools: { remote: string; mcp: McpAgentTool }[];
}

/** Fills each tool of `server` from its `tools/list`; throws when it cannot be reached or lacks one. */
async function describe(server: ServerEntry, ctx: AppContext): Promise<void> {
  let listed: Tool[];
  try {
    listed = await server.connection.list(ctx.abortSignal);
  } catch (error) {
    throw new Error(`tool-mcp: the MCP server "${server.name}" could not list its tools: ${messageOf(error)}`);
  }
  for (const { remote, mcp } of server.tools) {
    const found = listed.find((tool) => tool.name === remote);
    if (found === undefined) {
      const has = listed.map((tool) => tool.name).join(", ") || "none";
      throw new Error(`tool-mcp: the MCP server "${server.name}" has no tool "${remote}" (it has: ${has})`);
    }
    mcp.describe(found, found.annotations?.readOnlyHint === true ? "safe" : "never");
  }
}

interface Connection {
  /** The server's tools, connecting first when needed. */
  list(signal: AbortSignal | undefined): Promise<Tool[]>;
  /** Calls `tool`, connecting (again) when needed. */
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult>;
  /** Closes every client (ending its session); a call after this fails. */
  close(): Promise<void>;
}

/** One server's client, connected on first use and again when its session is gone. */
function connectionTo(server: string, settings: ServerConfig, token: (() => Promise<string>) | undefined): Connection {
  /** The client in use, or being connected. */
  let current: Promise<McpClient> | undefined;
  /** Every client not closed yet, connecting ones included: `close` ends them all. */
  const clients = new Set<McpClient>();
  let closed = false;

  const open = async (): Promise<McpClient> => {
    const client = new McpClient({ ...CLIENT, requestTimeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    clients.add(client);
    client.onClose(() => clients.delete(client));
    const transport = mcpHttpTransport({
      url: settings.url,
      ...(settings.headers !== undefined && { headers: { ...settings.headers } }),
      // Asked before each request: a rotated secret is used at once.
      ...(token !== undefined && { authProvider: { token } }),
    });
    await client.connect(transport);
    return client;
  };

  const connected = (): Promise<McpClient> => {
    if (closed) return Promise.reject(new Error(`tool-mcp: the MCP server "${server}" is not connected: the app is stopping`));
    if (current === undefined) {
      const opening = open();
      current = opening;
      // A failed connection is forgotten: the next call tries again.
      opening.catch(() => forget(opening));
    }
    return current;
  };

  /** Drops `used` if it is still the client in use, and closes it. */
  const forget = (used: Promise<McpClient>): void => {
    if (current !== used) return;
    current = undefined;
    used.then((client) => client.close()).catch(() => {});
  };

  return {
    async list(signal) {
      const client = await untilAborted(connected(), signal);
      return client.listTools(signal === undefined ? {} : { signal });
    },
    async call(tool, args, signal) {
      for (let attempt = 0; ; attempt++) {
        const using = connected();
        let client: McpClient;
        try {
          client = await untilAborted(using, signal);
        } catch (error) {
          if (signal?.aborted === true) throw error;
          throw new Error(`tool-mcp: the MCP server "${server}" could not be reached: ${messageOf(error)}`);
        }
        try {
          return await client.callTool(tool, args, signal === undefined ? {} : { signal });
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
