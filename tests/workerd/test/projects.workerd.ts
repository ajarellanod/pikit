/**
 * projects-sql on Cloudflare: the directory in the Durable Object `projects:index` and each project in
 * the object of its space, `projects:space:<space>` (deployment-cloudflare's `Conversation` class, as
 * `PlatformConversation`, `src/platform.ts`), reached through actors-do's `actor.mailbox` by RPC.
 *
 * - The `projects` suite (with the change log's cases over documents) from an App in an object of its
 *   own (storage-do, actors-do, projects-sql): every call crosses to the directory's or the project's
 *   object, which keeps the rows, the versions and the FTS5 index in its own SQLite, on the case's
 *   clock (`composeObjects`' `clock`). The directory and the one adopted space are emptied before each
 *   case; a restart is a second App.
 * - The Worker's App (actors-do, the Worker half, an `admin.auth`, deployment-cloudflare's server):
 *   the admin routes refuse a request without the operator (401) before reading anything; a project
 *   made there is in its space's object only, the directory's object holding its index row and no
 *   project; removed through the routes, then `Date` moved past the tombstone and the project object's
 *   alarm fired (actors-do's `wakeups`): it is purged from its object and the directory.
 */

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, type Handle, silentLogger, withContextValue } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { type AdminAuth, type Caller, PROJECT_TOMBSTONE_DAYS, type ProjectStore } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import { createProjectsConformance, type ProjectsSubject } from "@pikit/contracts/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import projectsSql, { INDEX_KEY, projectKey, worker as projectsSqlWorker } from "../../../registry/components/projects-sql/files/src/pikit/projects-sql/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

const ACTORS = { "actors-do": { binding: PLATFORM_BINDING } };
const CONFIG = { ...ACTORS, "projects-sql": { coreTokens: 2_000, staleAfterMs: 60_000 } };
const object = (key: string) => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));
/** The one space a case names (adopted by a trusted caller); every other space is `project:<new id>`. */
const ADOPTED = "googlechat:spaces/AAA";

// The directory and the adopted space outlive a case: empty them, then reset every instance so their next App makes the tables again.
beforeEach(async () => {
  for (const key of [INDEX_KEY, projectKey(ADOPTED)]) await runInDurableObject(object(key), (_instance, state) => state.storage.deleteAll());
  await resetObjects();
});
afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

for (const c of createProjectsConformance(async (): Promise<ProjectsSubject> => {
  const clock = createManualClock(Date.now());
  composeObjects([storageDo, actorsDo, projectsSql], CONFIG, { clock });
  const open = async () => {
    let handle: Handle<ProjectStore> | undefined;
    const consumer = defineComponent({ name: "projects-consumer", setup: (pikit) => void (handle = pikit.use("projects")) });
    const app = await defineApp({ components: withWorkersHost(objectHost(), [storageDo, actorsDo, projectsSql, consumer]), config: CONFIG, clock, target: "durable", logger: silentLogger }).create();
    await app.start();
    return { app, projects: (handle as Handle<ProjectStore>).get() };
  };
  let running = await open();
  return {
    projects: running.projects,
    ctx: running.app.context(),
    now: () => clock.now(),
    advance: (ms) => void clock.advance(ms),
    staleAfterMs: CONFIG["projects-sql"].staleAfterMs,
    coreTokens: CONFIG["projects-sql"].coreTokens,
    async restart() {
      await running.app.stop();
      running = await open();
      return running.projects;
    },
    close: () => running.app.stop(),
  };
})) {
  it(`projects-sql over storage-do and actors-do ${c.group}: ${c.name}`, () => inObject(c));
}

const AUTH = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** The Worker's App: projects-sql's Worker half (projects and the admin routes) served by deployment-cloudflare's server. */
async function workerApp() {
  const server = createWorkerServer(silentLogger);
  let handle: Handle<ProjectStore> | undefined;
  const consumer = defineComponent({ name: "projects-consumer", setup: (pikit) => void (handle = pikit.use("projects")) });
  const app = await defineApp({ components: [actorsDo, auth, projectsSqlWorker, consumer, server.component], config: ACTORS, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    app,
    projects: (handle as Handle<ProjectStore>).get(),
    fetch: async (path: string, init: RequestInit & { operator?: boolean } = {}) => {
      const response = await server.serve(
        new Request(`https://pikit.test${path}`, { ...init, headers: { ...(init.operator !== false && AUTH), "content-type": "application/json" } }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

const rows = (key: string, sql: string) => runInDurableObject(object(key), (_instance, state) => state.storage.sql.exec(sql).toArray());

it("from the Worker: 401 first; a project in its own object, the directory's apart; removed, and purged by its object's alarm past the tombstone", async () => {
  composeObjects([storageDo, actorsDo, projectsSql], CONFIG);
  const worker = await workerApp();
  const ana: Caller = { kind: "people", principals: [{ channel: "web", id: `u-${crypto.randomUUID()}` }] };
  try {
    expect(await worker.fetch("/admin/api/projects", { operator: false })).toEqual({ status: 401, body: { error: "unauthorized" } });
    const project = await worker.projects.create({ name: "AECC 2027" }, ana, worker.app.context());
    await worker.projects.putDocument(project.space, { title: "Brief", text: "The target CPA is 18 EUR.", mode: "core" }, ana, worker.app.context());
    expect(await worker.fetch(`/admin/api/projects/${project.id}`, { operator: false })).toEqual({ status: 401, body: { error: "unauthorized" } });

    // The project's rows are in its space's object; the directory's object holds its index row only.
    expect(await rows(projectKey(project.space), "SELECT id FROM projects_sql_projects")).toEqual([{ id: project.id }]);
    expect((await rows(projectKey(project.space), "SELECT text FROM projects_sql_search")).length).toBe(1);
    expect(await rows(INDEX_KEY, `SELECT id FROM projects_sql_index WHERE id = '${project.id}'`)).toEqual([{ id: project.id }]);
    expect(await rows(INDEX_KEY, "SELECT space FROM projects_sql_projects")).toEqual([]);

    const overview = await worker.fetch(`/admin/api/projects/${project.id}`);
    expect(overview.status).toBe(200);
    expect((overview.body.documents as { title: string }[]).map((document) => document.title)).toEqual(["Brief"]);
    const history = await worker.fetch(`/admin/api/projects/${project.id}/history`);
    expect((history.body.items as { action: string; item: { kind: string } }[]).map((entry) => [entry.action, entry.item.kind])).toEqual([
      ["added", "document"],
      ["added", "project"],
    ]);

    expect((await worker.fetch(`/admin/api/projects/${project.id}/remove`, { method: "POST" })).status).toBe(200);
    expect(await worker.projects.get(project.space, ana, worker.app.context())).toBeUndefined();

    // Past the tombstone, the project's object purges it at its alarm.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + PROJECT_TOMBSTONE_DAYS * 86_400_000 + 60_000, shouldAdvanceTime: true });
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(object(projectKey(project.space)));
        expect(await rows(projectKey(project.space), "SELECT id FROM projects_sql_projects")).toEqual([]);
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(await rows(projectKey(project.space), "SELECT n FROM projects_sql_changes")).toEqual([]);
    expect(await rows(INDEX_KEY, `SELECT id FROM projects_sql_index WHERE id = '${project.id}'`)).toEqual([]);
    expect((await worker.fetch(`/admin/api/projects/${project.id}`)).status).toBe(404);
  } finally {
    await worker.app.stop();
  }
});
