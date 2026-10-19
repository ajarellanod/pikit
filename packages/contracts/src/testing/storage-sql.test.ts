/**
 * The portable SQL and SQLite suites against `node:sqlite` in memory,
 * one statement at a time. It proves the suite asks only what the contract promises;
 * `storage-sqlite` is the real component, with a file.
 */

import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { defineComponent } from "@pikit/core";
import type { SqlDatabase, SqlRow, SqlStatements, SqlValue } from "../storage.ts";
import { createSqlDatabaseConformance, createSqliteDatabaseConformance } from "./storage-sql.ts";

function memoryDatabase(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  let line: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = line.then(work);
    line = next.catch(() => {});
    return next;
  };
  const statements: SqlStatements = {
    query: async <Row extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []) => db.prepare(sql).all(...params) as Row[],
    run: async (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
  };
  return {
    query: (sql, params) => serial(() => statements.query(sql, params)),
    run: (sql, params) => serial(() => statements.run(sql, params)),
    transaction: (work) =>
      serial(async () => {
        db.exec("BEGIN");
        try {
          const result = await work(statements);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
}

function fixture(database = memoryDatabase()) {
  // One database per case, shared by the apps the case starts, as a file would be.
  return {
    components: [defineComponent({
      name: "memory-sql",
      setup(pikit) {
        pikit.provide("storage.sql", database);
        pikit.provide("storage.sqlite", database);
      },
    })],
  };
}

for (const suite of [createSqlDatabaseConformance, createSqliteDatabaseConformance]) {
  for (const c of suite(() => fixture())) test(`${c.group}: ${c.name}`, () => c.run());
}

test("the SQLite suite rejects a provider that reuses committed ids", async () => {
  const database = memoryDatabase();
  const broken: SqlDatabase = {
    ...database,
    run: (sql, params) => database.run(sql.replace(" AUTOINCREMENT", ""), params),
  };
  const c = createSqliteDatabaseConformance(() => fixture(broken)).find((c) => c.name.includes("AUTOINCREMENT"));
  if (c === undefined) throw new Error("missing SQLite sequence conformance case");
  await expect(c.run()).rejects.toThrow("a pruned id never to be reused");
});

test("portable SQL alone does not satisfy the SQLite contract", async () => {
  const database = memoryDatabase();
  const [c] = createSqliteDatabaseConformance(() => ({
    components: [defineComponent({ name: "portable-sql", setup: (pikit) => void pikit.provide("storage.sql", database) })],
  }));
  if (c === undefined) throw new Error("missing SQLite conformance cases");
  await expect(c.run()).rejects.toThrow("storage.sqlite");
});
