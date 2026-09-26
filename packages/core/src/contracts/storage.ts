/**
 * `storage.sql` (SPEC §4.5, §16): a SQL database for the components that must keep records across
 * restarts: the outbox's deliveries, a scheduler's jobs, approvals. SQLite on a server
 * (`storage-sqlite`), a Durable Object's SQL on Cloudflare, Postgres later: each is a component
 * providing this contract.
 *
 * - **Async.** `[decision]` Postgres cannot be sync; SQLite and Durable Object SQL wrap in promises
 *   at no cost.
 * - **Parameters are bound**, never interpolated: `?` placeholders, one value each.
 * - **One database per app.** Each component owns its tables and prefixes them with its name
 *   (`outbox_…`), creating them in `start` (`CREATE TABLE IF NOT EXISTS`).
 * - **A transaction runs statements only**: no network call, no timer, nothing but `tx`'s own
 *   statements. A store that is sync underneath (SQLite, Durable Object SQL) may then run it as one
 *   step, and a stalled transaction never holds the database. Inside `work`, use `tx`: calling the
 *   database itself waits for the transaction to end, which never happens.
 * - The SQL dialect is the common subset of SQLite and Postgres a component chooses to use; this
 *   contract does not translate it.
 */

/** A value bound to a parameter or read from a column. Integers read back as `number`. */
export type SqlValue = string | number | null | Uint8Array;

/** One row, by column name. */
export type SqlRow = Record<string, SqlValue>;

export interface SqlStatements {
  /** The rows a statement returns (`SELECT`, or `… RETURNING`). */
  query<Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  /** A statement that changes something; how many rows it changed. */
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
}

export interface SqlDatabase extends SqlStatements {
  /**
   * `work`'s statements as one transaction: all of them commit when `work` resolves, none when it
   * rejects (with the same error). Transactions and statements outside them never interleave: a
   * statement outside waits, and never sees half of a transaction.
   */
  transaction<T>(work: (tx: SqlStatements) => Promise<T>): Promise<T>;
}

declare module "../capabilities.ts" {
  interface AppCapabilities {
    "storage.sql": SqlDatabase;
  }
}
