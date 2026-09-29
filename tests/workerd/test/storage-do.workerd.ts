/**
 * storage-do on a real SQLite-backed Durable Object: the `storage.sql` suite, and `storage-kv-sql`'s
 * `storage.kv` suite over it, each case in an object of its own. Then the start the way
 * `deployment-cloudflare` does it, and the object's SQL limits its README states.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type SqlDatabase, WORKERS_HOST } from "@pikit/contracts";
import { createKeyValueConformance, createSqlDatabaseConformance, withWorkersHost } from "@pikit/contracts/testing";
import { expect, it } from "vitest";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { inObject, objectHost } from "./host.ts";

for (const c of createSqlDatabaseConformance(() => ({ components: withWorkersHost(objectHost(), [storageDo]) }))) {
  it(`storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

for (const c of createKeyValueConformance(() => ({ components: withWorkersHost(objectHost(), [storageDo, storageKvSql]) }))) {
  it(`storage-kv-sql over storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

/** An app of storage-do started with `host` in app.start's context, and its `storage.sql`. */
async function started(): Promise<{ db: SqlDatabase; stop(): Promise<void> }> {
  let db: SqlDatabase | undefined;
  const user = defineComponent({
    name: "storage-user",
    setup(pikit) {
      const handle = pikit.use("storage.sql");
      return { start: () => void (db = handle.get()) };
    },
  });
  const app = await defineApp({ components: [storageDo, user], logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, objectHost(), BACKGROUND_CONTEXT));
  if (db === undefined) throw new Error("storage.sql was not resolved");
  return { db, stop: () => app.stop() };
}

it("storage-do reads the object from app.start's context, as deployment-cloudflare passes it", () =>
  inObject(async () => {
    const { db, stop } = await started();
    await db.run("CREATE TABLE seen (v TEXT)");
    expect(await db.run("INSERT INTO seen (v) VALUES (?), (?)", ["a", "b"])).toEqual({ changes: 2 });
    expect(await db.query("SELECT v FROM seen ORDER BY v")).toEqual([{ v: "a" }, { v: "b" }]);
    await stop();
  }));

it("the object's SQL limits in storage-do's README hold: long LIKE patterns fail, no BEGIN", () =>
  inObject(async () => {
    const { db, stop } = await started();
    await db.run("CREATE TABLE k (k TEXT)");
    await db.run("INSERT INTO k (k) VALUES (?)", ["short"]);
    expect(await db.query("SELECT k FROM k WHERE k LIKE ?", ["sho%"])).toEqual([{ k: "short" }]);
    await expect(db.query("SELECT k FROM k WHERE k LIKE ?", [`${"x".repeat(60)}%`])).rejects.toThrow(/pattern too complex/);
    await expect(db.run("BEGIN")).rejects.toThrow();
    await stop();
  }));

it("runs in workerd, not in Node", () => {
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
});
