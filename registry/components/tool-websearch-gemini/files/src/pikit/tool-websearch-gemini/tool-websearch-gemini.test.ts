/**
 * tool-websearch-gemini's tests. They are copied with the component and keep running in your project.
 * Gemini is a local stand-in of its `generateContent` API on a free port (`Bun.serve`), reached through
 * `apiBase`, which also answers the grounding redirects: no test reaches the network or needs a real
 * key. The tool is tested as installed (with `secrets`), called once as the runtime calls it
 * (`callTool`), and in a real Harness turn (`runToolCalls`), where the transcript is checked for the key.
 */

import { afterAll, expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import { callTool, runToolCalls } from "@pikit/pi-adapter/execution/testing";
import toolWebsearchGemini, { createGeminiSearchTool, DEFAULT_MODEL, KEY_SECRET } from "./index.ts";

const KEY = "gemini-test-key-0123456789";

/** The requests the fake Gemini received, and what it answers next. */
const received: { method: string; path: string; search: string; key: string | null; body: unknown }[] = [];
let answer: () => Response = () => Response.json({});

const gemini = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    // A grounding redirect: `/grounding-api-redirect/<n>` leads to `https://example.org/<n>`; `/gone` leads nowhere.
    if (url.pathname.startsWith("/grounding-api-redirect/")) {
      const id = url.pathname.split("/").at(-1);
      return id === "gone" ? new Response(null, { status: 404 }) : new Response(null, { status: 302, headers: { location: `https://example.org/${id}` } });
    }
    received.push({ method: request.method, path: url.pathname, search: url.search, key: request.headers.get("x-goog-api-key"), body: await request.json() });
    // As Gemini: a request with a wrong key is a 400 saying so.
    if (request.headers.get("x-goog-api-key") !== KEY) {
      return Response.json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    return answer();
  },
});
const apiBase = `http://127.0.0.1:${gemini.port}`;
const redirect = (id: string) => `${apiBase}/grounding-api-redirect/${id}`;
afterAll(() => gemini.stop(true));

/** Gemini's answer: `text`, grounded in `chunks`. */
function grounded(text: string, chunks: { uri: string; title: string }[] = []): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP", groundingMetadata: { groundingChunks: chunks.map((web) => ({ web })) } }],
  });
}

/** A `secrets` provider over `values`, as `secrets-env` over the environment. */
function secretsOf(values: Record<string, string>) {
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => values[name] }) });
}

/** The tool as installed in a started app, against the fake Gemini, with `secrets`. */
async function installed(secrets: Record<string, string> = { [KEY_SECRET]: KEY }, config: Record<string, unknown> = {}): Promise<{ tool: AgentTool; stop(): Promise<void> }> {
  let tool: AgentTool | undefined;
  const reader = defineComponent({
    name: "tool-reader",
    setup(pikit) {
      const tools = pikit.useKeyed("agent.tool");
      return { start: () => void (tool = tools.get("websearch")) };
    },
  });
  const app = await defineApp({
    components: [secretsOf(secrets), toolWebsearchGemini, reader],
    config: { "tool-websearch-gemini": { apiBase, ...config } },
    logger: silentLogger,
  }).create();
  await app.start();
  if (tool === undefined) throw new Error("agent.tool websearch was not provided");
  return { tool, stop: () => app.stop() };
}

/** One call, as the runtime makes it: its text, and its error (the message pi-durable gives the model) when it failed. */
async function search(tool: AgentTool, params: Record<string, unknown>): Promise<{ text: string; error?: string }> {
  const result = await callTool(tool, params);
  return result.isError ? { text: result.text, error: result.diagnostics.map((d) => d.message).join(" ") } : { text: result.text };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secretsOf({}), toolWebsearchGemini], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "tool-websearch-gemini")).toMatchObject({
    provides: ["agent.tool"],
    requires: ["secrets"],
    optional: [],
  });
  expect(app.describe().capabilities["agent.tool"]?.keys).toEqual({ websearch: "tool-websearch-gemini" });
});

test("it provides the tool websearch with replay safe", async () => {
  const s = await installed();

  expect([s.tool.name, s.tool.replay]).toEqual(["websearch", "safe"]);
  await s.stop();
});

test("it asks Gemini with google_search and the key in a header, and returns its answer and the real addresses of its sources", async () => {
  answer = () =>
    grounded("Pikit is a kit\nfor agents.", [
      { uri: redirect("pikit"), title: "example.org" },
      { uri: redirect("pikit"), title: "example.org" },
      { uri: redirect("gone"), title: "gone.example" },
      { uri: "https://direct.example/page", title: "direct.example" },
    ]);
  const s = await installed();
  const text = (await search(s.tool, { query: "pikit agents" })).text;
  const request = received.at(-1);

  expect([request?.method, request?.path, request?.search, request?.key]).toEqual(["POST", `/v1beta/models/${DEFAULT_MODEL}:generateContent`, "", KEY]);
  expect(request?.body).toMatchObject({ tools: [{ google_search: {} }] });
  expect(JSON.stringify(request?.body)).toContain("pikit agents");
  expect(text).toBe(
    `Pikit is a kit\nfor agents.\n\nSources:\n\n1. example.org\n   https://example.org/pikit\n\n2. gone.example\n   ${redirect("gone")}\n\n3. direct.example\n   https://direct.example/page`,
  );
  await s.stop();
});

test("count bounds the sources, the model comes from config, and Gemini's thoughts are left out", async () => {
  answer = () =>
    Response.json({
      candidates: [
        {
          content: { parts: [{ text: "thinking…", thought: true }, { text: "The answer." }] },
          groundingMetadata: { groundingChunks: ["a", "b", "c"].map((id) => ({ web: { uri: `https://example.org/${id}`, title: id } })) },
        },
      ],
    });
  const s = await installed(undefined, { model: "gemini-test" });
  const text = (await search(s.tool, { query: "pikit", count: 2 })).text;

  expect(received.at(-1)?.path).toBe("/v1beta/models/gemini-test:generateContent");
  expect(text).toBe("The answer.\n\nSources:\n\n1. a\n   https://example.org/a\n\n2. b\n   https://example.org/b");
  await s.stop();
});

test("an answer without sources is the answer alone, and none at all says so", async () => {
  answer = () => grounded("Only this.");
  const s = await installed();
  expect((await search(s.tool, { query: "pikit" })).text).toBe("Only this.");

  answer = () => Response.json({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] });
  expect((await search(s.tool, { query: "zzqx" })).text).toBe('No results for "zzqx".');

  answer = () => Response.json({ promptFeedback: { blockReason: "SAFETY" } });
  expect((await search(s.tool, { query: "zzqx" })).error).toBe("websearch: Gemini refused the search (SAFETY)");
  await s.stop();
});

test("without GEMINI_API_KEY it fails clearly, and asks Gemini nothing", async () => {
  const s = await installed({});
  const before = received.length;

  expect((await search(s.tool, { query: "pikit" })).error).toContain("websearch: GEMINI_API_KEY is not set");
  expect(received.length).toBe(before);
  await s.stop();
});

test("config apiKey names the variable the key is read from, and the errors name it; never the key itself", async () => {
  answer = () => grounded("From the other key.");
  const s = await installed({ MY_GEMINI_KEY: KEY }, { apiKey: "MY_GEMINI_KEY" });
  expect((await search(s.tool, { query: "pikit" })).text).toBe("From the other key.");
  expect(received.at(-1)?.key).toBe(KEY);
  await s.stop();

  const missing = await installed({ [KEY_SECRET]: KEY }, { apiKey: "MY_GEMINI_KEY" });
  expect((await search(missing.tool, { query: "pikit" })).error).toContain("websearch: MY_GEMINI_KEY is not set");
  await missing.stop();

  await expect(installed(undefined, { apiKey: KEY })).rejects.toThrow();
});

test("a refused key or a quota fails with Gemini's status, and never shows the key", async () => {
  const refused = await installed({ [KEY_SECRET]: "wrong-key" });
  const error = (await search(refused.tool, { query: "pikit" })).error;
  await refused.stop();

  expect(error).toBe("websearch: the Gemini API answered HTTP 400: the key in GEMINI_API_KEY was refused (API key not valid. Please pass a valid API key.)");
  expect(error).not.toContain("wrong-key");

  answer = () => Response.json({ error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } }, { status: 429 });
  const limited = await installed();
  expect((await search(limited.tool, { query: "pikit" })).error).toContain("HTTP 429: the key's rate limit or quota is reached");
  await limited.stop();
});

test("the key reaches only Gemini: nothing the model sees contains it", async () => {
  answer = () => grounded("An answer.", [{ uri: redirect("x"), title: "t" }]);
  const s = await installed();
  const result = await search(s.tool, { query: "pikit" });

  expect(JSON.stringify({ tool: s.tool, result })).not.toContain(KEY);
  await s.stop();
});

test("in a Harness turn: the key is nowhere in the transcript, even when an answer or an error echoes it", async () => {
  const tool = createGeminiSearchTool({ apiKey: async () => KEY, apiBase });
  answer = () => grounded(`echo ${KEY}`);
  const results = await runToolCalls({ tools: [tool], calls: [{ name: "websearch", args: { query: "pikit" } }] });
  answer = () => Response.json({ error: { message: `down for ${KEY}` } }, { status: 503 });
  const failed = await runToolCalls({ tools: [tool], calls: [{ name: "websearch", args: { query: "pikit" } }] });

  expect(results.map((r) => [r.name, r.isError])).toEqual([["websearch", false]]);
  expect(results[0]?.text).toContain("echo [redacted]");
  expect(failed[0]?.isError).toBe(true);
  expect(failed[0]?.text).toContain("HTTP 503");
  expect(JSON.stringify([results, failed])).not.toContain(KEY);
});
