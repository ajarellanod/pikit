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
import { capitalizeFirst } from "../registry/dashboard/files/src/lib/format.ts";
import { assistantName } from "../registry/dashboard/files/src/lib/names.ts";
import { imagesOf, sourcesOf } from "../registry/dashboard/files/src/lib/sources.ts";
import { INITIAL, type LiveState, reduce } from "../registry/dashboard/files/src/lib/transcript.ts";
import type { ApiPendingPiece, ApiReceipt } from "../registry/dashboard/files/src/lib/admin-api.ts";
import { groupsOf, placeOf, providersOf, summaryOf, usersOf, wiringOf } from "../registry/dashboard/files/src/lib/composition.ts";
import { EMPTY_TALLY, needsAttention, problemsOf, RECENT_MS, STUCK_AFTER_MS, tallyReceipts } from "../registry/dashboard/files/src/lib/delivery.ts";
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

test("channel-web's view keeps the component's admin-api.ts, byte for byte", () => {
  const component = join(REPO, "registry/components/channel-web");

  expect(readFileSync(join(component, "view/admin-api.ts"), "utf8")).toBe(readFileSync(join(component, "files/src/pikit/channel-web/admin-api.ts"), "utf8"));
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
    // An image served by URL (channel-web's chat), and one with neither bytes nor a URL: left out.
    { role: "user", content: [{ type: "image", url: "/chat/api/images/a1" }, { type: "image", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "websearch", arguments: { query: "bun" } }, { type: "toolCall", id: "c2", name: "fetch", arguments: { url: "https://example.com" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "websearch", content: [{ type: "text", text: search }] },
    { role: "toolResult", toolCallId: "c2", toolName: "fetch", content: [{ type: "text", text: page }] },
    // A failed call, another tool, a result that is not the tool's text: none is a source.
    { role: "toolResult", toolCallId: "c3", toolName: "fetch", content: [{ type: "text", text: "fetch: HTTP 500" }], isError: true },
    { role: "toolResult", toolCallId: "c4", toolName: "read", content: [{ type: "text", text: "1. a\n   https://x.test/" }] },
    { role: "toolResult", toolCallId: "c5", toolName: "fetch", content: [{ type: "text", text: "garbage" }] },
    { role: "toolResult", toolCallId: "c6", toolName: "websearch", content: "not a list" },
  ];

  expect(imagesOf(messages)).toEqual([
    { key: "0:1", src: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", at: 5 },
    { key: "1:0", src: "/chat/api/images/a1" },
  ]);
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
  expect(read("src/views/conversations/new-chat.tsx")).toContain("commands={commands ?? []}");
  expect(read("src/views/conversations/conversation.tsx")).toContain("commands: commands ?? []");
  expect(read("src/app.tsx")).toContain('useApi<ApiCommands>("/commands")');
  expect(promptBar).toContain('"No commands"');
  // Titles: the API's, no localStorage of them, no transcript read to name a chat.
  expect(chats).not.toContain("pikit-titles");
  expect(chats).not.toContain("/transcript");
  expect(chats).toContain("conversation.title");
});

test("an answer that ended between two snapshots (a reconnect) stays as last seen; one that ended with its event is its entry", () => {
  const partial = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: 7 });
  const snapshot = (fields: Record<string, unknown>) => ({ type: "event" as const, event: { type: "snapshot", ...fields } });
  const fold = (events: Parameters<typeof reduce>[1][]): LiveState => events.reduce(reduce, INITIAL);

  // Reconnected: the next snapshot no longer has the answer, and the transcript is not read again yet.
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

test("Settings' App section groups the components by what they are for, sums the App up in a line, and shows only the wiring worth a look", () => {
  const component = (name: string, provides: string[] = [], requires: string[] = [], optional: string[] = []) => ({ name, provides, requires, optional });
  const app = {
    version: 1,
    target: "durable",
    components: [
      component("channel-telegram-webhook", ["http.route"], ["agent.runtime"], ["outbound.queue"]),
      component("runtime-pi", ["agent.runtime", "model.complete"], ["storage.sql"], ["workspace"]),
      component("router-basic"),
      component("tool-bash", ["agent.tool"], [], ["workspace"]),
      component("tool-read", ["agent.tool"]),
      component("storage-do", ["storage.sql"]),
      component("storage-memory", ["storage.sql"]),
      component("admin-api", ["http.route"], ["agent.runtime"]),
      component("mystery"),
    ],
    capabilities: {
      "http.route": { providers: ["channel-telegram-webhook", "admin-api"], keys: { "POST /telegram": "channel-telegram-webhook", "GET /admin/api/app": "admin-api" } },
      "agent.runtime": { providers: ["runtime-pi"], selected: "runtime-pi" },
      "agent.tool": { providers: ["tool-bash", "tool-read"] },
      "storage.sql": { providers: ["storage-do", "storage-memory"], selected: "storage-do" },
      "outbound.queue": { providers: [] },
    },
    pipelines: { "route.resolve": [{ id: "project.vip", priority: 10 }, { id: "router-basic.default", priority: 0 }, "odd"], "message.inbound": [] },
    config: {},
  };

  // By what they provide, else by their name's prefix; Other last, each kind by name, no empty kind.
  expect(groupsOf(app.components).map((group) => [group.title, group.components.map((each) => each.name)])).toEqual([
    ["Channels", ["channel-telegram-webhook"]],
    ["Agents and models", ["router-basic", "runtime-pi"]],
    ["Tools", ["tool-bash", "tool-read"]],
    ["Data", ["storage-do", "storage-memory"]],
    ["Dashboard and admin", ["admin-api"]],
    ["Other", ["mystery"]],
  ]);
  expect(placeOf(app.target)).toBe("Cloudflare");
  expect(summaryOf(app, 1)).toBe("Talks on Telegram and this dashboard, with 1 agent and 2 tools: 9 components in all.");
  expect(summaryOf(app, undefined)).toBe("Talks on Telegram and this dashboard, with 2 tools: 9 components in all.");

  // Who gives a capability: its keys' providers, the one selected, or every one; nobody when none is installed.
  expect(providersOf(app, "http.route")).toEqual(["channel-telegram-webhook", "admin-api"]);
  expect(providersOf(app, "storage.sql")).toEqual(["storage-do"]);
  expect(providersOf(app, "agent.tool")).toEqual(["tool-bash", "tool-read"]);
  expect(providersOf(app, "outbound.queue")).toEqual([]);
  expect(usersOf(app, app.components[1] as (typeof app.components)[number])).toEqual(["channel-telegram-webhook", "admin-api"]);

  // A choice is a single capability with several providers: a collection (agent.tool) or a keyed one is not.
  const wiring = wiringOf(app);
  expect(wiring.choices).toEqual([{ capability: "storage.sql", providers: ["storage-do", "storage-memory"], selected: "storage-do" }]);
  expect(wiring.keyed).toEqual([
    { capability: "http.route", key: "GET /admin/api/app", provider: "admin-api" },
    { capability: "http.route", key: "POST /telegram", provider: "channel-telegram-webhook" },
  ]);
  expect(wiring.missing).toEqual([
    { capability: "outbound.queue", wantedBy: ["channel-telegram-webhook"] },
    { capability: "workspace", wantedBy: ["runtime-pi", "tool-bash"] },
  ]);
  // A pipeline with no stage is left out; a stage the API gives otherwise shows as its JSON.
  expect(wiring.pipelines).toEqual([{ name: "route.resolve", stages: [{ id: "project.vip", priority: 10 }, { id: "router-basic.default", priority: 0 }, { id: '"odd"' }] }]);
});

test("a table's states and tags read with a capital first letter, the rest as written; an element is left alone", () => {
  expect(capitalizeFirst("banned")).toBe("Banned");
  expect(capitalizeFirst("possibly twice")).toBe("Possibly twice");
  expect(capitalizeFirst("telegram:support")).toBe("Telegram:support");
  expect(capitalizeFirst("")).toBe("");
  const element = { type: "span" };
  expect(capitalizeFirst(element)).toBe(element);
});

test("Delivery lists answers, not pieces, and only those with a problem: stuck, not delivered, possibly twice; the rest are counted", () => {
  const now = 10 * 60_000;
  const piece = (key: string, index: number, change: Partial<ApiPendingPiece> = {}): ApiPendingPiece => ({
    idempotencyKey: key,
    conversationId: key.slice(0, key.indexOf(":")),
    index,
    channel: "telegram",
    conversationKey: `telegram:${key.split(":")[0]}`,
    state: "queued",
    attempts: 0,
    possibleDuplicate: false,
    storedAt: now - 1_000,
    ...change,
  });
  let cursor = 0;
  const receipt = (key: string, index: number, outcome: ApiReceipt["outcome"], at: number): ApiReceipt => ({
    cursor: String(++cursor),
    idempotencyKey: key,
    conversationId: key.slice(0, key.indexOf(":")),
    index,
    channel: "telegram",
    conversationKey: `telegram:${key.split(":")[0]}`,
    attempts: outcome.kind === "abandoned" ? 3 : 1,
    outcome,
    at,
  });
  const delivered = (possibleDuplicate = false) => ({ kind: "delivered" as const, platformMessageId: "m", possibleDuplicate });

  const pending = [
    // On its way: stored a second ago, never tried.
    piece("1:a", 0),
    // Retrying: stuck at once, whatever its age; its two pieces are one answer.
    piece("2:b", 0, { state: "retrying", attempts: 2, nextAttemptAt: now + 30_000, lastError: "transient: 502", storedAt: now - 20_000 }),
    piece("2:b", 1, { storedAt: now - 20_000 }),
    // Waiting longer than a minute, never tried (no transport): stuck.
    piece("3:c", 0, { storedAt: now - STUCK_AFTER_MS - 1 }),
    // Its first piece was delivered, the second waits: not counted as delivered.
    piece("4:d", 1),
  ];
  // Fed in two reads, as the feed is read on from its cursor.
  let tally = tallyReceipts(EMPTY_TALLY, [receipt("5:e", 0, delivered(), 1_000), receipt("5:e", 1, delivered(), 1_100), receipt("4:d", 0, delivered(), 2_000)]);
  const before = tally;
  tally = tallyReceipts(tally, [
    receipt("6:f", 0, delivered(), 3_000),
    receipt("6:f", 1, { kind: "abandoned", reason: "permanent: bot was blocked by the user" }, 3_100),
    receipt("7:g", 0, { kind: "abandoned", reason: "not delivered within 24 hours" }, 4_000),
    receipt("8:h", 0, delivered(true), 5_000),
    receipt("6:f", 2, { kind: "abandoned", reason: "permanent: bot was blocked by the user" }, 3_200),
  ]);
  expect(before.delivered.size).toBe(2);
  expect(tallyReceipts(tally, [])).toBe(tally);

  const problems = problemsOf(pending, tally, now);
  expect(problems.stuck.map((answer) => [answer.key, answer.retrying, answer.pieces])).toEqual([
    ["3:c", false, 1],
    ["2:b", true, 2],
  ]);
  expect(problems.stuck[1]).toMatchObject({ conversationId: "2", attempts: 2, lastError: "transient: 502", nextAttemptAt: now + 30_000, since: now - 20_000 });
  expect(problems.onTheirWay).toBe(2);
  // The latest given up first, with why, when, and how much of it got through.
  expect(problems.undelivered.map((answer) => [answer.key, answer.reason, answer.abandoned, answer.delivered])).toEqual([
    ["7:g", "not delivered within 24 hours", 1, 0],
    ["6:f", "permanent: bot was blocked by the user", 2, 1],
  ]);
  expect(problems.undelivered[1]?.at).toBe(3_100);
  expect(problems.duplicates.map((answer) => [answer.key, answer.pieces])).toEqual([["8:h", 1]]);
  // Delivered whole: 5:e and 8:h; 4:d still waits, 6:f was cut.
  expect(problems.delivered).toBe(2);
  expect(problems.since).toBe(1_000);

  expect(needsAttention(problems, now)).toBe(true);
  // A day after the last one was given up, with nothing stuck, the dot goes; the page still lists it.
  const later = 4_000 + RECENT_MS + 1;
  const quiet = problemsOf([piece("1:a", 0, { storedAt: later - 1_000 })], tally, later);
  expect(quiet.stuck).toEqual([]);
  expect(quiet.undelivered).toHaveLength(2);
  expect(needsAttention(quiet, later)).toBe(false);
  expect(needsAttention(problemsOf([], EMPTY_TALLY, now), now)).toBe(false);
});
