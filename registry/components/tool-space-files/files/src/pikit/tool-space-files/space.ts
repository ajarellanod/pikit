/**
 * The space's index actor: one per space, `space-files:<space>`, reached through `actor.mailbox`'s
 * `call` and answered here with `actor.inbox`'s `answer`, over the `storage.sql` of the App the actor
 * runs in (as memory-sql's person actors). On a server (mailbox-local) every key's actor is the App
 * itself, one database; on Cloudflare (actors-do) it is the Durable Object `space-files:<space>`, so a
 * space's writes are ordered and its index is in its own object.
 *
 * - **It answers only for its space**: every call carries `space`, and a call whose space is not the
 *   actor's (`key !== "space-files:" + space`), or a malformed one, is refused as `invalid`. Every
 *   message is checked on arrival: it crossed an actor as JSON.
 * - **It holds the index, never the bytes**: the bytes are in `storage.blob`, written by the tool
 *   before it calls `save` (so the index never names bytes that were not written), deleted after
 *   `remove` (so it never names bytes already deleted).
 * - **`save` is idempotent by the file's id** (the tool's call, hashed): a second `save` of an id
 *   answers the row kept the first time. Its limits and its version are decided in one transaction,
 *   so two saves at once never both pass a limit, nor take one version.
 * - **No secrets in what it keeps**: a name or description with a known credential's shape
 *   (`credentialSettingProblem`) is refused (`refused`), never echoed. File contents are the tool's
 *   to check: the actor never sees them.
 *
 * Calls (`CALL`), each `{ space, ... }`:
 * - `status` `{ id }` → `{ saved: SavedFile | null, usage: Usage }`;
 * - `save` `{ file: NewFile }` → `SavedFile`; refused `limit` (a limit of `Limits`), `refused` (a
 *   credential), `invalid`;
 * - `list` `{ limit }` → `{ files: ListedFile[], usage: Usage }`: the latest version of each name,
 *   newest first;
 * - `get` `{ id }` or `{ name, version? }` → `SavedFile | null` (no version: the latest);
 * - `versions` `{ name }` → the ids of every version of `name`;
 * - `remove` `{ ids }` → how many rows went (removing twice is removing once).
 */

import type { AppContext } from "@pikit/core";
import { ActorCallError, type ActorInbox, credentialSettingProblem, isJsonObject, type JsonValue, type SqlDatabase, type SqlRow } from "@pikit/contracts";

export const TABLE = "tool_space_files_files";

/** The actor that holds one space's index. */
export const actorKey = (space: string): string => `space-files:${space}`;

/** The calls a space's actor answers. */
export const CALL = {
  status: "tool-space-files.status",
  save: "tool-space-files.save",
  list: "tool-space-files.list",
  get: "tool-space-files.get",
  versions: "tool-space-files.versions",
  remove: "tool-space-files.remove",
} as const;

/** The longest space, name and description it keeps. */
export const SPACE_MAX = 1024;
export const NAME_MAX = 255;
export const DESCRIPTION_MAX = 500;
/** The most rows `list` answers at once. */
export const LIST_MAX = 1000;

/** A file's id: hex, as `fileId` makes it from a tool call. */
const ID = /^[0-9a-f]{16,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** One saved version. A type, not an interface: it crosses `actor.mailbox` as JSON. */
export type SavedFile = {
  id: string;
  name: string;
  version: number;
  description: string;
  size: number;
  sha256: string;
  /** The agent that saved it. */
  agent: string;
  createdAt: number;
};

/** What `save` is given: a version's all but its version number, which the actor decides. */
export type NewFile = Omit<SavedFile, "version">;

/** A name as `list` gives it: its latest version, with how many versions it has. */
export type ListedFile = SavedFile & { versions: number };

/** What a space keeps: its versions (each one is a file), its names, its bytes. */
export type Usage = { files: number; names: number; bytes: number };

/** The limits a space's actor holds every `save` to. */
export type Limits = { maxFileBytes: number; maxSpaceBytes: number; maxFiles: number };

/** Why `name` cannot name a saved file, or `undefined`: one line of 1 to 255 characters, not a path. */
export function nameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > NAME_MAX) return `a file's name is 1 to ${NAME_MAX} characters`;
  if (name === "." || name === ".." || /[/\\]/.test(name)) return 'a file\'s name is not a path: no "/" or "\\", not "." or ".."';
  if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return "a file's name has no control characters";
  return undefined;
}

/** Why `description` cannot describe a saved file, or `undefined`. */
export function descriptionProblem(description: string): string | undefined {
  if (description.trim() === "" || description.length > DESCRIPTION_MAX) return `a description is 1 to ${DESCRIPTION_MAX} characters`;
  return undefined;
}

/** Whether a name or description holds a known credential's shape (never saying which). */
export const holdsCredential = (text: string): boolean => credentialSettingProblem(text) !== undefined;

/** Which limit a new file of `size` bytes would break in a space that keeps `usage`, as a message for the model; `undefined` when none. */
export function limitProblem(usage: Usage, size: number, limits: Limits): string | undefined {
  if (size > limits.maxFileBytes) return `the file has ${size} bytes; a saved file has at most ${limits.maxFileBytes}`;
  if (usage.files + 1 > limits.maxFiles) return `the space already keeps ${usage.files} files (versions included), its most: delete some with files_delete first`;
  if (usage.bytes + size > limits.maxSpaceBytes) {
    return `the space keeps ${usage.bytes} bytes; with this file's ${size} it would pass its most, ${limits.maxSpaceBytes}: delete some with files_delete first`;
  }
  return undefined;
}

const invalid = (what: string) => new ActorCallError("invalid", `tool-space-files: ${what}`);

const stringOf = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value === "" || value.length > max) throw invalid(`"${name}" is a non-empty string of at most ${max} characters`);
  return value;
};
const integerOf = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid(`"${name}" is an integer from ${min} to ${max}`);
  return value;
};
const idOf = (value: unknown, name = "id"): string => {
  if (typeof value !== "string" || !ID.test(value)) throw invalid(`"${name}" is a file's id`);
  return value;
};
const nameOf = (value: unknown): string => {
  const name = stringOf(value, "name", NAME_MAX);
  const problem = nameProblem(name);
  if (problem !== undefined) throw invalid(problem);
  return name;
};

/** The space of a call to `key`'s actor and its fields; refused when it is another space's actor, or malformed. */
export function spaceOfCall(key: string, message: JsonValue): { space: string; fields: Record<string, JsonValue | undefined> } {
  if (!isJsonObject(message)) throw invalid("a call is a JSON object");
  const space = stringOf(message.space, "space", SPACE_MAX);
  if (key !== actorKey(space)) throw invalid(`${key} does not hold this space's files`);
  return { space, fields: message };
}

/** A new file as it arrived in `save`: checked; a name or description holding a credential refused and never echoed. */
function newFileOf(value: JsonValue | undefined): NewFile {
  if (value === undefined || !isJsonObject(value)) throw invalid('"file" is a JSON object');
  const description = stringOf(value.description, "file.description", DESCRIPTION_MAX);
  const problem = descriptionProblem(description);
  if (problem !== undefined) throw invalid(problem);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw invalid('"file.sha256" is a SHA-256 in hex');
  const { createdAt } = value;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) throw invalid('"file.createdAt" is epoch milliseconds');
  const file: NewFile = {
    id: idOf(value.id, "file.id"),
    name: nameOf(value.name),
    description,
    size: integerOf(value.size, "file.size", 0, Number.MAX_SAFE_INTEGER),
    sha256: value.sha256,
    agent: stringOf(value.agent, "file.agent", NAME_MAX),
    createdAt,
  };
  if (holdsCredential(file.name) || holdsCredential(file.description)) {
    throw new ActorCallError("refused", "tool-space-files: the name or description looks like it holds a credential: a space never keeps a secret");
  }
  return file;
}

const COLUMNS = "id, name, version, description, size, sha256, agent, created_at";

const fileOf = (row: SqlRow): SavedFile => ({
  id: String(row.id),
  name: String(row.name),
  version: Number(row.version),
  description: String(row.description),
  size: Number(row.size),
  sha256: String(row.sha256),
  agent: String(row.agent),
  createdAt: Number(row.created_at),
});

type Statements = Pick<SqlDatabase, "query">;

async function usageOf(sql: Statements, space: string): Promise<Usage> {
  const [row] = await sql.query(`SELECT COUNT(*) AS files, COUNT(DISTINCT name) AS names, COALESCE(SUM(size), 0) AS bytes FROM ${TABLE} WHERE space = ?`, [space]);
  return { files: Number(row?.files ?? 0), names: Number(row?.names ?? 0), bytes: Number(row?.bytes ?? 0) };
}

async function byId(sql: Statements, space: string, id: string): Promise<SavedFile | null> {
  const [row] = await sql.query(`SELECT ${COLUMNS} FROM ${TABLE} WHERE space = ? AND id = ?`, [space, id]);
  return row === undefined ? null : fileOf(row);
}

/** Creates the table, in the component's `start`. */
export async function createTable(sql: SqlDatabase): Promise<void> {
  await sql.run(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (space TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, ` +
      "description TEXT NOT NULL, size BIGINT NOT NULL, sha256 TEXT NOT NULL, agent TEXT NOT NULL, created_at BIGINT NOT NULL, " +
      "PRIMARY KEY (space, id), UNIQUE (space, name, version))",
  );
  await sql.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_recent ON ${TABLE} (space, created_at)`);
}

/** Registers the space actor's handlers, in `start`: over `sql` (the actor's own App's), held to `limits`. */
export function answerCalls(inbox: ActorInbox, sql: () => SqlDatabase, limits: Limits): void {
  inbox.answer(CALL.status, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const id = idOf(fields.id);
    return { saved: await byId(sql(), space, id), usage: await usageOf(sql(), space) };
  });

  inbox.answer(CALL.save, async (key, message, ctx: AppContext) => {
    const { space, fields } = spaceOfCall(key, message);
    const file = newFileOf(fields.file);
    return sql().transaction(async (tx) => {
      // The same id again (a replayed tool call): the row kept the first time.
      const kept = await byId(tx, space, file.id);
      if (kept !== null) return kept;
      const problem = limitProblem(await usageOf(tx, space), file.size, limits);
      if (problem !== undefined) throw new ActorCallError("limit", `tool-space-files: ${problem}`);
      const [latest] = await tx.query(`SELECT COALESCE(MAX(version), 0) AS version FROM ${TABLE} WHERE space = ? AND name = ?`, [space, file.name]);
      const version = Number(latest?.version ?? 0) + 1;
      await tx.run(`INSERT INTO ${TABLE} (space, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        space,
        file.id,
        file.name,
        version,
        file.description,
        file.size,
        file.sha256,
        file.agent,
        file.createdAt,
      ]);
      ctx.logger.info("tool-space-files: saved", { name: file.name, version, size: file.size });
      return { ...file, version } satisfies SavedFile;
    });
  });

  inbox.answer(CALL.list, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const limit = integerOf(fields.limit, "limit", 1, LIST_MAX);
    const rows = await sql().query(
      "SELECT f.id, f.name, f.version, f.description, f.size, f.sha256, f.agent, f.created_at, c.versions " +
        `FROM ${TABLE} f ` +
        `JOIN (SELECT name, MAX(version) AS latest, COUNT(*) AS versions FROM ${TABLE} WHERE space = ? GROUP BY name) c ON c.name = f.name AND c.latest = f.version ` +
        "WHERE f.space = ? ORDER BY f.created_at DESC, f.name ASC LIMIT ?",
      [space, space, limit],
    );
    return { files: rows.map((row) => ({ ...fileOf(row), versions: Number(row.versions) })), usage: await usageOf(sql(), space) };
  });

  inbox.answer(CALL.get, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    if (fields.id !== undefined) return byId(sql(), space, idOf(fields.id));
    const name = nameOf(fields.name);
    if (fields.version === undefined) {
      const [row] = await sql().query(`SELECT ${COLUMNS} FROM ${TABLE} WHERE space = ? AND name = ? ORDER BY version DESC LIMIT 1`, [space, name]);
      return row === undefined ? null : fileOf(row);
    }
    const version = integerOf(fields.version, "version", 1, Number.MAX_SAFE_INTEGER);
    const [row] = await sql().query(`SELECT ${COLUMNS} FROM ${TABLE} WHERE space = ? AND name = ? AND version = ?`, [space, name, version]);
    return row === undefined ? null : fileOf(row);
  });

  inbox.answer(CALL.versions, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    const rows = await sql().query(`SELECT id FROM ${TABLE} WHERE space = ? AND name = ? ORDER BY version`, [space, nameOf(fields.name)]);
    return rows.map((row) => String(row.id));
  });

  inbox.answer(CALL.remove, async (key, message) => {
    const { space, fields } = spaceOfCall(key, message);
    if (!Array.isArray(fields.ids) || fields.ids.length > LIST_MAX) throw invalid(`"ids" is a list of at most ${LIST_MAX} file ids`);
    const ids = fields.ids.map((id) => idOf(id));
    if (ids.length === 0) return 0;
    const { changes } = await sql().run(`DELETE FROM ${TABLE} WHERE space = ? AND id IN (${ids.map(() => "?").join(", ")})`, [space, ...ids]);
    return changes;
  });
}
