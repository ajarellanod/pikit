/**
 * The network the workerd lane's Worker sees: `vitest.config.ts` makes this workerd's outbound service,
 * so a `fetch` from a test goes through workerd's own, real `fetch` and lands here, in Node. Only the
 * fake MCP servers of `tool-mcp.workerd.ts` answer; any other address is refused, as the lane never
 * touches the network.
 *
 * Each server is `createFakeMcpServer` (`@pikit/pi-adapter/mcp/testing`, by path: this file is loaded by
 * Vitest's config, in Node), under a host of its own. `POST /__expire` makes one forget its sessions;
 * `GET /__requests` answers how many requests it received.
 *
 * `MCP_HOSTS.oauth` is an MCP server behind OAuth, with its authorization server on the same origin
 * (tool-mcp-oauth's `createFakeOAuthServer`: registration, PKCE, rotating refresh tokens), for
 * `tool-mcp-oauth.workerd.ts`, over https (pi-mcp sends OAuth credentials to https only). Its
 * controls: `POST /__oauth/reset` (a new fake), `POST /__oauth/expire` (the access token expires),
 * `POST /__oauth/delay` (each refresh waits the body's ms), `GET /__oauth/state` (what it saw).
 */

import { createFakeMcpServer, type FakeMcpServer, type FakeMcpTool } from "../../../packages/pi-adapter/src/testing/mcp.ts";
import { createFakeOAuthServer, type FakeOAuthServer } from "../../../registry/components/tool-mcp-oauth/files/src/pikit/tool-mcp-oauth/fake-oauth.test-support.ts";

export const MCP_HOSTS = {
  /** Answers in JSON bodies. */
  json: "mcp-json.pikit.test",
  /** Answers in server-sent event streams. */
  sse: "mcp-sse.pikit.test",
  /** Answers only requests with `Authorization: Bearer <MCP_TOKEN>`. */
  token: "mcp-token.pikit.test",
  /** Behind OAuth (https): its authorization server on the same origin. */
  oauth: "mcp-oauth.pikit.test",
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

let oauth: FakeOAuthServer = createFakeOAuthServer({ mcp: createFakeMcpServer({ tools: TOOLS }), name: "workerd" });

async function oauthOutbound(request: Request, url: URL): Promise<Response> {
  switch (url.pathname) {
    case "/__oauth/reset":
      oauth = createFakeOAuthServer({ mcp: createFakeMcpServer({ tools: TOOLS }), name: "workerd" });
      return new Response("reset");
    case "/__oauth/expire":
      oauth.expireAccess();
      return new Response("expired");
    case "/__oauth/delay":
      oauth.refreshDelayMs = Number(await request.text());
      return new Response("delayed");
    case "/__oauth/state":
      return Response.json({
        clientNames: oauth.registrations.map((body) => body.client_name),
        refreshes: oauth.tokenRequests.filter((form) => form.grant_type === "refresh_token").length,
        current: oauth.current,
        issued: oauth.issued,
        mcpAuthorizations: oauth.mcpAuthorizations,
      });
    default:
      return oauth.fetch(request);
  }
}

export async function mcpOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === MCP_HOSTS.oauth) return oauthOutbound(request, url);
  const server = servers[url.hostname];
  if (server === undefined) return new Response(`workerd lane: no network (${url.hostname})`, { status: 502 });
  if (url.pathname === "/__expire") {
    server.expireSessions();
    return new Response("expired");
  }
  if (url.pathname === "/__requests") return Response.json(server.requests.length);
  return server.fetch(request);
}
