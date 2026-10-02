/**
 * The `websearch` tool on pi-durable answers as `tool-websearch-brave`'s does, and its key never
 * reaches what the model or the transcript sees, in a real Harness turn too. Brave is a local stand-in
 * on a free port (`Bun.serve`), reached through `apiBase`: no test reaches the network.
 */

import { afterAll, expect, test } from "bun:test";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "../execution.ts";
import { runToolCalls } from "../testing/execution.ts";
import { BRAVE_KEY_SECRET, BRAVE_SEARCH_PATH, createBraveSearchTool } from "./index.ts";

const KEY = "brave-test-key-0123456789";
const received: { path: string; query: URLSearchParams; token: string | null }[] = [];
let answer: () => Response = () => Response.json({});

const brave = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    received.push({ path: url.pathname, query: url.searchParams, token: request.headers.get("x-subscription-token") });
    if (request.headers.get("x-subscription-token") !== KEY) return Response.json({ type: "ErrorResponse" }, { status: 401 });
    return answer();
  },
});
const apiBase = `http://127.0.0.1:${brave.port}`;
afterAll(() => brave.stop(true));

const toolWith = (key: string | undefined) => createBraveSearchTool({ apiKey: async () => key, apiBase });

async function search(tool: ToolRegistration, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute(args as never, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
  return (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

test("the tool websearch, replay safe, and nothing about the key in its definition", () => {
  const tool = toolWith(KEY);
  expect([tool.name, tool.replay]).toEqual(["websearch", "safe"]);
  expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["query", "count"]);
  expect(JSON.stringify(tool)).not.toContain(KEY);
});

test("it asks Brave with the key and returns the results as plain text", async () => {
  answer = () =>
    Response.json({
      web: {
        results: [
          { title: "pikit &amp; <strong>Pi</strong>", url: "https://example.org/pikit", description: "A kit for <strong>agents</strong> &#8212; small.", age: "2 days ago" },
          { title: "Second", url: "https://example.org/2", description: "" },
        ],
      },
    });
  const text = await search(toolWith(KEY), { query: "pikit agents", count: 2 });
  const request = received.at(-1);

  expect([request?.path, request?.query.get("q"), request?.query.get("count"), request?.token]).toEqual([BRAVE_SEARCH_PATH, "pikit agents", "2", KEY]);
  expect(text).toBe("1. pikit & Pi (2 days ago)\n   https://example.org/pikit\n   A kit for agents \u2014 small.\n\n2. Second\n   https://example.org/2");
});

test("five results by default, and a search with none says so", async () => {
  answer = () => Response.json({ web: { results: [] } });
  expect(await search(toolWith(KEY), { query: "zzqx" })).toBe('No results for "zzqx".');
  expect(received.at(-1)?.query.get("count")).toBe("5");
});

test("without the key it fails clearly, and asks Brave nothing", async () => {
  const before = received.length;
  await expect(search(toolWith(undefined), { query: "pikit" })).rejects.toThrow(`websearch: ${BRAVE_KEY_SECRET} is not set`);
  expect(received.length).toBe(before);
});

test("a refused key or a quota fails with Brave's status, and never shows the key", async () => {
  const error = await search(toolWith("wrong-key"), { query: "pikit" }).then(
    () => new Error("it answered"),
    (reason: unknown) => reason as Error,
  );
  expect(error.message).toBe("websearch: Brave Search answered HTTP 401: the key in BRAVE_API_KEY was refused");
  expect(error.message).not.toContain("wrong-key");

  answer = () => new Response("slow down", { status: 429 });
  await expect(search(toolWith(KEY), { query: "pikit" })).rejects.toThrow("HTTP 429: the key's rate limit or monthly quota is reached");
});

test("in a Harness turn: the key is nowhere in the transcript, even when an answer echoes it", async () => {
  answer = () => Response.json({ web: { results: [{ title: `echo ${KEY}`, url: "https://example.org", description: "d" }] } });
  const results = await runToolCalls({ tools: [toolWith(KEY)], calls: [{ name: "websearch", args: { query: "pikit" } }] });
  answer = () => new Response("down", { status: 503 });
  const failed = await runToolCalls({ tools: [toolWith(KEY)], calls: [{ name: "websearch", args: { query: "pikit" } }] });

  expect(results.map((r) => [r.name, r.isError])).toEqual([["websearch", false]]);
  expect(results[0]?.text).toContain("echo [redacted]");
  expect(failed[0]?.isError).toBe(true);
  expect(failed[0]?.text).toContain("HTTP 503");
  expect(JSON.stringify([results, failed])).not.toContain(KEY);
});
