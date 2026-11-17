/**
 * projects-sql's tests, copied with the component: the `projects` suite (`createProjectsConformance`,
 * with the change log's cases over documents) over an App of projects-sql, an in-memory mailbox (every
 * key's actor is the App, as on a server), `sqliteStorage()` and a manual clock (a restart is a second
 * App over the same database); then what only this provider promises: what setup declares, an actor
 * answering only for its key, the purge of a removed project after its tombstone, the version cap, and
 * the admin routes (401 first).
 */

import { expect, test } from "bun:test";
import { type App, type ComponentDefinition, defineApp, defineComponent, type Handle, type Pikit, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import {
  ActorCallError,
  type ActorMailbox,
  type AdminAuth,
  type Caller,
  type HttpRoute,
  type JsonValue,
  type ProjectStore,
  PROJECT_TOMBSTONE_DAYS,
  type SqlDatabase,
  type SqlStatements,
} from "@pikit/contracts";
import { createMemoryMailbox, createMemoryWakeups, createProjectsConformance, type ProjectsSubject } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import type { MemoryOwner, MemoryStore } from "./contract.ts";
import projectsSql, { CALL, INDEX_KEY, projectKey, searchAttempts, worker } from "./index.ts";
import { CHANGES } from "./tables.ts";

const CONFIG = { "projects-sql": { coreTokens: 2_000, staleAfterMs: 60_000 } };

/**
 * `sqliteStorage()` whose next write of a log entry fails, inside its transaction or out of it: what
 * the suite's `failNextCommit` asks of a provider (the item written, the entry not, nothing committed).
 */
function failingStorage(): { component: ComponentDefinition; failNext(): void } {
  const inner = sqliteStorage();
  let armed = false;
  const trip = (sql: string) => {
    if (armed && sql.includes(`INTO ${CHANGES}`)) {
      armed = false;
      throw new Error("projects-sql test: the write failed before its commit");
    }
  };
  const wrap = (db: SqlDatabase): SqlDatabase => ({
    query: (sql, params) => db.query(sql, params),
    run: async (sql, params) => (trip(sql), db.run(sql, params)),
    transaction: (work) =>
      db.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params), run: async (sql, params) => (trip(sql), tx.run(sql, params)) } satisfies SqlStatements)),
  });
  const component = defineComponent({
    name: inner.name,
    setup(pikit) {
      const proxy = new Proxy(pikit, {
        get(target, property) {
          if (property === "provide") return (name: string, value: unknown) => target.provide(name as never, (name === "storage.sql" ? wrap(value as SqlDatabase) : value) as never);
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return inner.setup(proxy as Pikit, undefined as never);
    },
  });
  return { component, failNext: () => void (armed = true) };
}

/** An App of projects-sql over `components`, and its `projects`. */
async function boot(components: ComponentDefinition[], clock: ReturnType<typeof createManualClock>, extra: ComponentDefinition[] = []) {
  let handle: Handle<ProjectStore> | undefined;
  const consumer = defineComponent({ name: "projects-consumer", setup: (pikit) => void (handle = pikit.use("projects")) });
  const app = await defineApp({ components: [...components, projectsSql, ...extra, consumer], config: CONFIG, clock, logger: silentLogger }).create();
  await app.start();
  return { app, projects: (handle as Handle<ProjectStore>).get() };
}

for (const c of createProjectsConformance(async (): Promise<ProjectsSubject> => {
  const clock = createManualClock();
  const storage = failingStorage();
  const components = [storage.component, createMemoryMailbox(), createMemoryWakeups()];
  let running = await boot(components, clock);
  return {
    projects: running.projects,
    ctx: running.app.context(),
    now: () => clock.now(),
    advance: (ms) => void clock.advance(ms),
    staleAfterMs: CONFIG["projects-sql"].staleAfterMs,
    coreTokens: CONFIG["projects-sql"].coreTokens,
    async restart() {
      await running.app.stop();
      running = await boot(components, clock);
      return running.projects;
    },
    failNextCommit: storage.failNext,
    close: () => running.app.stop(),
  };
})) {
  test(`projects-sql ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), createMemoryWakeups(), projectsSql], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "projects-sql")).toEqual({
    name: "projects-sql",
    provides: ["projects", "http.route"],
    requires: ["storage.sql", "actor.mailbox", "actor.inbox", "wakeups"],
    optional: ["memory", "admin.auth"],
  });
  const half = await defineApp({ components: [createMemoryMailbox(), worker], logger: silentLogger }).create();
  expect(half.describe().components.find((component) => component.name === "projects-sql-worker")).toEqual({
    name: "projects-sql-worker",
    provides: ["projects", "http.route"],
    requires: ["actor.mailbox"],
    optional: ["admin.auth"],
  });
});

/** An App with a probe of its mailbox, for calls made by hand. */
async function withMailbox(run: (call: (key: string, type: string, message: JsonValue) => Promise<JsonValue>, projects: ProjectStore, app: App) => Promise<void>) {
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "probe",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const { app, projects } = await boot([sqliteStorage(), createMemoryMailbox(), createMemoryWakeups()], createManualClock(), [probe]);
  try {
    await run((key, type, message) => (mailbox as ActorMailbox).call(key, type, message, app.context()), projects, app);
  } finally {
    await app.stop();
  }
}

const ANA = { channel: "web", id: "u-ana" };
const ana: Caller = { kind: "people", principals: [ANA] };
const codeOf = (work: Promise<unknown>) => work.then(() => "resolved", (error: unknown) => (error as { code?: string }).code ?? String(error));

test("a project's actor answers only for its own space, and checks what it is sent", async () => {
  await withMailbox(async (call, projects, app) => {
    const project = await projects.create({ name: "AECC" }, ana, app.context());
    const message = { space: project.space, op: "get", caller: ana } as unknown as JsonValue;
    expect(await codeOf(call(projectKey("project:other"), CALL.project, message))).toBe("invalid");
    expect(await codeOf(call(projectKey(project.space), CALL.project, { ...(message as object), op: "toString" } as JsonValue))).toBe("invalid");
    expect(await codeOf(call(projectKey(project.space), CALL.project, { ...(message as object), caller: { kind: "people", principals: [{ channel: "web" }] } } as JsonValue))).toBe("invalid");
    expect(await codeOf(call("projects:elsewhere", CALL.list, { caller: ana } as unknown as JsonValue))).toBe("invalid");
    // The purge is the component's own: refused from a caller, and a project not due is kept.
    expect(await codeOf(call(projectKey(project.space), CALL.project, { space: project.space, op: "purge", caller: ana } as unknown as JsonValue))).toBe("invalid");
    expect(await call(projectKey(project.space), CALL.project, { space: project.space, op: "purge", caller: "projects-sql" })).toBe(false);
    expect((await call(projectKey(project.space), CALL.project, message)) as { id: string }).toMatchObject({ id: project.id });
    expect(await call(INDEX_KEY, CALL.locate, { id: project.id })).toBe(project.space);
  });
});

test("a removed project is purged after its tombstone: the directory, its space's memory and every row", async () => {
  const clock = createManualClock();
  const purged: MemoryOwner[] = [];
  const memory = defineComponent({
    name: "memory-double",
    setup: (pikit) => pikit.provide("memory", { purge: async (owner: MemoryOwner) => void purged.push(owner) } as unknown as MemoryStore),
  });
  const storage = sqliteStorage();
  const components = [storage, createMemoryMailbox(), createMemoryWakeups(), memory];
  let { app, projects } = await boot(components, clock);
  const operator: Caller = { kind: "operator", id: "admin" };
  try {
    const kept = await projects.create({ name: "Kept" }, ana, app.context());
    const project = await projects.create({ name: "Gone" }, ana, app.context());
    await projects.putDocument(project.space, { title: "Plan", text: "The plan.", mode: "reference" }, ana, app.context());
    await projects.remove(project.space, ana, app.context());
    expect((await projects.list({}, operator, app.context())).items.find((each) => each.id === project.id)?.removedAt).toBeNumber();
    expect((await projects.list({}, ana, app.context())).items.map((each) => each.id)).toEqual([kept.id]);

    // A restart in between: the purge is asked for again at start.
    await app.stop();
    ({ app, projects } = await boot(components, clock));
    await clock.advance(PROJECT_TOMBSTONE_DAYS * 86_400_000 - 1_000);
    expect(await projects.get(project.space, operator, app.context())).toBeDefined();
    await clock.advance(2_000);
    for (let i = 0; i < 50 && purged.length === 0; i++) await clock.advance(10);
    expect(purged).toEqual([{ type: "space", space: project.space }]);
    expect(await projects.get(project.space, operator, app.context())).toBeUndefined();
    expect(await projects.locate(project.id, app.context())).toBeUndefined();
    expect((await projects.list({}, operator, app.context())).items.map((each) => each.id)).toEqual([kept.id]);
    // The space is free again: a trusted caller may adopt it anew.
    const again = await projects.create({ name: "Again", space: project.space, owner: ANA }, operator, app.context());
    expect(again.space).toBe(project.space);
    expect(await projects.changes(project.space, { limit: 10 }, operator, app.context())).toMatchObject({ items: [{ n: 1, action: "added" }] });
  } finally {
    await app.stop();
  }
});

test("archived projects are read-only until the owner unarchives them, and listed apart", async () => {
  await withMailbox(async (_call, projects, app) => {
    const ctx = app.context();
    const project = await projects.create({ name: "Old" }, ana, ctx);
    await projects.update(project.space, { archived: true }, ana, ctx);
    expect(await codeOf(projects.setInstructions(project.space, { text: "x", ifVersion: 0 }, ana, ctx))).toBe("forbidden");
    expect((await projects.list({}, ana, ctx)).items).toEqual([]);
    expect((await projects.list({ archived: true }, ana, ctx)).items.map((each) => each.id)).toEqual([project.id]);
    await projects.update(project.space, { archived: false }, ana, ctx);
    expect((await projects.setInstructions(project.space, { text: "x", ifVersion: 0 }, ana, ctx)).version).toBe(1);
  });
});

test("search: a document's hit names the read part it is in; refs are one per item", async () => {
  await withMailbox(async (_call, projects, app) => {
    const ctx = app.context();
    const { space } = await projects.create({ name: "Big" }, ana, ctx);
    const text = `${"filler words ".repeat(2_000)}needle here ${"more filler ".repeat(100)}needle again`;
    const document = await projects.putDocument(space, { title: "Long", text, mode: "reference" }, ana, ctx);
    const hits = await projects.search(space, "needle", 5, ana, ctx);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: `document:${document.id}`, kind: "document", title: "Long", part: 2, version: 1, by: { kind: "person", principal: ANA } });
    const read = await projects.read(space, document.id, { part: 2 }, ana, ctx);
    expect(read?.parts).toBe(2);
    expect(read?.text).toContain("needle");
    await projects.setInstructions(space, { text: "Use the needle.", ifVersion: 0 }, ana, ctx);
    await projects.addLink(space, { url: "https://example.com/needle", title: "Needle sheet" }, ana, ctx);
    expect((await projects.search(space, "needle", 10, ana, ctx)).map((hit) => hit.kind).sort()).toEqual(["document", "instructions", "link"]);
  });
});

test("a query becomes FTS5 queries of its quoted words: all, the phrase, any; none without a word", () => {
  expect(searchAttempts("ana@example.com")).toEqual(['"ana" AND "example" AND "com"', '"ana example com"', '"ana" OR "example" OR "com"']);
  expect(searchAttempts("tea")).toEqual(['"tea"']);
  expect(searchAttempts("?! -- ...")).toEqual([]);
});

// The admin routes.

const OPERATOR_TOKEN = "Bearer operator";
const auth = defineComponent({
  name: "auth-double",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === OPERATOR_TOKEN ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

test("the admin routes: 401 before anything is read, then every project and an operator's acts", async () => {
  let routes: Map<string, HttpRoute> | undefined;
  const reader = defineComponent({
    name: "routes-reader",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      return { start: () => void (routes = new Map(handle.keys().map((key) => [key, handle.get(key) as HttpRoute]))) };
    },
  });
  const { app, projects } = await boot([sqliteStorage(), createMemoryMailbox(), createMemoryWakeups(), auth], createManualClock(), [reader]);
  const ctx = app.context();
  const serve = (method: string, path: string, body?: unknown, token = OPERATOR_TOKEN) => {
    const request = new Request(`http://pikit.test${path}`, { method, headers: { authorization: token, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const pattern = [...(routes as Map<string, HttpRoute>).keys()].find((key) => {
      const [m, p] = key.split(" ") as [string, string];
      const a = p.split("/");
      const b = new URL(request.url).pathname.split("/");
      return m === method && a.length === b.length && a.every((segment, i) => segment.startsWith(":") || segment === b[i]);
    });
    if (pattern === undefined) throw new Error(`no route for ${method} ${path}`);
    return (routes as Map<string, HttpRoute>).get(pattern)?.(request, ctx) as Promise<Response>;
  };
  try {
    const project = await projects.create({ name: "AECC" }, ana, ctx);
    await projects.putDocument(project.space, { title: "Brief", text: "The brief.", mode: "core" }, ana, ctx);
    for (const [method, path] of [
      ["GET", "/admin/api/projects"],
      ["GET", `/admin/api/projects/${project.id}`],
      ["GET", `/admin/api/projects/${project.id}/history`],
      ["POST", `/admin/api/projects/${project.id}/remove`],
    ] as const) {
      const response = await serve(method, path, undefined, "Bearer wrong");
      expect([response.status, await response.json()]).toEqual([401, { error: "unauthorized" }]);
    }
    expect(await projects.get(project.space, ana, ctx)).toBeDefined();

    const list = await serve("GET", "/admin/api/projects");
    expect(((await list.json()) as { items: { id: string }[] }).items.map((each) => each.id)).toEqual([project.id]);
    const overview = (await (await serve("GET", `/admin/api/projects/${project.id}`)).json()) as { project: { name: string }; members: unknown[]; documents: { id: string }[] };
    expect([overview.project.name, overview.members.length, overview.documents.length]).toEqual(["AECC", 1, 1]);
    const read = (await (await serve("GET", `/admin/api/projects/${project.id}/documents/${overview.documents[0]?.id}`)).json()) as { text: string };
    expect(read.text).toBe("The brief.");
    expect((await serve("GET", "/admin/api/projects/0123456789abcdef0123456789abcdef")).status).toBe(404);
    expect((await serve("GET", "/admin/api/projects/not-an-id")).status).toBe(404);

    const history = (await (await serve("GET", `/admin/api/projects/${project.id}/history`)).json()) as { items: { n: number; action: string }[] };
    expect(history.items.map((entry) => entry.action)).toEqual(["added", "added"]);
    const restored = (await (await serve("POST", `/admin/api/projects/${project.id}/history/2/restore`)).json()) as { action: string; by: unknown };
    expect(restored).toMatchObject({ action: "restored", restores: 2, by: { kind: "operator", id: "ops" } });
    expect(await projects.documents(project.space, ana, ctx)).toEqual([]);
    expect((await serve("POST", `/admin/api/projects/${project.id}/history/1/restore`)).status).toBe(410);
    expect((await serve("POST", `/admin/api/projects/${project.id}/history/2/redact`)).status).toBe(200);
    expect((await projects.changes(project.space, { limit: 10 }, ana, ctx)).items.find((entry) => entry.n === 2)).toMatchObject({ restorable: false, redacted: { by: { kind: "operator", id: "ops" } } });

    expect((await serve("POST", `/admin/api/projects/${project.id}/members`, { principal: { channel: "web", id: "u-luis" } })).status).toBe(200);
    expect((await serve("POST", `/admin/api/projects/${project.id}/owner`, { principal: { channel: "web", id: "u-luis" } })).status).toBe(200);
    expect((await projects.get(project.space, ana, ctx))?.role).toBe("member");
    expect((await serve("POST", `/admin/api/projects/${project.id}/members/remove`, { principal: { channel: "web", id: "u-luis" } })).status).toBe(403);
    expect((await serve("POST", `/admin/api/projects/${project.id}/archive`, { archived: "yes" })).status).toBe(400);
    expect((await serve("POST", `/admin/api/projects/${project.id}/archive`, { archived: true })).status).toBe(200);
    expect((await serve("POST", `/admin/api/projects/${project.id}/remove`)).status).toBe(200);
    expect(await projects.get(project.space, ana, ctx)).toBeUndefined();
    expect(((await (await serve("POST", `/admin/api/projects/${project.id}/recover`)).json()) as { name: string }).name).toBe("AECC");
    expect((await projects.get(project.space, ana, ctx))?.archivedAt).toBeNumber();
  } finally {
    await app.stop();
  }
});

test("the routes without admin.auth: nobody is an operator", async () => {
  let routes: Map<string, HttpRoute> | undefined;
  const reader = defineComponent({
    name: "routes-reader",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      return { start: () => void (routes = new Map(handle.keys().map((key) => [key, handle.get(key) as HttpRoute]))) };
    },
  });
  const { app } = await boot([sqliteStorage(), createMemoryMailbox(), createMemoryWakeups()], createManualClock(), [reader]);
  try {
    const response = await routes?.get("GET /admin/api/projects")?.(new Request("http://pikit.test/admin/api/projects", { headers: { authorization: OPERATOR_TOKEN } }), app.context());
    expect(response?.status).toBe(401);
  } finally {
    await app.stop();
  }
});

test("errors cross as the store's codes", async () => {
  await withMailbox(async (call) => {
    const refused = await call(INDEX_KEY, CALL.create, { caller: ana, input: { name: "X", space: "s" } } as unknown as JsonValue).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("forbidden");
  });
});
