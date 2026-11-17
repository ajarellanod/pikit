/**
 * channel-web's projects on a server (features/projects.md, "channel-web's routes"), as a suite over the
 * stores: `projectRouteCases(fixture)` runs every project route over the `projects`, `space.files` and
 * `memory` the fixture gives (`projects.test.ts`: doubles of their contracts, `projects.test-support.ts`;
 * the repository's `projects-stores.test.ts`: the real providers, projects-sql, tool-space-files and
 * memory-sql), with `principals` and `document.convert` as doubles, the runtime's and the accounts'
 * doubles and a real `storage.sql`. The routes are held to the contracts, never to one provider's code.
 *
 * Each route is checked first for who may not (`401` without a session, `400` without the page's header,
 * `404` for a non-member with nothing read or written, `403` for a member's owner act), then for what it
 * does. Also: History merged across the three logs, a restore routed to its store, a chat started and
 * posted in a project (its space, its agents, its members), the chat's notices from the logs, and the
 * migration of the projects channel-web kept itself (`channel_web_projects`).
 *
 * What a test reads of the stores is their contracts' (`locate`, `changes` as an operator...); what
 * reached each store (`calls`: none for a non-member) is the fixture's to count.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineComponent } from "@pikit/core";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import type { Author, Caller, Change, ChangePage, ChangePageRequest, Project, ProjectStore, SpaceFiles, SqlDatabase } from "@pikit/contracts";
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
import { memoryItemId, type MemoryStore } from "./contract.ts";
import { createChannelWeb, NAME } from "./index.ts";
import { FakeConverter, FakePrincipals } from "./projects.test-support.ts";
import { adminAuth, answerOf, FakeAccounts, kvOf, OPERATOR, Runtime, router, type Served, secretsOf, serve } from "./runtime.test-support.ts";

/** The stores a fixture may give. */
export type StoreName = "projects" | "files" | "memory";
/** What an App may be given: the stores, `principals` and `document.convert` (doubles here). */
export type ServiceName = StoreName | "principals" | "convert";

/** The stores of one App, as a fixture opened them. */
export interface OpenedStores {
  /** What gives the App the stores named (and what they need). */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The calls each store got since `resetCalls`, by method (`create`, `save`, `restore`...). */
  calls(store: StoreName): string[];
  resetCalls(): void;
  /** The next call `method` of `projects` rejects (a store that is down). */
  failNext(method: string): void;
  /** The fixture's own state, for a restart over the same stores. */
  state?: unknown;
}

export interface ProjectStoresFixture {
  /** The stores named in `only`, on the App's clock `now`, kept under `dir` (the App's directory); `restartOf`: the same stores as that earlier App's, after it stopped. */
  open(options: { only: readonly StoreName[]; now: () => number; dir: string; restartOf?: OpenedStores }): Promise<OpenedStores>;
}

const OPERATOR_CALLER: Caller = { kind: "operator", id: "channel-web-test" };

/** Registers every case over `fixture`. */
export function projectRouteCases(fixture: ProjectStoresFixture): void {
  const apps: Served[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const served of apps.splice(0)) await served.app.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const API = "/chat/api";

  interface Chat {
    served: Served;
    runtime: Runtime;
    accounts: FakeAccounts;
    stores: OpenedStores;
    principals: FakePrincipals;
    convert: FakeConverter;
    dir: string;
    sql: () => SqlDatabase;
    ctx: () => AppContext;
    projects: () => ProjectStore;
    files: () => SpaceFiles;
    memory: () => MemoryStore;
  }

  /** The App with every store and double, or only those named (`only`: `[]` for no project store at all); `restartOf`: over that stopped App's stores and database. */
  async function chat(options: { only?: ServiceName[]; config?: Record<string, unknown>; components?: ComponentDefinition[]; before?: (sql: SqlDatabase) => Promise<void>; clock?: ManualClock; restartOf?: Chat } = {}): Promise<Chat> {
    const runtime = new Runtime();
    const accounts = new FakeAccounts();
    for (const id of ["ana", "ben", "cy"]) accounts.add(id);
    const only = options.only ?? ["projects", "files", "memory", "principals", "convert"];
    const dir = options.restartOf?.dir ?? mkdtempSync(pathJoin(tmpdir(), "pikit-channel-web-projects-"));
    if (options.restartOf === undefined) dirs.push(dir);
    const clock = options.clock;
    const stores = await fixture.open({ only: only.filter((name): name is StoreName => name === "projects" || name === "files" || name === "memory"), now: () => clock?.now() ?? Date.now(), dir, ...(options.restartOf !== undefined && { restartOf: options.restartOf.stores }) });
    stores.resetCalls();
    const principals = options.restartOf?.principals ?? new FakePrincipals();
    const convert = options.restartOf?.convert ?? new FakeConverter();
    let database: SqlDatabase | undefined;
    let services: { projects: ProjectStore | undefined; files: SpaceFiles | undefined; memory: MemoryStore | undefined } = { projects: undefined, files: undefined, memory: undefined };
    const probe = defineComponent({
      name: "sql-probe",
      setup(pikit) {
        const sql = pikit.use("storage.sql");
        const projects = pikit.useOptional("projects");
        const files = pikit.useOptional("space.files");
        const memory = pikit.useOptional("memory");
        return {
          async start() {
            database = sql.get();
            services = { projects: projects.get(), files: files.get(), memory: memory.get() };
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
    const doubles = defineComponent({
      name: "principals-convert-doubles",
      setup(pikit) {
        if (only.includes("principals")) pikit.provide("principals", principals);
        if (only.includes("convert")) pikit.provide("document.convert", convert);
      },
    });
    const served = await serve(
      [secretsOf(), runtime.component(), kvOf(), sqliteStorage(pathJoin(dir, "chat.db")), probe, router, agents, adminAuth, ...stores.components, doubles, ...(options.components ?? []), createChannelWeb({ accounts: accounts.wiring() })],
      { [NAME]: { agents: ["assistant", "helper"], ...options.config }, ...stores.config },
      "server",
      "http://pikit.test",
      clock,
    );
    apps.push(served);
    const need = <T>(value: T | undefined, what: string): T => {
      if (value === undefined) throw new Error(`this App has no ${what}`);
      return value;
    };
    return {
      served,
      runtime,
      accounts,
      stores,
      principals,
      convert,
      dir,
      sql: () => database as SqlDatabase,
      ctx: () => served.app.context(BACKGROUND_CONTEXT),
      projects: () => need(services.projects, "projects"),
      files: () => need(services.files, "space.files"),
      memory: () => need(services.memory, "memory"),
    };
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

  /** Every page of a log, oldest first. */
  async function wholeLog(read: (page: ChangePageRequest) => Promise<ChangePage>): Promise<Change[]> {
    const items: Change[] = [];
    let before: number | undefined;
    for (let page = 0; page < 100; page++) {
      const read1 = await read({ limit: 200, ...(before !== undefined && { before }) });
      items.push(...read1.items);
      before = read1.next;
      if (before === undefined) break;
    }
    return items.sort((a, b) => a.n - b.n);
  }
  /** The three logs of `space`, as an operator and the trusted stores read them (those this App has). */
  async function allEntries(c: Chat, space: string): Promise<Map<"project" | "memory" | "files", Change[]>> {
    const ctx = c.ctx();
    const logs = new Map<"project" | "memory" | "files", Change[]>();
    logs.set("project", await wholeLog((page) => c.projects().changes(space, page, OPERATOR_CALLER, ctx)));
    if (services(c).memory) logs.set("memory", await wholeLog((page) => c.memory().changes({ type: "space", space }, page, ctx)));
    if (services(c).files) logs.set("files", await wholeLog((page) => c.files().changes(space, page, ctx)));
    return logs;
  }
  const services = (c: Chat) => ({ memory: tryGet(() => c.memory()), files: tryGet(() => c.files()) });
  const tryGet = (get: () => unknown): boolean => {
    try {
      get();
      return true;
    } catch {
      return false;
    }
  };
  /** The three logs of `space` as one text, to compare before and after. */
  const logsOf = async (c: Chat, space: string): Promise<string> => JSON.stringify([...(await allEntries(c, space))]);

  /** `user` makes a project. */
  const make = (c: Chat, user: string, name: string, description?: string) => ok<ChatProject>(c, user, "POST", "/projects", { name, ...(description !== undefined && { description }) });
  /** `user` starts a chat. */
  async function start(c: Chat, user: string, text: string, extra: Record<string, unknown> = {}): Promise<{ id: string; requestId: string }> {
    return ok<{ id: string; requestId: string }>(c, user, "POST", "/conversations", { text, ...extra });
  }
  /** The space of project `id`, from the store. */
  const spaceOf = async (c: Chat, id: string): Promise<string> => (await c.projects().locate(id, c.ctx())) as string;
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
    expect([c.stores.calls("projects"), c.stores.calls("files"), c.stores.calls("memory")]).toEqual([[], [], []]);
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
    const space = await spaceOf(c, mine.id);
    await ok(c, "ana", "PUT", `/projects/${mine.id}/instructions`, { text: "ours", ifVersion: 0 });
    await ok(c, "ana", "POST", `/projects/${mine.id}/memory`, { kind: "rule", text: "be brief" });
    await c.served.fetch(`${API}/projects/${mine.id}/files?name=brief.txt&description=The%20brief`, as("ana", { method: "POST", body: "the brief", headers: { "content-type": "text/plain" } }));
    const { id: chatId } = await start(c, "ana", "inside", { project: mine.id });
    const before = await logsOf(c, space);
    const dispatched = c.runtime.dispatched.length;
    c.stores.resetCalls();

    const unknown = "b".repeat(32);
    for (const [method, path, body] of [...projectRoutes(mine.id, chatId), ...projectRoutes(unknown, chatId), ["GET", `/conversations?project=${mine.id}`], ["POST", "/conversations", { text: "into yours", project: mine.id }]] as [
      string,
      string,
      unknown?,
    ][]) {
      const answered = await call<{ error: string }>(c, "ben", method, path, body);
      expect({ method, path, status: answered.status, error: answered.body.error }).toEqual({ method, path, status: 404, error: "not_found" });
    }
    expect([c.stores.calls("files"), c.stores.calls("memory")]).toEqual([[], []]);
    expect(await logsOf(c, space)).toBe(before);
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
    expect(await spaceOf(c, work.id)).toBe(`project:${work.id}`);
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
    c.principals.link("dora@corp.example", { channel: "googlechat", id: "users/7", name: "Dora" });
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
    c.principals.people[0]?.unshift({ channel: "web", id: "dora" });
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
    // Refused, saying what is left (in the store's words).
    expect(over).toMatchObject({ status: 400, body: { error: "limit", message: expect.stringContaining("7000") } });
    expect((await call(c, "ana", "POST", `/projects/${work.id}/documents`, { title: "Both", mode: "core" })).status).toBe(400);

    const upload = (title: string, body: string, type: string) =>
      c.served.fetch(`${API}/projects/${work.id}/documents/upload?title=${encodeURIComponent(title)}&mode=reference`, as("ana", { method: "POST", body, headers: { "content-type": type } }));
    expect(((await (await upload("Notes", "# Notes\nhello", "text/markdown")).json()) as ChatDocument).chars).toBe(13);
    const pdf = await upload("Plan", "plan text", "application/pdf");
    expect(pdf.status).toBe(201);
    expect(c.convert.converted).toEqual(["Plan"]);
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
    // Newest first.
    expect(listed.items.map((each) => [each.name, each.version, each.versions])).toEqual([
      ["notes.txt", 1, 1],
      ["brief <1>.html", 2, 2],
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
    const owner = { type: "space" as const, space: await spaceOf(c, work.id) };
    // From before the project: a pending rule and a summary.
    await c.memory().remember(owner, { id: "r-old", kind: "rule", status: "pending", text: "Reply within a day", createdAt: 1, by: { kind: "agent", agent: "assistant", conversation: "web:ana:x" } }, c.ctx());
    await c.memory().remember(owner, { id: "summary:c1", kind: "summary", status: "active", text: "We planned Q1", createdAt: 2, by: { kind: "component", name: "memory-summaries" } }, c.ctx());

    const rule = await ok<ChatMemoryItem>(c, "ben", "POST", `/projects/${work.id}/memory`, { kind: "rule", text: "  Target  CPA 18 EUR " });
    expect(rule).toMatchObject({ id: await memoryItemId("rule", "target cpa 18 eur"), kind: "rule", status: "active", text: "Target CPA 18 EUR", by: { kind: "person", principal: { channel: "web", id: "ben", name: "ben" } } });
    // memory's memoryItemId("rule", "Target CPA 18 EUR"), pinned: the same words are one rule from the page and from /rules.
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
    expect(edited).toMatchObject({ id: await memoryItemId("rule", "Target CPA 20 EUR"), text: "Target CPA 20 EUR", kind: "rule", status: "active" });
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
    const clock = createManualClock(1_000);
    const c = await chat({ clock });
    const tick = () => clock.advance(10);
    const work = await make(c, "ana", "Work");
    await tick();
    await join(c, "ana", work, "ben");
    for (let i = 0; i < 4; i++) {
      await tick();
      await ok(c, "ben", "POST", `/projects/${work.id}/memory`, { kind: "note", text: `note ${i}` });
      await tick();
      await c.served.fetch(`${API}/projects/${work.id}/files?name=f${i}.txt&description=File`, as("ben", { method: "POST", body: `file ${i}`, headers: { "content-type": "text/plain" } }));
      await tick();
      await ok(c, "ben", "POST", `/projects/${work.id}/links`, { url: `https://example.com/${i}`, title: `link ${i}` });
    }
    // Two entries at the same time in two logs: the merge keeps both, in its order of logs.
    await tick();
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
    const entries = await allEntries(c, await spaceOf(c, work.id));
    const expected = (["project", "memory", "files"] as const).flatMap((log) => {
      return (entries.get(log) ?? []).map((each) => `${log}#${each.n}`);
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
    expect(c.stores.calls("memory").filter((each) => each === "restore").length).toBe(1);
    expect(c.stores.calls("files").filter((each) => each === "restore").length).toBe(1);
    // The owner's acts (a member added): a member may not undo them; the owner may.
    const added = of("project", "member");
    expect((await call(c, "ben", "POST", `/projects/${work.id}/history/project/${added.n}/restore`)).status).toBe(403);
    // No such log, no such entry.
    expect((await call(c, "ben", "POST", `/projects/${work.id}/history/other/1/restore`)).status).toBe(404);
    expect((await call(c, "ben", "POST", `/projects/${work.id}/history/project/0/restore`)).status).toBe(404);
    // Nothing edits or deletes an entry.
    for (const method of ["PATCH", "DELETE", "PUT"]) expect((await call(c, "ana", method, `/projects/${work.id}/history/project/1`)).status).toBe(404);
  });

  test("A CHAT IN A PROJECT: made by a member in the project's space (every chat of it the same; one of no project in its user's personal space), with an agent the project allows (its first when none is picked; another 400); not in an archived project (403); a non-member's attempt makes nothing (404)", async () => {
    const c = await chat();
    const work = await make(c, "ana", "Work");
    await join(c, "ana", work, "ben");
    const space = await spaceOf(c, work.id);
    const a = await start(c, "ana", "one", { project: work.id });
    const b = await start(c, "ben", "two", { project: work.id, agent: "helper" });
    expect(c.runtime.pointers.get(keyOf("ana", a.id))?.space).toBe(space);
    expect(c.runtime.pointers.get(keyOf("ben", b.id))).toMatchObject({ space, agent: "helper" });
    expect(c.runtime.dispatched.find((each) => each.requestId === a.requestId)?.conversation.space).toBe(space);
    const none = await start(c, "ana", "outside");
    // Outside every project: the user's personal space.
    expect(c.runtime.pointers.get(keyOf("ana", none.id))?.space).toBe("web:ana");

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
    const calls = c.stores.calls("projects").length;
    expect((await call(c, "ben", "POST", `/conversations/${loose.id}/messages`, { text: "x" })).status).toBe(202);
    expect(c.stores.calls("projects").length).toBe(calls);
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
    const space = await spaceOf(c, work.id);
    const here = await start(c, "ana", "the plan", { project: work.id });
    const there = await start(c, "ana", "elsewhere", { project: work.id });
    const key = keyOf("ana", here.id);
    const agent = (conversation: string): Author => ({ kind: "agent", agent: "assistant", conversation, for: { channel: "web", id: "ana" } });
    await c.memory().remember({ type: "space", space }, { id: `${key}:call-1`, kind: "fact", status: "active", text: "Juan prefers calls", createdAt: 1, by: agent(key) }, c.ctx());
    await c.files().save(space, { name: "plan.md", description: "The plan", bytes: new TextEncoder().encode("plan") }, agent(key), c.ctx());
    await c.projects().addLink(space, { url: "https://example.com/sheet", title: "The sheet" }, { kind: "agent", agent: "assistant", conversation: key, space }, c.ctx());
    await c.memory().remember({ type: "space", space }, { id: "r-x", kind: "rule", status: "active", text: "Be brief", createdAt: 1, by: { kind: "person", principal: { channel: "web", id: "ana" }, conversation: key } }, c.ctx());
    await c.memory().remember({ type: "space", space }, { id: "other", kind: "fact", status: "active", text: "Elsewhere", createdAt: 1, by: agent(keyOf("ana", there.id)) }, c.ctx());
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
    // Undone from the page: the notice says so (and by whom), and undoing the undo puts it back.
    const note = notices.items.find((each) => each.item.kind === "note") as ChatChange;
    const undo = await ok<ChatChange>(c, "ana", "POST", `/projects/${work.id}/history/memory/${note.n}/restore`);
    const after = await ok<ChatNotices>(c, "ana", "GET", `/conversations/${here.id}/notices`);
    expect(after.items.find((each) => each.n === note.n && each.log === "memory")?.undone).toEqual({ at: undo.at, by: { kind: "person", principal: { channel: "web", id: "ana", name: "ana" } } });
    expect(after.items.filter((each) => each.undone !== undefined).length).toBe(1);
    await ok(c, "ana", "POST", `/projects/${work.id}/history/memory/${undo.n}/restore`);
    expect((await ok<ChatNotices>(c, "ana", "GET", `/conversations/${here.id}/notices`)).items.filter((each) => each.undone !== undefined)).toEqual([]);
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
    await c.projects().create({ id: home, space: `web:ana:project:${home}`, name: "Home (kept)", owner: { channel: "web", id: "ana" } }, { kind: "component", name: "channel-web" }, c.ctx());
    expect(await tableExists(c.sql())).toBe(true);

    const listed = await ok<ChatPage<ChatProject>>(c, "ana", "GET", "/projects");
    expect(listed.items.map((each) => [each.id, each.name, each.role, each.chats]).sort()).toEqual([
      [work, "Work", "owner", 1],
      [home, "Home (kept)", "owner", 0],
    ].sort());
    expect([await spaceOf(c, work), await spaceOf(c, home), await spaceOf(c, bens)]).toEqual([`web:ana:project:${work}`, `web:ana:project:${home}`, `web:ben:project:${bens}`]);
    expect((await c.projects().get(`web:ben:project:${bens}`, OPERATOR_CALLER, c.ctx()))?.owner).toMatchObject({ channel: "web", id: "ben" });
    expect((await allEntries(c, `web:ana:project:${work}`)).get("project")?.[0]?.by).toEqual({ kind: "component", name: "channel-web" });
    expect(await tableExists(c.sql())).toBe(false);
    expect(c.served.logged.find((each) => each.message.includes("carried over"))?.fields).toEqual({ projects: 2 });
    // Its chat keeps its project and posts there (its user a member, as owner).
    expect((await ok<ChatPage<{ title: string }>>(c, "ana", "GET", `/conversations?project=${work}`)).items.map((each) => each.title)).toEqual(["Old chat"]);

    // Run again (the App restarted over the same stores, the old row back): nothing more made, nothing fails.
    await c.served.app.stop();
    const again = await chat({ before: formerTable([["ana", work, "Work"]]), restartOf: c });
    await ok(again, "ana", "GET", "/projects");
    expect(again.stores.calls("projects").filter((each) => each === "create").length).toBe(0);
    expect(await tableExists(again.sql())).toBe(false);

    // No project store: the table stays, for when one is installed.
    const none = await chat({ only: [], before: formerTable(rows) });
    expect((await call(none, "ana", "GET", "/projects")).status).toBe(404);
    expect(await tableExists(none.sql())).toBe(true);

    // A store that fails: the request says so (503), the table stays, and the next request carries it over.
    const flaky = await chat({ before: formerTable(rows) });
    flaky.stores.failNext("create");
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
    const record = async (id: string) => {
      const space = await spaceOf(c, id);
      const [project, members, changes] = await Promise.all([
        c.projects().get(space, OPERATOR_CALLER, c.ctx()),
        c.projects().members(space, { limit: 100 }, OPERATOR_CALLER, c.ctx()),
        c.projects().changes(space, { limit: 1 }, OPERATOR_CALLER, c.ctx()),
      ]);
      return { project: project as Project, members: members.items, last: changes.items[0] };
    };
    const handed = await record(shared.id);
    expect(handed.project.owner.id).toBe("cy");
    expect(handed.members.map((each) => each.principal.id)).toEqual(["cy", "ana"]);
    expect(handed.last?.by).toEqual({ kind: "operator", id: "ops" });
    expect((await record(alone.id)).project.archivedAt).toBeNumber();
    expect((await record(theirs.id)).members.map((each) => each.principal.id)).toEqual(["ana"]);
  });
}
