/**
 * A `storage.sql` over one SQLite file, for tests: what `storage-sqlite` provides on a server (one
 * connection, one statement at a time, WAL, a busy timeout), in a few lines and with no component.
 *
 * With `durableObjectLimits`, every statement is first checked against what a Cloudflare Durable
 * Object's SQL refuses, so a store tested here is known to fit there: at most 100 bound parameters,
 * 100 KB of SQL text, 2 MB per bound value (a row holds at most 2 MB), and no `LIKE` or `GLOB` (a
 * pattern over ~50 bytes fails there). A statement over a limit rejects, as it would on Cloudflare.
 */

import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase, SqlRow, SqlStatements, SqlValue } from "@pikit/contracts";

export interface SqliteDatabase {
  database: SqlDatabase;
  /** Waits for the statement in flight, then closes the file. */
  close(): Promise<void>;
}

const MAX_PARAMS = 100;
const MAX_SQL_BYTES = 100 * 1024;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;

export function openSqliteDatabase(path: string, options: { durableObjectLimits?: boolean } = {}): SqliteDatabase {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  const encoder = new TextEncoder();
  const check = (sql: string, params: readonly SqlValue[]) => {
    if (options.durableObjectLimits !== true) return;
    if (params.length > MAX_PARAMS) throw new Error(`Durable Object limit: ${params.length} bound parameters (at most ${MAX_PARAMS})`);
    if (encoder.encode(sql).length > MAX_SQL_BYTES) throw new Error("Durable Object limit: a statement over 100 KB");
    if (/\b(LIKE|GLOB)\b/i.test(sql)) throw new Error("Durable Object limit: LIKE and GLOB fail on long patterns; use a range");
    for (const param of params) {
      const bytes = typeof param === "string" ? encoder.encode(param).length : param instanceof Uint8Array ? param.length : 0;
      if (bytes > MAX_VALUE_BYTES) throw new Error(`Durable Object limit: a bound value of ${bytes} bytes (a row holds at most 2 MB)`);
    }
  };

  let line: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = line.then(work);
    line = next.catch(() => {});
    return next;
  };
  const statements: SqlStatements = {
    query: async <Row extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []) => {
      check(sql, params);
      return db.prepare(sql).all(...params) as Row[];
    },
    run: async (sql, params = []) => {
      check(sql, params);
      return { changes: Number(db.prepare(sql).run(...params).changes) };
    },
  };
  const database: SqlDatabase = {
    query: (sql, params) => serial(() => statements.query(sql, params)),
    run: (sql, params) => serial(() => statements.run(sql, params)),
    transaction: (work) =>
      serial(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await work(statements);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
  return {
    database,
    async close() {
      await line;
      db.close();
    },
  };
}
