/**
 * The `storage.sql` suite against the smallest database that could pass it: `node:sqlite` in memory,
 * one statement at a time. It proves the suite asks only what the contract promises (S12);
 * `storage-sqlite` is the real component, with a file.
 */

import { test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { defineComponent } from "../app.ts";
import type { SqlDatabase, SqlRow, SqlStatements, SqlValue } from "../contracts/storage.ts";
import { createSqlDatabaseConformance } from "./storage-sql.ts";

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

for (const c of createSqlDatabaseConformance(() => {
  // One database per case, shared by the apps the case starts, as a file would be.
  const database = memoryDatabase();
  return { components: [defineComponent({ name: "memory-sql", setup: (pikit) => void pikit.provide("storage.sql", database) })] };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
