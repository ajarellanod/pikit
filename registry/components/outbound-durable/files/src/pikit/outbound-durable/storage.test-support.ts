/**
 * For the tests only: a `storage.sql` over one SQLite file, so outbound-durable's tests need no other
 * component (a component never imports another's files). `storage-sqlite` is the real one.
 */

import { DatabaseSync } from "node:sqlite";
import { defineComponent, type SqlDatabase, type SqlRow, type SqlStatements, type SqlValue } from "@pikit/core";

export function testStorage(path: string) {
  let db: DatabaseSync | undefined;
  let line: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = line.then(work);
    line = next.catch(() => {});
    return next;
  };
  const open = () => {
    if (db === undefined) throw new Error("test storage: not running");
    return db;
  };
  const statements: SqlStatements = {
    query: async <Row extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []) => open().prepare(sql).all(...params) as Row[],
    run: async (sql, params = []) => ({ changes: Number(open().prepare(sql).run(...params).changes) }),
  };
  const database: SqlDatabase = {
    query: (sql, params) => serial(() => statements.query(sql, params)),
    run: (sql, params) => serial(() => statements.run(sql, params)),
    transaction: (work) =>
      serial(async () => {
        open().exec("BEGIN IMMEDIATE");
        try {
          const result = await work(statements);
          open().exec("COMMIT");
          return result;
        } catch (error) {
          if (open().isTransaction) open().exec("ROLLBACK");
          throw error;
        }
      }),
  };
  return defineComponent({
    name: "test-storage",
    setup(pikit) {
      pikit.provide("storage.sql", database);
      return {
        start() {
          db = new DatabaseSync(path);
          db.exec("PRAGMA journal_mode = WAL");
        },
        async stop() {
          await line.catch(() => {});
          db?.close();
          db = undefined;
        },
      };
    },
  });
}
