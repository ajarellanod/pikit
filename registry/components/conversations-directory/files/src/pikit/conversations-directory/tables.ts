/**
 * conversations-directory's tables, each made at its first use (an App makes only those it uses):
 *
 * - **The directory's** (`_entries`, `_viewers`, `_activity`): on a server the App's own `storage.sql`;
 *   on Cloudflare the index object's (`conversations-directory:index`) only.
 * - **Each conversation's App's** (`_outbox`, `_titles`): on a server the same database; on Cloudflare
 *   each conversation's object's.
 *
 * Portable SQL (`storage.sql`): `BIGINT` for times, `ON CONFLICT` upserts, no rowids.
 */

import type { SqlDatabase } from "@pikit/contracts";

/** One row per conversation (a key and its runtime conversation): its place, activity, title and state for everyone. */
export const ENTRIES = "conversations_directory_entries";
/** One row per viewer (`viewerKey`) and conversation: hidden for me, read up to, my own name. */
export const VIEWERS = "conversations_directory_viewers";
/** The newest activity of each conversation (at most `ACTIVITY_KEPT`): who, when, whether people see it. For `unread`. */
export const ACTIVITY = "conversations_directory_activity";
/** In each conversation's App: what the directory is not told yet, one merged update per conversation. */
export const OUTBOX = "conversations_directory_outbox";
/** In each conversation's App: what titles it (the text, the model's tries) and the record that it was told. */
export const TITLES = "conversations_directory_titles";

/** Activity rows kept per conversation: enough for `unread`, capped at `UNREAD_MAX`. */
export const ACTIVITY_KEPT = 100;

const DIRECTORY = [
  `CREATE TABLE IF NOT EXISTS ${ENTRIES} (key TEXT NOT NULL, conversation TEXT NOT NULL, channel TEXT, agent TEXT, space TEXT, owner TEXT, ` +
    "delegated INTEGER NOT NULL DEFAULT 0, is_current INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL DEFAULT 0, last_activity BIGINT NOT NULL DEFAULT 0, " +
    "shown_activity BIGINT NOT NULL DEFAULT 0, busy INTEGER NOT NULL DEFAULT 0, seq BIGINT NOT NULL DEFAULT 0, title TEXT, title_source TEXT, title_at BIGINT, " +
    "title_search TEXT, state TEXT NOT NULL DEFAULT 'listed', state_at BIGINT, state_by TEXT, PRIMARY KEY (key, conversation))",
  `CREATE INDEX IF NOT EXISTS ${ENTRIES}_shown ON ${ENTRIES} (shown_activity, key, conversation)`,
  `CREATE INDEX IF NOT EXISTS ${ENTRIES}_owner ON ${ENTRIES} (owner, shown_activity)`,
  `CREATE INDEX IF NOT EXISTS ${ENTRIES}_space ON ${ENTRIES} (space, shown_activity)`,
  `CREATE INDEX IF NOT EXISTS ${ENTRIES}_last ON ${ENTRIES} (last_activity, key, conversation)`,
  `CREATE TABLE IF NOT EXISTS ${VIEWERS} (viewer TEXT NOT NULL, key TEXT NOT NULL, conversation TEXT NOT NULL, hidden_at BIGINT, read_at BIGINT, name TEXT, name_search TEXT, ` +
    "PRIMARY KEY (viewer, key, conversation))",
  `CREATE TABLE IF NOT EXISTS ${ACTIVITY} (key TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL, at BIGINT NOT NULL, by TEXT NOT NULL, shown INTEGER NOT NULL, ` +
    "PRIMARY KEY (key, conversation, id))",
  `CREATE INDEX IF NOT EXISTS ${ACTIVITY}_at ON ${ACTIVITY} (key, conversation, at)`,
];

const LOCAL = [
  `CREATE TABLE IF NOT EXISTS ${OUTBOX} (key TEXT NOT NULL, conversation TEXT NOT NULL, patch TEXT NOT NULL, seq BIGINT NOT NULL, PRIMARY KEY (key, conversation))`,
  `CREATE TABLE IF NOT EXISTS ${TITLES} (key TEXT NOT NULL, conversation TEXT NOT NULL, agent TEXT, input TEXT, tries INTEGER NOT NULL DEFAULT 0, ` +
    "due INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, conversation))",
];

/** `sql()` once `statements` ran on it (the first call runs them; a failure is tried again by the next). */
function lazily(sql: () => SqlDatabase, statements: readonly string[]): () => Promise<SqlDatabase> {
  let ready: Promise<void> | undefined;
  return async () => {
    const db = sql();
    ready ??= (async () => {
      for (const statement of statements) await db.run(statement);
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return db;
  };
}

/** The directory's database, its tables made at the first use. */
export const directoryTables = (sql: () => SqlDatabase) => lazily(sql, DIRECTORY);
/** A conversation's App's database (outbox, titles), its tables made at the first use. */
export const localTables = (sql: () => SqlDatabase) => lazily(sql, LOCAL);
