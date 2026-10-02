/**
 * tool-mcp and `@pikit/pi-adapter/mcp` in workerd, through the Worker's real `fetch`: workerd's
 * outbound service is the fake MCP servers of `mcp-outbound.ts` (`vitest.config.ts`), so nothing here
 * replaces `globalThis.fetch` and nothing reaches the network.
 *
 * The first case pins what pi-mcp 1.0 fixed upstream: 0.99 called the global `fetch` as a method of its
 * transport, which workerd refuses ("Illegal invocation"); 1.0 calls it without a receiver, so its own
 * transport works here, and `mcpHttpTransport`'s wrapper is only belt and braces.
 */

import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import { createMemoryKeyValueStorage } from "@pikit/contracts/testing";
import { callTool } from "@pikit/pi-adapter/execution/testing";
import { McpClient, mcpHttpTransport, StreamableHttpTransport } from "@pikit/pi-adapter/mcp";
import { expect, it } from "vitest";
import toolMcp from "../../../registry/components/tool-mcp/files/src/pikit/tool-mcp/index.ts";
import { seed } from "../../../registry/components/tool-mcp/files/src/pikit/tool-mcp/seed.ts";
import { MCP_HOSTS, MCP_TOKEN } from "./mcp-outbound.ts";

const urlOf = (host: string) => `http://${host}/mcp`;
/** One call, as the runtime makes it: its text, and whether it failed. */
async function call(tool: AgentTool | undefined, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (tool === undefined) throw new Error("no such tool");
  const outcome = await callTool(tool, args);
  return { text: outcome.text, isError: outcome.isError };
}

it("pi-mcp 1.0's own transport works on workerd's fetch (0.99's failed with Illegal invocation)", async () => {
  const client = new McpClient({ name: "pikit-workerd", version: "0.0.0" });
  await client.connect(new StreamableHttpTransport({ url: urlOf(MCP_HOSTS.json), openGetStream: false }));
  expect((await client.listTools()).map((tool) => tool.name)).toEqual(["ask_question", "open_issue"]);
  await client.close();
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
    expect(tools.get("wiki_open_issue")?.replay).toBe("unsafe");

    expect(await call(tools.get("wiki_ask_question"), { repoName: "pikit" })).toEqual({ text: "pikit: it is a kit", isError: false });
    // A failure the server reports is an error result, with its text.
    expect(await call(tools.get("wiki_open_issue"), { title: "" })).toEqual({ text: "a title is required", isError: true });
    expect((await call(tools.get("private_ask_question"), { repoName: "pi" })).text).toBe("pi: it is a kit");

    // The server forgets its sessions, as one that restarted: the call connects again.
    await fetch(`http://${MCP_HOSTS.sse}/__expire`, { method: "POST" });
    expect((await call(tools.get("wiki_ask_question"), { repoName: "again" })).text).toBe("again: it is a kit");
  } finally {
    await app.stop();
  }
});

it("tool-mcp in workerd with storage.kv: a start with the kept listing makes no request; the first call connects and lists", async () => {
  const storage = createMemoryKeyValueStorage();
  const kv = defineComponent({ name: "storage-kv-test", setup: (pikit) => pikit.provide("storage.kv", storage) });
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
  const requests = async () => (await (await fetch(`http://${MCP_HOSTS.json}/__requests`)).json()) as number;
  const definition = defineApp({
    components: [kv, toolMcp, reader],
    config: { "tool-mcp": { servers: { wiki: { url: urlOf(MCP_HOSTS.json), tools: ["ask_question"] } } } },
    logger: silentLogger,
  });
  const first = await definition.create();
  await first.start();
  await first.stop();

  const before = await requests();
  const app = await definition.create();
  await app.start();
  try {
    expect(await requests()).toBe(before);
    const ask = tools.get("wiki_ask_question");
    expect(ask?.description).toBe("Asks a question about a repository.");
    expect(ask?.replay).toBe("safe");
    expect((await call(ask, { repoName: "pikit" })).text).toBe("pikit: it is a kit");
    // initialize, notifications/initialized, tools/list, tools/call.
    expect((await requests()) - before).toBe(4);
  } finally {
    await app.stop();
  }
});

it("tool-mcp in workerd with a bundled seed and nothing kept (a new conversation's object): the start makes no request", async () => {
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
  const requests = async () => (await (await fetch(`http://${MCP_HOSTS.json}/__requests`)).json()) as number;
  // What `beforeDeploy` writes into seed.ts, which this Worker bundles: put in the imported object.
  seed.wiki = {
    url: urlOf(MCP_HOSTS.json),
    tools: {
      ask_question: {
        name: "ask_question",
        description: "Asks, from the seed.",
        inputSchema: { type: "object", properties: { repoName: { type: "string" } }, required: ["repoName"] },
        annotations: { readOnlyHint: true },
      },
    },
  };
  const kv = defineComponent({ name: "storage-kv-test", setup: (pikit) => pikit.provide("storage.kv", createMemoryKeyValueStorage()) });
  const app = await defineApp({
    components: [kv, toolMcp, reader],
    config: { "tool-mcp": { servers: { wiki: { url: urlOf(MCP_HOSTS.json), tools: ["ask_question"] } } } },
    logger: silentLogger,
  }).create();
  const before = await requests();
  try {
    await app.start();
    expect(await requests()).toBe(before);
    const ask = tools.get("wiki_ask_question");
    expect(ask?.description).toBe("Asks, from the seed.");
    expect(ask?.replay).toBe("safe");
    expect((await call(ask, { repoName: "pikit" })).text).toBe("pikit: it is a kit");
    // The first call connects and lists: the tool follows the server.
    expect((await requests()) - before).toBe(4);
    expect(ask?.description).toBe("Asks a question about a repository.");
  } finally {
    delete seed.wiki;
    await app.stop();
  }
});
