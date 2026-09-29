/**
 * @pikit/pi-adapter/mcp/testing: a small MCP server speaking Streamable HTTP, as a `fetch` handler
 * (`(request) => Response`), for the tests of `tool-mcp` and of this adapter. Serve it with
 * `Bun.serve({ port: 0, fetch: server.fetch })` on a server, or as workerd's outbound service in the
 * workerd lane: no test reaches the network. Neutral: it imports nothing at run time.
 *
 * It does what a real server does with pikit's client: `initialize` opens a session (its id in
 * `Mcp-Session-Id`), `tools/list` and `tools/call` need it, `DELETE` ends it, a forgotten one answers
 * 404, and `GET` (the server-to-client stream) answers 405. With `token`, a request without
 * `Authorization: Bearer <token>` answers 401. `requests` records what it received.
 */

import type { CallToolResult, Tool } from "@earendil-works/pi-mcp";

/** A tool the fake server lists, and what it answers when called (its arguments as JSON by default). */
export interface FakeMcpTool extends Tool {
  call?(args: Record<string, unknown>): CallToolResult | Promise<CallToolResult>;
}

export interface FakeMcpServerOptions {
  tools: FakeMcpTool[];
  /** The bearer token every request must carry. */
  token?: string;
  /** How requests are answered: a JSON body (default), or a server-sent event stream. */
  responses?: "json" | "sse";
}

/** One request the server received. */
export interface FakeMcpRequest {
  method: string;
  /** The JSON-RPC method, for a POST. */
  rpc?: string;
  authorization: string | null;
  session: string | null;
  /** Any header the test wants to check, lower-case names. */
  headers: Record<string, string>;
}

export interface FakeMcpServer {
  fetch(request: Request): Promise<Response>;
  readonly requests: FakeMcpRequest[];
  /** Forgets every session, as a server that restarted: their next request answers 404. */
  expireSessions(): void;
  /** How many sessions were opened (`initialize`) so far. */
  readonly sessionsOpened: number;
}

const PROTOCOL_VERSION = "2025-11-25";

export function createFakeMcpServer(options: FakeMcpServerOptions): FakeMcpServer {
  const requests: FakeMcpRequest[] = [];
  const sessions = new Set<string>();
  let opened = 0;

  const answer = (body: unknown, headers: Record<string, string> = {}): Response => {
    if (options.responses === "sse") {
      return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream", ...headers } });
    }
    return Response.json(body, { headers });
  };

  const handle = async (request: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const authorization = request.headers.get("authorization");
    const session = request.headers.get("mcp-session-id");
    const body = request.method === "POST" ? ((await request.json()) as { id?: string | number; method?: string; params?: Record<string, unknown> }) : undefined;
    requests.push({ method: request.method, ...(body?.method !== undefined && { rpc: body.method }), authorization, session, headers });

    if (options.token !== undefined && authorization !== `Bearer ${options.token}`) {
      return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="fake"' } });
    }
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") {
      if (session !== null) sessions.delete(session);
      return new Response(null, { status: 200 });
    }
    if (body === undefined) return new Response(null, { status: 405 });

    if (body.method === "initialize") {
      opened++;
      const id = `session-${opened}`;
      sessions.add(id);
      return answer(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0.0" } },
        },
        { "mcp-session-id": id },
      );
    }
    if (session === null) return new Response("no session", { status: 400 });
    if (!sessions.has(session)) return new Response("session not found", { status: 404 });
    // A notification (no id) is accepted without an answer.
    if (body.id === undefined) return new Response(null, { status: 202 });

    if (body.method === "tools/list") {
      const tools = options.tools.map(({ call: _call, ...tool }) => tool);
      return answer({ jsonrpc: "2.0", id: body.id, result: { tools } });
    }
    if (body.method === "tools/call") {
      const name = body.params?.name;
      const tool = options.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return answer({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } });
      }
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      const result = tool.call === undefined ? { content: [{ type: "text", text: JSON.stringify(args) }] } : await tool.call(args);
      return answer({ jsonrpc: "2.0", id: body.id, result });
    }
    if (body.method === "ping") return answer({ jsonrpc: "2.0", id: body.id, result: {} });
    return answer({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${String(body.method)}` } });
  };

  return {
    fetch: handle,
    requests,
    expireSessions: () => sessions.clear(),
    get sessionsOpened() {
      return opened;
    },
  };
}
