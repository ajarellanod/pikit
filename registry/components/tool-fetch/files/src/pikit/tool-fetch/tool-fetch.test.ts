/**
 * tool-fetch's tests. They are copied with the component and keep running in your project. The web
 * is a local server on a free port (`Bun.serve`): no test reaches the network. The tool's own cases
 * (every content type, limits, redirects) are @pikit/pi-adapter's; these check what you install.
 */

import { afterAll, expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import { callTool } from "@pikit/pi-adapter/execution/testing";
import toolFetch, { createFetchTool } from "./index.ts";

const PAGE = `<!doctype html><html><head><title>Docs</title><script>var secret = 1;</script></head>
<body><h1>Welcome</h1><p>Read the <a href="/guide">guide</a>.</p></body></html>`;

const web = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/page") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/echo") return Response.json({ method: request.method, body: await request.text() });
    if (url.pathname === "/slow") return new Promise<Response>(() => {});
    return new Response("?", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${web.port}`;
afterAll(() => web.stop(true));

/** The tool as installed in a started app. */
async function installed(): Promise<{ tool: AgentTool; stop(): Promise<void> }> {
  let tool: AgentTool | undefined;
  const reader = defineComponent({
    name: "tool-reader",
    setup(pikit) {
      const tools = pikit.useKeyed("agent.tool");
      return { start: () => void (tool = tools.get("fetch")) };
    },
  });
  const app = await defineApp({ components: [toolFetch, reader], logger: silentLogger }).create();
  await app.start();
  if (tool === undefined) throw new Error("agent.tool fetch was not provided");
  return { tool, stop: () => app.stop() };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [toolFetch], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "tool-fetch")).toMatchObject({ provides: ["agent.tool"], requires: [], optional: [] });
  expect(app.describe().capabilities["agent.tool"]?.keys).toEqual({ fetch: "tool-fetch" });
});

test("it provides the tool fetch with replay unsafe, whose description asks to confirm what is not a GET", async () => {
  const s = await installed();

  expect([s.tool.name, s.tool.replay]).toEqual(["fetch", "unsafe"]);
  expect(s.tool.description).toContain("wait for their confirmation");
  await s.stop();
});

test("an HTML page comes back as readable text with absolute links, without scripts", async () => {
  const s = await installed();

  const result = await callTool(s.tool, { url: `${origin}/page` });

  expect(result.isError).toBe(false);
  expect(result.text).toContain("Welcome\nRead the guide.");
  expect(result.text).toContain(`- guide: ${origin}/guide`);
  expect(result.text).not.toContain("secret");
  await s.stop();
});

test("POST sends its body; a scheme other than http(s) is refused", async () => {
  const s = await installed();

  expect((await callTool(s.tool, { url: `${origin}/echo`, method: "POST", body: "hi" })).text).toContain('"body": "hi"');
  expect((await callTool(s.tool, { url: "file:///etc/passwd" })).isError).toBe(true);
  await s.stop();
});

test("it gives up at its timeout", async () => {
  const result = await callTool(createFetchTool({ timeoutMs: 100 }), { url: `${origin}/slow` });

  expect(result.isError).toBe(true);
  expect(result.diagnostics.map((d) => d.message).join(" ")).toContain("0.1 s");
});
