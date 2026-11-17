/**
 * Acceptance: projects end to end on a server, with the real components (features/projects.md). Each
 * component was built against doubles of the others; here they meet only through the kit's contracts,
 * and this test is the only file that names them all:
 *
 * - channel-web's routes (the page's API, a user's session from its accounts double), its chats run by
 *   runtime-pi on a SQLite file, the model provider-faux's `faux/scripted` (`call: <tool> <json>`,
 *   `echo-system <section>`, `echo-tools`);
 * - projects-sql (the project store: an index actor and an actor per project, over mailbox-local);
 * - memory-sql, memory-recall (`project_note`, `project_rule` in a project's space) and memory-summaries;
 * - tool-space-files (`space.files`, `project_file_save`), its bytes in storage-blob-fs, each chat's
 *   workspace execution-local's and workspace-local's;
 * - projects-context (the `<project>` section, `project_search`, `project_read`, `project_link`);
 * - conversations-kv over storage-kv-sql (each chat's space recorded), wakeups on the test's clock.
 *
 * Doubles: the accounts (channel-web's, a session a cookie), `principals` (a directory linking a
 * person's identities), the router (every message to `assistant`) and the operator's `admin.auth`.
 *
 * What it proves, through the page's routes and the model's own requests: a project made, a member
 * added, its instructions and a core document set; a chat started in it sees one section, `<project>`
 * (instructions, the document, the rules with their source), and only the project's tools (each
 * extension's `offerTools`); the agent's note, rule, file and link each said "Added to the project",
 * shown in the chat's notices, found by `project_search` (federated over the three stores) and read by
 * `project_read`; History merges the three logs; a member restores a removed note and a document's
 * version exactly; a non-member gets `404` everywhere with nothing read; a removed member's writes
 * stop; the project's quiet chats are summarized into its memory and found by `project_search`; outside
 * a project the plain memory and files tools are offered, the project's are not.
 *
 * A repository test: it imports the components' files from `registry/`, as their own `app.test.ts`
 * files do; no component's files import another's (SPEC P4).
 */

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { compareHttpRoutes, defineAgent, type HttpRoute, matchesHttpRoute, parseHttpRouteKey } from "@pikit/contracts";
import { createMemoryWakeups } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import type {
  ChatChange,
  ChatDocument,
  ChatDocumentRead,
  ChatMemory,
  ChatMemoryItem,
  ChatNotices,
  ChatPage,
  ChatProject,
  ChatProjectOverview,
  ChatStartResponse,
} from "../../registry/components/channel-web/files/src/pikit/channel-web/api.ts";
import { createChannelWeb, NAME as CHANNEL_WEB } from "../../registry/components/channel-web/files/src/pikit/channel-web/index.ts";
import { FakePrincipals } from "../../registry/components/channel-web/files/src/pikit/channel-web/projects.test-support.ts";
import { adminAuth, FakeAccounts, router, secretsOf } from "../../registry/components/channel-web/files/src/pikit/channel-web/runtime.test-support.ts";
import conversationsKv from "../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import executionLocal from "../../registry/components/execution-local/files/src/pikit/execution-local/index.ts";
import mailboxLocal from "../../registry/components/mailbox-local/files/src/pikit/mailbox-local/index.ts";
import memoryRecall from "../../registry/components/memory-recall/files/src/pikit/memory-recall/index.ts";
import memorySql from "../../registry/components/memory-sql/files/src/pikit/memory-sql/index.ts";
import memorySummaries from "../../registry/components/memory-summaries/files/src/pikit/memory-summaries/index.ts";
import projectsContext from "../../registry/components/projects-context/files/src/pikit/projects-context/index.ts";
import projectsSql from "../../registry/components/projects-sql/files/src/pikit/projects-sql/index.ts";
import providerFaux from "../../registry/components/provider-faux/files/src/pikit/provider-faux/index.ts";
import runtimePi from "../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageBlobFs from "../../registry/components/storage-blob-fs/files/src/pikit/storage-blob-fs/index.ts";
import storageKvSql from "../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolSpaceFiles from "../../registry/components/tool-space-files/files/src/pikit/tool-space-files/index.ts";
import workspaceLocal from "../../registry/components/workspace-local/files/src/pikit/workspace-local/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const API = "/chat/api";
const PAGE = "https://agents.example.com/chat/#/projects/{id}";
/** The agent of every chat: it names the three extensions a project's agent uses. */
const assistant = defineAgent({ name: "assistant", model: "faux/scripted", extensions: ["project", "memory", "space-files"] });

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

/** The App, started, and the page's API as each user calls it. */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-projects-e2e-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "workspace");
  const clock = createManualClock(Date.now());
  const accounts = new FakeAccounts();
  for (const id of ["ana", "ben", "cy"]) accounts.add(id);
  const principals = new FakePrincipals();
  // Ana's Google Chat identity is hers too: her web session's caller carries both.
  principals.link("ana@example.com", { channel: "web", id: "ana" }, { channel: "googlechat", id: "users/ana" });

  const results: Result[] = [];
  let routes: { get(key: string): HttpRoute | undefined; keys(): string[] } | undefined;
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      pikit.on("agent.settled", (result) => void results.push(result));
      pikit.on("agent.failed", (result) => void results.push(result));
      return { start: () => void (routes = handle) };
    },
  });
  const extras = defineComponent({
    name: "e2e-test",
    setup(pikit) {
      pikit.provideKeyed("agent.definition", assistant.name, assistant);
      pikit.provide("principals", principals);
    },
  });
  const components = [
    sqliteStorage(join(dir, "pikit.db")),
    storageKvSql,
    mailboxLocal,
    createMemoryWakeups(),
    secretsOf(),
    adminAuth,
    router,
    extras,
    providerFaux,
    runtimePi,
    conversationsKv,
    executionLocal,
    workspaceLocal,
    storageBlobFs,
    projectsSql,
    memorySql,
    memoryRecall,
    memorySummaries,
    toolSpaceFiles,
    projectsContext,
    createChannelWeb({ accounts: accounts.wiring() }),
    observer,
  ];
  const config = {
    [CHANNEL_WEB]: { agents: ["assistant"] },
    "execution-local": { root },
    "storage-blob-fs": { root: join(dir, "blobs") },
    "memory-summaries": { model: "faux/echo", agents: ["assistant"], idleMinutes: 30 },
    "memory-recall": { freshMs: 0, noProjectMs: 0 },
    "tool-space-files": { freshMs: 0, noProjectMs: 0 },
    "projects-context": { freshMs: 0, noProjectMs: 0, pageUrl: PAGE },
    "projects-sql": { coreTokens: 4_000 },
  };
  const app = await defineApp({ components, config, clock, logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());

  /** A request served as a server serves it: the most specific matching route. */
  const fetch = async (path: string, init: RequestInit): Promise<Response> => {
    const request = new Request(`http://pikit.test${path}`, init);
    const { pathname } = new URL(request.url);
    const key = (routes?.keys() ?? [])
      .map((each) => ({ each, parsed: parseHttpRouteKey(each) }))
      .filter((r) => r.parsed !== undefined && matchesHttpRoute(r.parsed, request.method, pathname))
      .sort((a, b) => compareHttpRoutes(a.parsed!, b.parsed!))[0]?.each;
    if (key === undefined) return new Response("not found", { status: 404 });
    return routes!.get(key)!(request, app.context(BACKGROUND_CONTEXT));
  };

  /** `method path` as `user` (JSON, or bytes with their type): its status and body. */
  const call = async <T = unknown>(user: string, method: string, path: string, body?: unknown, type?: string): Promise<{ status: number; body: T }> => {
    // A second between requests: each change its own time, as History orders them.
    await clock.advance(1_000);
    const headers: Record<string, string> = { ...FakeAccounts.session(user), "x-pikit-chat": "1", "content-type": type ?? "application/json" };
    const payload = body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body);
    const response = await fetch(`${API}${path}`, { method, headers, ...(payload !== undefined && { body: payload }) });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      // Bytes (a download).
    }
    return { status: response.status, body: parsed as T };
  };
  /** As `call`, expecting `status` (201 for a POST that makes something, else 200). */
  const ok = async <T>(user: string, method: string, path: string, body?: unknown, status = 200, type?: string): Promise<T> => {
    const answered = await call<T>(user, method, path, body, type);
    expect({ method, path, status: answered.status, body: answered.status === status ? "ok" : answered.body }).toEqual({ method, path, status, body: "ok" });
    return answered.body;
  };

  /** The answer of request `requestId` once its run settled (the clock moved on while it runs). */
  const answer = async (requestId: string): Promise<string> => {
    for (let i = 0; i < 2000; i++) {
      const result = results.find((r) => r.requestIds?.includes(requestId) ?? r.requestId === requestId);
      if (result !== undefined) return result.kind === "completed" ? (result.text ?? "") : `${result.kind}: ${result.error?.message}`;
      await clock.advance(0);
      await Bun.sleep(1);
    }
    throw new Error(`no answer to ${requestId}`);
  };

  /** `user` starts a chat (in `project`, when given) with `text`: its chat id and the answer. */
  const start = async (user: string, text: string, project?: string): Promise<{ chat: string; answer: string }> => {
    const made = await ok<ChatStartResponse>(user, "POST", "/conversations", { text, ...(project !== undefined && { project }) }, 201);
    return { chat: made.id, answer: await answer(made.requestId) };
  };
  /** `user` says `text` in their chat `chat`: the answer. */
  const say = async (user: string, chat: string, text: string): Promise<string> => {
    const sent = await ok<{ requestId: string }>(user, "POST", `/conversations/${chat}/messages`, { text }, 202);
    return answer(sent.requestId);
  };
  /** Writes `bytes` at `path` in the workspace of `user`'s chat `chat` (workspace-local's directory of its key). */
  const workspaceWrite = (user: string, chat: string, path: string, bytes: string) => {
    const workspace = join(root, "agents", assistant.name, "_chats", createHash("sha256").update(`web:${user}:${chat}`).digest("hex"));
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, path), bytes);
  };

  return { app, clock, accounts, call, ok, start, say, workspaceWrite };
}

const call = (tool: string, args: Record<string, unknown>) => `call: ${tool} ${JSON.stringify(args)}`;

test("a project end to end: made on the page, its chat's agent sees it and adds to it, History, undo, members", async () => {
  const w = await world();

  // Ana makes the project, adds Ben, writes its instructions and a core document.
  const project = await w.ok<ChatProject>("ana", "POST", "/projects", { name: "AECC 2027", description: "The client's launch" }, 201);
  const P = `/projects/${project.id}`;
  await w.ok("ana", "POST", `${P}/members`, { email: "ben@example.com" }, 201);
  await w.ok("ana", "PUT", `${P}/instructions`, { text: "Answer the client formally.", ifVersion: 0 });
  const brief = await w.ok<ChatDocument>("ana", "POST", `${P}/documents`, { title: "Brief 2027", mode: "core", text: "The brief: a launch in Valencia, for 300 guests." }, 201);
  expect(brief).toMatchObject({ mode: "core", version: 1 });
  // The budget is the store's (projects-sql's coreTokens), as the page shows it and refuses past it.
  expect((await w.ok<{ coreBudget: number }>("ana", "GET", `${P}/documents`)).coreBudget).toBe(4_000);
  expect((await w.call<{ error: string; message: string }>("ana", "POST", `${P}/documents`, { title: "Big", mode: "core", text: "x".repeat(16_000) })).body).toMatchObject({ error: "limit", message: expect.stringContaining("of the 4000 tokens") });

  // Ben starts a chat in it: the project's tools only, and its one section.
  const { chat, answer: tools } = await w.start("ben", "echo-tools", project.id);
  expect(tools).toBe("project_file_get, project_file_save, project_link, project_note, project_read, project_rule, project_search, propose_preference");
  const section = await w.say("ben", chat, "echo-system project");
  expect(section).toStartWith(`<project>\nYou work in the project "AECC 2027" (${project.id}),`);
  expect(section).toContain("Answer the client formally.");
  expect(section).toMatch(new RegExp(`<document id="${brief.id}" title="Brief 2027" version="1" updated="[0-9-]+" by="ana">\\nThe brief: a launch in Valencia, for 300 guests\\.\\n</document>`));
  expect(section).toContain(`https://agents.example.com/chat/#/projects/${project.id}`);
  for (const other of ["memory", "space-files"]) expect(await w.say("ben", chat, `echo-system ${other}`)).toBe(`(no section ${other})`);

  // The agent adds a note, a rule, a file and a link: each says so.
  const added = async (text: string) => (await w.say("ben", chat, text)).split("\n").at(-1);
  expect(await added(call("project_note", { note: "Juan visits Valencia on Tuesdays" }))).toBe("Added to the project: Juan visits Valencia on Tuesdays");
  expect(await added(call("project_rule", { rule: "Quote prices for Valencia in EUR" }))).toBe("Added to the project: Quote prices for Valencia in EUR");
  w.workspaceWrite("ben", chat, "venue.md", "The venue in Valencia seats 300 people.");
  expect(await added(call("project_file_save", { path: "venue.md", description: "Venue notes" }))).toBe("Added to the project: venue.md");
  expect(await added(call("project_link", { url: "https://drive.google.com/valencia", title: "Valencia folder" }))).toBe("Added to the project: Valencia folder");

  // The next request's section carries the rule with its source.
  const after = await w.say("ben", chat, "echo-system project");
  expect(after).toMatch(/- Quote prices for Valencia in EUR \(rule:r-[0-9a-f]{8}; added by agent assistant in a web chat, answering ben, \d{4}-\d\d-\d\d\)/);
  expect(after).toContain("- Juan visits Valencia on Tuesdays (note:");
  expect(after).toContain("- venue.md (file:venue.md; 39 B, version 1, by agent assistant in a web chat, answering ben, ");
  expect(after).toContain("- Valencia folder: https://drive.google.com/valencia (link:");

  // One search over the three stores finds each kind; each hit's ref reads.
  const found = (await w.say("ben", chat, call("project_search", { query: "Valencia" }))).replace(/^project_search: /, "");
  const hits = found.split("\n").flatMap((line) => {
    const hit = /^- \[(\w+)\] .* \(((?:\w+)(?::[^;,)]+)?)[;,)]/.exec(line);
    return hit === null ? [] : [{ kind: hit[1] as string, ref: hit[2] as string }];
  });
  expect(new Set(hits.map((hit) => hit.kind))).toEqual(new Set(["document", "rule", "note", "file", "link"]));
  const read = async (item: string) => w.say("ben", chat, call("project_read", { item }));
  const refOf = (kind: string) => hits.find((hit) => hit.kind === kind)?.ref as string;
  expect(await read(refOf("document"))).toContain("The brief: a launch in Valencia, for 300 guests.");
  expect(await read(refOf("note"))).toMatch(/\nJuan visits Valencia on Tuesdays$/);
  expect(await read(refOf("rule"))).toMatch(/\nQuote prices for Valencia in EUR$/);
  expect(await read(refOf("file"))).toMatch(/\nThe venue in Valencia seats 300 people\.$/);
  expect(await read(refOf("link"))).toContain('Link "Valencia folder": https://drive.google.com/valencia');
  expect(await read("instructions")).toMatch(/\nAnswer the client formally\.$/);

  // The chat's notices: what its agent added, from the three logs.
  const notices = await w.ok<ChatNotices>("ben", "GET", `/conversations/${chat}/notices`);
  expect(notices.project).toBe(project.id);
  expect(notices.items.map((item) => [item.log, item.action, item.item.kind, item.item.title, item.by.kind])).toEqual([
    ["project", "added", "link", "Valencia folder", "agent"],
    ["files", "added", "file", "venue.md", "agent"],
    ["memory", "added", "rule", "Quote prices for Valencia in EUR", "agent"],
    ["memory", "added", "note", "Juan visits Valencia on Tuesdays", "agent"],
  ]);

  // History merges the three logs, newest first, each entry with its author.
  const history = await w.ok<ChatPage<ChatChange>>("ana", "GET", `${P}/history?limit=50`);
  expect(new Set(history.items.map((item) => item.log))).toEqual(new Set(["project", "memory", "files"]));
  expect(history.items.map((item) => [item.log, item.item.kind, item.action])).toEqual([
    ["project", "link", "added"],
    ["files", "file", "added"],
    ["memory", "rule", "added"],
    ["memory", "note", "added"],
    ["project", "document", "added"],
    ["project", "instructions", "added"],
    ["project", "member", "added"],
    ["project", "project", "added"],
  ]);
  // The same words added on the page are the agent's rule, kept once (memory's memoryItemId): nothing new in History.
  const same = await w.ok<ChatMemoryItem>("ana", "POST", `${P}/memory`, { kind: "rule", text: "  quote prices for  Valencia in EUR " }, 201);
  expect(same).toMatchObject({ id: refOf("rule").slice("rule:".length), text: "Quote prices for Valencia in EUR", by: { kind: "agent" } });
  expect((await w.ok<ChatPage<ChatChange>>("ana", "GET", `${P}/history?limit=50`)).items).toEqual(history.items);
  const overview = await w.ok<ChatProjectOverview>("ben", "GET", P);
  expect(overview).toMatchObject({ coreBudget: 4_000, documents: 1, links: 1, files: { names: 1 }, memory: { rules: 1, notes: 1, summaries: 0 } });

  // Ben (a member) removes the note, then brings it back from History: the same id, words and author.
  const memory = await w.ok<ChatMemory>("ben", "GET", `${P}/memory`);
  const note = memory.notes[0] as ChatMemoryItem;
  await w.ok("ben", "DELETE", `${P}/memory/${encodeURIComponent(note.id)}`, undefined, 204);
  expect((await w.ok<ChatMemory>("ben", "GET", `${P}/memory`)).notes).toEqual([]);
  const removal = (await w.ok<ChatPage<ChatChange>>("ben", "GET", `${P}/history?limit=1`)).items[0] as ChatChange;
  expect(removal).toMatchObject({ log: "memory", action: "removed", item: { kind: "note", id: note.id }, by: { kind: "person", principal: { channel: "web", id: "ben" } } });
  await w.ok("ben", "POST", `${P}/history/memory/${removal.n}/restore`);
  expect((await w.ok<ChatMemory>("ben", "GET", `${P}/memory`)).notes).toEqual([note]);

  // Ana writes a second version of the brief; Ben brings the first back: version 3, as version 1.
  await w.ok("ana", "PATCH", `${P}/documents/${brief.id}`, { text: "The brief: a launch in Madrid.", ifVersion: 1 });
  const change = (await w.ok<ChatPage<ChatChange>>("ben", "GET", `${P}/history?limit=1`)).items[0] as ChatChange;
  expect(change).toMatchObject({ log: "project", action: "changed", item: { kind: "document", id: brief.id }, version: 2 });
  await w.ok("ben", "POST", `${P}/history/project/${change.n}/restore`);
  const restored = await w.ok<ChatDocumentRead>("ben", "GET", `${P}/documents/${brief.id}`);
  expect(restored.text).toBe("The brief: a launch in Valencia, for 300 guests.");
  expect(restored.document).toMatchObject({ title: "Brief 2027", mode: "core", version: 3 });
  expect(await w.say("ben", chat, "echo-system project")).toContain('version="3"');

  // Cy is no member: 404 on every route, as a project that never existed; nothing changed.
  const before = await w.ok<ChatPage<ChatChange>>("ana", "GET", `${P}/history?limit=100`);
  for (const [method, path, body] of [
    ["GET", P],
    ["PATCH", P, { name: "Mine" }],
    ["GET", `${P}/members`],
    ["POST", `${P}/members`, { email: "cy@example.com" }],
    ["GET", `${P}/instructions`],
    ["PUT", `${P}/instructions`, { text: "Theirs", ifVersion: 1 }],
    ["GET", `${P}/documents`],
    ["GET", `${P}/documents/${brief.id}`],
    ["GET", `${P}/files`],
    ["GET", `${P}/files/venue.md`],
    ["GET", `${P}/memory`],
    ["POST", `${P}/memory`, { kind: "rule", text: "Answer in French" }],
    ["DELETE", `${P}/memory/${encodeURIComponent(note.id)}`],
    ["GET", `${P}/links`],
    ["GET", `${P}/history`],
    ["POST", `${P}/history/memory/1/restore`],
    ["POST", `${P}/history/project/1/restore`],
    ["GET", `${P}/conversations`],
    ["GET", `${P}/conversations/${chat}/transcript`],
  ] as [string, string, unknown?][]) {
    expect({ method, path, status: (await w.call("cy", method, path, body)).status }).toEqual({ method, path, status: 404 });
  }
  expect((await w.call("cy", "POST", "/conversations", { text: "hello", project: project.id })).status).toBe(404);
  expect(await w.ok<ChatPage<ChatChange>>("ana", "GET", `${P}/history?limit=100`)).toEqual(before);

  // Ana removes Ben: his writes stop at his next request, his chat with them.
  await w.ok("ana", "DELETE", `${P}/members/${encodeURIComponent("web:ben")}`, undefined, 204);
  for (const [method, path, body] of [
    ["PUT", `${P}/instructions`, { text: "His", ifVersion: 1 }],
    ["POST", `${P}/memory`, { kind: "note", text: "His note" }],
    ["POST", `${P}/links`, { url: "https://example.com/his", title: "His" }],
    ["POST", `${P}/history/memory/1/restore`],
  ] as [string, string, unknown?][]) {
    expect({ method, path, status: (await w.call("ben", method, path, body)).status }).toEqual({ method, path, status: 404 });
  }
  expect((await w.call("ben", "POST", `${P}/files?name=his.md&description=His`, new TextEncoder().encode("his"), "text/markdown")).status).toBe(404);
  expect((await w.call("ben", "POST", `/conversations/${chat}/messages`, { text: "hello" })).status).toBe(403);
  expect(await w.ok<ChatPage<ChatChange>>("ana", "GET", `${P}/history?limit=100`)).toEqual({
    ...before,
    items: [expect.objectContaining({ log: "project", action: "removed", item: expect.objectContaining({ kind: "member" }) }), ...before.items],
  });

  // A chat of the project gone quiet is summarized into the project's memory (memory-summaries), and found with the rest.
  const planning = await w.start("ana", "The Valencia launch plan: radio first", project.id);
  expect(planning.answer).toBe("faux: The Valencia launch plan: radio first");
  await w.clock.advance(31 * 60_000);
  let summaries: ChatMemoryItem[] = [];
  for (let i = 0; i < 200 && summaries.length === 0; i++) {
    await w.clock.advance(0);
    await Bun.sleep(5);
    summaries = (await w.ok<ChatMemory>("ana", "GET", `${P}/memory`)).summaries;
  }
  // Both chats of the project (Ben's, Ana's), each by memory-summaries, in the project's space.
  for (let i = 0; i < 200 && summaries.length < 2; i++) {
    await w.clock.advance(0);
    await Bun.sleep(5);
    summaries = (await w.ok<ChatMemory>("ana", "GET", `${P}/memory`)).summaries;
  }
  expect(summaries.map((each) => each.by)).toEqual([
    { kind: "component", name: "memory-summaries" },
    { kind: "component", name: "memory-summaries" },
  ]);
  const later = (await w.say("ana", planning.chat, call("project_search", { query: "radio" }))).replace(/^project_search: /, "");
  expect(later).toMatch(/^- \[summary\] .*radio/m);

  // Outside a project: memory's and files' own tools, no project_ tool and no <project> section.
  const plain = await w.start("ana", "echo-tools");
  expect(plain.answer).toBe("files_delete, files_get, files_list, files_save, forget, propose_preference, propose_rule, read_memory, recall, remember");
  expect(await w.say("ana", plain.chat, "echo-system project")).toBe("(no section project)");
  expect(await w.say("ana", plain.chat, call("project_note", { note: "x" }))).toStartWith("project_note failed: ");
});
