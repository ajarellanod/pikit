/**
 * storage-sqlite: the app's SQL database in one SQLite file (SPEC §4.5, `storage.sql`).
 *
 * Components that keep records across restarts (the outbox's deliveries, a scheduler's jobs) use it
 * through `storage.sql`; each creates and prefixes its own tables. It is `node:sqlite`, which Bun
 * and Node >= 22 both ship, so no native module is installed.
 *
 * - **One connection, one statement at a time.** Statements and transactions run in order on one
 *   line, so a transaction is never interleaved with anything, and a statement outside it never
 *   sees half of it. A transaction's work may only run statements (the contract): it holds the line
 *   while it runs.
 * - **WAL**, so a reader in another process (`sqlite3` in a shell, a backup) never blocks the app,
 *   and a `busy_timeout` for when one briefly locks it.
 * - Stopping waits for the statement in flight (the stop deadline bounds the wait), then closes.
 *
 * Target: `server` (it uses a file).
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineComponent, type SqlDatabase, type SqlRow, type SqlStatements, type SqlValue } from "@pikit/core";
import Type from "typebox";

const Config = Type.Object({
  /** The database file, relative to the working directory. */
  path: Type.String({ minLength: 1, default: ".pikit/pikit.db" }),
  /** How long a statement waits for a lock another process holds, in milliseconds. */
  busyTimeoutMs: Type.Integer({ minimum: 0, default: 5_000 }),
});

export default defineComponent({
  name: "storage-sqlite",
  config: Config,
  setup(pikit, config) {
    let db: DatabaseSync | undefined;
    let line: Promise<unknown> = Promise.resolve();
    /** Runs `work` after everything queued before it, whether that succeeded or failed. */
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = line.then(work);
      line = next.catch(() => {});
      return next;
    };
    const open = (): DatabaseSync => {
      if (db === undefined) throw new Error("storage-sqlite: storage.sql used while the app is not running");
      return db;
    };

    // Statements run directly on the connection: the caller already holds the line.
    const statements: SqlStatements = {
      query: async <Row extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []) => open().prepare(sql).all(...params) as Row[],
      run: async (sql, params = []) => ({ changes: Number(open().prepare(sql).run(...params).changes) }),
    };

    const database: SqlDatabase = {
      query: (sql, params) => serial(() => statements.query(sql, params)),
      run: (sql, params) => serial(() => statements.run(sql, params)),
      transaction: (work) =>
        serial(async () => {
          const connection = open();
          connection.exec("BEGIN IMMEDIATE");
          try {
            const result = await work(statements);
            connection.exec("COMMIT");
            return result;
          } catch (error) {
            // A failed COMMIT leaves no transaction open; only roll back one that is.
            if (connection.isTransaction) connection.exec("ROLLBACK");
            throw error;
          }
        }),
    };
    pikit.provide("storage.sql", database);

    return {
      async start() {
        const file = resolve(config.path);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const connection = new DatabaseSync(file);
        try {
          connection.exec("PRAGMA journal_mode = WAL");
          connection.exec(`PRAGMA busy_timeout = ${config.busyTimeoutMs}`);
          connection.exec("PRAGMA foreign_keys = ON");
          // A file that is not a database fails here, not at the first component's statement.
          connection.prepare("SELECT count(*) FROM sqlite_schema").get();
        } catch (error) {
          connection.close();
          throw new Error(`storage-sqlite: cannot use ${file} as a database: ${error instanceof Error ? error.message : String(error)}`);
        }
        db = connection;
      },
      async stop(ctx) {
        const connection = db;
        if (connection === undefined) return;
        // Let the statement in flight finish; the stop deadline bounds the wait.
        await untilAborted(line, ctx.abortSignal);
        db = undefined;
        connection.close();
      },
    };
  },
});

function untilAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  const settled = work.then(
    () => {},
    () => {},
  );
  if (signal === undefined) return settled;
  return Promise.race([
    settled,
    new Promise<void>((done) => {
      if (signal.aborted) done();
      signal.addEventListener("abort", () => done(), { once: true });
    }),
  ]);
}
