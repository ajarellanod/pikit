/**
 * tool-mcp's tests. They are copied with the component and keep running in your project. Each MCP
 * server is a local stand-in on a free port (`Bun.serve` over `createFakeMcpServer`), speaking
 * Streamable HTTP: no test reaches the network or needs a real token. Runs use a scripted model.
 */

import { afterAll, expect, test } from "bun:test";
import { type App, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { type AgentTool, defineAgent, type KeyValueStorage, type SqlDatabase } from "@pikit/contracts";
import { createMemoryKeyValueStorage } from "@pikit/contracts/testing";
import { createDurableRuntime, modelsFrom, openDurableStorage } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@pikit/pi-adapter/execution";
import { callTool } from "@pikit/pi-adapter/execution/testing";
import { createFakeMcpServer, type FakeMcpServer, type FakeMcpTool } from "@pikit/pi-adapter/mcp/testing";
import { type ModelRequest, scriptedProvider, testComponents } from "@pikit/pi-adapter/testing";
import toolMcp, { type SeedListing } from "./index.ts";
import { seed } from "./seed.ts";

const TOKEN = "mcp-test-token-0123456789";

const WIKI_TOOLS: FakeMcpTool[] = [
  {
    name: "ask_question",
    title: "Ask a question",
    description: "Asks a question about a repository.",
    inputSchema: { type: "object", properties: { repoName: { type: "string" }, question: { type: "string" } }, required: ["repoName", "question"] },
    annotations: { readOnlyHint: true },
    call: (args) => ({ content: [{ type: "text", text: `${String(args.repoName)}: it is a kit` }] }),
  },
  {
    name: "open_issue",
    description: "Opens an issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    call: (args) =>
      args.title === "" ? { content: [{ type: "text", text: "a title is required" }], isError: true } : { content: [{ type: "text", text: "opened #7" }] },
  },
  { name: "no_arguments", inputSchema: { type: "object" } },
  {
    name: "slow",
    description: "Never answers.",
    inputSchema: { type: "object" },
    call: () => new Promise(() => {}),
  },
];

const stops: (() => unknown)[] = [];
afterAll(async () => {
  for (const stop of stops.reverse()) await stop();
});

/** A fake MCP server on a free port, and its URL. */
function serve(server: FakeMcpServer): string {
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: server.fetch });
  stops.push(() => http.stop(true));
  return `http://127.0.0.1:${http.port}/mcp`;
}

/** A `secrets` provider over `values`, as `secrets-env` over the environment. */
function secretsOf(values: Record<string, string>) {
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => values[name] }) });
}

interface Installed {
  app: App;
  /** The agent tools, read in `start` by a component that uses them (as runtime-pi does). */
  tools: Map<string, AgentTool>;
}

/** A `storage.kv` provider over `storage`: apps created one after the other over it share its data. */
function kvOf(storage: KeyValueStorage) {
  return defineComponent({ name: "storage-kv-test", setup: (pikit) => pikit.provide("storage.kv", storage) });
}

/** tool-mcp in an app with `config`, started; `extra` are more components (secrets, storage.kv). */
async function installed(config: Record<string, unknown>, extra: ComponentDefinition[] = [], logger: Logger = silentLogger): Promise<Installed> {
  const tools = new Map<string, AgentTool>();
  const reader = defineComponent({
    name: "tool-reader",
    setup(pikit) {
      const provided = pikit.useKeyed("agent.tool");
      return {
        start() {
          for (const key of provided.keys()) {
            const tool = provided.get(key);
            if (tool !== undefined) tools.set(key, tool);
          }
        },
      };
    },
  });
  const app = await defineApp({ components: [...extra, toolMcp, reader], config: { "tool-mcp": config }, logger }).create();
  await app.start();
  stops.push(() => app.stop());
  return { app, tools };
}

/** A copy of the wiki's tools, for a server whose tools a test changes. */
const wikiTools = (): FakeMcpTool[] => WIKI_TOOLS.map((tool) => ({ ...tool }));

/** A logger that keeps its errors' messages. */
function errorsLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return { ...silentLogger, errors, error: (message) => void errors.push(message) };
}

/**
 * Calls `tool` as the runtime does, outside a run: its text, and whether it failed. A throw is a failed
 * call whose text is the error's message, as pi-durable gives it to the model.
 */
async function call(tool: AgentTool | undefined, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
  if (tool === undefined) throw new Error("no such tool");
  const outcome = await callTool(tool, args, signal === undefined ? {} : { context: withAbortSignal(signal, BACKGROUND_CONTEXT) });
  const thrown = outcome.diagnostics.filter((d) => d.code === "tool_error").map((d) => d.message);
  return { text: [outcome.text, ...thrown].filter((part) => part !== "").join("\n"), isError: outcome.isError };
}

/** The text of a call that succeeded. */
async function textOf(result: Promise<{ text: string; isError: boolean }> | { text: string; isError: boolean }): Promise<string> {
  const settled = await result;
  if (settled.isError) throw new Error(settled.text);
  return settled.text;
}

async function startError(config: Record<string, unknown>, extra: ComponentDefinition[] = []): Promise<string> {
  const app = await defineApp({ components: [...extra, toolMcp], config: { "tool-mcp": config }, logger: silentLogger }).create();
  return app.start().then(
    async () => {
      await app.stop();
      return "it started";
    },
    (error: unknown) => {
      const cause = (error as Error).cause;
      return `${(error as Error).message} ${cause instanceof Error ? cause.message : ""}`;
    },
  );
}

test("without servers it provides no tool, and starts", async () => {
  const s = await installed({});
  expect([...s.tools.keys()]).toEqual([]);
});

test("each named tool is provided as <server>_<tool>, and only those named", async () => {
  const url = serve(createFakeMcpServer({ tools: WIKI_TOOLS }));
  const s = await installed({ servers: { wiki: { url, tools: ["ask_question", "open_issue"] } } });
  expect([...s.tools.keys()].sort()).toEqual(["wiki_ask_question", "wiki_open_issue"]);
  expect(s.tools.get("wiki_ask_question")?.name).toBe("wiki_ask_question");
});

test("at start each tool takes its description and parameters from the server, and its replay from readOnlyHint", async () => {
  const url = serve(createFakeMcpServer({ tools: WIKI_TOOLS }));
  const s = await installed({ servers: { wiki: { url, tools: ["ask_question", "open_issue", "no_arguments"] } } });
  const ask = s.tools.get("wiki_ask_question");
  expect(ask?.description).toBe("Asks a question about a repository.");
  expect(ask?.parameters).toMatchObject({ type: "object", properties: { repoName: { type: "string" } }, required: ["repoName", "question"] });
  expect(ask?.replay).toBe("safe");
  expect(s.tools.get("wiki_open_issue")?.replay).toBe("unsafe");
  // A server that gives no description or properties: the name, and an empty object.
  expect(s.tools.get("wiki_no_arguments")?.description).toBe("no_arguments");
  expect(s.tools.get("wiki_no_arguments")?.parameters).toMatchObject({ type: "object", properties: {} });
});

test("a call reaches the server's tool with its arguments and returns its content", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const s = await installed({ servers: { wiki: { url: serve(server), tools: ["ask_question", "no_arguments"] } } });
  expect(await textOf(call(s.tools.get("wiki_ask_question"), { repoName: "pikit", question: "what?" }))).toBe("pikit: it is a kit");
  expect(await textOf(call(s.tools.get("wiki_no_arguments"), {}))).toBe("{}");
  // One session, opened at start; never the server-to-client GET stream.
  expect(server.sessionsOpened).toBe(1);
  expect(server.requests.some((r) => r.method === "GET")).toBe(false);
});

test("a failure the server reports (isError) fails the call with its text", async () => {
  const s = await installed({ servers: { wiki: { url: serve(createFakeMcpServer({ tools: WIKI_TOOLS })), tools: ["open_issue"] } } });
  await expect(textOf(call(s.tools.get("wiki_open_issue"), { title: "" }))).rejects.toThrow("a title is required");
  expect(await textOf(call(s.tools.get("wiki_open_issue"), { title: "bug" }))).toBe("opened #7");
});

test("a tool the server does not have stops the start, naming the ones it has", async () => {
  const url = serve(createFakeMcpServer({ tools: WIKI_TOOLS }));
  const message = await startError({ servers: { wiki: { url, tools: ["ask_question", "delete_everything"] } } });
  expect(message).toContain('the MCP server "wiki" has no tool "delete_everything" (it has: ask_question, open_issue, no_arguments, slow)');
});

test("a server that cannot be reached stops the start", async () => {
  const message = await startError({ servers: { gone: { url: "http://127.0.0.1:9/mcp", tools: ["anything"] } } });
  expect(message).toContain('the MCP server "gone" could not list its tools');
});

test("when the server forgets the session, the call connects again and is sent once", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const s = await installed({ servers: { wiki: { url: serve(server), tools: ["ask_question"] } } });
  server.expireSessions();
  const before = server.requests.filter((r) => r.rpc === "tools/call").length;
  expect(await textOf(call(s.tools.get("wiki_ask_question"), { repoName: "pi", question: "?" }))).toBe("pi: it is a kit");
  expect(server.sessionsOpened).toBe(2);
  // The first try was refused (404) before running; the second ran it.
  expect(server.requests.filter((r) => r.rpc === "tools/call").length - before).toBe(2);
});

test("the token is read from the secret the config names and sent as a bearer token; never in config or errors", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS, token: TOKEN });
  const url = serve(server);
  const config = { servers: { wiki: { url, secret: "WIKI_MCP_TOKEN", tools: ["ask_question"] } } };
  const s = await installed(config, [secretsOf({ WIKI_MCP_TOKEN: TOKEN })]);
  await call(s.tools.get("wiki_ask_question"), { repoName: "pikit", question: "?" });
  expect(server.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

  const refused = await startError(config, [secretsOf({ WIKI_MCP_TOKEN: "wrong-token" })]);
  expect(refused).toContain('the MCP server "wiki" could not list its tools');
  expect(refused).not.toContain("wrong-token");
  expect(await startError(config, [secretsOf({})])).toContain('the secret WIKI_MCP_TOKEN, the token of the MCP server "wiki", is not set');
  expect(await startError(config)).toContain('the MCP server "wiki" needs the secret WIKI_MCP_TOKEN, but no component provides secrets');
});

test("headers from config reach the server", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  await installed({ servers: { wiki: { url: serve(server), headers: { "x-team": "blue" }, tools: ["ask_question"] } } });
  expect(server.requests.every((r) => r.headers["x-team"] === "blue")).toBe(true);
});

test("a call ends when its run is cancelled, and the server is told", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const s = await installed({ servers: { wiki: { url: serve(server), tools: ["slow"] } } });
  const controller = new AbortController();
  const pending = call(s.tools.get("wiki_slow"), {}, controller.signal);
  while (!server.requests.some((r) => r.rpc === "tools/call")) await Bun.sleep(2);
  controller.abort(new Error("run cancelled"));
  expect((await pending).isError).toBe(true);
  while (!server.requests.some((r) => r.rpc === "notifications/cancelled")) await Bun.sleep(2);
});

test("stop ends each server's session", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const s = await installed({ servers: { wiki: { url: serve(server), tools: ["ask_question"] } } });
  await s.app.stop();
  expect(server.requests.at(-1)?.method).toBe("DELETE");
});

test("with storage.kv, a start without a kept listing reaches the server and keeps what it listed of the named tools", async () => {
  const storage = createMemoryKeyValueStorage();
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const url = serve(server);
  const s = await installed({ servers: { wiki: { url, tools: ["ask_question", "open_issue"] } } }, [kvOf(storage)]);
  expect(server.requests.map((r) => r.rpc).filter((rpc) => rpc !== undefined)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  expect(s.tools.get("wiki_ask_question")?.description).toBe("Asks a question about a repository.");
  const kept = (await storage.namespace("tool-mcp").get("server/wiki")) as Record<string, unknown> | undefined;
  expect(kept).toMatchObject({
    url,
    tools: {
      ask_question: { name: "ask_question", title: "Ask a question", description: "Asks a question about a repository.", annotations: { readOnlyHint: true } },
      open_issue: { name: "open_issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
    },
  });
  // Only the named tools.
  expect(Object.keys(kept?.tools as object).sort()).toEqual(["ask_question", "open_issue"]);
  expect(Number.isNaN(Date.parse(String(kept?.listedAt)))).toBe(false);
});

test("with a kept listing, a start makes no request and describes the tools from it; the first call connects", async () => {
  const storage = createMemoryKeyValueStorage();
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const config = { servers: { wiki: { url: serve(server), tools: ["ask_question", "open_issue"] } } };
  await installed(config, [kvOf(storage)]);
  const before = server.requests.length;

  const s = await installed(config, [kvOf(storage)]);
  expect(server.requests.length).toBe(before);
  const ask = s.tools.get("wiki_ask_question");
  expect(ask?.description).toBe("Asks a question about a repository.");
  expect(ask?.parameters).toMatchObject({ type: "object", properties: { repoName: { type: "string" } }, required: ["repoName", "question"] });
  expect(ask?.replay).toBe("safe");
  expect(s.tools.get("wiki_open_issue")?.replay).toBe("unsafe");

  expect(await textOf(call(ask, { repoName: "pikit", question: "?" }))).toBe("pikit: it is a kit");
  expect(server.requests.slice(before).flatMap((r) => (r.rpc === undefined ? [] : [r.rpc]))).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});

test("a kept listing for another URL, or without every named tool, is not used: the start reaches the server", async () => {
  const storage = createMemoryKeyValueStorage();
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const url = serve(server);
  await installed({ servers: { wiki: { url, tools: ["ask_question"] } } }, [kvOf(storage)]);

  let before = server.requests.length;
  await installed({ servers: { wiki: { url, tools: ["ask_question", "open_issue"] } } }, [kvOf(storage)]);
  expect(server.requests.length).toBeGreaterThan(before);

  await storage.namespace("tool-mcp").set("server/wiki", { url: "http://127.0.0.1:9/elsewhere", listedAt: "2026-01-01T00:00:00.000Z", tools: {} });
  before = server.requests.length;
  await installed({ servers: { wiki: { url, tools: ["ask_question"] } } }, [kvOf(storage)]);
  expect(server.requests.length).toBeGreaterThan(before);
});

test("a server that is down does not stop a start that has its listing: its calls fail, the other servers answer", async () => {
  const storage = createMemoryKeyValueStorage();
  const wiki = createFakeMcpServer({ tools: WIKI_TOOLS });
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: wiki.fetch });
  const config = {
    servers: {
      wiki: { url: `http://127.0.0.1:${http.port}/mcp`, tools: ["ask_question"] },
      other: { url: serve(createFakeMcpServer({ tools: WIKI_TOOLS })), tools: ["ask_question"] },
    },
  };
  await installed(config, [kvOf(storage)]);
  await http.stop(true);

  const s = await installed(config, [kvOf(storage)]);
  expect(s.tools.get("wiki_ask_question")?.description).toBe("Asks a question about a repository.");
  await expect(textOf(call(s.tools.get("wiki_ask_question"), { repoName: "pikit", question: "?" }))).rejects.toThrow('tool-mcp: the MCP server "wiki" could not be reached');
  expect(await textOf(call(s.tools.get("other_ask_question"), { repoName: "pi", question: "?" }))).toBe("pi: it is a kit");
});

test("with storage.kv but no kept listing, a server that cannot be reached still stops the start", async () => {
  const message = await startError({ servers: { gone: { url: "http://127.0.0.1:9/mcp", tools: ["anything"] } } }, [kvOf(createMemoryKeyValueStorage())]);
  expect(message).toContain('the MCP server "gone" could not list its tools');
});

test("each connection lists the tools again: the tools and the kept listing follow the server", async () => {
  const storage = createMemoryKeyValueStorage();
  const tools = wikiTools();
  const server = createFakeMcpServer({ tools });
  const config = { servers: { wiki: { url: serve(server), tools: ["ask_question"] } } };
  await installed(config, [kvOf(storage)]);
  const s = await installed(config, [kvOf(storage)]);
  const ask = s.tools.get("wiki_ask_question");

  // The first call after a start from the kept listing connects, and lists.
  (tools[0] as FakeMcpTool).description = "Asks, version 2.";
  await call(ask, { repoName: "pikit", question: "?" });
  expect(ask?.description).toBe("Asks, version 2.");
  expect(await storage.namespace("tool-mcp").get("server/wiki")).toMatchObject({ tools: { ask_question: { description: "Asks, version 2." } } });

  // A forgotten session connects again, and lists again.
  tools[0] = { ...(tools[0] as FakeMcpTool), description: "Asks, version 3.", annotations: { readOnlyHint: false } };
  server.expireSessions();
  await call(ask, { repoName: "pikit", question: "?" });
  expect(ask?.description).toBe("Asks, version 3.");
  expect(ask?.replay).toBe("unsafe");
  expect(await storage.namespace("tool-mcp").get("server/wiki")).toMatchObject({ tools: { ask_question: { description: "Asks, version 3." } } });
});

test("a named tool the server no longer lists fails its calls and is logged; the next start still starts", async () => {
  const storage = createMemoryKeyValueStorage();
  const tools = wikiTools();
  const server = createFakeMcpServer({ tools });
  const config = { servers: { wiki: { url: serve(server), tools: ["ask_question", "open_issue"] } } };
  await installed(config, [kvOf(storage)]);
  tools.splice(tools.findIndex((tool) => tool.name === "open_issue"), 1);

  const logger = errorsLogger();
  const s = await installed(config, [kvOf(storage)], logger);
  await expect(textOf(call(s.tools.get("wiki_open_issue"), { title: "bug" }))).rejects.toThrow(
    'tool-mcp: the MCP server "wiki" no longer lists the tool "open_issue" (it has: ask_question, no_arguments, slow)',
  );
  expect(logger.errors).toEqual(['tool-mcp: the MCP server "wiki" no longer lists the tool "open_issue": its calls fail']);
  expect(server.requests.some((r) => r.rpc === "tools/call")).toBe(false);
  // The other tools still answer.
  expect(await textOf(call(s.tools.get("wiki_ask_question"), { repoName: "pikit", question: "?" }))).toBe("pikit: it is a kit");

  // The kept listing keeps the tool's last description: a start does not stop the app over it.
  const before = server.requests.length;
  await installed(config, [kvOf(storage)]);
  expect(server.requests.length).toBe(before);
});

/**
 * Runs `body` with `listings` in the bundled seed (the object `seed.ts` exports, which index.ts reads
 * at each start), then puts back what it held: your own `seed.ts` may hold servers of its own.
 */
async function withSeed(listings: Record<string, SeedListing>, body: () => Promise<void>): Promise<void> {
  const before = { ...seed };
  Object.assign(seed, listings);
  try {
    await body();
  } finally {
    for (const name of Object.keys(seed)) delete seed[name];
    Object.assign(seed, before);
  }
}

/** A seed's listing of the wiki's tools at `url`, as `beforeDeploy` writes it, with `description` for ask_question. */
function seededWiki(url: string, description = "Asks, from the seed."): SeedListing {
  const ask = WIKI_TOOLS[0] as FakeMcpTool;
  const open = WIKI_TOOLS[1] as FakeMcpTool;
  return {
    url,
    tools: {
      ask_question: { name: ask.name, title: "Ask a question", description, inputSchema: ask.inputSchema, annotations: { readOnlyHint: true } },
      open_issue: { name: open.name, description: "Opens an issue.", inputSchema: open.inputSchema },
    },
  };
}

test("with a seed for the server's URL and nothing kept, a start makes no request and describes the tools from the seed", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const url = serve(server);
  const storage = createMemoryKeyValueStorage();
  await withSeed({ wiki: seededWiki(url) }, async () => {
    // With storage.kv holding nothing (a new conversation's object), and without storage.kv.
    for (const extra of [[kvOf(storage)], []]) {
      const s = await installed({ servers: { wiki: { url, tools: ["ask_question", "open_issue"] } } }, extra);
      expect(server.requests).toHaveLength(0);
      const ask = s.tools.get("wiki_ask_question");
      expect(ask?.description).toBe("Asks, from the seed.");
      expect(ask?.parameters).toMatchObject({ properties: { repoName: { type: "string" } }, required: ["repoName", "question"] });
      expect(ask?.replay).toBe("safe");
      expect(s.tools.get("wiki_open_issue")?.replay).toBe("unsafe");
    }
  });
  expect(await storage.namespace("tool-mcp").get("server/wiki")).toBeUndefined();

  // The first call connects and lists: the tools follow the server, and the listing is kept.
  await withSeed({ wiki: seededWiki(url) }, async () => {
    const s = await installed({ servers: { wiki: { url, tools: ["ask_question"] } } }, [kvOf(storage)]);
    expect(await textOf(call(s.tools.get("wiki_ask_question"), { repoName: "pikit", question: "?" }))).toBe("pikit: it is a kit");
    expect(s.tools.get("wiki_ask_question")?.description).toBe("Asks a question about a repository.");
  });
  expect(await storage.namespace("tool-mcp").get("server/wiki")).toMatchObject({ url, tools: { ask_question: { description: "Asks a question about a repository." } } });
});

test("a seed without this server's listing (written before config changed) is said at start; an empty seed is quiet", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const url = serve(server);
  const warned = (): Logger & { warnings: string[] } => {
    const warnings: string[] = [];
    return { ...silentLogger, warnings, warn: (message) => void warnings.push(message) };
  };
  const config = { servers: { wiki: { url, tools: ["ask_question"] } } };

  const quiet = warned();
  await installed(config, [], quiet);
  expect(quiet.warnings).toEqual([]);

  await withSeed({ other: seededWiki("http://127.0.0.1:1/mcp") }, async () => {
    const logger = warned();
    await installed(config, [], logger);
    expect(logger.warnings).toEqual([
      'tool-mcp: seed.ts has no listing of the MCP server "wiki" for its URL and tools: this start reaches it; run `pikit up` (or commit the seed.ts it writes)',
    ]);
  });
});

test("the kept listing wins over the seed: it is refreshed on each connection", async () => {
  const storage = createMemoryKeyValueStorage();
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const url = serve(server);
  const config = { servers: { wiki: { url, tools: ["ask_question"] } } };
  await storage.namespace("tool-mcp").set("server/wiki", { url, listedAt: "2026-09-01T00:00:00.000Z", tools: { ask_question: { name: "ask_question", description: "Asks, as kept.", inputSchema: { type: "object" } } } });
  await withSeed({ wiki: seededWiki(url) }, async () => {
    const s = await installed(config, [kvOf(storage)]);
    expect(server.requests).toHaveLength(0);
    expect(s.tools.get("wiki_ask_question")?.description).toBe("Asks, as kept.");
  });
});

test("a seed for another URL, or without every named tool, is not used: the start reaches the server, and one that is down stops it", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const url = serve(server);
  await withSeed({ wiki: seededWiki("https://mcp.example.com/elsewhere") }, async () => {
    const s = await installed({ servers: { wiki: { url, tools: ["ask_question"] } } });
    expect(server.requests.filter((r) => r.rpc === "tools/list")).toHaveLength(1);
    expect(s.tools.get("wiki_ask_question")?.description).toBe("Asks a question about a repository.");
  });
  await withSeed({ wiki: seededWiki(url) }, async () => {
    await installed({ servers: { wiki: { url, tools: ["ask_question", "no_arguments"] } } });
    expect(server.requests.filter((r) => r.rpc === "tools/list")).toHaveLength(2);
  });
  // An empty seed, or one for another server, is strict as before.
  await withSeed({ other: seededWiki("http://127.0.0.1:9/mcp") }, async () => {
    const message = await startError({ servers: { gone: { url: "http://127.0.0.1:9/mcp", tools: ["ask_question"] } } });
    expect(message).toContain('the MCP server "gone" could not list its tools');
  });
});

test("without storage.kv, every start reaches the server", async () => {
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const config = { servers: { wiki: { url: serve(server), tools: ["ask_question"] } } };
  await installed(config);
  await installed(config);
  expect(server.requests.filter((r) => r.rpc === "tools/list")).toHaveLength(2);
});

test("the config's example composes and provides its tools (setup only: nothing is reached)", async () => {
  const examples = (toolMcp.config as { examples?: Record<string, unknown>[] }).examples ?? [];
  expect(examples).toHaveLength(1);
  const app = await defineApp({ components: [toolMcp], config: { "tool-mcp": examples[0] }, logger: silentLogger }).create();
  const keys = (app.describe() as { capabilities: Record<string, { keys?: Record<string, string> }> }).capabilities["agent.tool"]?.keys;
  expect(Object.keys(keys ?? {}).sort()).toEqual(["deepwiki_ask_wiki_question", "deepwiki_read_wiki_structure"]);
});

test("setup refuses a server name that cannot start a tool name, and two tools with one name", async () => {
  const url = "http://127.0.0.1:9/mcp";
  const bad = defineApp({ components: [toolMcp], config: { "tool-mcp": { servers: { "my wiki": { url, tools: ["a"] } } } }, logger: silentLogger });
  await expect(bad.create()).rejects.toThrow('the server name "my wiki" may hold only letters, digits, "_" and "-"');
  const twice = defineApp({ components: [toolMcp], config: { "tool-mcp": { servers: { a: { url, tools: ["b_c"] }, a_b: { url, tools: ["c"] } } } }, logger: silentLogger });
  await expect(twice.create()).rejects.toThrow('"a/b_c" and "a_b/c" would both be the tool "a_b_c"');
});

test("in a real run, the model sees what the server described at start, its call reaches the server, and a reported failure is a failed call", async () => {
  // When pi-durable reads a tool: the runtime installs agents' tools by name when a conversation is
  // configured (after every start), and pi-durable reads description, parameters and replay from that
  // same object at each model request.
  const server = createFakeMcpServer({ tools: WIKI_TOOLS });
  const agents = [defineAgent({ name: "researcher", model: "faux/scripted", tools: ["wiki_ask_question", "wiki_open_issue"] })];
  const fixtures = testComponents({ agents });
  const settled: string[] = [];
  let sql!: SqlDatabase;
  let tools!: { get(name: string): AgentTool | undefined };
  const reader = defineComponent({
    name: "runtime-reader",
    setup(pikit) {
      const storage = pikit.use("storage.sql");
      const provided = pikit.useKeyed("agent.tool");
      pikit.on("agent.settled", (payload) => void settled.push(payload.requestId));
      return {
        start() {
          sql = storage.get();
          tools = provided;
        },
      };
    },
  });
  const app = await defineApp({
    components: [fixtures.storage, toolMcp, reader],
    config: { "tool-mcp": { servers: { wiki: { url: serve(server), tools: ["ask_question", "open_issue"] } } } },
    logger: silentLogger,
  }).create();
  await app.start();
  stops.push(() => app.stop());

  const requests: ModelRequest[] = [];
  const runtime = createDurableRuntime({
    storage: () => openDurableStorage(sql),
    agent: (name) => agents.find((agent) => agent.name === name),
    tool: (name) => tools.get(name),
    models: modelsFrom([scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) })]),
    events: app.context(),
  });
  stops.push(() => runtime.close(app.context()));
  const conversation = { key: "test:researcher", agent: "researcher", conversationId: await runtime.createConversation(app.context()) };
  await runtime.dispatch({ requestId: "r-1", conversation, prompt: 'call: wiki_ask_question {"repoName":"pikit","question":"what?"}' }, app.context());
  while (!settled.includes("r-1")) await Bun.sleep(5);

  // pi-durable gives the model its tools in the transcript: a system message's `toolsAdded`.
  const offered = requests[0]?.messages
    .flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []))
    .find((tool) => tool.name === "wiki_ask_question");
  expect(offered?.description).toBe("Asks a question about a repository.");
  expect(offered?.parameters).toMatchObject({ properties: { repoName: { type: "string" }, question: { type: "string" } } });
  const result = requests.at(-1)?.messages.find((message) => message.role === "toolResult");
  expect(result?.role === "toolResult" && result.isError).toBe(false);
  expect(JSON.stringify(result)).toContain("pikit: it is a kit");
  expect(server.requests.filter((r) => r.rpc === "tools/call")).toHaveLength(1);

  // An MCP isError is recorded as a failed call, with the server's text.
  await runtime.dispatch({ requestId: "r-2", conversation, prompt: 'call: wiki_open_issue {"title":""}' }, app.context());
  while (!settled.includes("r-2")) await Bun.sleep(5);
  const failed = [...(requests.at(-1)?.messages ?? [])].reverse().find((message) => message.role === "toolResult");
  expect(failed?.role === "toolResult" && failed.isError).toBe(true);
  expect(JSON.stringify(failed)).toContain("a title is required");
});
