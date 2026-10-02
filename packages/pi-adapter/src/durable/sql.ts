/**
 * pi-durable's portable SQLite storage over pikit's `storage.sql` (SPEC §4.1, C5). Spike: see README.md.
 *
 * `SqliteStorage` (`@earendil-works/pi-durable/storage/sqlite`) needs an async `SqliteDatabase` facade;
 * `storage.sql` is one on every SQLite provider pikit has (storage-sqlite's file, storage-do's Durable
 * Object SQL), so one adapter serves a server and a Durable Object alike.
 *
 * - **Queueing and rollback** are the provider's: a `storage.sql` transaction already holds the line
 *   (statements and other transactions outside it wait), commits when its work resolves, and rejects
 *   with the same error after rolling back when it rejects. A failed ROLLBACK surfaces as its own
 *   error (storage-sqlite), which is what `SqliteDatabase` asks for.
 * - **Handles expire.** A transaction handle refuses statements once its callback has settled.
 * - **`exec`** runs one statement per `run`; several are split (`splitSqlStatements`) and, outside a
 *   transaction, run in one, so nothing interleaves between them.
 * - **`bigint`**: `storage.sql` has none. pi-durable 1.0 never binds one (its ids are numbers, its
 *   `next_id` column is TEXT), so a safe-integer bigint binds as a number and a larger one throws.
 * - **`close`** waits for the facade's own operations and refuses new ones; it never closes the
 *   database, which belongs to the app (the provider closes it at stop).
 */

import type { SqlDatabase, SqlStatements, SqlValue } from "@pikit/contracts";
import { type SqliteDatabase, type SqliteExecutor, SqliteStorage, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

export type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
export { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/** pikit's `storage.sql` as the `SqliteDatabase` pi-durable's `SqliteStorage` runs on. */
export function sqliteDatabaseFrom(db: SqlDatabase): SqliteDatabase {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("storage.sql facade is closed"));
    const running = operation();
    const settled = running.then(
      () => {},
      () => {},
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return running;
  };

  const database = executor(db, () => {});
  return {
    exec: (sql) => {
      const statements = splitSqlStatements(sql);
      if (statements.length <= 1) return track(() => database.exec(sql));
      // Several statements are one step of the line, as one `exec` is on a connection.
      return track(() => db.transaction(async (tx) => executor(tx, () => {}).exec(sql)));
    },
    run: (sql, ...params) => track(() => database.run(sql, ...params)),
    get: (sql, ...params) => track(() => database.get(sql, ...params)),
    all: (sql, ...params) => track(() => database.all(sql, ...params)),
    transaction: <T>(callback: (transaction: SqliteExecutor) => Promise<T>) =>
      track(() =>
        db.transaction(async (tx) => {
          let active = true;
          try {
            return await callback(
              executor(tx, () => {
                if (!active) throw new Error("SQLite transaction handle is no longer active");
              }),
            );
          } finally {
            active = false;
          }
        }),
      ),
    async close() {
      closed = true;
      await Promise.all(pending);
    },
  };
}

/** pi-durable's `SqliteStorage` over `storage.sql`: creates or migrates its tables, then opens it. */
export function openDurableStorage(db: SqlDatabase): Promise<SqliteStorage> {
  return SqliteStorage.open(sqliteDatabaseFrom(db));
}

function executor(statements: SqlStatements, assertActive: () => void): SqliteExecutor {
  const guarded = <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    return operation();
  };
  return {
    exec: (sql) =>
      guarded(async () => {
        for (const statement of splitSqlStatements(sql)) await statements.run(statement);
      }),
    run: (sql, ...params) =>
      guarded(async () => {
        await statements.run(sql, params.map(bind));
      }),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) =>
      guarded(async () => (await statements.query(sql, params.map(bind)))[0] as T | undefined),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) =>
      guarded(async () => (await statements.query(sql, params.map(bind))) as unknown as T[]),
  };
}

function bind(value: SqliteValue): SqlValue {
  if (typeof value !== "bigint") return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`storage.sql cannot bind ${value}: integers past 2^53 have no SqlValue`);
  }
  return Number(value);
}

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;

/**
 * SQL text split into its statements, without the separating semicolons; empty and comment-only
 * statements are dropped. Semicolons inside strings, quoted identifiers, comments and a trigger's
 * `BEGIN … END` body (CASE … END included) do not split.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let hasCode = false;
  let words = 0;
  let first = "";
  let trigger = false;
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k === -1) {
          j = sql.length;
          break;
        }
        // A doubled quote is an escaped one; brackets have no escape.
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      hasCode = true;
      i = j;
    } else if (c === ";") {
      if (!trigger || depth === 0) {
        if (hasCode) out.push(sql.slice(start, i).trim());
        start = i + 1;
        hasCode = false;
        words = 0;
        first = "";
        trigger = false;
        depth = 0;
      }
      i++;
    } else {
      WORD.lastIndex = i;
      const word = WORD.exec(sql)?.[0];
      if (word === undefined) {
        if (!/\s/.test(c)) hasCode = true;
        i++;
        continue;
      }
      hasCode = true;
      const upper = word.toUpperCase();
      if (words === 0) first = upper;
      // CREATE [TEMP | TEMPORARY] TRIGGER
      if (words <= 2 && first === "CREATE" && upper === "TRIGGER") trigger = true;
      if (trigger && (upper === "BEGIN" || upper === "CASE")) depth++;
      if (trigger && upper === "END" && depth > 0) depth--;
      words++;
      i += word.length;
    }
  }
  if (hasCode) out.push(sql.slice(start).trim());
  return out;
}
