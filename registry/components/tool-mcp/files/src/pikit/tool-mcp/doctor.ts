/**
 * tool-mcp's check of `pikit doctor`, which `pikit up` and `pikit dev` run first: strict before a
 * deploy, so the deployed app can be tolerant (it starts from the listing kept in `storage.kv`, or
 * the seed `pikit up` bundles, and a server that is down fails only its calls).
 *
 * Each server in config is reached from this machine (`initialize`, `tools/list`) and must list every
 * tool config names; a server with a `secret` is sent the token from `.env` or the environment, the
 * value `pikit up` gives the app. Each failure is one problem naming the server; the token's value
 * never appears in one. Nothing is written: `pikit up` writes the seed (`deploy.ts`).
 *
 * `component.json` declares it (`"hooks": { "doctor": "doctor.ts" }`), and the CLI calls `doctor(io)`
 * in the project's process tree. Never part of the app: the app imports nothing of this file.
 */

import { McpClient, type Tool } from "@pikit/pi-adapter/mcp";
import { CLIENT, messageOf, type ServerConfig, transportTo } from "./index.ts";

/** How long one request of the check may take, unless the server's config says otherwise. */
export const DOCTOR_TIMEOUT_MS = 15_000;

/** What the CLI gives the check (`component-doctor.ts`): this component's config and a reader of the environment. */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

/** The problems of the servers in config: none when each answers and lists every named tool. */
export async function doctor(io: DoctorIO): Promise<string[]> {
  const listed = await Promise.all(Object.entries(serversOf(io.config)).map(([name, settings]) => listNamed(name, settings, io.get)));
  return listed.flatMap((result) => ("problems" in result ? result.problems : []));
}

/** The servers of this component's config. */
export function serversOf(config: Readonly<Record<string, unknown>>): Record<string, ServerConfig> {
  return (config.servers ?? {}) as Record<string, ServerConfig>;
}

/**
 * The tools config names, as the server `name` lists them from this machine (in config's order), or
 * the problems that stop it: a missing token, a server that cannot be reached, a named tool it lacks.
 * The session is ended either way.
 */
export async function listNamed(name: string, settings: ServerConfig, get: (name: string) => string | undefined): Promise<{ tools: Tool[] } | { problems: string[] }> {
  let token: string | undefined;
  if (settings.secret !== undefined) {
    token = get(settings.secret);
    if (token === undefined || token === "") {
      return { problems: [`the MCP server "${name}" needs the secret ${settings.secret}, which is not set in .env or the environment: run \`pikit configure\` or set it`] };
    }
  }
  const secret = token;
  const client = new McpClient({ ...CLIENT, requestTimeoutMs: settings.timeoutMs ?? DOCTOR_TIMEOUT_MS });
  try {
    await client.connect(transportTo(settings, secret === undefined ? undefined : async () => secret));
    const listed = await client.listTools();
    const has = listed.map((tool) => tool.name).join(", ") || "none";
    const tools = settings.tools.flatMap((remote) => listed.filter((tool) => tool.name === remote).slice(0, 1));
    const lacking = settings.tools.filter((remote) => !listed.some((tool) => tool.name === remote));
    if (lacking.length > 0) return { problems: lacking.map((tool) => `the MCP server "${name}" has no tool "${tool}" (it has: ${has})`) };
    return { tools };
  } catch (error) {
    const message = secret === undefined ? messageOf(error) : messageOf(error).replaceAll(secret, "[secret]");
    return { problems: [`the MCP server "${name}" (${settings.url}) could not list its tools: ${message}`] };
  } finally {
    await client.close().catch(() => {});
  }
}
