/**
 * memory-sql's tests, copied with the component: the `memory` suite (`conformance.ts`, the change log's
 * cases included) over an App of memory-sql, an in-memory mailbox (`createMemoryMailbox`, every key's
 * actor is the App, as on a server) and a SQLite database in memory (a restart is a second App over the
 * same database) whose next write can be made to fail before it commits, with one agent kept apart
 * (`agentScope`); the same suite through the Worker half (`worker`), from an App with only a mailbox to
 * the owners' App; then what only this provider promises: an owner's actor answers only for that
 * owner, and checks what it is sent; and how a query becomes FTS5 queries.
 */

import { expect, test } from "bun:test";
import { type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ManualClock } from "@pikit/core/testing";
import { ActorCallError, type ActorMailbox, type SqlDatabase } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import { openSqliteDatabase, sqliteStorage } from "@pikit/pi-adapter/testing";
import { createMemoryConformance } from "./conformance.ts";
import memorySql, { actorKey, CALL, CHANGES, searchAttempts, worker } from "./index.ts";

const SCOPE = { agentScope: ["trader"] };

/**
 * `storage.sql` over one SQLite database in memory, shared by every App it is in (a restart); after
 * `failNextCommit()`, the next transaction's log entry fails, after the memory is written and before it
 * commits (a crash between the two).
 */
function failingStorage() {
  const sqlite = openSqliteDatabase(":memory:");
  let failNext = false;
  const db = sqlite.database;
  const database: SqlDatabase = {
    query: (sql, params) => db.query(sql, params),
    run: (sql, params) => db.run(sql, params),
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: (sql, params) => tx.query(sql, params),
          async run(sql, params) {
            if (failNext && sql.startsWith(`INSERT INTO ${CHANGES} `)) {
              failNext = false;
              throw new Error("storage-failing: the process died before the commit");
            }
            return tx.run(sql, params);
          },
        }),
      ),
  };
  const component = defineComponent({ name: "storage-failing", setup: (pikit) => pikit.provide("storage.sql", database) });
  return { component, failNextCommit: () => void (failNext = true) };
}

for (const c of createMemoryConformance(() => {
  const storage = failingStorage();
  const mailbox = createMemoryMailbox();
  return { components: () => [storage.component, mailbox, memorySql], config: { "memory-sql": SCOPE }, agentScope: ["trader"], failNextCommit: storage.failNextCommit };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}

/** A mailbox that hands every call to `target`'s: the Worker's App reaching the owners' objects. */
const bridge = (target: () => ActorMailbox): ComponentDefinition =>
  defineComponent({
    name: "mailbox-bridge",
    setup: (pikit) =>
      pikit.provide("actor.mailbox", {
        send: (key, type, message, ctx) => target().send(key, type, message, ctx),
        call: (key, type, message, ctx) => target().call(key, type, message, ctx),
        stream: (key, type, message, ctx) => target().stream(key, type, message, ctx),
      }),
  });

/** The owners' App (memory-sql over a database in memory, on `clock`), started; its mailbox. */
async function ownersApp(clock: ManualClock) {
  let mailbox: ActorMailbox | undefined;
  const grab = defineComponent({
    name: "grab-mailbox",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), memorySql, grab], config: { "memory-sql": SCOPE }, clock, logger: silentLogger }).create();
  await app.start();
  return { app, mailbox: () => mailbox as ActorMailbox };
}

for (const c of createMemoryConformance(async (clock) => {
  const owners = await ownersApp(clock);
  return { components: () => [bridge(owners.mailbox), worker], config: { "memory-sql-worker": SCOPE }, agentScope: ["trader"], dispose: () => owners.app.stop() };
})) {
  test(`through the Worker half: ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), memorySql], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "memory-sql")).toEqual({
    name: "memory-sql",
    provides: ["memory"],
    requires: ["storage.sql", "actor.mailbox", "actor.inbox"],
    optional: [],
  });
  const half = await defineApp({ components: [createMemoryMailbox(), worker], logger: silentLogger }).create();
  expect(half.describe().components.find((component) => component.name === "memory-sql-worker")).toEqual({
    name: "memory-sql-worker",
    provides: ["memory"],
    requires: ["actor.mailbox"],
    optional: [],
  });
});

test("an owner's actor refuses a call for another owner, a kind the owner does not keep, and a malformed call, as invalid", async () => {
  let mailbox: ActorMailbox | undefined;
  const caller = defineComponent({
    name: "caller",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), memorySql, caller], logger: silentLogger }).create();
  await app.start();
  try {
    const call = (key: string, type: string, message: Parameters<ActorMailbox["call"]>[2]) => mailbox?.call(key, type, message, app.context());
    const codeOf = (work: Promise<unknown> | undefined) => work?.then(() => "resolved", (error: unknown) => (error instanceof ActorCallError ? error.code : String(error)));
    const team = { type: "space", space: "googlechat:spaces/A" } as const;
    const other = { type: "space", space: "googlechat:spaces/B" } as const;
    const ana = { type: "person", channel: "googlechat", id: "users/1" } as const;
    const fact = { id: "x", kind: "fact", status: "active", text: "likes tea", createdAt: 1 };

    expect(await codeOf(call(actorKey(other), CALL.list, { owner: team, kinds: ["fact"], limit: 10 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(other), CALL.remember, { owner: team, memory: fact }))).toBe("invalid");
    expect(await codeOf(call(actorKey(ana), CALL.list, { owner: team, kinds: ["fact"], limit: 10 }))).toBe("invalid");
    // A person's channel with a colon is not another person's key.
    expect(await codeOf(call(actorKey({ type: "person", channel: "a", id: "b:c" }), CALL.list, { owner: { type: "person", channel: "a:b", id: "c" }, kinds: ["preference"], limit: 1 }))).toBe(
      "invalid",
    );
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["fact"], limit: 0 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["secret"], limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["preference"], limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: [], limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["rule"], status: "maybe", limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.remember, { owner: team, memory: { ...fact, createdAt: undefined } as never }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.forget, { owner: { type: "space" }, id: "x", kinds: ["fact"] }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.approve, { owner: team, id: "x", kind: "preference" }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, ["not", "an", "object"]))).toBe("invalid");
    expect(await call(actorKey(team), CALL.list, { owner: team, kinds: ["fact"], limit: 10 })).toEqual([]);
  } finally {
    await app.stop();
  }
});

test("a query becomes FTS5 queries of its quoted words: all, the phrase, any; none without a word", () => {
  expect(searchAttempts("ana@example.com")).toEqual(['"ana" AND "example" AND "com"', '"ana example com"', '"ana" OR "example" OR "com"']);
  expect(searchAttempts('tea "NOT" (cake*')).toEqual(['"tea" AND "NOT" AND "cake"', '"tea NOT cake"', '"tea" OR "NOT" OR "cake"']);
  expect(searchAttempts("tea")).toEqual(['"tea"']);
  expect(searchAttempts("?! -- ...")).toEqual([]);
});
