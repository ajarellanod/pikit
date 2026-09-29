/**
 * The tables of Pi sessions on `storage.sql`, and how a payload too large for one row is kept.
 *
 * One row per session (`sessions_sql_sessions`, with its sequence high-water mark and running totals),
 * and one table per kind of record a session commits: entries, usage rows, scalar values and list
 * elements. Every record carries the session-wide `seq` Pi assigned it, which is unique within the
 * session, so a payload split in parts is keyed by it (`sessions_sql_chunks`).
 *
 * The dialect is the common subset of SQLite and a Durable Object's SQL, within the object's limits:
 * - **2 MB per row.** A payload (an entry's JSON with an image, a queued message) is stored inline up
 *   to `CHUNK_CHARS`, and in parts of that size beyond it. `CHUNK_CHARS` UTF-16 units are at most three
 *   times as many UTF-8 bytes: 768 KB.
 * - **100 bound parameters per statement.** Lists of ids are bound in batches of `BATCH`.
 * - **100 KB per statement.** Every statement is a constant; values are always bound.
 * - **No LIKE or GLOB** (patterns over ~50 bytes fail): a key prefix is a range (`prefixEnd`).
 *
 * The tables are sessions-sql's (`sessions_sql_`), migrated like the other components' tables: a
 * `schema_version` in `sessions_sql_meta`, one transaction per step, the version read inside it.
 */

import type { SqlDatabase, SqlStatements } from "@pikit/contracts";

export const SESSIONS = "sessions_sql_sessions";
export const ENTRIES = "sessions_sql_entries";
export const USAGE = "sessions_sql_usage";
export const VALUES = "sessions_sql_values";
export const LISTS = "sessions_sql_lists";
export const CHUNKS = "sessions_sql_chunks";
const META = "sessions_sql_meta";

/** The largest payload kept inline, and the size of each part of a larger one, in UTF-16 units. */
export const CHUNK_CHARS = 256 * 1024;
/** Ids bound per statement, below the Durable Object's 100 parameters (a statement binds a few more). */
export const BATCH = 90;

/**
 * The schema, one step per version: `sessions_sql_meta.schema_version` says how many have run. A
 * payload column (`json`) is `NULL` when its record is stored in `parts` chunks, and also when Pi
 * stored `undefined` (a value set to `undefined`); `parts` is 0 then.
 */
const MIGRATIONS: readonly ((tx: SqlStatements) => Promise<void>)[] = [
  async (tx) => {
    await tx.run(`CREATE TABLE ${SESSIONS} (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      storage_version INTEGER NOT NULL,
      cwd TEXT,
      parent_session_id TEXT,
      next_seq INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      usage_json TEXT NOT NULL
    )`);
    await tx.run(`CREATE TABLE ${ENTRIES} (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      parent_id TEXT,
      type TEXT NOT NULL,
      custom_type TEXT,
      timestamp_ms INTEGER NOT NULL,
      json TEXT,
      parts INTEGER NOT NULL,
      PRIMARY KEY (session_id, id),
      UNIQUE (session_id, seq)
    )`);
    await tx.run(`CREATE TABLE ${USAGE} (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT,
      parts INTEGER NOT NULL,
      PRIMARY KEY (session_id, id),
      UNIQUE (session_id, seq)
    )`);
    await tx.run(`CREATE TABLE ${VALUES} (
      session_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      address_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT,
      parts INTEGER NOT NULL,
      PRIMARY KEY (session_id, namespace, address_key)
    )`);
    await tx.run(`CREATE TABLE ${LISTS} (
      session_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      address_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT,
      parts INTEGER NOT NULL,
      PRIMARY KEY (session_id, namespace, address_key, seq)
    )`);
    await tx.run(`CREATE TABLE ${CHUNKS} (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      part INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (session_id, seq, part)
    )`);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Brings the tables to `SCHEMA_VERSION`, refusing a database written by a newer version. Each step
 * reads the version in the transaction that runs it, so two processes starting at once never both
 * run one step (on SQLite, `BEGIN IMMEDIATE` takes the write lock before the read).
 */
export async function migrate(db: SqlDatabase): Promise<void> {
  await db.run(`CREATE TABLE IF NOT EXISTS ${META} (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
  let done = false;
  while (!done) {
    done = await db.transaction(async (tx) => {
      const [row] = await tx.query<{ value: number }>(`SELECT value FROM ${META} WHERE name = 'schema_version'`);
      const version = row?.value ?? 0;
      if (version > SCHEMA_VERSION) {
        throw new Error(`sessions-sql: the database is at schema version ${version}, newer than this version's ${SCHEMA_VERSION}; upgrade @pikit/pi-adapter`);
      }
      if (version === SCHEMA_VERSION) return true;
      await (MIGRATIONS[version] as (tx: SqlStatements) => Promise<void>)(tx);
      await tx.run(`INSERT INTO ${META} (name, value) VALUES ('schema_version', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`, [version + 1]);
      return false;
    });
  }
}

/** A payload as stored: inline JSON, or `NULL` and its parts. `undefined` (no JSON at all) is `NULL` with no parts. */
export interface Payload {
  json: string | null;
  parts: string[];
}

export function encode(value: unknown): Payload {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) return { json: null, parts: [] };
  if (text.length <= CHUNK_CHARS) return { json: text, parts: [] };
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    // Never split a surrogate pair: half of one is not valid text, and SQLite would store it altered.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return { json: null, parts };
}

/** Stores the parts of the record `seq` of `session`, when it has any. */
export async function writeParts(tx: SqlStatements, session: string, seq: number, payload: Payload): Promise<void> {
  for (const [part, text] of payload.parts.entries()) {
    await tx.run(`INSERT INTO ${CHUNKS} (session_id, seq, part, text) VALUES (?, ?, ?, ?)`, [session, seq, part, text]);
  }
}

/** A stored record's value: its inline JSON, or its parts joined. */
export async function decode(tx: SqlStatements, session: string, row: { seq: number; json: string | null; parts: number }): Promise<unknown> {
  if (row.parts === 0) return row.json === null ? undefined : JSON.parse(row.json);
  const parts = await tx.query<{ text: string }>(`SELECT text FROM ${CHUNKS} WHERE session_id = ? AND seq = ? ORDER BY part`, [session, row.seq]);
  if (parts.length !== row.parts) throw new Error(`sessions-sql: record ${row.seq} of session ${session} has ${parts.length} of its ${row.parts} parts`);
  return JSON.parse(parts.map((part) => part.text).join(""));
}

/**
 * The smallest string after every string starting with `prefix`, in code point order (SQLite's
 * `BINARY` order on UTF-8): `key >= prefix AND key < prefixEnd(prefix)` selects exactly the keys
 * starting with it. `undefined` when there is none (an empty prefix, or only U+10FFFF).
 */
export function prefixEnd(prefix: string): string | undefined {
  const points = Array.from(prefix, (character) => character.codePointAt(0) as number);
  while (points.length > 0) {
    const last = points.pop() as number;
    if (last < 0x10ffff) return String.fromCodePoint(...points, last + 1 === 0xd800 ? 0xe000 : last + 1);
  }
  return undefined;
}

/** `ids` in batches of `BATCH`, with their placeholders. */
export function* batches(ids: readonly string[]): Generator<{ ids: string[]; marks: string }> {
  for (let start = 0; start < ids.length; start += BATCH) {
    const slice = ids.slice(start, start + BATCH);
    yield { ids: slice, marks: slice.map(() => "?").join(", ") };
  }
}

