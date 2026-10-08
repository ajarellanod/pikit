/**
 * The dashboard template (`registry/dashboard/files/`, copied to a project's `src/dashboard/` by
 * `pikit ui on`) keeps what SPEC §5 asks of it. Building it needs its npm packages, so it is built by
 * hand (`bun install && bun run build` in that folder); these checks need nothing.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssets, type DashboardFiles } from "../registry/components/admin-api/files/src/pikit/admin-api/assets.ts";
import { assistantName } from "../registry/dashboard/files/src/lib/names.ts";
import { imagesOf, sourcesOf } from "../registry/dashboard/files/src/views/conversations/sources.ts";
import { INITIAL, type LiveState, reduce } from "../registry/dashboard/files/src/views/conversations/live-state.ts";
import { generated, OUTPUT } from "./ui-registry.ts";

const REPO = join(import.meta.dir, "..");
const DASHBOARD = join(REPO, "registry/dashboard/files");
const read = (path: string) => readFileSync(join(DASHBOARD, path), "utf8");

test("the dashboard's copy of the admin API's types is admin-api's api.ts, byte for byte", () => {
  const original = readFileSync(join(REPO, "registry/components/admin-api/files/src/pikit/admin-api/api.ts"), "utf8");

  expect(read("src/lib/admin-api.ts")).toBe(original);
});

/** Each `export interface` / `export type` of `text` by name, its comments left out and its spacing normalized. */
function declarations(text: string): Map<string, string> {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = new Map<string, string>();
  for (const match of code.matchAll(/export (interface|type) (\w+)/g)) {
    let depth = 0;
    let end = match.index;
    for (; end < code.length; end++) {
      const char = code[end];
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0 && match[1] === "interface") break;
      else if (char === ";" && depth === 0 && match[1] === "type") break;
    }
    found.set(match[2] as string, code.slice(match.index, end + 1).replace(/\s+/g, " ").replace(/;\s*}/g, " }").replace(/{\s+/g, "{ "));
  }
  return found;
}

test("admin-proposals' view keeps the proposals contract's shapes and its api.ts' bodies as its types.ts", () => {
  const component = join(REPO, "registry/components/admin-proposals");
  const sources = new Map([
    ...declarations(readFileSync(join(REPO, "packages/contracts/src/proposals.ts"), "utf8")),
    ...declarations(readFileSync(join(component, "files/src/pikit/admin-proposals/api.ts"), "utf8")),
  ]);
  const copy = declarations(readFileSync(join(component, "view/types.ts"), "utf8"));

  for (const name of ["ProposalList", "ProposalDetail", "ProposalsStatus", "ApproveBody", "ApproveResponse"]) expect(copy.has(name)).toBe(true);
  for (const [name, declaration] of copy) expect([name, declaration]).toEqual([name, sources.get(name) ?? "missing"]);
});

test("its npm packages are pinned to exact versions, so every project builds the same dashboard", () => {
  const manifest = JSON.parse(read("package.json")) as Record<string, Record<string, string> | undefined>;
  const ranges = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version));

  expect(ranges).toEqual([]);
  expect(existsSync(join(DASHBOARD, "bun.lock"))).toBe(true);
});

test("every view is a folder of src/views/ with an index.tsx that defines it under its own name", () => {
  const views = readdirSync(join(DASHBOARD, "src/views"));

  expect(views.length).toBeGreaterThan(0);
  for (const view of views) {
    expect(read(`src/views/${view}/index.tsx`)).toContain(`id: "${view}"`);
  }
});

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A project's src/ with the template's embed step and a built dist/, and admin-api's folder when `withAdminApi`. */
function builtProject(withAdminApi: boolean): string {
  const src = mkdtempSync(join(realpathSync(tmpdir()), "pikit-embed-"));
  temps.push(src);
  cpSync(join(DASHBOARD, "scripts"), join(src, "dashboard", "scripts"), { recursive: true });
  mkdirSync(join(src, "dashboard", "dist", "assets"), { recursive: true });
  writeFileSync(join(src, "dashboard", "dist", "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(src, "dashboard", "dist", "assets", "index-abc.js"), "console.log('é')");
  writeFileSync(join(src, "dashboard", "dist", "favicon.ico"), new Uint8Array([0, 159, 255]));
  if (withAdminApi) mkdirSync(join(src, "pikit", "admin-api"), { recursive: true });
  return src;
}

async function embed(src: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, join(src, "dashboard", "scripts", "embed.ts")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: out + err };
}

test("its build's last step writes dist/ into admin-api's dashboard-files.ts, which admin-api serves byte for byte", async () => {
  const src = builtProject(true);
  expect(read("package.json")).toContain('"build": "tsc -b && vite build && bun scripts/embed.ts"');

  const first = await embed(src);
  expect(first).toMatchObject({ code: 0 });
  expect(first.out).toContain("embed: 3 files into");
  const module = join(src, "pikit", "admin-api", "dashboard-files.ts");
  const { DASHBOARD_FILES } = (await import(module)) as { DASHBOARD_FILES: DashboardFiles };
  expect(Object.keys(DASHBOARD_FILES)).toEqual(["assets/index-abc.js", "favicon.ico", "index.html"]);

  const assets = createAssets(DASHBOARD_FILES);
  expect(await assets.serve("/admin/conversations/x").text()).toContain("id=root");
  expect(await assets.serve("/admin/assets/index-abc.js").text()).toBe("console.log('é')");
  expect([...new Uint8Array(await assets.serve("/admin/favicon.ico").arrayBuffer())]).toEqual([0, 159, 255]);

  // Built again with nothing changed, the module is left as it was.
  const again = await embed(src);
  expect(again.out).toContain("is up to date (3 files)");
});

test("without admin-api next to it, the build makes dist/ only", async () => {
  const src = builtProject(false);

  expect(await embed(src)).toMatchObject({ code: 0, out: expect.stringContaining("admin-api is not installed") });
  expect(existsSync(join(src, "pikit"))).toBe(false);
});

test("it is served under /admin/ and its primitives are attributed", () => {
  expect(read("vite.config.ts")).toContain('base: "/admin/"');
  expect(read("NOTICE")).toContain("shadcn/ui");
  expect(read("NOTICE")).toContain("MIT");
  expect(read("NOTICE")).toContain("Beautiful UI");
  expect(read("NOTICE")).toContain("Copyright (c) 2026 Shane Levine");
  expect(read("NOTICE")).toContain("iconoir");
});

test("it keeps the Content-Security-Policy: no inline script, every asset a file, no paid icon set", () => {
  const html = read("index.html");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];

  expect(scripts.length).toBeGreaterThan(0);
  for (const [, attributes = "", body = ""] of scripts) {
    expect(attributes).toContain("src=");
    expect(body.trim()).toBe("");
  }
  // The theme before the first paint is a file of public/, not an inline script.
  expect(html).toContain('<script src="/admin/theme.js"></script>');
  expect(existsSync(join(DASHBOARD, "public/theme.js"))).toBe(true);
  // A font inlined as a data: URI is refused by `font-src 'self'`.
  expect(read("vite.config.ts")).toContain("assetsInlineLimit: 0");
  expect(read("package.json")).not.toContain("@central-icons-react");
});

test("the @pikit shadcn registry (registry/ui/r/) is what scripts/ui-registry.ts generates from the sources", () => {
  const files = generated();

  for (const [name, text] of files) expect({ name, text: readFileSync(join(OUTPUT, name), "utf8") }).toEqual({ name, text });
  expect(readdirSync(OUTPUT).sort()).toEqual([...files.keys()].sort());
  expect((JSON.parse(read("components.json")) as { registries: Record<string, string> }).registries["@pikit"]).toContain("registry/ui/r/{name}.json");
});

test("the Context panel reads a transcript's sources as the websearch and fetch tools write them, and leaves out what does not parse", () => {
  const search = [
    "1. Bun \u2014 a fast runtime (2 days ago)\n   https://bun.sh/\n   Bun is a fast JavaScript runtime.",
    "2. No address\n   not-a-url\n   left out",
    "3. Cloudflare Durable Objects\n   https://developers.cloudflare.com/durable-objects/",
  ].join("\n\n");
  const page = "HTTP 200 OK \u00b7 text/html; charset=utf-8 \u00b7 https://example.com/\n\n# Example Domain\n\nThis domain is for examples.\n\nLinks:\n- More: https://iana.org/";
  const messages = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }], timestamp: 5 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "websearch", arguments: { query: "bun" } }, { type: "toolCall", id: "c2", name: "fetch", arguments: { url: "https://example.com" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "websearch", content: [{ type: "text", text: search }] },
    { role: "toolResult", toolCallId: "c2", toolName: "fetch", content: [{ type: "text", text: page }] },
    // A failed call, another tool, a result that is not the tool's text: none is a source.
    { role: "toolResult", toolCallId: "c3", toolName: "fetch", content: [{ type: "text", text: "fetch: HTTP 500" }], isError: true },
    { role: "toolResult", toolCallId: "c4", toolName: "read", content: [{ type: "text", text: "1. a\n   https://x.test/" }] },
    { role: "toolResult", toolCallId: "c5", toolName: "fetch", content: [{ type: "text", text: "garbage" }] },
    { role: "toolResult", toolCallId: "c6", toolName: "websearch", content: "not a list" },
  ];

  expect(imagesOf(messages)).toEqual([{ key: "0:1", mimeType: "image/png", data: "iVBORw0KGgo=", at: 5 }]);
  expect(sourcesOf(messages).map(({ title, href, body, badge, meta }) => ({ title, href, body, badge, meta }))).toEqual([
    { title: "Bun \u2014 a fast runtime (2 days ago)", href: "https://bun.sh/", body: "Bun is a fast JavaScript runtime.", badge: "WEB", meta: "result 1" },
    { title: "Cloudflare Durable Objects", href: "https://developers.cloudflare.com/durable-objects/", body: "", badge: "WEB", meta: "result 3" },
    { title: "Example Domain", href: "https://example.com/", body: "This domain is for examples.", badge: "HTML", meta: "28 characters" },
  ]);
});

test("an assistant is shown by its words, the first capitalized; its stored name stays as it is", () => {
  expect(["assistant", "support-bot", "sales_helper-v2", "Ops", "a--b", "-"].map(assistantName)).toEqual(["Assistant", "Support bot", "Sales helper v2", "Ops", "A b", "-"]);
});

test('the "/" menu lists only the commands the App registered; titles are the API\'s, never kept or looked for in the browser', () => {
  const composer = read("src/views/conversations/composer.ts");
  const promptBar = read("src/components/bui/PromptBar.tsx");
  const chats = read("src/lib/chats.tsx");
  // No command of the dashboard's own: its actions are buttons.
  expect(composer).not.toContain("composerCommands");
  expect(promptBar).not.toMatch(/control\?: "image"/);
  for (const page of ["src/views/conversations/home.tsx", "src/views/conversations/conversation.tsx"]) expect(read(page)).toContain("commands={commands ?? []}");
  expect(read("src/app.tsx")).toContain('useApi<ApiCommands>("/commands")');
  expect(promptBar).toContain('"No commands"');
  // Titles: the API's, no localStorage of them, no transcript read to name a chat.
  expect(chats).not.toContain("pikit-titles");
  expect(chats).not.toContain("/transcript");
  expect(chats).toContain("conversation.title");
});

test("an answer that ended between two polled snapshots (Cloudflare) stays as last seen; one that ended with its event is its entry", () => {
  const partial = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: 7 });
  const snapshot = (fields: Record<string, unknown>) => ({ type: "event" as const, event: { type: "snapshot", ...fields } });
  const fold = (events: Parameters<typeof reduce>[1][]): LiveState => events.reduce(reduce, INITIAL);

  // Polled: the next snapshot no longer has the answer, and the transcript is not read again yet.
  const polled = fold([snapshot({ run: {}, generation: { message: partial("Hel") } }), snapshot({})]);
  expect(polled.busy).toBe(false);
  expect(polled.partial).toBeUndefined();
  expect(polled.ended).toEqual([partial("Hel")]);
  // The same answer, still written: not ended.
  expect(fold([snapshot({ run: {}, generation: { message: partial("Hel") } }), snapshot({ run: {}, generation: { message: partial("Hello") } })]).ended).toEqual([]);

  // Streamed: its end brings the entry, as the transcript will give it.
  const streamed = fold([
    snapshot({ run: {} }),
    { type: "event", event: { type: "message_start", message: partial("") } },
    { type: "event", event: { type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "Hello" }] } },
    { type: "event", event: { type: "message_end", entry: { id: 12, kind: "message", model: [partial("Hello")] } } },
  ]);
  expect(streamed.partial).toBeUndefined();
  expect(streamed.ended).toEqual([]);
  expect(streamed.entries).toEqual([{ id: "12", kind: "message", messages: [partial("Hello")] }]);
});
