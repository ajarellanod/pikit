/**
 * The network the workerd lane's Worker sees: `vitest.config.ts` makes this workerd's outbound service,
 * so a `fetch` from a test goes through workerd's own, real `fetch` and lands here, in Node. Only the
 * fake MCP servers of `tool-mcp.workerd.ts` answer; any other address is refused, as the lane never
 * touches the network.
 *
 * Each server is `createFakeMcpServer` (`@pikit/pi-adapter/mcp/testing`, by path: this file is loaded by
 * Vitest's config, in Node), under a host of its own. `POST /__expire` makes one forget its sessions;
 * `GET /__requests` answers how many requests it received.
 */

import { createFakeMcpServer, type FakeMcpServer, type FakeMcpTool } from "../../../packages/pi-adapter/src/testing/mcp.ts";

export const MCP_HOSTS = {
  /** Answers in JSON bodies. */
  json: "mcp-json.pikit.test",
  /** Answers in server-sent event streams. */
  sse: "mcp-sse.pikit.test",
  /** Answers only requests with `Authorization: Bearer <MCP_TOKEN>`. */
  token: "mcp-token.pikit.test",
} as const;

export const MCP_TOKEN = "workerd-mcp-token";

const TOOLS: FakeMcpTool[] = [
  {
    name: "ask_question",
    description: "Asks a question about a repository.",
    inputSchema: { type: "object", properties: { repoName: { type: "string" } }, required: ["repoName"] },
    annotations: { readOnlyHint: true },
    call: (args) => ({ content: [{ type: "text", text: `${String(args.repoName)}: it is a kit` }] }),
  },
  {
    name: "open_issue",
    description: "Opens an issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    call: () => ({ content: [{ type: "text", text: "a title is required" }], isError: true }),
  },
];

const servers: Record<string, FakeMcpServer> = {
  [MCP_HOSTS.json]: createFakeMcpServer({ tools: TOOLS }),
  [MCP_HOSTS.sse]: createFakeMcpServer({ tools: TOOLS, responses: "sse" }),
  [MCP_HOSTS.token]: createFakeMcpServer({ tools: TOOLS, token: MCP_TOKEN }),
};

export async function mcpOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const server = servers[url.hostname];
  if (server === undefined) return new Response(`workerd lane: no network (${url.hostname})`, { status: 502 });
  if (url.pathname === "/__expire") {
    server.expireSessions();
    return new Response("expired");
  }
  if (url.pathname === "/__requests") return Response.json(server.requests.length);
  return server.fetch(request);
}
