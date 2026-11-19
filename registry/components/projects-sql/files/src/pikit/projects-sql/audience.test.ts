/**
 * projects-sql's stage of `conversation.audience`, copied with the component:
 * `createConversationAudienceConformance` over both halves (the default export's App, as on a server;
 * the Worker half's App calling a backend App of the default export through a bridged mailbox, as on
 * Cloudflare), and what only this provider promises: a space a project adopted is never granted, an
 * archived project's still is.
 */

import { expect, test } from "bun:test";
import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorMailbox, audienceGrants, type Caller, type Principal, type ProjectStore, type SqlDatabase } from "@pikit/contracts";
import { type AudienceMember, type ConversationAudienceFixture, createConversationAudienceConformance, createMemoryMailbox, createMemoryWakeups } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import projectsSql, { AUDIENCE_SOURCE, worker } from "./index.ts";

const TRUSTED: Caller = { kind: "component", name: "projects-sql-audience-test" };

/** `sqliteStorage()` that fails every statement once `down()` was called: the store down. */
function downableStorage(): { component: ComponentDefinition; down(): void } {
  const inner = sqliteStorage();
  let down = false;
  const check = () => {
    if (down) throw new Error("projects-sql test: the database is down");
  };
  const wrap = (db: SqlDatabase): SqlDatabase => ({
    query: async (sql, params) => (check(), db.query(sql, params)),
    run: async (sql, params) => (check(), db.run(sql, params)),
    transaction: async (work) => (check(), db.transaction(work)),
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
      return inner.setup(proxy, undefined as never);
    },
  });
  return { component, down: () => void (down = true) };
}

/** A component that keeps the App's `projects` (and `actor.mailbox`) for the test. */
function probe(): { component: ComponentDefinition; projects(): ProjectStore; mailbox(): ActorMailbox } {
  let projects: Handle<ProjectStore> | undefined;
  let mailbox: Handle<ActorMailbox> | undefined;
  const component = defineComponent({
    name: "projects-audience-probe",
    setup(pikit) {
      projects = pikit.use("projects");
      mailbox = pikit.use("actor.mailbox");
    },
  });
  return { component, projects: () => (projects as Handle<ProjectStore>).get(), mailbox: () => (mailbox as Handle<ActorMailbox>).get() };
}

/** Makes and ends memberships through `projects()`: each `member` a new project. */
function memberships(projects: () => ProjectStore): Pick<ConversationAudienceFixture, "member" | "remove"> {
  const owners = new Map<string, Principal>();
  let n = 0;
  return {
    async member(_app: App, ctx: AppContext, role: "member" | "owner"): Promise<AudienceMember> {
      n++;
      const owner: Principal = { channel: "web", id: `u-owner-${n}` };
      const project = await projects().create({ name: `Project ${n}`, owner }, TRUSTED, ctx);
      owners.set(project.space, owner);
      if (role === "owner") return { principals: [owner], space: project.space };
      const member: Principal = { channel: "web", id: `u-member-${n}` };
      await projects().addMember(project.space, member, { kind: "people", principals: [owner] }, ctx);
      return { principals: [member, { channel: "telegram", id: `t-member-${n}` }], space: project.space };
    },
    async remove(_app: App, ctx: AppContext, member: AudienceMember) {
      const owner = owners.get(member.space) as Principal;
      const ownerCaller: Caller = { kind: "people", principals: [owner] };
      if (member.principals[0]?.id === owner.id) await projects().remove(member.space, ownerCaller, ctx);
      else await projects().removeMember(member.space, member.principals[0] as Principal, ownerCaller, ctx);
    },
  };
}

/** The default export's App (a server's: every actor is the App). */
function serverFixture(): ConversationAudienceFixture {
  const storage = downableStorage();
  const kept = probe();
  return {
    components: [storage.component, createMemoryMailbox(), createMemoryWakeups(), projectsSql, kept.component],
    source: AUDIENCE_SOURCE,
    ...memberships(kept.projects),
    fail: () => storage.down(),
  };
}

/** The Worker half's App, its mailbox bridged to a backend App running the default export (Cloudflare's split). */
async function workerFixture(): Promise<ConversationAudienceFixture> {
  const backendProbe = probe();
  const backend = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), createMemoryWakeups(), projectsSql, backendProbe.component], logger: silentLogger }).create();
  await backend.start();
  let down = false;
  const bridge = defineComponent({
    name: "bridged-mailbox",
    setup(pikit) {
      const unsupported = () => Promise.reject(new Error("bridged-mailbox: only calls cross"));
      pikit.provide("actor.mailbox", {
        send: unsupported,
        stream: unsupported,
        call: (key, type, message, ctx) => (down ? Promise.reject(new ActorCallError("unreachable", "bridged-mailbox: the backend is down")) : backendProbe.mailbox().call(key, type, message, ctx)),
      } as ActorMailbox);
    },
  });
  const kept = probe();
  return {
    components: [bridge, worker, kept.component],
    source: AUDIENCE_SOURCE,
    ...memberships(kept.projects),
    fail: () => void (down = true),
    dispose: () => backend.stop(),
  };
}

for (const [half, factory] of [
  ["default", serverFixture],
  ["worker", workerFixture],
] as const) {
  for (const c of createConversationAudienceConformance(factory)) test(`projects-sql (${half} half) ${c.group}: ${c.name}`, () => c.run());
}

test("only a project's own space is granted: an adopted one never, an archived project's still", async () => {
  const kept = probe();
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), createMemoryWakeups(), projectsSql, kept.component], logger: silentLogger }).create();
  await app.start();
  try {
    const ctx = app.context();
    const owner: Principal = { channel: "web", id: "u-adopter" };
    const adopted = await kept.projects().create({ name: "Adopted", owner, space: "googlechat:spaces/AAA" }, { kind: "operator", id: "op" }, ctx);
    const own = await kept.projects().create({ name: "Own", owner }, TRUSTED, ctx);
    expect(await kept.projects().roleOf(adopted.space, [owner], ctx)).toBe("owner");
    expect(await audienceGrants(ctx, [owner])).toEqual([{ space: own.space, role: "owner", source: AUDIENCE_SOURCE }]);
    expect(await audienceGrants(ctx, [owner], adopted.space)).toEqual([]);
    expect(await audienceGrants(ctx, [owner], own.space)).toEqual([{ space: own.space, role: "owner", source: AUDIENCE_SOURCE }]);
    await kept.projects().update(own.space, { archived: true }, { kind: "people", principals: [owner] }, ctx);
    expect(await audienceGrants(ctx, [owner])).toEqual([{ space: own.space, role: "owner", source: AUDIENCE_SOURCE }]);
  } finally {
    await app.stop();
  }
});
