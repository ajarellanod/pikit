/**
 * tool-mcp's check of `pikit doctor`, which `pikit up` and `pikit dev` run first: strict before a
 * deploy, so the deployed app can be tolerant (it starts from the listing kept in `storage.kv`, and a
 * server that is down fails only its calls).
 *
 * Each server in config is reached from this machine (`initialize`, `tools/list`) and must list every
 * tool config names; a server with a `secret` is sent the token from `.env` or the environment, the
 * value `pikit up` gives the app. Each failure is one problem naming the server; the token's value
 * never appears in one. Nothing is kept: the app keeps its own listing when it connects.
 *
 * The CLI calls `doctor(io)` from `src/pikit/tool-mcp/doctor.ts` (as it calls `configure.ts`'s
 * `configure`), in the project's process tree. Never part of the app: nothing imports this file.
 */

import { McpClient } from "@pikit/pi-adapter/mcp";
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
  const servers = (io.config.servers ?? {}) as Record<string, ServerConfig>;
  const found = await Promise.all(Object.entries(servers).map(([name, settings]) => check(name, settings, io.get)));
  return found.flat();
}

async function check(name: string, settings: ServerConfig, get: (name: string) => string | undefined): Promise<string[]> {
  let token: string | undefined;
  if (settings.secret !== undefined) {
    token = get(settings.secret);
    if (token === undefined || token === "") {
      return [`the MCP server "${name}" needs the secret ${settings.secret}, which is not set in .env or the environment: run \`pikit configure\` or set it`];
    }
  }
  const secret = token;
  const client = new McpClient({ ...CLIENT, requestTimeoutMs: settings.timeoutMs ?? DOCTOR_TIMEOUT_MS });
  try {
    await client.connect(transportTo(settings, secret === undefined ? undefined : async () => secret));
    const listed = await client.listTools();
    const has = listed.map((tool) => tool.name).join(", ") || "none";
    return settings.tools
      .filter((tool) => !listed.some((listedTool) => listedTool.name === tool))
      .map((tool) => `the MCP server "${name}" has no tool "${tool}" (it has: ${has})`);
  } catch (error) {
    const message = secret === undefined ? messageOf(error) : messageOf(error).replaceAll(secret, "[secret]");
    return [`the MCP server "${name}" (${settings.url}) could not list its tools: ${message}`];
  } finally {
    await client.close().catch(() => {});
  }
}
