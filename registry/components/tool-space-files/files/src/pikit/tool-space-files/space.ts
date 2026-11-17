/**
 * The space's index actor: one per space, `space-files:<space>`, reached through `actor.mailbox`'s
 * `call` and answered here with `actor.inbox`'s `answer`, over the `storage.sql` of the App the actor
 * runs in (as memory-sql's owner actors). On a server (mailbox-local) every key's actor is the App
 * itself, one database; on Cloudflare (actors-do) it is the Durable Object `space-files:<space>`, so a
 * space's writes are ordered and its index, texts and log are in its own object.
 *
 * - **It answers only for its space**: every call carries `space`, and a call whose space is not the
 *   actor's (`key !== "space-files:" + space`), or a malformed one, is refused as `invalid`. Every
 *   message is checked on arrival: it crossed an actor as JSON (authors with `parseAuthor`).
 * - **It holds the index, the texts and the log, never the bytes being saved**: the caller writes the
 *   bytes to `storage.blob` before it calls `save` (so the index never names bytes that were not
 *   written). The actor deletes bytes itself only when it purges (a trashed name 30 days on, a space).
 * - **`save` is one transaction**: the idempotency check (a second `save` of an id answers the version
 *   kept the first time), the limits, the version, the row, its text parts and its log entry. Two saves
 *   at once never both pass a limit, nor take one version; a crash leaves all of it or none.
 * - **Trash** hides a name with its versions (`tool_space_files_names.trashed_at`); a wakeup
 *   (`tool-space-files.sweep`) purges each trashed name `SPACE_FILES_TRASH_DAYS` later: its rows, its
 *   texts and (after them) its bytes, with a `removed` entry that is not restorable. An agent may trash
 *   only a name every version of which agents saved (`mayTrash`).
 * - **The log** (`tool_space_files_changes`): one entry per save, trash, restore and purge, written in
 *   the transaction of the change, numbered 1, 2, 3 per space. An entry keeps the state before it (the
 *   name visible or not, and its newest version's id), which is what `restore` brings back: a version is
 *   never deleted but with its whole name (a purge), so the state before is there until then. An entry
 *   is restorable while that version exists, it is not past `CHANGE_RETENTION_DAYS` and not redacted.
 * - **Search** is SQLite's FTS5 over each version's name and description (part 0) and its text in parts
 *   of `SPACE_FILE_TEXT_PART` characters (parts 1...), an external-content index kept in step by
 *   triggers; only the newest version of a name out of the trash is found.
 * - **No secrets in what it keeps**: a name, description or text with a known credential's shape
 *   (`credentialSettingProblem`) is refused (`refused`), never echoed.
 *
 * Calls (`CALL`), each `{ space, ... }`:
 * - `status` `{ id }` -> `{ saved: SpaceFile | null, usage, limits }`;
 * - `save` `{ file: { id, name, description, size, sha256, type?, text? }, by }` -> `SpaceFile`;
 * - `list` `{ limit, trashed? }` -> `{ files: ListedSpaceFile[], usage }`;
 * - `file` `{ name, version?, trashed? }` -> `{ file: SpaceFile, blob } | null` (`blob`: the id of the
 *   version whose bytes it has: its own, or the one a restore copied);
 * - `versions` `{ name }` -> `SpaceFile[]`, oldest first;
 * - `trash` `{ name, by }` -> `boolean`;
 * - `search` `{ query, limit }` -> `SpaceFileMatch[]`; `text` `{ name, version?, part }` -> `SpaceFileText | null`;
 * - `changes` `{ page }` -> `ChangePage`; `restore` `{ n, by }` -> `Change`; `redact` `{ n, by }` -> `null`;
 * - `purge` `{}` -> `null`.
 */

import type { AppContext } from "@pikit/core";
import {
  ActorCallError,
  type ActorInbox,
  type Author,
  type BlobStore,
  type Change,
  type ChangeAction,
  type ChangePage,
  ChangeInputError,
  changeTitle,
  CONVERT_TEXT_MAX,
  credentialSettingProblem,
  isJsonObject,
  type JsonValue,
  type ListedSpaceFile,
  mayTrash,
  mediaTypeOf,
  parseAuthor,
  parseChangePageRequest,
  pastRetention,
  SPACE_FILE_TEXT_PART,
  SPACE_FILES_LIST_MAX,
  SPACE_FILES_TRASH_DAYS,
  type SpaceFile,
  type SpaceFileMatch,
  type SpaceFilesUsage,
  type SpaceFileText,
  spaceFileDescriptionProblem,
  spaceFileNameProblem,
  type SqlDatabase,
  type SqlRow,
  type SqlStatements,
  type Wakeups,
} from "@pikit/contracts";

/** Every version of every name: its row. */
export const VERSIONS = "tool_space_files_versions";
/** Every name, and when it was trashed. */
export const NAMES = "tool_space_files_names";
/** Each version's searchable parts: part 0 its name and description, parts 1... its text. */
export const PARTS = "tool_space_files_parts";
/** The FTS5 index over `PARTS`. */
export const SEARCH = "tool_space_files_search";
/** The change log of each space. */
export const CHANGES = "tool_space_files_changes";
/** Bytes to delete once their rows are gone (`*`: every key of the space). */
export const DOOMED = "tool_space_files_doomed";

/** The actor that holds one space's index. */
export const actorKey = (space: string): string => `space-files:${space}`;

/** The calls a space's actor answers. */
export const CALL = {
  status: "tool-space-files.status",
  save: "tool-space-files.save",
  list: "tool-space-files.list",
  file: "tool-space-files.file",
  versions: "tool-space-files.versions",
  trash: "tool-space-files.trash",
  search: "tool-space-files.search",
  text: "tool-space-files.text",
  changes: "tool-space-files.changes",
  restore: "tool-space-files.restore",
  redact: "tool-space-files.redact",
  purge: "tool-space-files.purge",
} as const;

/** The wakeup that purges trashed names and deletes doomed bytes, in the App the actors run in. */
export const SWEEP = "tool-space-files.sweep";
/** The `storage.blob` namespace: the component's own name. */
export const NAMESPACE = "tool-space-files";
/** Who a purge of the trash is by. */
export const SWEEPER: Author = { kind: "component", name: "tool-space-files" };
/** The most bytes (or names) one run of the sweep deletes: a Durable Object's event has 50 subrequests on the Free plan. */
export const SWEEP_BATCH = 20;

/** The longest space the actor keeps. */
export const SPACE_MAX = 1024;
const TRASH_MS = SPACE_FILES_TRASH_DAYS * 86_400_000;

/** A file's id: hex, a tool call's hash or a random one. */
export const FILE_ID = /^[0-9a-f]{16,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The limits a space's actor holds every `save` to. */
export type Limits = { maxFileBytes: number; maxSpaceBytes: number; maxFiles: number };

/** What `save` is given by the caller, the bytes already written. A type: it crosses an actor as JSON. */
export type SavedFileInput = { id: string; name: string; description: string; size: number; sha256: string; type?: string; text?: string };

/** A version and the id of the version whose bytes it has. */
export type Located = { file: SpaceFile; blob: string };

/** Where a saved file's bytes are in `storage.blob`: the space hashed (blob keys take few characters), then the bytes' version id. */
export const blobKey = async (space: string, id: string): Promise<string> => `${await sha256Hex(space)}/${id}`;

const encoder = new TextEncoder();

/** The hex SHA-256 of `data`. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether a text holds a known credential's shape, as a word of it (never saying which). */
export const holdsCredential = (text: string): boolean => credentialSettingProblem(text) !== undefined;

/**
 * Whether a file's text holds a known credential's shape: `=`, quotes and commas separate words too,
 * so a `.env` line (`API_KEY=sk-...`) or a JSON value (`{"apiKey":"sk-..."}`) is caught.
 */
export const textHoldsCredential = (text: string): boolean => holdsCredential(text.replace(/[="'`,]/g, " "));

/** Which limit a new file of `size` bytes would break in a space that keeps `usage`; `undefined` when none. */
export function limitProblem(usage: SpaceFilesUsage, size: number, limits: Limits): string | undefined {
  if (size > limits.maxFileBytes) return `the file has ${size} bytes; a saved file has at most ${limits.maxFileBytes}`;
  if (usage.files + 1 > limits.maxFiles) {
    return `the space already keeps ${usage.files} files (versions included, and trashed ones until they are purged), its most: trash some first`;
  }
  if (usage.bytes + size > limits.maxSpaceBytes) {
    return `the space keeps ${usage.bytes} bytes; with this file's ${size} it would pass its most, ${limits.maxSpaceBytes} (trashed files count until they are purged): trash some first`;
  }
  return undefined;
}

/** The longest query `search` reads, in characters. */
const QUERY_MAX = 500;

/**
 * The FTS5 queries `query` is tried as, most precise first: all of its words, the phrase, any of them.
 * Words are runs of letters and digits, each quoted: an email, a URL, a path or a hyphenated id is its
 * words, and no query is an FTS5 syntax error. None when it has no word. (memory-sql's rule.)
 */
export function searchAttempts(query: string): string[] {
  const words = query.slice(0, QUERY_MAX).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const quoted = words.map((word) => `"${word}"`);
  return [...new Set([quoted.join(" AND "), `"${words.join(" ")}"`, quoted.join(" OR ")])];
}

const invalid = (what: string) => new ActorCallError("invalid", what);

const stringOf = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value === "" || value.length > max) throw invalid(`"${name}" is a non-empty string of at most ${max} characters`);
  return value;
};
const integerOf = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid(`"${name}" is an integer from ${min} to ${max}`);
  return value;
};
const idOf = (value: unknown, name = "id"): string => {
  if (typeof value !== "string" || !FILE_ID.test(value)) throw invalid(`"${name}" is a file's id (16 to 64 lowercase hex)`);
  return value;
};
const nameOf = (value: unknown): string => {
  const name = stringOf(value, "name", 255);
  const problem = spaceFileNameProblem(name);
  if (problem !== undefined) throw invalid(problem);
  return name;
};
/** An author as it arrived: checked and copied, `invalid` (without its value) otherwise. */
const authorOf = (value: unknown): Author => {
  try {
    return parseAuthor(value);
  } catch (error) {
    if (error instanceof ChangeInputError) throw invalid(error.message);
    throw error;
  }
};
/** A media type as given: 1 to 255 printable ASCII characters, a type and subtype. */
export const typeProblem = (type: string): string | undefined =>
  type.length > 255 || !/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(type) || mediaTypeOf(type) === "" ? 'a file\'s type is a media type ("application/pdf")' : undefined;

/** The space of a call to `key`'s actor and its fields; refused when it is another space's actor, or malformed. */
export function spaceOfCall(key: string, message: JsonValue): { space: string; fields: Record<string, JsonValue | undefined> } {
  if (!isJsonObject(message)) throw invalid("a call is a JSON object");
  const space = stringOf(message.space, "space", SPACE_MAX);
  if (key !== actorKey(space)) throw invalid(`${key} does not hold this space's files`);
  return { space, fields: message };
}

/** A saved file as it arrived in `save`: checked; a name, description or text holding a credential refused and never echoed. */
function savedFileOf(value: JsonValue | undefined): SavedFileInput {
  if (value === undefined || !isJsonObject(value)) throw invalid('"file" is a JSON object');
  const description = stringOf(value.description, "file.description", 500);
  const problem = spaceFileDescriptionProblem(description);
  if (problem !== undefined) throw invalid(problem);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw invalid('"file.sha256" is a SHA-256 in hex');
  const file: SavedFileInput = {
    id: idOf(value.id, "file.id"),
    name: nameOf(value.name),
    description,
    size: integerOf(value.size, "file.size", 0, Number.MAX_SAFE_INTEGER),
    sha256: value.sha256,
  };
  if (value.type !== undefined && value.type !== null) {
    if (typeof value.type !== "string" || typeProblem(value.type) !== undefined) throw invalid('"file.type" is a media type');
    file.type = value.type;
  }
  if (value.text !== undefined && value.text !== null) {
    if (typeof value.text !== "string" || value.text === "" || value.text.length > CONVERT_TEXT_MAX) throw invalid(`"file.text" is a non-empty string of at most ${CONVERT_TEXT_MAX} characters`);
    file.text = value.text;
  }
  if (holdsCredential(file.name) || holdsCredential(file.description)) {
    throw new ActorCallError("refused", "the name or description looks like it holds a credential: a space never keeps a secret");
  }
  if (file.text !== undefined && textHoldsCredential(file.text)) {
    throw new ActorCallError("refused", "the file looks like it holds a credential (a key, a token, a password): a space never keeps a secret");
  }
  return file;
}

/** A text cut in parts of `SPACE_FILE_TEXT_PART` characters. */
export const textParts = (text: string): string[] => {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += SPACE_FILE_TEXT_PART) parts.push(text.slice(at, at + SPACE_FILE_TEXT_PART));
  return parts;
};

const COLUMNS = "v.id, v.name, v.version, v.description, v.size, v.sha256, v.type, v.by_author, v.created_at, v.blob, v.parts, n.trashed_at";
const FROM = `${VERSIONS} AS v JOIN ${NAMES} AS n ON n.space = v.space AND n.name = v.name`;
const NEWEST = `v.version = (SELECT MAX(version) FROM ${VERSIONS} WHERE space = v.space AND name = v.name)`;

const fileOf = (row: SqlRow): SpaceFile => ({
  id: String(row.id),
  name: String(row.name),
  version: Number(row.version),
  description: String(row.description),
  size: Number(row.size),
  sha256: String(row.sha256),
  ...(row.type !== null && row.type !== undefined && { type: String(row.type) }),
  by: parseAuthor(JSON.parse(String(row.by_author))),
  createdAt: Number(row.created_at),
  ...(row.trashed_at !== null && row.trashed_at !== undefined && { trashedAt: Number(row.trashed_at) }),
  text: Number(row.parts) > 0 ? "indexed" : "none",
});
const locatedOf = (row: SqlRow): Located => ({ file: fileOf(row), blob: String(row.blob) });

async function usageOf(sql: SqlStatements, space: string): Promise<SpaceFilesUsage> {
  const [count] = await sql.query(`SELECT COUNT(*) AS files, COUNT(DISTINCT name) AS names FROM ${VERSIONS} WHERE space = ?`, [space]);
  // A restored version shares the bytes of the one it copies: bytes count once.
  const [bytes] = await sql.query(`SELECT COALESCE(SUM(size), 0) AS bytes FROM (SELECT MAX(size) AS size FROM ${VERSIONS} WHERE space = ? GROUP BY blob)`, [space]);
  return { files: Number(count?.files ?? 0), names: Number(count?.names ?? 0), bytes: Number(bytes?.bytes ?? 0) };
}

async function byId(sql: SqlStatements, space: string, id: string): Promise<Located | undefined> {
  const [row] = await sql.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.space = ? AND v.id = ?`, [space, id]);
  return row === undefined ? undefined : locatedOf(row);
}

/** A name's version (`version`), or its newest; trashed or not. */
async function versionOf(sql: SqlStatements, space: string, name: string, version?: number): Promise<Located | undefined> {
  const [row] =
    version === undefined
      ? await sql.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.space = ? AND v.name = ? AND ${NEWEST}`, [space, name])
      : await sql.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.space = ? AND v.name = ? AND v.version = ?`, [space, name, version]);
  return row === undefined ? undefined : locatedOf(row);
}

/** A name's state: whether it is shown (kept and out of the trash), and its newest version. */
type NameState = { visible: boolean; newest?: Located };
const stateOf = async (sql: SqlStatements, space: string, name: string): Promise<NameState> => {
  const newest = await versionOf(sql, space, name);
  return newest === undefined ? { visible: false } : { visible: newest.file.trashedAt === undefined, newest };
};

/** One entry to append; `before` is the state `restore` brings back (absent once redacted). */
type Entry = {
  at: number;
  by: Author;
  action: ChangeAction;
  name: string;
  version?: number;
  restores?: number;
  before: { visible: boolean; newest?: string };
  after?: string;
  restorable: boolean;
};

/** Appends `entry` to `space`'s log, numbered after the last: in the transaction of the change it records. */
async function append(tx: SqlStatements, space: string, entry: Entry): Promise<number> {
  const [last] = await tx.query(`SELECT COALESCE(MAX(n), 0) AS n FROM ${CHANGES} WHERE space = ?`, [space]);
  const n = Number(last?.n ?? 0) + 1;
  await tx.run(
    `INSERT INTO ${CHANGES} (space, n, at, by_author, action, name, title, version, restores, before_visible, before_newest, after_newest, restorable) ` +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      space,
      n,
      entry.at,
      JSON.stringify(entry.by),
      entry.action,
      entry.name,
      changeTitle(entry.name),
      entry.version ?? null,
      entry.restores ?? null,
      entry.before.visible ? 1 : 0,
      entry.before.newest ?? null,
      entry.after ?? null,
      entry.restorable ? 1 : 0,
    ],
  );
  return n;
}

/** The state an entry restores, the version it needs, and whether it is restorable at `now`. */
async function restorableNow(sql: SqlStatements, space: string, row: SqlRow, now: number): Promise<boolean> {
  if (Number(row.restorable) !== 1 || row.redacted_at !== null || pastRetention(Number(row.at), now)) return false;
  const needed = row.after_newest ?? row.before_newest;
  if (needed === null || needed === undefined) return false;
  const [kept] = await sql.query(`SELECT 1 AS kept FROM ${VERSIONS} WHERE space = ? AND id = ?`, [space, String(needed)]);
  return kept !== undefined;
}

async function changeOf(sql: SqlStatements, space: string, row: SqlRow, now: number): Promise<Change> {
  const change: Change = {
    n: Number(row.n),
    at: Number(row.at),
    by: parseAuthor(JSON.parse(String(row.by_author))),
    action: row.action as ChangeAction,
    item: { kind: "file", id: String(row.name), title: String(row.title) },
    restorable: await restorableNow(sql, space, row, now),
  };
  if (row.version !== null) change.version = Number(row.version);
  if (row.restores !== null) change.restores = Number(row.restores);
  if (row.redacted_at !== null) change.redacted = { at: Number(row.redacted_at), by: parseAuthor(JSON.parse(String(row.redacted_by))) };
  return change;
}

const entryAt = async (sql: SqlStatements, space: string, n: number) => (await sql.query(`SELECT * FROM ${CHANGES} WHERE space = ? AND n = ?`, [space, n]))[0];

/** Writes a new version of `name` (its row and its parts), `blob` the id of the version whose bytes it has. */
async function insertVersion(
  tx: SqlStatements,
  space: string,
  row: { id: string; name: string; version: number; description: string; size: number; sha256: string; type?: string; by: Author; createdAt: number; blob: string },
  parts: { from: "text"; text: string[] } | { from: "copy"; id: string },
): Promise<void> {
  let count: number;
  if (parts.from === "text") {
    count = parts.text.length;
    await tx.run(`INSERT INTO ${PARTS} (space, id, part, name, description, text) VALUES (?, ?, 0, ?, ?, '')`, [space, row.id, row.name, row.description]);
    for (const [index, text] of parts.text.entries()) {
      await tx.run(`INSERT INTO ${PARTS} (space, id, part, name, description, text) VALUES (?, ?, ?, '', '', ?)`, [space, row.id, index + 1, text]);
    }
  } else {
    const [kept] = await tx.query(`SELECT parts FROM ${VERSIONS} WHERE space = ? AND id = ?`, [space, parts.id]);
    count = Number(kept?.parts ?? 0);
    await tx.run(`INSERT INTO ${PARTS} (space, id, part, name, description, text) SELECT space, ?, part, name, description, text FROM ${PARTS} WHERE space = ? AND id = ? ORDER BY part`, [
      row.id,
      space,
      parts.id,
    ]);
  }
  await tx.run(
    `INSERT INTO ${VERSIONS} (space, id, name, version, description, size, sha256, type, by_author, created_at, blob, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [space, row.id, row.name, row.version, row.description, row.size, row.sha256, row.type ?? null, JSON.stringify(row.by), row.createdAt, row.blob, count],
  );
  await tx.run(`INSERT INTO ${NAMES} (space, name, trashed_at) VALUES (?, ?, NULL) ON CONFLICT (space, name) DO UPDATE SET trashed_at = NULL`, [space, row.name]);
}

/** A random version id: 32 lowercase hex. */
export const newFileId = (): string => crypto.randomUUID().replaceAll("-", "");

/** Creates the tables, the search index and its triggers, in the component's `start`. */
export async function createTables(sql: SqlDatabase): Promise<void> {
  await sql.run(
    `CREATE TABLE IF NOT EXISTS ${VERSIONS} (space TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, description TEXT NOT NULL, ` +
      "size BIGINT NOT NULL, sha256 TEXT NOT NULL, type TEXT, by_author TEXT NOT NULL, created_at BIGINT NOT NULL, blob TEXT NOT NULL, parts INTEGER NOT NULL, " +
      "PRIMARY KEY (space, id), UNIQUE (space, name, version))",
  );
  await sql.run(`CREATE INDEX IF NOT EXISTS ${VERSIONS}_recent ON ${VERSIONS} (space, created_at)`);
  await sql.run(`CREATE TABLE IF NOT EXISTS ${NAMES} (space TEXT NOT NULL, name TEXT NOT NULL, trashed_at BIGINT, PRIMARY KEY (space, name))`);
  await sql.run(`CREATE INDEX IF NOT EXISTS ${NAMES}_trashed ON ${NAMES} (trashed_at)`);
  await sql.run(
    `CREATE TABLE IF NOT EXISTS ${PARTS} (n INTEGER PRIMARY KEY, space TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, name TEXT NOT NULL, ` +
      "description TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (space, id, part))",
  );
  // A version's parts never change: inserted with it, deleted with it (a purge). The triggers keep the
  // index in step in the statement that changes them.
  await sql.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH} USING fts5(name, description, text, content='${PARTS}', content_rowid='n', tokenize='unicode61 remove_diacritics 2')`,
  );
  await sql.run(
    `CREATE TRIGGER IF NOT EXISTS ${PARTS}_indexed AFTER INSERT ON ${PARTS} BEGIN INSERT INTO ${SEARCH} (rowid, name, description, text) VALUES (new.n, new.name, new.description, new.text); END`,
  );
  await sql.run(
    `CREATE TRIGGER IF NOT EXISTS ${PARTS}_unindexed AFTER DELETE ON ${PARTS} BEGIN ` +
      `INSERT INTO ${SEARCH} (${SEARCH}, rowid, name, description, text) VALUES ('delete', old.n, old.name, old.description, old.text); END`,
  );
  await sql.run(
    `CREATE TABLE IF NOT EXISTS ${CHANGES} (space TEXT NOT NULL, n INTEGER NOT NULL, at BIGINT NOT NULL, by_author TEXT NOT NULL, action TEXT NOT NULL, ` +
      "name TEXT NOT NULL, title TEXT NOT NULL, version INTEGER, restores INTEGER, before_visible INTEGER, before_newest TEXT, after_newest TEXT, " +
      "restorable INTEGER NOT NULL, redacted_at BIGINT, redacted_by TEXT, PRIMARY KEY (space, n))",
  );
  await sql.run(`CREATE TABLE IF NOT EXISTS ${DOOMED} (space TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (space, blob))`);
}

/** What the space's actor works with, in the App it runs in. */
export type SpaceActorDeps = {
  sql: () => SqlDatabase;
  /** The component's `storage.blob` namespace: only the purge deletes bytes here. */
  blobs: () => BlobStore;
  wakeups: () => Wakeups;
  limits: Limits;
};

/**
 * Asks for the sweep when it has work: now when bytes wait to be deleted, else when the oldest trashed
 * name is due. Called after a change that trashes or purges, and at start (K6: requests may not have
 * survived).
 */
export async function scheduleSweep(deps: SpaceActorDeps, ctx: AppContext): Promise<void> {
  const db = deps.sql();
  const [doomed] = await db.query(`SELECT 1 AS doomed FROM ${DOOMED} LIMIT 1`);
  if (doomed !== undefined) return deps.wakeups().at(SWEEP, ctx.clock.now(), ctx);
  const [oldest] = await db.query(`SELECT MIN(trashed_at) AS at FROM ${NAMES} WHERE trashed_at IS NOT NULL`);
  if (oldest?.at !== null && oldest?.at !== undefined) await deps.wakeups().at(SWEEP, Number(oldest.at) + TRASH_MS, ctx);
}

/** Deletes the bytes waiting in `DOOMED`, at most `budget` keys; how many deletions it made. Bytes a version still names are never deleted. */
async function deleteDoomed(deps: SpaceActorDeps, budget: number, ctx: AppContext): Promise<{ deleted: number; done: boolean }> {
  const db = deps.sql();
  const blobs = deps.blobs();
  let deleted = 0;
  const named = async (space: string, blob: string) => (await db.query(`SELECT 1 AS named FROM ${VERSIONS} WHERE space = ? AND blob = ? LIMIT 1`, [space, blob]))[0] !== undefined;
  for (const row of await db.query(`SELECT space, blob FROM ${DOOMED} ORDER BY space, blob LIMIT ?`, [budget])) {
    if (ctx.abortSignal?.aborted || deleted >= budget) return { deleted, done: false };
    const space = String(row.space);
    const blob = String(row.blob);
    if (blob !== "*") {
      if (!(await named(space, blob))) {
        await blobs.delete(await blobKey(space, blob));
        deleted++;
      }
    } else {
      // Every key of the space (a purged space: orphans of saves cut between their two writes too).
      const prefix = `${await sha256Hex(space)}/`;
      let cursor: string | undefined;
      do {
        const page = await blobs.list(prefix, { limit: SWEEP_BATCH, ...(cursor !== undefined && { cursor }) });
        for (const entry of page.entries) {
          if (deleted >= budget) return { deleted, done: false };
          if (await named(space, entry.key.slice(prefix.length))) continue;
          await blobs.delete(entry.key);
          deleted++;
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
    }
    await db.run(`DELETE FROM ${DOOMED} WHERE space = ? AND blob = ?`, [space, blob]);
  }
  const [more] = await db.query(`SELECT 1 AS more FROM ${DOOMED} LIMIT 1`);
  return { deleted, done: more === undefined };
}

/** Purges one trashed name: its rows and parts, its bytes doomed, a `removed` entry not restorable; all in one transaction. */
async function purgeName(deps: SpaceActorDeps, space: string, name: string, now: number): Promise<void> {
  await deps.sql().transaction(async (tx) => {
    const [named] = await tx.query(`SELECT trashed_at FROM ${NAMES} WHERE space = ? AND name = ?`, [space, name]);
    if (named === undefined || named.trashed_at === null || Number(named.trashed_at) + TRASH_MS > now) return;
    const newest = await versionOf(tx, space, name);
    await tx.run(`INSERT INTO ${DOOMED} (space, blob) SELECT DISTINCT space, blob FROM ${VERSIONS} WHERE space = ? AND name = ? ON CONFLICT DO NOTHING`, [space, name]);
    await tx.run(`DELETE FROM ${PARTS} WHERE space = ? AND id IN (SELECT id FROM ${VERSIONS} WHERE space = ? AND name = ?)`, [space, space, name]);
    await tx.run(`DELETE FROM ${VERSIONS} WHERE space = ? AND name = ?`, [space, name]);
    await tx.run(`DELETE FROM ${NAMES} WHERE space = ? AND name = ?`, [space, name]);
    await append(tx, space, {
      at: now,
      by: SWEEPER,
      action: "removed",
      name,
      ...(newest !== undefined && { version: newest.file.version }),
      before: { visible: false },
      restorable: false,
    });
  });
}

/**
 * The sweep's run: the trashed names due (purged), then the doomed bytes, a batch at a time; it asks
 * to run again at once while work remains, else when the next trashed name is due. Idempotent: a run
 * cut short leaves rows or doomed bytes the next run finds.
 */
export async function sweep(deps: SpaceActorDeps, ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  const due = await deps.sql().query(`SELECT space, name FROM ${NAMES} WHERE trashed_at IS NOT NULL AND trashed_at <= ? ORDER BY trashed_at LIMIT ?`, [
    now - TRASH_MS,
    SWEEP_BATCH,
  ]);
  for (const row of due) {
    if (ctx.abortSignal?.aborted) break;
    await purgeName(deps, String(row.space), String(row.name), now);
    ctx.logger.info("tool-space-files: purged a trashed file");
  }
  const { done } = await deleteDoomed(deps, SWEEP_BATCH, ctx);
  if (!done || due.length === SWEEP_BATCH) return deps.wakeups().at(SWEEP, ctx.clock.now(), ctx);
  await scheduleSweep(deps, ctx);
}

/** Registers the space actor's handlers, in `start`. */
export function answerCalls(inbox: ActorInbox, deps: SpaceActorDeps): void {
  const sql = deps.sql;

  inbox.answer(CALL.status, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const saved = await byId(sql(), space, idOf(fields.id));
    return { saved: saved?.file ?? null, usage: await usageOf(sql(), space), limits: deps.limits } as unknown as JsonValue;
  });

  inbox.answer(CALL.save, async (key, message, ctx: AppContext) => {
    const { space, fields } = spaceOfCall(key, message);
    const file = savedFileOf(fields.file);
    const by = authorOf(fields.by);
    const now = ctx.clock.now();
    const saved = await sql().transaction(async (tx) => {
      // The same id again (a replayed tool call, a retried upload): the version kept the first time.
      const kept = await byId(tx, space, file.id);
      if (kept !== undefined) return { file: kept.file, fresh: false };
      const problem = limitProblem(await usageOf(tx, space), file.size, deps.limits);
      if (problem !== undefined) throw new ActorCallError("limit", problem);
      const before = await stateOf(tx, space, file.name);
      const version = (before.newest?.file.version ?? 0) + 1;
      await insertVersion(
        tx,
        space,
        { ...file, version, by, createdAt: now, blob: file.id },
        { from: "text", text: file.text === undefined ? [] : textParts(file.text) },
      );
      // The entry last, in the same transaction: the item and its entry commit together or not at all.
      await append(tx, space, {
        at: now,
        by,
        action: before.newest === undefined ? "added" : "changed",
        name: file.name,
        version,
        before: { visible: before.visible, ...(before.newest !== undefined && { newest: before.newest.file.id }) },
        after: file.id,
        restorable: true,
      });
      return { file: (await byId(tx, space, file.id))?.file as SpaceFile, fresh: true };
    });
    if (saved.fresh) ctx.logger.info("tool-space-files: saved", { version: saved.file.version, size: saved.file.size, text: saved.file.text });
    return saved.file as unknown as JsonValue;
  });

  inbox.answer(CALL.list, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const limit = integerOf(fields.limit, "limit", 1, SPACE_FILES_LIST_MAX);
    const trashed = fields.trashed === true;
    const rows = await sql().query(
      `SELECT ${COLUMNS}, (SELECT COUNT(*) FROM ${VERSIONS} WHERE space = v.space AND name = v.name) AS versions FROM ${FROM} ` +
        `WHERE v.space = ? AND ${NEWEST} AND n.trashed_at IS ${trashed ? "NOT NULL" : "NULL"} ORDER BY v.created_at DESC, v.name ASC LIMIT ?`,
      [space, limit],
    );
    const files = rows.map((row): ListedSpaceFile => ({ ...fileOf(row), versions: Number(row.versions) }));
    return { files, usage: await usageOf(sql(), space) } as unknown as JsonValue;
  });

  inbox.answer(CALL.file, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const version = fields.version === undefined || fields.version === null ? undefined : integerOf(fields.version, "version", 1, Number.MAX_SAFE_INTEGER);
    const found = await versionOf(sql(), space, nameOf(fields.name), version);
    if (found === undefined || (found.file.trashedAt !== undefined && fields.trashed !== true)) return null;
    return found as unknown as JsonValue;
  });

  inbox.answer(CALL.versions, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const rows = await sql().query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.space = ? AND v.name = ? ORDER BY v.version`, [space, nameOf(fields.name)]);
    return rows.map(fileOf) as unknown as JsonValue;
  });

  inbox.answer(CALL.trash, async (key, message, ctx: AppContext) => {
    const { space, fields } = spaceOfCall(key, message);
    const name = nameOf(fields.name);
    const by = authorOf(fields.by);
    const now = ctx.clock.now();
    const trashed = await sql().transaction(async (tx) => {
      const state = await stateOf(tx, space, name);
      if (!state.visible || state.newest === undefined) return false;
      const savers = (await tx.query(`SELECT by_author FROM ${VERSIONS} WHERE space = ? AND name = ?`, [space, name])).map((row) => parseAuthor(JSON.parse(String(row.by_author))));
      if (!mayTrash(by, savers)) throw new ActorCallError("forbidden", "an agent trashes only files that agents alone saved: a person saved a version of this one");
      await tx.run(`UPDATE ${NAMES} SET trashed_at = ? WHERE space = ? AND name = ?`, [now, space, name]);
      await append(tx, space, {
        at: now,
        by,
        action: "removed",
        name,
        version: state.newest.file.version,
        before: { visible: true, newest: state.newest.file.id },
        after: state.newest.file.id,
        restorable: true,
      });
      return true;
    });
    if (trashed) await scheduleSweep(deps, ctx);
    return trashed;
  });

  inbox.answer(CALL.search, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const query = stringOf(fields.query, "query", 10_000);
    const limit = integerOf(fields.limit, "limit", 1, SPACE_FILES_LIST_MAX);
    for (const attempt of searchAttempts(query)) {
      // Best first; a file is found once, at its best part. Only the newest version of a name out of the trash.
      const rows = await sql().query(
        `SELECT ${COLUMNS}, p.part AS part, snippet(${SEARCH}, -1, '[', ']', '...', 16) AS snippet ` +
          `FROM ${SEARCH} JOIN ${PARTS} AS p ON p.n = ${SEARCH}.rowid JOIN ${VERSIONS} AS v ON v.space = p.space AND v.id = p.id ` +
          `JOIN ${NAMES} AS n ON n.space = v.space AND n.name = v.name ` +
          `WHERE ${SEARCH} MATCH ? AND p.space = ? AND n.trashed_at IS NULL AND ${NEWEST} ` +
          `ORDER BY bm25(${SEARCH}), v.created_at DESC, v.name ASC, p.part ASC LIMIT ?`,
        [attempt, space, Math.min(limit * 8, SPACE_FILES_LIST_MAX)],
      );
      const found = new Map<string, SpaceFileMatch>();
      for (const row of rows) {
        if (found.has(String(row.id)) || found.size >= limit) continue;
        const part = Number(row.part);
        found.set(String(row.id), { file: fileOf(row), snippet: String(row.snippet), ...(part > 0 && { part }) });
      }
      if (found.size > 0) return [...found.values()] as unknown as JsonValue;
    }
    return [];
  });

  inbox.answer(CALL.text, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const version = fields.version === undefined || fields.version === null ? undefined : integerOf(fields.version, "version", 1, Number.MAX_SAFE_INTEGER);
    const part = integerOf(fields.part, "part", 1, Number.MAX_SAFE_INTEGER);
    const found = await versionOf(sql(), space, nameOf(fields.name), version);
    if (found === undefined || found.file.trashedAt !== undefined) return null;
    const [count] = await sql().query(`SELECT parts FROM ${VERSIONS} WHERE space = ? AND id = ?`, [space, found.file.id]);
    const parts = Number(count?.parts ?? 0);
    if (parts === 0) return null;
    if (part > parts) throw invalid(`its text has ${parts} ${parts === 1 ? "part" : "parts"}`);
    const [row] = await sql().query(`SELECT text FROM ${PARTS} WHERE space = ? AND id = ? AND part = ?`, [space, found.file.id, part]);
    return { file: found.file, text: String(row?.text ?? ""), part, parts } satisfies SpaceFileText as unknown as JsonValue;
  });

  inbox.answer(CALL.changes, async (key, message, ctx: AppContext) => {
    const { space, fields } = spaceOfCall(key, message);
    let page: ReturnType<typeof parseChangePageRequest>;
    try {
      page = parseChangePageRequest(fields.page);
    } catch (error) {
      if (error instanceof ChangeInputError) throw invalid(error.message);
      throw error;
    }
    const now = ctx.clock.now();
    const rows = await sql().query(`SELECT * FROM ${CHANGES} WHERE space = ?${page.before === undefined ? "" : " AND n < ?"} ORDER BY n DESC LIMIT ?`, [
      space,
      ...(page.before === undefined ? [] : [page.before]),
      page.limit + 1,
    ]);
    const items: Change[] = [];
    for (const row of rows.slice(0, page.limit)) items.push(await changeOf(sql(), space, row, now));
    const last = items.at(-1);
    return { items, ...(rows.length > page.limit && last !== undefined && { next: last.n }) } satisfies ChangePage as unknown as JsonValue;
  });

  inbox.answer(CALL.restore, async (key, message, ctx: AppContext) => {
    const { space, fields } = spaceOfCall(key, message);
    const n = integerOf(fields.n, "n", 1, Number.MAX_SAFE_INTEGER);
    const by = authorOf(fields.by);
    const now = ctx.clock.now();
    const result = await sql().transaction(async (tx) => {
      const entry = await entryAt(tx, space, n);
      if (entry === undefined) throw new ActorCallError("not_found", `the space's log has no change ${n}`);
      if (!(await restorableNow(tx, space, entry, now))) {
        throw new ActorCallError("gone", `change ${n} can no longer be restored (redacted, past retention, or its file purged)`);
      }
      const name = String(entry.name);
      const current = await stateOf(tx, space, name);
      const target = { visible: Number(entry.before_visible) === 1, newest: entry.before_newest === null ? undefined : String(entry.before_newest) };
      let newest = current.newest;
      let trashes = false;
      if (!target.visible) {
        if (current.visible) {
          await tx.run(`UPDATE ${NAMES} SET trashed_at = ? WHERE space = ? AND name = ?`, [now, space, name]);
          trashes = true;
        }
      } else {
        if (target.newest !== current.newest?.file.id) {
          // The version before the change, saved again as the newest: its bytes, description, type, text and author.
          const old = await byId(tx, space, target.newest as string);
          if (old === undefined) throw new ActorCallError("gone", `change ${n} can no longer be restored`);
          const id = newFileId();
          const { file } = old;
          await insertVersion(
            tx,
            space,
            {
              id,
              name,
              version: (current.newest?.file.version ?? 0) + 1,
              description: file.description,
              size: file.size,
              sha256: file.sha256,
              ...(file.type !== undefined && { type: file.type }),
              by: file.by,
              createdAt: now,
              blob: old.blob,
            },
            { from: "copy", id: file.id },
          );
          newest = await byId(tx, space, id);
        }
        await tx.run(`UPDATE ${NAMES} SET trashed_at = NULL WHERE space = ? AND name = ?`, [space, name]);
      }
      const restored = await append(tx, space, {
        at: now,
        by,
        action: "restored",
        name,
        ...(newest !== undefined && { version: newest.file.version }),
        restores: n,
        before: { visible: current.visible, ...(current.newest !== undefined && { newest: current.newest.file.id }) },
        ...(newest !== undefined && { after: newest.file.id }),
        restorable: true,
      });
      return { change: await changeOf(tx, space, (await entryAt(tx, space, restored)) as SqlRow, now), trashes };
    });
    if (result.trashes) await scheduleSweep(deps, ctx);
    return result.change as unknown as JsonValue;
  });

  inbox.answer(CALL.redact, async (key, message, ctx: AppContext) => {
    const { space, fields } = spaceOfCall(key, message);
    const n = integerOf(fields.n, "n", 1, Number.MAX_SAFE_INTEGER);
    const by = authorOf(fields.by);
    if (by.kind !== "operator") throw new ActorCallError("forbidden", "only an operator redacts a change");
    const { changes } = await sql().run(
      `UPDATE ${CHANGES} SET redacted_at = ?, redacted_by = ?, title = 'redacted', before_visible = NULL, before_newest = NULL, after_newest = NULL ` +
        "WHERE space = ? AND n = ? AND redacted_at IS NULL",
      [ctx.clock.now(), JSON.stringify(by), space, n],
    );
    if (changes === 0 && (await entryAt(sql(), space, n)) === undefined) throw new ActorCallError("not_found", `the space's log has no change ${n}`);
    return null;
  });

  inbox.answer(CALL.purge, async (key, message, ctx: AppContext) => {
    const { space } = spaceOfCall(key, message);
    await sql().transaction(async (tx) => {
      // Every byte of the space goes once its rows are gone: listed by the space's prefix, orphans included.
      await tx.run(`INSERT INTO ${DOOMED} (space, blob) VALUES (?, '*') ON CONFLICT DO NOTHING`, [space]);
      await tx.run(`DELETE FROM ${DOOMED} WHERE space = ? AND blob <> '*'`, [space]);
      await tx.run(`DELETE FROM ${PARTS} WHERE space = ?`, [space]);
      await tx.run(`DELETE FROM ${VERSIONS} WHERE space = ?`, [space]);
      await tx.run(`DELETE FROM ${NAMES} WHERE space = ?`, [space]);
      await tx.run(`DELETE FROM ${CHANGES} WHERE space = ?`, [space]);
    });
    // The bytes now when they are few; the sweep finishes the rest.
    const { done } = await deleteDoomed(deps, SWEEP_BATCH, ctx);
    if (!done) await deps.wakeups().at(SWEEP, ctx.clock.now(), ctx);
    return null;
  });
}
