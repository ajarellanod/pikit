// better-auth's own adapter suite (`@better-auth/test-utils/adapter`, 1.7.7) against `sqlAdapter` on
// a SQLite file with Durable Object limits (no LIKE, at most 100 parameters), as storage.sql is on
// both targets. The suite is written for vitest; bun maps `vitest` onto bun:test itself, but
// its tests take vitest's `(name, options, fn({ onTestFailed, skip }))`: `test.skipIf` is adapted to it
// (calls of bun's own shape pass through).

import * as bun from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlDatabase } from "@pikit/contracts";
import { openSqliteDatabase, type SqliteDatabase } from "@pikit/pi-adapter/testing";
import { migrate, quote, sqlAdapter, whereSql } from "./adapter.ts";

/** vitest's test context on bun:test. `skip()` inside a test ends it as passed. */
class Skipped extends Error {}
const skipIf = bun.test.skipIf.bind(bun.test);
(bun.test as unknown as { skipIf: unknown }).skipIf =
  (condition: boolean) =>
  (name: string, options: unknown, fn: unknown): void => {
    if (typeof options === "function") return skipIf(condition)(name, options as () => void, fn as number);
    const vitestFn = fn as (context: unknown) => Promise<void>;
    skipIf(condition)(
      name,
      async () => {
        const failed: Array<() => unknown> = [];
        try {
          await vitestFn({
            onTestFailed: (callback: () => unknown) => failed.push(callback),
            skip: (when?: unknown) => {
              if (when === undefined || typeof when === "string" || when === true) throw new Skipped();
            },
          });
        } catch (error) {
          if (error instanceof Skipped) return;
          for (const callback of failed) await callback();
          throw error;
        }
      },
      (options as { timeout?: number }).timeout,
    );
  };

const dir = mkdtempSync(join(tmpdir(), "channel-web-adapter-"));
let open: SqliteDatabase | undefined;
let generation = 0;
const database = (): SqlDatabase => {
  if (open === undefined) throw new Error("no database");
  return open.database;
};

/** A test-only migration: every table better-auth's options name, as the suite changes them. */
async function migrateFor(options: object): Promise<void> {
  const { getAuthTables } = await import("better-auth/db");
  await open?.close();
  open = openSqliteDatabase(join(dir, `suite-${generation++}.db`), { durableObjectLimits: true });
  const tables = getAuthTables(options as never);
  for (const table of Object.values(tables)) {
    const columns = [`"id" TEXT PRIMARY KEY`];
    for (const [key, field] of Object.entries(table.fields)) {
      const type =
        field.type === "number" ? (field.bigint === true ? "BIGINT" : "INTEGER") : field.type === "boolean" ? "INTEGER" : "TEXT";
      columns.push(`${quote(field.fieldName ?? key)} ${type}${field.unique === true ? " UNIQUE" : ""}`);
    }
    await database().run(`CREATE TABLE IF NOT EXISTS ${quote(table.modelName)} (${columns.join(", ")})`);
  }
}

bun.afterAll(async () => {
  await open?.close();
  rmSync(dir, { recursive: true, force: true });
});

bun.test("the shipped tables: made twice without error, named channel_web_*", async () => {
  const sqlite = openSqliteDatabase(join(dir, "shipped.db"), { durableObjectLimits: true });
  try {
    await migrate(sqlite.database);
    await migrate(sqlite.database);
    const rows = await sqlite.database.query<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name");
    bun.expect(rows.map((r) => r.name).filter((n) => !n.startsWith("sqlite_"))).toEqual([
      "channel_web_account",
      "channel_web_account_provider",
      "channel_web_account_user",
      "channel_web_session",
      "channel_web_session_token",
      "channel_web_session_user",
      "channel_web_user",
      "channel_web_user_created",
      "channel_web_user_email",
      "channel_web_verification",
      "channel_web_verification_identifier",
    ]);
  } finally {
    await sqlite.close();
  }
});

bun.test("where: AND clauses, then the OR clauses as one group; empty IN matches nothing", () => {
  const params: unknown[] = [];
  const sql = whereSql(
    [
      { field: "a", value: 1, operator: "eq", connector: "AND", mode: "sensitive" },
      { field: "b", value: "x", operator: "eq", connector: "OR", mode: "insensitive" },
      { field: "c", value: null, operator: "eq", connector: "OR", mode: "sensitive" },
      { field: "d", value: [], operator: "in", connector: "AND", mode: "sensitive" },
    ],
    params as never,
  );
  bun.expect(sql).toBe(` WHERE "a" = ? AND 1 = 0 AND (LOWER("b") = ? OR "c" IS NULL)`);
  bun.expect(params).toEqual([1, "x"]);
});

const { testAdapter, normalTestSuite, authFlowTestSuite, caseInsensitiveTestSuite, joinsTestSuite, uuidTestSuite, transactionsTestSuite } =
  await import("@better-auth/test-utils/adapter");

// bun's `expect(promise).resolves.not.toThrow()` fails on a promise of `undefined` (vitest passes
// it): that case is the test below instead.
const bunIncompatible = { disableTests: { "delete - should not throw on record not found": true } };

bun.test("delete of a missing record resolves", async () => {
  await migrateFor({});
  const adapter = sqlAdapter({ database })({});
  bun.expect(await adapter.delete({ model: "user", where: [{ field: "id", value: "100000" }] })).toBeUndefined();
});

const { execute } = await testAdapter({
  adapter: () => sqlAdapter({ database }),
  runMigrations: migrateFor,
  tests: [
    normalTestSuite(bunIncompatible),
    authFlowTestSuite(),
    caseInsensitiveTestSuite(),
    joinsTestSuite(bunIncompatible),
    uuidTestSuite(bunIncompatible),
    // `transaction: false` (storage.sql's transactions run statements only): no rollback to test.
    transactionsTestSuite({ disableTests: { ALL: true } }),
  ],
});
execute();
