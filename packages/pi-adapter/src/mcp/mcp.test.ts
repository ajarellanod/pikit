/**
 * @pikit/pi-adapter/mcp: neutral once bundled, and its helpers against the fake MCP server of
 * `./testing.ts`, reached through `fetch` (no network).
 */

import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@pikit/core";
import { McpClient, mcpAgentTool, mcpHttpTransport, mcpParameters, mcpToolName, mcpToolResult, StreamableHttpTransport } from "./index.ts";
import { createFakeMcpServer, type FakeMcpServer } from "./testing.ts";

const URL_ = "http://mcp.test/mcp";

/** A `fetch` that reaches `server` and remembers the `this` it was called with. */
function fetchOf(server: FakeMcpServer): { fetch: typeof fetch; receivers: unknown[] } {
  const receivers: unknown[] = [];
  // pi-mcp passes a string or a URL.
  const fake = function (this: unknown, input: string | URL, init?: RequestInit) {
    receivers.push(this);
    return server.fetch(new Request(String(input), init));
  };
  return { fetch: fake as typeof fetch, receivers };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the export bundles without Node: pi-mcp's stdio transport and OAuth callback server are left out", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./index.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    // Pi's other packages are held neutral by the adapter's other exports; this checks pi-mcp.
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@pikit/*"],
  });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]?.text();
  expect(code).toContain("StreamableHttpTransport");
  for (const node of ["node:", "child_process", "cross-spawn", "createServer", "StdioTransport"]) {
    expect(code).not.toContain(node);
  }
});

test("mcpHttpTransport calls fetch as a plain function, and never opens the GET stream", async () => {
  const server = createFakeMcpServer({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
  const { fetch: fake, receivers } = fetchOf(server);
  // The global fetch, as Workers' own: it refuses to be called as a method of another object.
  globalThis.fetch = fake;
  const client = new McpClient({ name: "pikit-test", version: "0.0.0" });
  await client.connect(mcpHttpTransport({ url: URL_ }));
  expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
  await client.close();

  expect(receivers.length).toBeGreaterThan(0);
  expect(receivers.every((receiver) => receiver === undefined)).toBe(true);
  expect(server.requests.map((r) => r.rpc ?? r.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
});

test("Pi's gap the wrapper closes: pi-mcp 0.99 calls the global fetch as a method of its transport", async () => {
  // When this fails, Pi fixed it upstream: `mcpHttpTransport` may drop its wrapper.
  const server = createFakeMcpServer({ tools: [] });
  const { fetch: fake, receivers } = fetchOf(server);
  globalThis.fetch = fake;
  const transport = new StreamableHttpTransport({ url: URL_, openGetStream: false });
  const client = new McpClient({ name: "pikit-test", version: "0.0.0" });
  await client.connect(transport);
  await client.close();
  expect(receivers[0]).toBe(transport);
});

test("mcpHttpTransport uses a fetch it is given, also unbound", async () => {
  const server = createFakeMcpServer({ tools: [] });
  const { fetch: fake, receivers } = fetchOf(server);
  const client = new McpClient({ name: "pikit-test", version: "0.0.0" });
  await client.connect(mcpHttpTransport({ url: URL_, fetch: fake, headers: { "x-team": "blue" } }));
  await client.close();
  expect(receivers).not.toHaveLength(0);
  expect(receivers.every((receiver) => receiver === undefined)).toBe(true);
  expect(server.requests[0]?.headers["x-team"]).toBe("blue");
});

test("mcpToolName: <server>_<tool>, only [A-Za-z0-9_-], at most 64 characters", () => {
  expect(mcpToolName("github", "search_issues")).toBe("github_search_issues");
  expect(mcpToolName("my.server", "ns/tool name")).toBe("my_server_ns_tool_name");
  expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
});

test("mcpParameters: always an object schema with properties", () => {
  expect(mcpParameters({})).toMatchObject({ type: "object", properties: {} });
  const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  expect(mcpParameters(schema)).toMatchObject(schema);
});

test("mcpToolResult: content for the model; a result with isError throws its text", () => {
  expect(mcpToolResult({ content: [{ type: "text", text: "ok" }] }, "s_t")).toEqual({ content: [{ type: "text", text: "ok" }], details: undefined });
  expect(() => mcpToolResult({ content: [{ type: "text", text: "no such repository" }], isError: true }, "s_t")).toThrow("no such repository");
  expect(() => mcpToolResult({ content: [], isError: true }, "s_t")).toThrow("s_t: the MCP server reported a failure without a message");
});

test("mcpAgentTool: provided before it is described; describe fills the same object Pi reads", async () => {
  const calls: Record<string, unknown>[] = [];
  const mcp = mcpAgentTool({
    name: "wiki_ask",
    label: "wiki: ask",
    call: async (params) => {
      calls.push(params);
      return params.fail === true ? { content: [{ type: "text", text: "it failed" }], isError: true } : { content: [{ type: "text", text: "answer" }] };
    },
  });
  const tool = mcp.tool;
  expect(tool.name).toBe("wiki_ask");
  expect(tool.replay).toBe("never");

  mcp.describe(
    { name: "ask", title: "Ask", description: "Asks the wiki.", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
    "safe",
  );
  expect(mcp.tool).toBe(tool);
  expect(tool.label).toBe("Ask");
  expect(tool.description).toBe("Asks the wiki.");
  expect(tool.parameters).toMatchObject({ type: "object", properties: { q: { type: "string" } } });
  expect(tool.replay).toBe("safe");

  const invocation = { invocationId: "i", operationId: "o", turnId: "t", getMemo: async () => undefined, setMemo: async () => {} };
  const result = await tool.execute("call-1", { q: "what" }, () => {}, undefined, invocation, BACKGROUND_CONTEXT);
  expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  await expect(tool.execute("call-2", { fail: true }, () => {}, undefined, invocation, BACKGROUND_CONTEXT)).rejects.toThrow("it failed");
  expect(calls).toEqual([{ q: "what" }, { fail: true }]);
});
