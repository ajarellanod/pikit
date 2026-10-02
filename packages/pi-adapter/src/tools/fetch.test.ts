/**
 * The `fetch` tool on pi-durable answers as `tool-fetch`'s does (the same cases, called through
 * pi-durable's `execute(args, api, context)`), and runs in a Harness turn. The web is a local server on
 * a free port (`Bun.serve`): no test reaches the network.
 */

import { afterAll, expect, test } from "bun:test";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "../execution.ts";
import { runToolCalls } from "../testing/execution.ts";
import { createFetchTool, FETCH_MAX_OUTPUT } from "./index.ts";

const ctx = BACKGROUND_CONTEXT;
const received: { method: string; path: string; headers: Headers; body: string }[] = [];
const PAGE = `<!doctype html><html><head><title>Docs &amp; notes</title><style>.hidden{}</style><script>var secret = 1;</script></head>
<body><h1>Welcome</h1><p>Read the <a href="/guide">guide&nbsp;here</a> or <a href="https://example.org/x">elsewhere</a>.</p>
<p>Fish &amp; chips &#8212; <a href="#top">top</a> <a href="javascript:void(0)">nothing</a></p><ul><li>one</li><li>two</li></ul>
<table><tr><th>name</th><th>size</th></tr><tr><td>a.txt</td><td>3</td></tr></table></body></html>`;

const web = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    received.push({ method: request.method, path: url.pathname, headers: request.headers, body: await request.text() });
    switch (url.pathname) {
      case "/page":
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      case "/data":
        return Response.json({ name: "pikit", tags: ["a", "b"] });
      case "/image":
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { headers: { "content-type": "image/png" } });
      case "/plain":
        return new Response("just text", { headers: { "content-type": "text/plain" } });
      case "/untyped-binary":
        return new Response(new Uint8Array([1, 2, 0, 3]));
      case "/large":
        return new Response("x".repeat(3000), { headers: { "content-type": "text/plain" } });
      case "/huge":
        return new Response("y".repeat(FETCH_MAX_OUTPUT + 10_000), { headers: { "content-type": "text/plain" } });
      case "/moved":
        return Response.redirect(new URL("/plain", request.url).href, 302);
      case "/echo":
        return Response.json({ method: request.method, body: received.at(-1)?.body });
      case "/missing":
        return new Response("no such thing", { status: 404, headers: { "content-type": "text/plain" } });
      case "/slow":
        return new Promise<Response>(() => {}); // never answers
      default:
        return new Response("?", { status: 400 });
    }
  },
});
const origin = `http://127.0.0.1:${web.port}`;
afterAll(() => web.stop(true));

/** Runs one call; a failure rejects, as pi-durable sees it before making the error result. */
async function run(args: Record<string, unknown>, tool: ToolRegistration = createFetchTool(), context: Context = ctx): Promise<string> {
  const result = await tool.execute(args as never, {} as ToolExecutionApi, context);
  return (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

test("the tool fetch, replay unsafe, whose description asks to confirm what is not a GET", () => {
  const tool = createFetchTool();
  expect([tool.name, tool.replay]).toEqual(["fetch", "unsafe"]);
  expect(tool.description).toContain("wait for their confirmation");
  expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["url", "method", "headers", "body", "raw"]);
});

test("an HTML page comes back as its title, readable text and absolute links, without head or scripts", async () => {
  const text = await run({ url: `${origin}/page` });

  expect(text).toStartWith(`HTTP 200 OK · text/html; charset=utf-8 · ${origin}/page`);
  expect(text).toContain("# Docs & notes");
  expect(text).toContain("Welcome\nRead the guide here or elsewhere.");
  expect(text).toContain("Fish & chips \u2014 top nothing");
  expect(text).toContain("one\ntwo");
  expect(text).toContain("name size\na.txt 3");
  expect(text).toContain(`Links:\n- guide here: ${origin}/guide\n- elsewhere: https://example.org/x`);
  expect(text).not.toContain("var secret");
  expect(text).not.toContain(".hidden");
  expect(text).not.toContain("#top");
  expect(text).not.toContain("javascript:");
});

test("raw: true gives the HTML as it is", async () => {
  expect(await run({ url: `${origin}/page`, raw: true })).toContain("<script>var secret = 1;</script>");
});

test("JSON comes back pretty-printed; other text as it is; an error status is reported, not thrown", async () => {
  expect(await run({ url: `${origin}/data` })).toEndWith(`\n\n${JSON.stringify({ name: "pikit", tags: ["a", "b"] }, null, 2)}`);
  expect(await run({ url: `${origin}/plain` })).toEndWith("\n\njust text");
  expect(await run({ url: `${origin}/missing` })).toStartWith("HTTP 404 Not Found");
});

test("binary content is refused, by its content type or by its bytes when it has none", async () => {
  const typed = await run({ url: `${origin}/image` });
  expect(typed).toContain("(binary content, 8 bytes: not shown");
  expect(typed).not.toContain("PNG");
  expect(await run({ url: `${origin}/untyped-binary` })).toContain("binary content");
});

test("redirects are followed, and the answer names where it ended", async () => {
  expect(await run({ url: `${origin}/moved` })).toStartWith(`HTTP 200 OK · text/plain · ${origin}/plain`);
});

test("POST sends its body and headers; HEAD returns the status and headers; no credential of its own is sent", async () => {
  const posted = await run({ url: `${origin}/echo`, method: "POST", headers: { "content-type": "application/json", "x-trace": "7" }, body: '{"a":1}' });
  const request = received.at(-1);
  const head = await run({ url: `${origin}/plain`, method: "HEAD" });

  expect(posted).toContain('"method": "POST"');
  expect(posted).toContain('"body": "{\\"a\\":1}"');
  expect(request?.headers.get("x-trace")).toBe("7");
  expect(request?.headers.get("user-agent")).toStartWith("pikit-fetch");
  expect(request?.headers.get("authorization")).toBeNull();
  expect(request?.headers.get("cookie")).toBeNull();
  expect(head).toStartWith("HTTP 200 OK · text/plain");
  expect(head).toContain("content-type: text/plain");
});

test("it refuses what is not http(s), a method it does not allow, and a body on a GET", async () => {
  await expect(run({ url: "file:///etc/passwd" })).rejects.toThrow("only http:// and https://");
  await expect(run({ url: "not a url" })).rejects.toThrow("is not a URL");
  await expect(run({ url: `${origin}/plain`, method: "TRACE" })).rejects.toThrow("the method TRACE is not allowed");
  await expect(run({ url: `${origin}/plain`, body: "x" })).rejects.toThrow("a GET request has no body");
});

test("it reads at most its limit of the body, and says so; the model gets at most FETCH_MAX_OUTPUT characters", async () => {
  const text = await run({ url: `${origin}/large` }, createFetchTool({ maxBytes: 1000 }));
  expect(text).toContain("(only the first 1000 bytes were read)");
  expect(text).toEndWith(`\n\n${"x".repeat(1000)}`);

  const huge = await run({ url: `${origin}/huge` });
  expect(huge).toMatch(/\n\n\(\u2026 \d+ more characters not shown\)$/);
  expect(huge.length).toBeLessThan(FETCH_MAX_OUTPUT + 100);
});

test("it gives up at its timeout, and stops when the call is cancelled", async () => {
  await expect(run({ url: `${origin}/slow` }, createFetchTool({ timeoutMs: 200 }))).rejects.toThrow(`127.0.0.1:${web.port} did not answer within 0.2 s`);

  const controller = new AbortController();
  const pending = run({ url: `${origin}/slow` }, createFetchTool(), withAbortSignal(controller.signal, ctx));
  setTimeout(() => controller.abort(new Error("cancelled")), 50);
  await expect(pending).rejects.toThrow("cancelled");
});

test("in a Harness turn: the model reads a page, and a refused URL is an error result it can read", async () => {
  const results = await runToolCalls({
    tools: [createFetchTool()],
    calls: [
      { name: "fetch", args: { url: `${origin}/plain` } },
      { name: "fetch", args: { url: "file:///etc/passwd" } },
      // The schema refuses a method outside the list before the tool runs.
      { name: "fetch", args: { url: `${origin}/plain`, method: "TRACE" } },
    ],
  });

  expect(results.map((r) => [r.name, r.isError])).toEqual([
    ["fetch", false],
    ["fetch", true],
    ["fetch", true],
  ]);
  expect(results[0]?.text).toEndWith("just text");
  expect(results[1]?.text).toContain("only http:// and https://");
});
