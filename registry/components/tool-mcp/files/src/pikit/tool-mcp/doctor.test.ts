/**
 * tool-mcp's check of `pikit doctor` (`doctor.ts`). Each MCP server is a local stand-in on a free
 * port (`Bun.serve` over `createFakeMcpServer`): no test reaches the network or needs a real token.
 */

import { afterAll, expect, test } from "bun:test";
import { createFakeMcpServer, type FakeMcpServer } from "@pikit/pi-adapter/mcp/testing";
import { doctor } from "./doctor.ts";

const TOKEN = "mcp-doctor-token-0123456789";
const TOOLS = [
  { name: "ask_question", inputSchema: { type: "object" } },
  { name: "open_issue", inputSchema: { type: "object" } },
];

const stops: (() => unknown)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop();
});

function serve(server: FakeMcpServer): string {
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: server.fetch });
  stops.push(() => http.stop(true));
  return `http://127.0.0.1:${http.port}/mcp`;
}

const env = (values: Record<string, string>) => (name: string) => values[name];

test("no servers: no problem", async () => {
  expect(await doctor({ config: {}, get: env({}) })).toEqual([]);
  expect(await doctor({ config: { servers: {} }, get: env({}) })).toEqual([]);
});

test("a server that lists every named tool: no problem, and its session is ended", async () => {
  const server = createFakeMcpServer({ tools: TOOLS });
  expect(await doctor({ config: { servers: { wiki: { url: serve(server), tools: ["ask_question", "open_issue"] } } }, get: env({}) })).toEqual([]);
  expect(server.requests.map((r) => r.rpc ?? r.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
});

test("a named tool the server lacks, and a server that cannot be reached, are problems naming the server", async () => {
  const url = serve(createFakeMcpServer({ tools: TOOLS }));
  const problems = await doctor({
    config: {
      servers: {
        wiki: { url, tools: ["ask_question", "delete_everything"] },
        gone: { url: "http://127.0.0.1:9/mcp", tools: ["anything"] },
      },
    },
    get: env({}),
  });
  expect(problems).toHaveLength(2);
  expect(problems[0]).toBe('the MCP server "wiki" has no tool "delete_everything" (it has: ask_question, open_issue)');
  expect(problems[1]).toStartWith('the MCP server "gone" (http://127.0.0.1:9/mcp) could not list its tools: ');
});

test("the token comes from the environment by the secret's name; missing or refused is a problem that never shows it", async () => {
  const server = createFakeMcpServer({ tools: TOOLS, token: TOKEN });
  const config = { servers: { wiki: { url: serve(server), secret: "WIKI_MCP_TOKEN", tools: ["ask_question"] } } };
  expect(await doctor({ config, get: env({ WIKI_MCP_TOKEN: TOKEN }) })).toEqual([]);
  expect(server.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

  expect(await doctor({ config, get: env({}) })).toEqual([
    'the MCP server "wiki" needs the secret WIKI_MCP_TOKEN, which is not set in .env or the environment: run `pikit configure` or set it',
  ]);
  const refused = await doctor({ config, get: env({ WIKI_MCP_TOKEN: "wrong-token" }) });
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain('the MCP server "wiki"');
  expect(refused[0]).toContain("could not list its tools");
  expect(refused[0]).not.toContain("wrong-token");
});
