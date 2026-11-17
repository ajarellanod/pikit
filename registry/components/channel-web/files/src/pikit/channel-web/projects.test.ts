/**
 * channel-web's projects on a server (features/projects.md, "channel-web's routes"): every project route
 * over doubles of `projects`, `space.files`, `memory`, `principals` and `document.convert`
 * (`projects.test-support.ts`), the runtime's and the accounts' doubles and a real `storage.sql`.
 * Each route is checked first for who may not (`401` without a session, `400` without the page's header,
 * `404` for a non-member with nothing read or written, `403` for a member's owner act), then for what it
 * does. Also: History merged across the three logs, a restore routed to its store, a chat started and
 * posted in a project (its space, its agents, its members), the chat's notices from the logs, and the
 * migration of the projects channel-web kept itself (`channel_web_projects`).
 */

import { afterEach, expect, test } from "bun:test";
import { type ComponentDefinition, defineComponent } from "@pikit/core";
import type { Author, ChangePage, SqlDatabase } from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import type {
  ChatChange,
  ChatConfig,
  ChatDocument,
  ChatDocumentRead,
  ChatDocuments,
  ChatFiles,
  ChatInstructions,
  ChatMember,
  ChatMemory,
  ChatMemoryItem,
  ChatNotices,
  ChatPage,
  ChatProject,
  ChatProjectConversation,
  ChatProjectOverview,
  ChatSpaceFile,
  ChatTranscriptEntry,
} from "./api.ts";
import { memberKey } from "./api.ts";
import { keyOf } from "./chat.ts";
import { createChannelWeb, NAME } from "./index.ts";
import { encodeHistoryCursor, mergeHistory, parseHistoryCursor, ruleId } from "./project-routes.ts";
import { type ProjectDoubles, projectDoubles, projectsComponent } from "./projects.test-support.ts";
import { adminAuth, answerOf, FakeAccounts, kvOf, OPERATOR, Runtime, router, type Served, secretsOf, serve } from "./runtime.test-support.ts";

const apps: Served[] = [];
afterEach(async () => {
  for (const served of apps.splice(0)) await served.app.stop();
});

const API = "/chat/api";

interface Chat {
  served: Served;
  runtime: Runtime;
  accounts: FakeAccounts;
  doubles: ProjectDoubles;
  sql: () => SqlDatabase;
}

/** The App with every double, or only those named (`only`: `[]` for no project store at all). */
async function chat(options: { only?: (keyof ProjectDoubles)[]; config?: Record<string, unknown>; components?: ComponentDefinition[]; before?: (sql: SqlDatabase) => Promise<void> } = {}): Promise<Chat> {
  const runtime = new Runtime();
  const accounts = new FakeAccounts();
  for (const id of ["ana", "ben", "cy"]) accounts.add(id);
  const doubles = projectDoubles();
  const given = Object.fromEntries(Object.entries(doubles).filter(([name]) => options.only === undefined || options.only.includes(name as keyof ProjectDoubles)));
  let database: SqlDatabase | undefined;
  const probe = defineComponent({
    name: "sql-probe",
    setup(pikit) {
      const sql = pikit.use("storage.sql");
      return {
        async start() {
          database = sql.get();
          await options.before?.(database);
        },
      };
    },
  });
  const agents = defineComponent({
    name: "agents-test",
    setup(pikit) {
      for (const name of ["assistant", "helper", "secret"]) pikit.provideKeyed("agent.definition", name, { name, model: "test/model" });
    },
  });
  const served = await serve(
    [secretsOf(), runtime.component(), kvOf(), sqliteStorage(), probe, router, agents, adminAuth, projectsComponent(given), ...(options.components ?? []), createChannelWeb({ accounts: accounts.wiring() })],
    { [NAME]: { agents: ["assistant", "helper"], ...options.config } },
  );
  apps.push(served);
  return { served, runtime, accounts, doubles, sql: () => database as SqlDatabase };
}

const as = (user: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...FakeAccounts.session(user), "x-pikit-chat": "1", "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
});
const send = (user: string, method: string, body?: unknown): RequestInit => as(user, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });

/** `method path` as `user`: its status and JSON (or text). */
async function call<T = unknown>(c: Chat, user: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await c.served.fetch(`${API}${path}`, send(user, method, body));
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    // Bytes (a download).
  }
  return { status: response.status, body: parsed as T };
}
async function ok<T>(c: Chat, user: string, method: string, path: string, body?: unknown, status = method === "POST" && !path.endsWith("restore") && !path.endsWith("approve") && !path.endsWith("/owner") ? 201 : 200): Promise<T> {
  const answered = await call<T>(c, user, method, path, body);
  expect({ method, path, status: answered.status, body: answered.status === status ? "ok" : answered.body }).toEqual({ method, path, status, body: "ok" });
  return answered.body;
}

/** `user` makes a project. */
const make = (c: Chat, user: string, name: string, description?: string) => ok<ChatProject>(c, user, "POST", "/projects", { name, ...(description !== undefined && { description }) });
/** `user` starts a chat. */
async function start(c: Chat, user: string, text: string, extra: Record<string, unknown> = {}): Promise<{ id: string; requestId: string }> {
  return ok<{ id: string; requestId: string }>(c, user, "POST", "/conversations", { text, ...extra });
}
/** The space of project `id`, from the store. */
const spaceOf = (c: Chat, id: string): string => c.doubles.projects.ids.get(id) as string;
/** `user` a member of `project`, added by its owner by email. */
const join = (c: Chat, owner: string, project: ChatProject, user: string) => ok<ChatMember>(c, owner, "POST", `/projects/${project.id}/members`, { email: `${user}@example.com` });

/** Every project route, with a body where it takes one. */
function projectRoutes(id: string, chat: string = crypto.randomUUID()): [string, string, unknown?][] {
  return [
    ["GET", `/projects/${id}`],
    ["PATCH", `/projects/${id}`, { name: "x" }],
    ["DELETE", `/projects/${id}`],
    ["GET", `/projects/${id}/members`],
    ["POST", `/projects/${id}/members`, { email: "cy@example.com" }],
    ["DELETE", `/projects/${id}/members/${encodeURIComponent(memberKey({ channel: "web", id: "ana" }))}`],
    ["POST", `/projects/${id}/owner`, { channel: "web", id: "cy" }],
    ["GET", `/projects/${id}/instructions`],
    ["PUT", `/projects/${id}/instructions`, { text: "theirs", ifVersion: 1 }],
    ["GET", `/projects/${id}/instructions/versions`],
    ["GET", `/projects/${id}/documents`],
    ["POST", `/projects/${id}/documents`, { title: "t", mode: "reference", text: "x" }],
    ["POST", `/projects/${id}/documents/upload?title=t&mode=reference`, "x"],
    ["GET", `/projects/${id}/documents/d-1`],
    ["PATCH", `/projects/${id}/documents/d-1`, { title: "x", ifVersion: 1 }],
    ["DELETE", `/projects/${id}/documents/d-1`],
    ["GET", `/projects/${id}/documents/d-1/versions`],
    ["GET", `/projects/${id}/files`],
    ["POST", `/projects/${id}/files?name=a.txt&description=x`, "x"],
    ["GET", `/projects/${id}/files/brief.txt`],
    ["DELETE", `/projects/${id}/files/brief.txt`],
    ["GET", `/projects/${id}/files/brief.txt/versions`],
    ["POST", `/projects/${id}/files/brief.txt/restore`],
    ["GET", `/projects/${id}/memory`],
    ["POST", `/projects/${id}/memory`, { kind: "rule", text: "theirs" }],
    ["PATCH", `/projects/${id}/memory/r-1`, { text: "theirs" }],
    ["DELETE", `/projects/${id}/memory/r-1`],
    ["POST", `/projects/${id}/memory/r-1/approve`],
    ["GET", `/projects/${id}/links`],
    ["POST", `/projects/${id}/links`, { url: "https://example.com", title: "x" }],
    ["DELETE", `/projects/${id}/links/l-1`],
    ["GET", `/projects/${id}/history`],
    ["POST", `/projects/${id}/history/project/1/restore`],
    ["POST", `/projects/${id}/history/memory/1/restore`],
    ["POST", `/projects/${id}/history/files/1/restore`],
    ["GET", `/projects/${id}/conversations`],
    ["GET", `/projects/${id}/conversations/${chat}/transcript`],
  ];
}

test("every project route needs a session (401) and a change the page's header (400), before anything is read", async () => {
  const c = await chat();
  const id = "a".repeat(32);
  for (const [method, path] of [["GET", "/projects"], ["POST", "/projects"], ["GET", `/conversations/${crypto.randomUUID()}/notices`], ...projectRoutes(id)] as [string, string][]) {
    const anonymous = await c.served.fetch(`${API}${path}`, { method, headers: { "x-pikit-chat": "1" }, ...(method !== "GET" && { body: "{}" }) });
    expect({ method, path, status: anonymous.status }).toEqual({ method, path, status: 401 });
    if (method !== "GET") {
      const forged = await c.served.fetch(`${API}${path}`, { method, headers: FakeAccounts.session("ana"), body: "{}" });
      expect({ method, path, status: forged.status }).toEqual({ method, path, status: 400 });
    }
  }
  expect([c.doubles.projects.calls, c.doubles.files.calls, c.doubles.memory.calls]).toEqual([[], [], []]);
});

test("without a project store there are no projects: the config says none, every project route and a chat naming a project are 404, a chat of none works", async () => {
  const c = await chat({ only: [] });
  expect(((await (await c.served.fetch(`${API}/config`)).json()) as ChatConfig).projects).toBeUndefined();
  const id = "a".repeat(32);
  for (const [method, path, body] of [["GET", "/projects"], ["POST", "/projects", { name: "x" }], ...projectRoutes(id)] as [string, string, unknown?][]) {
    expect({ method, path, status: (await call(c, "ana", method, path, body)).status }).toEqual({ method, path, status: 404 });
  }
  expect((await call(c, "ana", "POST", "/conversations", { text: "x", project: id })).status).toBe(404);
  expect((await call(c, "ana", "GET", `/conversations?project=${id}`)).status).toBe(404);
  const { id: chatId } = await start(c, "ana", "no project");
  expect(await ok<ChatNotices>(c, "ana", "GET", `/conversations/${chatId}/notices`)).toEqual({ items: [] });
  // What the page offers follows what is installed.
  const some = await chat({ only: ["projects", "files"] });
  expect(((await (await some.served.fetch(`${API}/config`)).json()) as ChatConfig).projects).toEqual({ files: true, memory: false, convert: false });
  expect((await call(some, "ana", "GET", `/projects/${(await make(some, "ana", "P")).id}/memory`)).status).toBe(404);
});

test("ISOLATION: a non-member with a member's project id gets 404 on every route, as an id that never existed: nothing of the files or memory read or written, nothing of the project changed or restored", async () => {
  const c = await chat();
  const mine = await make(c, "ana", "Secret");
  const space = spaceOf(c, mine.id);
  await ok(c, "ana", "PUT", `/projects/${mine.id}/instructions`, { text: "ours", ifVersion: 0 });
  await ok(c, "ana", "POST", `/projects/${mine.id}/memory`, { kind: "rule", text: "be brief" });
  await c.served.fetch(`${API}/projects/${mine.id}/files?name=brief.txt&description=The%20brief`, as("ana", { method: "POST", body: "the brief", headers: { "content-type": "text/plain" } }));
  const { id: chatId } = await start(c, "ana", "inside", { project: mine.id });
  const before = JSON.stringify([c.doubles.projects.spaces.get(space)?.log.entries, [...c.doubles.memory.owners.values()].map((each) => each.log.entries), [...c.doubles.files.spaces.values()].map((each) => each.log.entries)]);
  const dispatched = c.runtime.dispatched.length;
  c.doubles.files.calls.length = 0;
  c.doubles.memory.calls.length = 0;

  const unknown = "b".repeat(32);
  for (const [method, path, body] of [...projectRoutes(mine.id, chatId), ...projectRoutes(unknown, chatId), ["GET", `/conversations?project=${mine.id}`], ["POST", "/conversations", { text: "into yours", project: mine.id }]] as [
    string,
    string,
    unknown?,
  ][]) {
    const answered = await call<{ error: string }>(c, "ben", method, path, body);
    expect({ method, path, status: answered.status, error: answered.body.error }).toEqual({ method, path, status: 404, error: "not_found" });
  }
  expect([c.doubles.files.calls, c.doubles.memory.calls]).toEqual([[], []]);
  expect(JSON.stringify([c.doubles.projects.spaces.get(space)?.log.entries, [...c.doubles.memory.owners.values()].map((each) => each.log.entries), [...c.doubles.files.spaces.values()].map((each) => each.log.entries)])).toBe(before);
  expect(c.runtime.dispatched.length).toBe(dispatched);
  expect(await ok<ChatPage<ChatProject>>(c, "ben", "GET", "/projects")).toEqual({ items: [] });
  // Ids that are no project id are no project, before anything is asked.
  for (const bad of ["x", mine.id.toUpperCase(), crypto.randomUUID()]) expect((await call(c, "ana", "GET", `/projects/${bad}`)).status).toBe(404);
  // Another user's chat is no chat of the project, even for a member.
  await join(c, "ana", mine, "ben");
  const { id: bensOwn } = await start(c, "ben", "outside");
  expect((await call(c, "ben", "GET", `/projects/${mine.id}/conversations/${bensOwn}/transcript`)).status).toBe(404);
});

test("PROJECTS: made (owner the user, space project:<id>), listed with role, members and chats, archived apart; changed by any member; agents and archive the owner's (403 for a member); agents only those users may pick; removed only when empty (409 with chats), the owner's", async () => {
  const c = await chat();
  const work = await make(c, "ana", "  Work   stuff ", "The 2027 work");
  expect(work).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), name: "Work stuff", description: "The 2027 work", agents: [], owner: { channel: "web", id: "ana", name: "ana" }, role: "owner", members: 1, archived: false, chats: 0, createdAt: expect.any(Number), updatedAt: expect.any(Number) });
  expect(spaceOf(c, work.id)).toBe(`project:${work.id}`);
  expect((await call<{ error: string }>(c, "ana", "POST", "/projects", { name: "x".repeat(61) })).body.error).toBe("invalid");
  expect((await call(c, "ana", "POST", "/projects", { name: "" })).status).toBe(400);

  await join(c, "ana", work, "ben");
  expect((await ok<ChatPage<ChatProject>>(c, "ben", "GET", "/projects")).items.map((each) => [each.name, each.role, each.members])).toEqual([["Work stuff", "member", 2]]);
  // Any member renames it; the owner's acts are the owner's.
  expect((await ok<ChatProject>(c, "ben", "PATCH", `/projects/${work.id}`, { name: "Office" })).name).toBe("Office");
  for (const body of [{ agents: ["helper"] }, { archived: true }]) expect({ body, status: (await call(c, "ben", "PATCH", `/projects/${work.id}`, body)).status }).toEqual({ body, status: 403 });
  expect((await call(c, "ben", "DELETE", `/projects/${work.id}`)).status).toBe(403);
  // Only assistants users may pick.
  expect((await call<{ error: string }>(c, "ana", "PATCH", `/projects/${work.id}`, { agents: ["secret"] })).status).toBe(400);
  expect((await ok<ChatProject>(c, "ana", "PATCH", `/projects/${work.id}`, { agents: ["helper"] })).agents).toEqual(["helper"]);

  // The overview: counts, the budget, the latest changes.
  await start(c, "ben", "a chat", { project: work.id });
  const overview = await ok<ChatProjectOverview>(c, "ana", "GET", `/projects/${work.id}`);
  expect(overview).toMatchObject({ project: { id: work.id, name: "Office", chats: 1, members: 2 }, documents: 0, coreTokens: 0, coreBudget: 8000, links: 0, files: { names: 0, bytes: 0 }, memory: { rules: 0, notes: 0, summaries: 0 } });
  expect(overview.recent.map((each) => [each.log, each.action, each.item.kind])).toEqual([
    ["project", "changed", "project"],
    ["project", "changed", "project"],
    ["project", "added", "member"],
    ["project", "added", "project"],
  ]);

  // With a chat it is not removed (archived instead); empty, by its owner.
  expect((await call<{ error: string }>(c, "ana", "DELETE", `/projects/${work.id}`)).body.error).toBe("not_empty");
  await ok(c, "ana", "PATCH", `/projects/${work.id}`, { archived: true });
  expect((await ok<ChatPage<ChatProject>>(c, "ana", "GET", "/projects")).items).toEqual([]);
  expect((await ok<ChatPage<ChatProject>>(c, "ana", "GET", "/projects?archived=1")).items.map((each) => [each.name, each.archived])).toEqual([["Office", true]]);
  const empty = await make(c, "ana", "Empty");
  expect((await call(c, "ana", "DELETE", `/projects/${empty.id}`)).status).toBe(204);
  expect((await call(c, "ana", "GET", `/projects/${empty.id}`)).status).toBe(404);
});

test("MEMBERS: any member adds a user of this chat by email (a directory's person too; an unknown email 404, nothing added); the list says who is you; anyone leaves, the owner only after handing it over; the owner removes others (a member 403)", async () => {
  const c = await chat();
  c.doubles.principals.link("dora@corp.example", { channel: "googlechat", id: "users/7", name: "Dora" });
  const work = await make(c, "ana", "Work");
  await join(c, "ana", work, "ben");
  // Ben (a member) adds Cy, and Dora by her directory's email.
  expect((await ok<ChatMember>(c, "ben", "POST", `/projects/${work.id}/members`, { email: "CY@example.com" })).principal).toEqual({ channel: "web", id: "cy", name: "cy" });
  expect((await ok<ChatMember>(c, "ben", "POST", `/projects/${work.id}/members`, { email: "dora@corp.example" })).principal).toEqual({ channel: "googlechat", id: "users/7", name: "Dora" });
  expect((await call(c, "ben", "POST", `/projects/${work.id}/members`, { email: "nobody@example.com" })).status).toBe(404);
  const members = await ok<ChatPage<ChatMember>>(c, "ben", "GET", `/projects/${work.id}/members`);
  expect(members.items.map((each) => [each.principal.id, each.role, each.you, each.current])).toEqual([
    ["ana", "owner", false, true],
    ["ben", "member", true, true],
    ["cy", "member", false, true],
    ["users/7", "member", false, true],
  ]);
  expect(members.items[2]?.by).toEqual({ kind: "person", principal: { channel: "web", id: "ben", name: "ben" } });

  // A member removes no one else; the owner does; a member leaves.
  const cy = encodeURIComponent(memberKey({ channel: "web", id: "cy" }));
  expect((await call(c, "ben", "DELETE", `/projects/${work.id}/members/${cy}`)).status).toBe(403);
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/members/${cy}`)).status).toBe(204);
  expect((await call(c, "cy", "GET", `/projects/${work.id}`)).status).toBe(404);
  // The owner leaves only after a transfer, which is the owner's.
  const ana = encodeURIComponent(memberKey({ channel: "web", id: "ana" }));
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/members/${ana}`)).status).toBe(403);
  expect((await call(c, "ben", "POST", `/projects/${work.id}/owner`, { channel: "web", id: "ben" })).status).toBe(403);
  expect((await ok<ChatProject>(c, "ana", "POST", `/projects/${work.id}/owner`, { channel: "web", id: "ben" })).owner.id).toBe("ben");
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/members/${ana}`)).status).toBe(204);
  expect((await call(c, "ana", "GET", `/projects/${work.id}`)).status).toBe(404);
  // Principals: Dora signed in on the web (linked to her directory identity) is a member there too.
  c.accounts.add("dora", "dora@corp.example");
  c.doubles.principals.people[0]?.unshift({ channel: "web", id: "dora" });
  expect((await ok<ChatProjectOverview>(c, "dora", "GET", `/projects/${work.id}`)).project.role).toBe("member");
});

test("INSTRUCTIONS: written over a version (409 behind it, the newer kept), with their versions and authors; a credential refused (400), never echoed", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  await join(c, "ana", work, "ben");
  expect(await ok<object>(c, "ana", "GET", `/projects/${work.id}/instructions`)).toEqual({});
  const first = await ok<ChatInstructions>(c, "ana", "PUT", `/projects/${work.id}/instructions`, { text: "Answer in Spanish", ifVersion: 0 }, 200);
  expect(first).toMatchObject({ text: "Answer in Spanish", version: 1, by: { kind: "person", principal: { channel: "web", id: "ana" } } });
  await ok(c, "ben", "PUT", `/projects/${work.id}/instructions`, { text: "Answer in Catalan", ifVersion: 1 }, 200);
  const behind = await call<{ error: string }>(c, "ana", "PUT", `/projects/${work.id}/instructions`, { text: "mine", ifVersion: 1 });
  expect({ status: behind.status, error: behind.body.error }).toEqual({ status: 409, error: "conflict" });
  expect((await ok<{ instructions: ChatInstructions }>(c, "ana", "GET", `/projects/${work.id}/instructions`)).instructions.text).toBe("Answer in Catalan");
  expect((await ok<{ instructions: ChatInstructions }>(c, "ana", "GET", `/projects/${work.id}/instructions?version=1`)).instructions.text).toBe("Answer in Spanish");
  expect((await ok<ChatPage<{ version: number; by: Author }>>(c, "ana", "GET", `/projects/${work.id}/instructions/versions`)).items.map((each) => [each.version, (each.by as { principal: { id: string } }).principal.id])).toEqual([
    [1, "ana"],
    [2, "ben"],
  ]);
  const secret = `sk-${"a".repeat(30)}`;
  const refused = await call(c, "ana", "PUT", `/projects/${work.id}/instructions`, { text: `use ${secret}`, ifVersion: 2 });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).not.toContain(secret);
});

test("DOCUMENTS: from text, from an uploaded text file, from a PDF through document.convert (415 without one), from a saved file (its source kept); core within the budget (400 saying what is left); a new title or mode keeps the text; read by part and version; versions; removed", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  const brief = await ok<ChatDocument>(c, "ana", "POST", `/projects/${work.id}/documents`, { title: "Brief", mode: "core", text: "x".repeat(4000) });
  expect(brief).toMatchObject({ title: "Brief", mode: "core", chars: 4000, tokens: 1000, version: 1, by: { kind: "person" } });
  const over = await call<{ error: string; message: string }>(c, "ana", "POST", `/projects/${work.id}/documents`, { title: "Big", mode: "core", text: "y".repeat(30_000) });
  expect(over).toEqual({ status: 400, body: { error: "limit", message: "the core documents' budget has 7000 tokens left" } });
  expect((await call(c, "ana", "POST", `/projects/${work.id}/documents`, { title: "Both", mode: "core" })).status).toBe(400);

  const upload = (title: string, body: string, type: string) =>
    c.served.fetch(`${API}/projects/${work.id}/documents/upload?title=${encodeURIComponent(title)}&mode=reference`, as("ana", { method: "POST", body, headers: { "content-type": type } }));
  expect(((await (await upload("Notes", "# Notes\nhello", "text/markdown")).json()) as ChatDocument).chars).toBe(13);
  const pdf = await upload("Plan", "plan text", "application/pdf");
  expect(pdf.status).toBe(201);
  expect(c.doubles.convert.converted).toEqual(["Plan"]);
  expect((await upload("Sheet", "PK", "application/zip")).status).toBe(415);

  // From a saved file: its text, and where it came from.
  await c.served.fetch(`${API}/projects/${work.id}/files?name=data.csv&description=Data`, as("ana", { method: "POST", body: "a,b\n1,2", headers: { "content-type": "text/csv" } }));
  const fromFile = await ok<ChatDocument>(c, "ana", "POST", `/projects/${work.id}/documents`, { title: "Data", mode: "reference", file: { name: "data.csv" } });
  expect(fromFile).toMatchObject({ chars: 7, source: { file: "data.csv", fileVersion: 1 } });

  // A new mode keeps the text and its source; over an old version, 409.
  const moved = await ok<ChatDocument>(c, "ana", "PATCH", `/projects/${work.id}/documents/${fromFile.id}`, { mode: "core", ifVersion: 1 });
  expect(moved).toMatchObject({ mode: "core", version: 2, chars: 7, source: { file: "data.csv" } });
  expect((await call(c, "ana", "PATCH", `/projects/${work.id}/documents/${fromFile.id}`, { title: "x", ifVersion: 1 })).status).toBe(409);
  const long = await ok<ChatDocument>(c, "ana", "POST", `/projects/${work.id}/documents`, { title: "Long", mode: "reference", text: "z".repeat(45_000) });
  const part = await ok<ChatDocumentRead>(c, "ana", "GET", `/projects/${work.id}/documents/${long.id}?part=3`);
  expect([part.part, part.parts, part.text.length]).toEqual([3, 3, 5000]);
  expect((await ok<ChatDocumentRead>(c, "ana", "GET", `/projects/${work.id}/documents/${long.id}`)).part).toBe(1);
  expect((await ok<ChatPage<unknown>>(c, "ana", "GET", `/projects/${work.id}/documents/${fromFile.id}/versions`)).items.length).toBe(2);
  const listed = await ok<ChatDocuments>(c, "ana", "GET", `/projects/${work.id}/documents`);
  expect([listed.items.length, listed.coreTokens, listed.coreBudget]).toEqual([5, 1002, 8000]);
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/documents/${long.id}`)).status).toBe(204);
  expect((await call(c, "ana", "GET", `/projects/${work.id}/documents/${long.id}`)).status).toBe(404);
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/documents/${long.id}`)).status).toBe(404);

  const noConverter = await chat({ only: ["projects", "files"] });
  const other = await make(noConverter, "ana", "Other");
  const refused = await noConverter.served.fetch(`${API}/projects/${other.id}/documents/upload?title=Plan`, as("ana", { method: "POST", body: "plan", headers: { "content-type": "application/pdf" } }));
  expect(refused.status).toBe(415);
});

test("FILES: uploaded by a member (the person its author), listed, versioned, downloaded as an attachment never shown in the page, trashed and restored; too large 413; a credential in a text file refused (400)", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  await join(c, "ana", work, "ben");
  const upload = (user: string, name: string, body: string, type = "text/plain", extra = "") =>
    c.served.fetch(`${API}/projects/${work.id}/files?name=${encodeURIComponent(name)}&description=The%20brief${extra}`, as(user, { method: "POST", body, headers: { "content-type": type } }));
  const first = (await (await upload("ana", "brief <1>.html", "<script>alert(1)</script>", "text/html")).json()) as ChatSpaceFile;
  expect(first).toMatchObject({ name: "brief <1>.html", version: 1, size: 25, type: "text/html", by: { kind: "person", principal: { channel: "web", id: "ana" } }, text: "indexed" });
  expect(((await (await upload("ben", "brief <1>.html", "v2", "text/html")).json()) as ChatSpaceFile).version).toBe(2);
  // Idempotent by the page's id.
  const id = "0123456789abcdef0123";
  await upload("ben", "notes.txt", "n", "text/plain", `&id=${id}`);
  await upload("ben", "notes.txt", "n", "text/plain", `&id=${id}`);
  const listed = await ok<ChatFiles>(c, "ana", "GET", `/projects/${work.id}/files`);
  expect(listed.items.map((each) => [each.name, each.version, each.versions])).toEqual([
    ["brief <1>.html", 2, 2],
    ["notes.txt", 1, 1],
  ]);
  expect(listed.usage).toEqual({ files: 3, names: 2, bytes: 28 });

  const name = encodeURIComponent("brief <1>.html");
  const download = await c.served.fetch(`${API}/projects/${work.id}/files/${name}?version=1`, as("ben"));
  expect(await download.text()).toBe("<script>alert(1)</script>");
  expect(Object.fromEntries(["content-disposition", "x-content-type-options", "content-security-policy", "cache-control"].map((h) => [h, download.headers.get(h)]))).toEqual({
    "content-disposition": "attachment; filename*=UTF-8''brief%20%3C1%3E.html",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  });
  expect((await ok<ChatPage<ChatSpaceFile>>(c, "ana", "GET", `/projects/${work.id}/files/${name}/versions`)).items.map((each) => each.by)).toEqual([
    { kind: "person", principal: { channel: "web", id: "ana", name: "ana" } },
    { kind: "person", principal: { channel: "web", id: "ben", name: "ben" } },
  ]);

  expect((await call(c, "ben", "DELETE", `/projects/${work.id}/files/${name}`)).status).toBe(204);
  expect((await ok<ChatFiles>(c, "ana", "GET", `/projects/${work.id}/files`)).items.map((each) => each.name)).toEqual(["notes.txt"]);
  expect((await ok<ChatFiles>(c, "ana", "GET", `/projects/${work.id}/files?trashed=1`)).items.map((each) => each.name)).toEqual(["brief <1>.html"]);
  expect((await call(c, "ana", "GET", `/projects/${work.id}/files/${name}`)).status).toBe(404);
  expect((await ok<ChatChange>(c, "ana", "POST", `/projects/${work.id}/files/${name}/restore`)).action).toBe("restored");
  expect((await ok<ChatFiles>(c, "ana", "GET", `/projects/${work.id}/files`)).items.length).toBe(2);
  expect((await call(c, "ana", "POST", `/projects/${work.id}/files/${name}/restore`)).status).toBe(404);

  const big = await upload("ana", "big.bin", "x".repeat(1024 * 1024 + 1), "application/octet-stream");
  expect({ status: big.status, error: ((await big.json()) as { error: string }).error }).toEqual({ status: 413, error: "limit" });
  const secret = `sk-${"b".repeat(30)}`;
  const refused = await upload("ana", "keys.txt", `key=${secret}`);
  expect(refused.status).toBe(400);
  expect(await refused.text()).not.toContain(secret);
});

test("MEMORY: any member adds rules (active at once, the rule id memory-recall gives the same words) and notes, edits them (replace), removes them; summaries shown; rules proposed before the project wait, added or discarded by a member; each with its author", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  await join(c, "ana", work, "ben");
  const owner = { type: "space" as const, space: spaceOf(c, work.id) };
  // From before the project: a pending rule and a summary.
  await c.doubles.memory.remember(owner, { id: "r-old", kind: "rule", status: "pending", text: "Reply within a day", createdAt: 1, by: { kind: "agent", agent: "assistant", conversation: "web:ana:x" } });
  await c.doubles.memory.remember(owner, { id: "summary:c1", kind: "summary", status: "active", text: "We planned Q1", createdAt: 2, by: { kind: "component", name: "memory-summaries" } });

  const rule = await ok<ChatMemoryItem>(c, "ben", "POST", `/projects/${work.id}/memory`, { kind: "rule", text: "  Target  CPA 18 EUR " });
  expect(rule).toMatchObject({ id: await ruleId("target cpa 18 eur"), kind: "rule", status: "active", text: "Target CPA 18 EUR", by: { kind: "person", principal: { channel: "web", id: "ben", name: "ben" } } });
  // memory-recall's itemId("rule", "Target CPA 18 EUR"), pinned: the same words are one rule from the page and from /rules.
  expect(rule.id).toBe("r-56edef9e");
  const note = await ok<ChatMemoryItem>(c, "ana", "POST", `/projects/${work.id}/memory`, { kind: "note", text: "Juan prefers calls" });
  expect(note).toMatchObject({ kind: "note", status: "active" });
  const read = await ok<ChatMemory>(c, "ana", "GET", `/projects/${work.id}/memory`);
  expect([read.rules.map((each) => each.text), read.notes.map((each) => each.text), read.summaries.map((each) => each.text), read.proposed.map((each) => each.text)]).toEqual([
    ["Target CPA 18 EUR"],
    ["Juan prefers calls"],
    ["We planned Q1"],
    ["Reply within a day"],
  ]);

  const edited = await ok<ChatMemoryItem>(c, "ana", "PATCH", `/projects/${work.id}/memory/${rule.id}`, { text: "Target CPA 20 EUR" }, 200);
  expect(edited).toMatchObject({ id: await ruleId("Target CPA 20 EUR"), text: "Target CPA 20 EUR", kind: "rule", status: "active" });
  expect((await call(c, "ana", "PATCH", `/projects/${work.id}/memory/summary:c1`, { text: "x" })).status).toBe(404);
  expect((await ok<ChatMemoryItem>(c, "ana", "POST", `/projects/${work.id}/memory/r-old/approve`)).status).toBe("active");
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/memory/${note.id}`)).status).toBe(204);
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/memory/${note.id}`)).status).toBe(404);
  const now = await ok<ChatMemory>(c, "ana", "GET", `/projects/${work.id}/memory`);
  expect([now.rules.map((each) => each.text).sort(), now.notes, now.proposed]).toEqual([["Reply within a day", "Target CPA 20 EUR"], [], []]);
  const secret = `sk-${"c".repeat(30)}`;
  const refused = await call(c, "ana", "POST", `/projects/${work.id}/memory`, { kind: "rule", text: `use ${secret}` });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).not.toContain(secret);
});

test("LINKS: any member adds (idempotent by URL, a URL with a password refused) and removes", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  const link = await ok<{ id: string; url: string; by: Author }>(c, "ana", "POST", `/projects/${work.id}/links`, { url: "https://drive.example/folder", title: "Folder", note: " the 2027 folder " });
  expect(link).toMatchObject({ url: "https://drive.example/folder", by: { kind: "person" } });
  expect((await ok<{ id: string }>(c, "ana", "POST", `/projects/${work.id}/links`, { url: "https://drive.example/folder", title: "Again" })).id).toBe(link.id);
  expect((await call(c, "ana", "POST", `/projects/${work.id}/links`, { url: "https://user:pw@example.com", title: "x" })).status).toBe(400);
  expect((await ok<ChatPage<unknown>>(c, "ana", "GET", `/projects/${work.id}/links`)).items.length).toBe(1);
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/links/${link.id}`)).status).toBe(204);
  expect((await call(c, "ana", "DELETE", `/projects/${work.id}/links/${link.id}`)).status).toBe(404);
});

test("HISTORY: the three logs merged newest first, paged with a cursor per log (every entry once, each log in its order); a restore goes to the store that holds the entry, by its rules (a member restores content, not the owner's acts: 403); no route edits or deletes an entry", async () => {
  let clock = 1_000;
  const c = await chat();
  for (const each of [c.doubles.projects, c.doubles.files, c.doubles.memory] as { now: () => number }[]) (each as { now: () => number }).now = () => clock;
  const tick = () => (clock += 10);
  const work = await make(c, "ana", "Work");
  tick();
  await join(c, "ana", work, "ben");
  for (let i = 0; i < 4; i++) {
    tick();
    await ok(c, "ben", "POST", `/projects/${work.id}/memory`, { kind: "note", text: `note ${i}` });
    tick();
    await c.served.fetch(`${API}/projects/${work.id}/files?name=f${i}.txt&description=File`, as("ben", { method: "POST", body: `file ${i}`, headers: { "content-type": "text/plain" } }));
    tick();
    await ok(c, "ben", "POST", `/projects/${work.id}/links`, { url: `https://example.com/${i}`, title: `link ${i}` });
  }
  // Two entries at the same time in two logs: the merge keeps both, in its order of logs.
  tick();
  await ok(c, "ben", "POST", `/projects/${work.id}/memory`, { kind: "note", text: "same time" });
  await c.served.fetch(`${API}/projects/${work.id}/files?name=same.txt&description=File`, as("ben", { method: "POST", body: "same", headers: { "content-type": "text/plain" } }));

  const seen: ChatChange[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const read = await ok<ChatPage<ChatChange>>(c, "ana", "GET", `/projects/${work.id}/history?limit=3${cursor === undefined ? "" : `&cursor=${cursor}`}`);
    seen.push(...read.items);
    cursor = read.next;
    if (cursor === undefined) break;
  }
  // Every entry of every log, once, newest first.
  const expected = (["project", "memory", "files"] as const).flatMap((log) => {
    const entries = log === "project" ? c.doubles.projects.spaces.get(spaceOf(c, work.id))?.log.entries : log === "memory" ? [...c.doubles.memory.owners.values()][0]?.log.entries : [...c.doubles.files.spaces.values()][0]?.log.entries;
    return (entries ?? []).map((each) => `${log}#${each.n}`);
  });
  expect(seen.map((each) => `${each.log}#${each.n}`).sort()).toEqual(expected.sort());
  expect(seen.length).toBe(16);
  expect(seen.map((each) => each.at)).toEqual([...seen.map((each) => each.at)].sort((a, b) => b - a));
  expect(seen.slice(0, 2).map((each) => each.log)).toEqual(["memory", "files"]);
  for (const log of ["project", "memory", "files"]) {
    const numbers = seen.filter((each) => each.log === log).map((each) => each.n);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
  }
  expect((await call(c, "ana", "GET", `/projects/${work.id}/history?cursor=not-ours`)).status).toBe(400);

  // Undo of a note, a file's save, a link: each through its own store, by the restorer.
  const of = (log: string, kind: string) => seen.find((each) => each.log === log && each.item.kind === kind && each.action === "added") as ChatChange;
  const note = of("memory", "note");
  const restored = await ok<ChatChange>(c, "ben", "POST", `/projects/${work.id}/history/memory/${note.n}/restore`);
  expect(restored).toMatchObject({ log: "memory", action: "restored", restores: note.n, by: { kind: "person", principal: { id: "ben" } } });
  expect((await ok<ChatChange>(c, "ben", "POST", `/projects/${work.id}/history/files/${of("files", "file").n}/restore`)).log).toBe("files");
  expect((await ok<ChatChange>(c, "ben", "POST", `/projects/${work.id}/history/project/${of("project", "link").n}/restore`)).log).toBe("project");
  expect(c.doubles.memory.calls.filter((each) => each === "restore").length).toBe(1);
  expect(c.doubles.files.calls.filter((each) => each === "restore").length).toBe(1);
  // The owner's acts (a member added): a member may not undo them; the owner may.
  const added = of("project", "member");
  expect((await call(c, "ben", "POST", `/projects/${work.id}/history/project/${added.n}/restore`)).status).toBe(403);
  // No such log, no such entry.
  expect((await call(c, "ben", "POST", `/projects/${work.id}/history/other/1/restore`)).status).toBe(404);
  expect((await call(c, "ben", "POST", `/projects/${work.id}/history/project/0/restore`)).status).toBe(404);
  // Nothing edits or deletes an entry.
  for (const method of ["PATCH", "DELETE", "PUT"]) expect((await call(c, "ana", method, `/projects/${work.id}/history/project/1`)).status).toBe(404);
});

test("HISTORY's merge (pure): one log's entries in its order, ties by log, each log's place the last taken; a page past every log has no next; a cursor round-trips and a foreign one is refused", () => {
  const entry = (n: number, at: number) => ({ n, at, by: { kind: "component" as const, name: "t" }, action: "added" as const, item: { kind: "k", id: String(n), title: "t" }, restorable: true });
  const page = (items: ReturnType<typeof entry>[], next?: number): ChangePage => ({ items, ...(next !== undefined && { next }) });
  const merged = mergeHistory(
    new Map([
      ["project", { page: page([entry(9, 50), entry(8, 30)], 8), place: undefined }],
      ["memory", { page: page([entry(4, 50), entry(3, 40)]), place: undefined }],
      ["files", { page: page([]), place: 0 }],
    ]),
    3,
  );
  expect(merged.items.map((each) => `${each.log}#${each.n}`)).toEqual(["project#9", "memory#4", "memory#3"]);
  expect(merged.next).toEqual({ project: 9, memory: 0, files: 0 });
  // The last page: everything taken, nothing more.
  const last = mergeHistory(new Map([["project", { page: page([entry(1, 1)]), place: 2 }]]), 5);
  expect(last).toEqual({ items: [expect.objectContaining({ n: 1 })] });
  expect(parseHistoryCursor(encodeHistoryCursor({ project: 9, memory: 0 }))).toEqual({ project: 9, memory: 0 });
  for (const bad of ["", "e30x", encodeHistoryCursor({ other: 1 } as never), btoa('{"project":-1}')]) expect(() => parseHistoryCursor(bad)).toThrow();
});

test("A CHAT IN A PROJECT: made by a member in the project's space (every chat of it the same), with an agent the project allows (its first when none is picked; another 400); not in an archived project (403); a non-member's attempt makes nothing (404)", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  await join(c, "ana", work, "ben");
  const space = spaceOf(c, work.id);
  const a = await start(c, "ana", "one", { project: work.id });
  const b = await start(c, "ben", "two", { project: work.id, agent: "helper" });
  expect(c.runtime.pointers.get(keyOf("ana", a.id))?.space).toBe(space);
  expect(c.runtime.pointers.get(keyOf("ben", b.id))).toMatchObject({ space, agent: "helper" });
  expect(c.runtime.dispatched.find((each) => each.requestId === a.requestId)?.conversation.space).toBe(space);
  const none = await start(c, "ana", "outside");
  expect(c.runtime.pointers.get(keyOf("ana", none.id))?.space).toBeUndefined();

  await ok(c, "ana", "PATCH", `/projects/${work.id}`, { agents: ["helper"] });
  const picked = await start(c, "ana", "three", { project: work.id });
  expect(c.runtime.pointers.get(keyOf("ana", picked.id))?.agent).toBe("helper");
  expect((await call(c, "ana", "POST", "/conversations", { text: "four", project: work.id, agent: "assistant" })).status).toBe(400);
  const pointers = c.runtime.pointers.size;
  expect((await call(c, "cy", "POST", "/conversations", { text: "five", project: work.id })).status).toBe(404);
  await ok(c, "ana", "PATCH", `/projects/${work.id}`, { archived: true });
  expect((await call(c, "ana", "POST", "/conversations", { text: "six", project: work.id })).status).toBe(403);
  expect(c.runtime.pointers.size).toBe(pointers);
  // The user's own chats of it, for a member only.
  expect((await call(c, "cy", "GET", `/conversations?project=${work.id}`)).status).toBe(404);
  expect((await ok<ChatPage<{ title: string }>>(c, "ana", "GET", `/conversations?project=${work.id}`)).items.map((each) => each.title)).toEqual(["Three", "One"]);
});

test("POSTING in a project's chat: only while its author is a member (a removed one 403, nothing dispatched), the project not archived, and its agent one the project still allows; a chat of no project is not asked", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  await join(c, "ana", work, "ben");
  const bens = await start(c, "ben", "mine", { project: work.id, agent: "assistant" });
  expect((await call(c, "ben", "POST", `/conversations/${bens.id}/messages`, { text: "more" })).status).toBe(202);
  const dispatched = c.runtime.dispatched.length;
  // The project's agents changed: assistant is no longer allowed.
  await ok(c, "ana", "PATCH", `/projects/${work.id}`, { agents: ["helper"] });
  expect((await call<{ error: string }>(c, "ben", "POST", `/conversations/${bens.id}/messages`, { text: "again" })).body.error).toBe("forbidden");
  await ok(c, "ana", "PATCH", `/projects/${work.id}`, { agents: [] });
  // Ben removed: his chat is read only for him.
  await ok(c, "ana", "DELETE", `/projects/${work.id}/members/${encodeURIComponent(memberKey({ channel: "web", id: "ben" }))}`, undefined, 204);
  expect((await call(c, "ben", "POST", `/conversations/${bens.id}/messages`, { text: "/rules be brief" })).status).toBe(403);
  // Archived: no one posts.
  const anas = await start(c, "ana", "hers", { project: work.id });
  await ok(c, "ana", "PATCH", `/projects/${work.id}`, { archived: true });
  expect((await call(c, "ana", "POST", `/conversations/${anas.id}/messages`, { text: "x" })).status).toBe(403);
  expect(c.runtime.dispatched.length).toBe(dispatched + 1);
  const loose = await start(c, "ben", "loose");
  const calls = c.doubles.projects.calls.length;
  expect((await call(c, "ben", "POST", `/conversations/${loose.id}/messages`, { text: "x" })).status).toBe(202);
  expect(c.doubles.projects.calls.length).toBe(calls);
});

test("THE PROJECT'S CHATS: every member's, listed with whose they are; another member's read (cut by the policy), never written; a non-member none", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  await join(c, "ana", work, "ben");
  const anas = await start(c, "ana", "the plan", { project: work.id });
  await start(c, "ben", "the budget", { project: work.id });
  await start(c, "ben", "not in it");
  await c.runtime.end(keyOf("ana", anas.id), [anas.requestId], { messages: [answerOf("Here is the plan")] });
  const listed = await ok<ChatPage<ChatProjectConversation>>(c, "ben", "GET", `/projects/${work.id}/conversations`);
  expect(listed.items.map((each) => [each.title, each.userId, each.mine]).sort()).toEqual([
    ["The budget", "ben", true],
    ["The plan", "ana", false],
  ]);
  const transcript = await ok<ChatPage<ChatTranscriptEntry>>(c, "ben", "GET", `/projects/${work.id}/conversations/${anas.id}/transcript`);
  expect(transcript.items.length).toBeGreaterThan(0);
  // Ben cannot write in Ana's chat: it is not his conversation.
  expect((await call(c, "ben", "POST", `/conversations/${anas.id}/messages`, { text: "x" })).status).toBe(404);
  expect((await call(c, "cy", "GET", `/projects/${work.id}/conversations`)).status).toBe(404);
});

test("NOTICES: a chat's are the logs' entries whose author worked in it (an agent's note, file, link; its author's command), newest first; another chat's never; none for a non-member or a chat of no project", async () => {
  const c = await chat();
  const work = await make(c, "ana", "Work");
  const space = spaceOf(c, work.id);
  const here = await start(c, "ana", "the plan", { project: work.id });
  const there = await start(c, "ana", "elsewhere", { project: work.id });
  const key = keyOf("ana", here.id);
  const agent = (conversation: string): Author => ({ kind: "agent", agent: "assistant", conversation, for: { channel: "web", id: "ana" } });
  await c.doubles.memory.remember({ type: "space", space }, { id: `${key}:call-1`, kind: "fact", status: "active", text: "Juan prefers calls", createdAt: 1, by: agent(key) });
  await c.doubles.files.save(space, { name: "plan.md", description: "The plan", bytes: new TextEncoder().encode("plan") }, agent(key));
  await c.doubles.projects.addLink(space, { url: "https://example.com/sheet", title: "The sheet" }, { kind: "agent", agent: "assistant", conversation: key, space });
  await c.doubles.memory.remember({ type: "space", space }, { id: "r-x", kind: "rule", status: "active", text: "Be brief", createdAt: 1, by: { kind: "person", principal: { channel: "web", id: "ana" }, conversation: key } });
  await c.doubles.memory.remember({ type: "space", space }, { id: "other", kind: "fact", status: "active", text: "Elsewhere", createdAt: 1, by: agent(keyOf("ana", there.id)) });
  await ok(c, "ana", "POST", `/projects/${work.id}/memory`, { kind: "note", text: "From the page" });

  const notices = await ok<ChatNotices>(c, "ana", "GET", `/conversations/${here.id}/notices`);
  expect(notices.project).toBe(work.id);
  expect(notices.items.map((each) => [each.log, each.item.kind, each.item.title]).sort()).toEqual([
    ["files", "file", "plan.md"],
    ["memory", "note", "Juan prefers calls"],
    ["memory", "rule", "Be brief"],
    ["project", "link", "The sheet"],
  ]);
  expect((await ok<ChatNotices>(c, "ana", "GET", `/conversations/${there.id}/notices`)).items.map((each) => each.item.title)).toEqual(["Elsewhere"]);
  // Another user's chat id is no chat of theirs.
  expect((await call(c, "ben", "GET", `/conversations/${here.id}/notices`)).status).toBe(404);
  // Its author no longer a member (the owner handed it over, then left): none.
  await join(c, "ana", work, "ben");
  await ok(c, "ana", "POST", `/projects/${work.id}/owner`, { channel: "web", id: "ben" });
  await ok(c, "ana", "DELETE", `/projects/${work.id}/members/${encodeURIComponent(memberKey({ channel: "web", id: "ana" }))}`, undefined, 204);
  expect(await ok<ChatNotices>(c, "ana", "GET", `/conversations/${here.id}/notices`)).toEqual({ project: work.id, items: [] });
});

/** The former table, as channel-web made it, with `rows`. */
const formerTable =
  (rows: [user: string, id: string, name: string][]) =>
  async (sql: SqlDatabase): Promise<void> => {
    await sql.run("CREATE TABLE IF NOT EXISTS channel_web_projects (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, id))");
    for (const [user, id, name] of rows) await sql.run("INSERT INTO channel_web_projects (user_id, id, name, created_at) VALUES (?, ?, ?, 1)", [user, id, name]);
  };
const tableExists = async (sql: SqlDatabase): Promise<boolean> =>
  (await sql.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_web_projects'")).length > 0;

test("MIGRATION: the projects channel-web kept itself carried over at the first project request, by a trusted call, with the same ids and spaces (web:<user>:project:<id>, so their chats keep their memory and files) and their users as owners; the table dropped; idempotent; without a project store nothing moves", async () => {
  const work = "1".repeat(32);
  const home = "2".repeat(32);
  const bens = "3".repeat(32);
  const rows: [string, string, string][] = [
    ["ana", work, "Work"],
    ["ana", home, "Home"],
    ["ben", bens, "Ben's"],
  ];
  const c = await chat({ before: formerTable(rows) });
  // A chat made in the old project before: its row names the project (the tables made by a first read).
  await ok(c, "ana", "GET", "/conversations");
  await c.sql().run(
    "INSERT INTO channel_web_conversations (key, user_id, chat_id, agent, project, title, title_search, created_at, last_activity, hidden, archived, busy, version) VALUES (?, 'ana', ?, 'assistant', ?, 'Old chat', 'old chat', 1, 1, 0, 0, 0, 1)",
    [keyOf("ana", "00000000-0000-4000-8000-000000000001"), "00000000-0000-4000-8000-000000000001", work],
  );
  // One carried over already (a run cut after its create): left as it is.
  await c.doubles.projects.create({ id: home, space: `web:ana:project:${home}`, name: "Home (kept)", owner: { channel: "web", id: "ana" } }, { kind: "component", name: "channel-web" }, c.served.app.context());
  expect(await tableExists(c.sql())).toBe(true);

  const listed = await ok<ChatPage<ChatProject>>(c, "ana", "GET", "/projects");
  expect(listed.items.map((each) => [each.id, each.name, each.role, each.chats]).sort()).toEqual([
    [work, "Work", "owner", 1],
    [home, "Home (kept)", "owner", 0],
  ].sort());
  expect([spaceOf(c, work), spaceOf(c, home), spaceOf(c, bens)]).toEqual([`web:ana:project:${work}`, `web:ana:project:${home}`, `web:ben:project:${bens}`]);
  expect(c.doubles.projects.spaces.get(`web:ben:project:${bens}`)?.project.owner).toEqual({ channel: "web", id: "ben" });
  expect(c.doubles.projects.spaces.get(`web:ana:project:${work}`)?.log.entries[0]?.by).toEqual({ kind: "component", name: "channel-web" });
  expect(await tableExists(c.sql())).toBe(false);
  expect(c.served.logged.find((each) => each.message.includes("carried over"))?.fields).toEqual({ projects: 2 });
  // Its chat keeps its project and posts there (its user a member, as owner).
  expect((await ok<ChatPage<{ title: string }>>(c, "ana", "GET", `/conversations?project=${work}`)).items.map((each) => each.title)).toEqual(["Old chat"]);

  // Run again (another App's start): nothing more made, nothing fails.
  const creates = c.doubles.projects.calls.filter((each) => each === "create").length;
  const again = await chat({ before: formerTable([["ana", work, "Work"]]) });
  again.doubles.projects.spaces = c.doubles.projects.spaces;
  for (const [id, space] of c.doubles.projects.ids) again.doubles.projects.ids.set(id, space);
  await ok(again, "ana", "GET", "/projects");
  expect(again.doubles.projects.calls.filter((each) => each === "create").length).toBe(0);
  expect(c.doubles.projects.calls.filter((each) => each === "create").length).toBe(creates);
  expect(await tableExists(again.sql())).toBe(false);

  // No project store: the table stays, for when one is installed.
  const none = await chat({ only: [], before: formerTable(rows) });
  expect((await call(none, "ana", "GET", "/projects")).status).toBe(404);
  expect(await tableExists(none.sql())).toBe(true);

  // A store that fails: the request says so (503), the table stays, and the next request carries it over.
  const flaky = await chat({ before: formerTable(rows) });
  flaky.doubles.projects.failNext = { method: "create", error: new Error("the store is down") };
  expect((await call(flaky, "ana", "GET", "/projects")).status).toBe(503);
  expect(await tableExists(flaky.sql())).toBe(true);
  expect((await ok<ChatPage<ChatProject>>(flaky, "ana", "GET", "/projects")).items.length).toBe(2);
  expect(await tableExists(flaky.sql())).toBe(false);
});

test("A USER REMOVED by the operator: each project they own goes to its oldest manual member (else it is archived), and they leave every project", async () => {
  const c = await chat();
  const shared = await make(c, "ben", "Shared");
  await join(c, "ben", shared, "cy");
  await join(c, "ben", shared, "ana");
  const alone = await make(c, "ben", "Alone");
  const theirs = await make(c, "ana", "Ana's");
  await join(c, "ana", theirs, "ben");
  expect((await c.served.fetch("/admin/api/channel-web/users/ben", { method: "DELETE", headers: OPERATOR })).status).toBe(204);
  const record = (id: string) => c.doubles.projects.spaces.get(spaceOf(c, id));
  expect(record(shared.id)?.project.owner.id).toBe("cy");
  expect(record(shared.id)?.members.map((each) => each.principal.id)).toEqual(["cy", "ana"]);
  expect(record(alone.id)?.project.archivedAt).toBeNumber();
  expect(record(theirs.id)?.members.map((each) => each.principal.id)).toEqual(["ana"]);
  expect(record(shared.id)?.log.entries.at(-1)?.by).toEqual({ kind: "operator", id: "ops" });
});
