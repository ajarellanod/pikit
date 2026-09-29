/**
 * tool-mcp and `@pikit/pi-adapter/mcp` in workerd, through the Worker's real `fetch`: workerd's
 * outbound service is the fake MCP servers of `mcp-outbound.ts` (`vitest.config.ts`), so nothing here
 * replaces `globalThis.fetch` and nothing reaches the network.
 *
 * The first case pins Pi's gap the adapter closes: pi-mcp 0.99 calls the global `fetch` as a method of
 * its transport, which workerd refuses ("Illegal invocation"). When it fails, Pi fixed it upstream and
 * `mcpHttpTransport` may drop its wrapper.
 */

import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import { McpClient, mcpHttpTransport, StreamableHttpTransport } from "@pikit/pi-adapter/mcp";
import { expect, it } from "vitest";
import toolMcp from "../../../registry/components/tool-mcp/files/src/pikit/tool-mcp/index.ts";
import { MCP_HOSTS, MCP_TOKEN } from "./mcp-outbound.ts";

const urlOf = (host: string) => `http://${host}/mcp`;
const invocation = { invocationId: "i", operationId: "o", turnId: "t", getMemo: async () => undefined, setMemo: async () => {} };
const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
}

it("Pi's gap: pi-mcp's own transport, on workerd's fetch, fails with Illegal invocation", async () => {
  const client = new McpClient({ name: "pikit-workerd", version: "0.0.0" });
  await expect(client.connect(new StreamableHttpTransport({ url: urlOf(MCP_HOSTS.json), openGetStream: false }))).rejects.toThrow("Illegal invocation");
});

for (const kind of ["json", "sse"] as const) {
  it(`mcpHttpTransport works on workerd's fetch (${kind} answers): connect, list, call, close`, async () => {
    const client = new McpClient({ name: "pikit-workerd", version: "0.0.0" });
    await client.connect(mcpHttpTransport({ url: urlOf(MCP_HOSTS[kind]) }));
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["ask_question", "open_issue"]);
    const result = await client.callTool("ask_question", { repoName: "pikit" });
    expect(result.content).toEqual([{ type: "text", text: "pikit: it is a kit" }]);
    await client.close();
  });
}

it("tool-mcp in workerd: tools described at start, calls, a reported failure, a forgotten session, a secret token", async () => {
  const tools = new Map<string, AgentTool>();
  const reader = defineComponent({
    name: "tool-reader",
    setup(pikit) {
      const provided = pikit.useKeyed("agent.tool");
      return {
        start() {
          for (const key of provided.keys()) tools.set(key, provided.get(key) as AgentTool);
        },
      };
    },
  });
  const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => (name === "WIKI_TOKEN" ? MCP_TOKEN : undefined) }) });
  const app = await defineApp({
    components: [secrets, toolMcp, reader],
    config: {
      "tool-mcp": {
        servers: {
          wiki: { url: urlOf(MCP_HOSTS.sse), tools: ["ask_question", "open_issue"] },
          private: { url: urlOf(MCP_HOSTS.token), secret: "WIKI_TOKEN", tools: ["ask_question"] },
        },
      },
    },
    logger: silentLogger,
  }).create();
  await app.start();
  try {
    const ask = tools.get("wiki_ask_question");
    expect(ask?.description).toBe("Asks a question about a repository.");
    expect(ask?.replay).toBe("safe");
    expect(tools.get("wiki_open_issue")?.replay).toBe("never");

    const call = (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`no tool ${name}`);
      return tool.execute("call-1", params, () => {}, undefined, invocation, context);
    };
    expect(textOf(await call("wiki_ask_question", { repoName: "pikit" }))).toBe("pikit: it is a kit");
    await expect(call("wiki_open_issue", { title: "" })).rejects.toThrow("a title is required");
    expect(textOf(await call("private_ask_question", { repoName: "pi" }))).toBe("pi: it is a kit");

    // The server forgets its sessions, as one that restarted: the call connects again.
    await fetch(`http://${MCP_HOSTS.sse}/__expire`, { method: "POST" });
    expect(textOf(await call("wiki_ask_question", { repoName: "again" }))).toBe("again: it is a kit");
  } finally {
    await app.stop();
  }
});
