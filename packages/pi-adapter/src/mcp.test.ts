/**
 * @pikit/pi-adapter/mcp: remote MCP tools as pi-durable tools, against the fake MCP server of
 * `../mcp/testing.ts` reached through `fetch` (no network); and the neutral durable exports bundle
 * without Node.
 */

import { afterEach, expect, test } from "bun:test";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createFakeMcpServer, type FakeMcpServer } from "./testing/mcp.ts";
import { BACKGROUND_CONTEXT } from "./execution.ts";
import { runToolCalls } from "./testing/execution.ts";
import { McpClient, mcpHttpTransport, mcpParameters, mcpTool, mcpToolName, mcpToolResult, type Tool } from "./mcp.ts";

const URL_ = "http://mcp.test/mcp";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A `fetch` that reaches `server` and remembers the `this` it was called with. */
function fetchOf(server: FakeMcpServer): { fetch: typeof fetch; receivers: unknown[] } {
  const receivers: unknown[] = [];
  const fake = function (this: unknown, input: string | URL, init?: RequestInit) {
    receivers.push(this);
    return server.fetch(new Request(String(input), init));
  };
  return { fetch: fake as typeof fetch, receivers };
}

test("the neutral durable exports bundle without Node", async () => {
  for (const entry of ["./mcp.ts", "./tools/index.ts", "./execution.ts", "./testing/execution.ts"]) {
    const built = await Bun.build({ entrypoints: [new URL(entry, import.meta.url).pathname], target: "browser", format: "esm", external: ["@pikit/*"] });
    expect(built.success).toBe(true);
    const code = (await built.outputs[0]?.text()) ?? "";
    for (const node of ['from "node:', "child_process", "cross-spawn", "StdioTransport", "NodeExecutionEnv"]) {
      expect({ entry, has: code.includes(node) ? node : undefined }).toEqual({ entry, has: undefined });
    }
  }
});

test("mcpHttpTransport calls fetch as a plain function, and never opens the GET stream", async () => {
  const server = createFakeMcpServer({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
  const { fetch: fake, receivers } = fetchOf(server);
  globalThis.fetch = fake;
  const client = new McpClient({ name: "pikit-test", version: "0.0.0" });
  await client.connect(mcpHttpTransport({ url: URL_ }));
  expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
  await client.close();

  expect(receivers.every((receiver) => receiver === undefined)).toBe(true);
  expect(server.requests.map((r) => r.rpc ?? r.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
});

test("mcpToolName and mcpParameters name and shape a remote tool as before", () => {
  expect(mcpToolName("github", "search_issues")).toBe("github_search_issues");
  expect(mcpToolName("my.server", "ns/tool name")).toBe("my_server_ns_tool_name");
  expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
  expect(mcpParameters({})).toMatchObject({ type: "object", properties: {} });
});

test("mcpToolResult: content for the model; a result with isError is an error result, not a throw", () => {
  expect(mcpToolResult({ content: [{ type: "text", text: "ok" }] }, "s_t")).toEqual({ content: [{ type: "text", text: "ok" }] });
  expect(mcpToolResult({ content: [{ type: "text", text: "no such repository" }], isError: true }, "s_t")).toEqual({
    content: [{ type: "text", text: "no such repository" }],
    isError: true,
  });
  expect(mcpToolResult({ content: [], isError: true }, "s_t")).toEqual({
    content: [{ type: "text", text: "s_t: the MCP server reported a failure without a message" }],
    isError: true,
  });
});

const ASK: Tool = {
  name: "ask",
  title: "Ask",
  description: "Asks the wiki.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  annotations: { readOnlyHint: true },
};

test("mcpTool: provided before it is described; describe changes what the registered object reports", async () => {
  const calls: Record<string, unknown>[] = [];
  const mcp = mcpTool({
    name: "wiki_ask",
    label: "wiki: ask",
    call: async (args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "answer" }] };
    },
  });
  const tool = mcp.tool;
  expect([tool.name, tool.replay, tool.description]).toEqual(["wiki_ask", "unsafe", "wiki: ask (an MCP tool, described when its component starts)"]);

  mcp.describe(ASK, "safe");
  expect(mcp.tool).toBe(tool);
  expect([tool.description, tool.replay]).toEqual(["Asks the wiki.", "safe"]);
  expect(tool.parameters).toMatchObject(ASK.inputSchema);
  mcp.describe({ name: "ask", title: "Ask", inputSchema: {} }, "unsafe");
  expect([tool.description, tool.replay]).toEqual(["Ask", "unsafe"]);

  const result = await tool.execute({ q: "what" } as never, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
  expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  expect(calls).toEqual([{ q: "what" }]);
});

test("in a Harness turn: a described MCP tool is called through the client, its schema enforced, a failure an error result", async () => {
  const server = createFakeMcpServer({
    tools: [
      { ...ASK, call: (args) => ({ content: [{ type: "text", text: `wiki says: ${String(args.q)}` }] }) },
      { name: "break", inputSchema: { type: "object" }, call: () => ({ content: [{ type: "text", text: "it broke" }], isError: true }) },
    ],
  });
  const { fetch: fake } = fetchOf(server);
  const client = new McpClient({ name: "pikit-test", version: "0.0.0" });
  await client.connect(mcpHttpTransport({ url: URL_, fetch: fake }));
  const listed = await client.listTools();
  const tools = listed.map((remote) => {
    const mcp = mcpTool({ name: mcpToolName("wiki", remote.name), label: `wiki: ${remote.name}`, call: (args, signal) => client.callTool(remote.name, args, signal === undefined ? {} : { signal }) });
    mcp.describe(remote, remote.annotations?.readOnlyHint === true ? "safe" : "unsafe");
    return mcp.tool;
  });

  const results = await runToolCalls({
    tools,
    calls: [
      { name: "wiki_ask", args: { q: "pikit" } },
      { name: "wiki_ask", args: {} },
      { name: "wiki_break", args: {} },
    ],
  });
  await client.close();

  expect(tools.map((tool) => [tool.name, tool.replay])).toEqual([
    ["wiki_ask", "safe"],
    ["wiki_break", "unsafe"],
  ]);
  expect(results.map((r) => [r.name, r.isError])).toEqual([
    ["wiki_ask", false],
    ["wiki_ask", true],
    ["wiki_break", true],
  ]);
  expect(results[0]?.text).toBe("wiki says: pikit");
  expect(results[2]?.text).toContain("it broke");
  // The call without `q` was refused by the described schema: the server got one call to `ask`.
  expect(server.requests.filter((r) => r.rpc === "tools/call")).toHaveLength(2);
});
