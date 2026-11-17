/**
 * The directory's actor, `projects:index`: which projects exist, their spaces, and who is in each, for
 * `create`, `list` and `locate`. It is never an access check: each project's actor is the truth and
 * tells the directory every new version after its commit (`indexed`; newer versions win), so a list
 * may lag a moment behind a project, never let anyone into one.
 *
 * - `create` checks what only the directory can (an id taken, the projects one principal owns), then
 *   asks the project's actor to make it (`init`: one project a space, `space_taken` otherwise) and
 *   keeps what it answered. A crash between the two leaves a project its actor holds and the directory
 *   does not list until its next change; the same `create` again (a trusted caller's, with its id)
 *   finds it and answers it.
 * - `list` for people: the projects where one of their principals is a current member
 *   (`memberIsCurrent` in SQL), never a removed one; operators and components: every project,
 *   removed ones included (`removedAt`). Archived projects are listed apart (`archived: true`).
 */

import {
  type Caller,
  isJsonObject,
  isProjectId,
  type JsonValue,
  type Page,
  PROJECTS_OWNED_MAX,
  type Principal,
  type Project,
  ProjectError,
  type ProjectErrorCode,
  parseCaller,
  parsePrincipal,
  principalKey,
  projectSpace,
  type SqlDatabase,
  type SqlRow,
} from "@pikit/contracts";
import { type IndexEntry, type ProjectsSqlOptions, SPACE_MAX } from "./project.ts";
import { INDEX, INDEX_MEMBERS } from "./tables.ts";

/** The directory's actor. */
export const INDEX_KEY = "projects:index";
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

export type DirectoryEnv = {
  db: SqlDatabase;
  now(): number;
  options: ProjectsSqlOptions;
  /** The `init` call to a space's project actor: `{ project, indexed }`. */
  init(space: string, message: JsonValue): Promise<JsonValue>;
};

const fail = (code: ProjectErrorCode, message: string) => new ProjectError(code, `projects-sql: ${message}`);
const invalid = (message: string) => fail("invalid", message);
const principal = (value: unknown, what: string): Principal => {
  try {
    return parsePrincipal(value, what);
  } catch (error) {
    throw invalid((error as Error).message);
  }
};

const owned = (key: string, message: JsonValue): Record<string, JsonValue | undefined> => {
  if (key !== INDEX_KEY) throw invalid(`${key} is not the directory (${INDEX_KEY} is)`);
  if (!isJsonObject(message)) throw invalid("a call is a JSON object");
  return message;
};

const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** `create`: the new project, made by its space's actor, kept in the directory. */
export async function create(env: DirectoryEnv, key: string, message: JsonValue): Promise<JsonValue> {
  const fields = owned(key, message);
  const caller = parseCaller(fields.caller);
  if (caller.kind === "agent") throw fail("forbidden", "agents do not make projects");
  const input = fields.input;
  if (!isJsonObject(input)) throw invalid("input is a JSON object");
  let owner: Principal;
  let id: string;
  let space: string;
  if (caller.kind === "people") {
    if (input.id !== undefined || input.space !== undefined) throw fail("forbidden", "people never name a project's space or id");
    owner = caller.principals[0] as Principal;
    if (input.owner !== undefined && input.owner !== null && principalKey(principal(input.owner, "owner")) !== principalKey(owner)) {
      throw fail("forbidden", "people make projects they own");
    }
    id = randomId();
    space = projectSpace(id);
  } else {
    if (input.owner === undefined || input.owner === null) throw invalid("a trusted caller names the owner");
    owner = principal(input.owner, "owner");
    if (input.id !== undefined && input.id !== null && !isProjectId(input.id)) throw invalid("a project's id is 32 lowercase hex");
    id = typeof input.id === "string" ? input.id : randomId();
    if (input.space !== undefined && input.space !== null && (typeof input.space !== "string" || input.space.trim() === "" || input.space.length > SPACE_MAX)) {
      throw invalid(`a space is a non-empty string of at most ${SPACE_MAX} characters`);
    }
    space = typeof input.space === "string" ? input.space : projectSpace(id);
  }
  const [taken] = await env.db.query(`SELECT space FROM ${INDEX} WHERE id = ?`, [id]);
  if (taken !== undefined && String(taken.space) !== space) throw fail("conflict", "this id is another project's");
  if (taken === undefined) {
    const [count] = await env.db.query(`SELECT COUNT(*) AS projects FROM ${INDEX} WHERE owner_key = ? AND removed = 0`, [principalKey(owner)]);
    if (Number(count?.projects ?? 0) >= PROJECTS_OWNED_MAX) throw fail("limit", `one person owns at most ${PROJECTS_OWNED_MAX} projects`);
  }
  const project = { id, name: input.name ?? null, description: input.description ?? "", agents: input.agents ?? [], owner };
  const made = await env.init(space, { space, op: "init", caller: caller as unknown as JsonValue, project: project as unknown as JsonValue });
  const answer = made as { project: JsonValue; indexed: IndexEntry };
  await keep(env.db, answer.indexed);
  return answer.project;
}

/** Keeps `entry` unless the directory holds a newer version of its project. */
async function keep(db: SqlDatabase, entry: IndexEntry): Promise<void> {
  const { project } = entry;
  await db.transaction(async (tx) => {
    const [held] = await tx.query(`SELECT version FROM ${INDEX} WHERE id = ?`, [project.id]);
    if (held !== undefined && Number(held.version) >= project.version) return;
    // A purged project's space adopted again under another id: the old row goes.
    await tx.run(`DELETE FROM ${INDEX} WHERE space = ? AND id <> ?`, [project.space, project.id]);
    await tx.run(
      `INSERT INTO ${INDEX} (id, space, owner_key, project, archived, removed, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ` +
        "ON CONFLICT (id) DO UPDATE SET owner_key = excluded.owner_key, project = excluded.project, archived = excluded.archived, removed = excluded.removed, " +
        "updated_at = excluded.updated_at, version = excluded.version",
      [
        project.id,
        project.space,
        entry.ownerKey,
        JSON.stringify(project),
        project.archivedAt === undefined ? 0 : 1,
        project.removedAt === undefined ? 0 : 1,
        project.updatedAt,
        project.version,
      ],
    );
    await tx.run(`DELETE FROM ${INDEX_MEMBERS} WHERE space = ?`, [project.space]);
    for (const member of entry.members) {
      await tx.run(`INSERT INTO ${INDEX_MEMBERS} (space, key, source, checked_at) VALUES (?, ?, ?, ?)`, [project.space, member.key, member.source, member.checkedAt]);
    }
  });
}

/** `indexed`: a project's actor's entry after a change. */
export async function indexed(env: DirectoryEnv, key: string, message: JsonValue): Promise<JsonValue> {
  const fields = owned(key, message);
  const entry = fields.entry;
  if (!isJsonObject(entry) || !isJsonObject(entry.project) || typeof entry.ownerKey !== "string" || !Array.isArray(entry.members)) throw invalid("entry is an index entry");
  await keep(env.db, entry as unknown as IndexEntry);
  return null;
}

/** `unindexed`: a purged project leaves the directory. */
export async function unindexed(env: DirectoryEnv, key: string, message: JsonValue): Promise<JsonValue> {
  const fields = owned(key, message);
  if (typeof fields.space !== "string" || !isProjectId(fields.id)) throw invalid("unindexed is { space, id }");
  await env.db.transaction(async (tx) => {
    await tx.run(`DELETE FROM ${INDEX} WHERE id = ? AND space = ?`, [fields.id as string, fields.space as string]);
    await tx.run(`DELETE FROM ${INDEX_MEMBERS} WHERE space = ? AND NOT EXISTS (SELECT 1 FROM ${INDEX} WHERE space = ?)`, [fields.space as string, fields.space as string]);
  });
  return null;
}

/** `locate`: the space of project `id`, or `null`. */
export async function locate(env: DirectoryEnv, key: string, message: JsonValue): Promise<JsonValue> {
  const fields = owned(key, message);
  if (!isProjectId(fields.id)) return null;
  const [row] = await env.db.query(`SELECT space FROM ${INDEX} WHERE id = ?`, [fields.id]);
  return row === undefined ? null : String(row.space);
}

const CURSOR = /^(\d+):([0-9a-f]{32})$/;

/** `list`: a page of projects, newest change first. */
export async function list(env: DirectoryEnv, key: string, message: JsonValue): Promise<JsonValue> {
  const fields = owned(key, message);
  const caller: Caller = parseCaller(fields.caller);
  if (caller.kind === "agent") throw fail("forbidden", "agents do not list projects");
  const query = isJsonObject(fields.query) ? fields.query : {};
  const limit = query.limit === undefined || query.limit === null ? LIST_DEFAULT : query.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw invalid(`limit is an integer from 1 to ${LIST_MAX}`);
  if (query.archived !== undefined && query.archived !== null && typeof query.archived !== "boolean") throw invalid("archived is true or false");
  const where = ["i.archived = ?"];
  const params: (string | number)[] = [query.archived === true ? 1 : 0];
  if (query.cursor !== undefined && query.cursor !== null) {
    const match = typeof query.cursor === "string" ? CURSOR.exec(query.cursor) : null;
    if (match === null) throw invalid("cursor is the one a page gave");
    where.push("(i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))");
    params.push(Number(match[1]), Number(match[1]), match[2] as string);
  }
  let rows: SqlRow[];
  const keys = caller.kind === "people" ? caller.principals.map(principalKey) : [];
  if (caller.kind === "people") {
    rows = await env.db.query(
      `SELECT i.project, i.owner_key, i.updated_at, i.id FROM ${INDEX} AS i WHERE i.removed = 0 AND ${where.join(" AND ")} AND EXISTS (SELECT 1 FROM ${INDEX_MEMBERS} AS m ` +
        `WHERE m.space = i.space AND m.key IN (${keys.map(() => "?").join(", ")}) AND (m.source = 'manual' OR m.checked_at >= ?)) ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
      [...params, ...keys, env.now() - env.options.staleAfterMs, limit + 1],
    );
  } else {
    rows = await env.db.query(`SELECT i.project, i.owner_key, i.updated_at, i.id FROM ${INDEX} AS i WHERE ${where.join(" AND ")} ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`, [
      ...params,
      limit + 1,
    ]);
  }
  const items = rows.slice(0, limit).map((row) => {
    const { role: _role, removedAt, ...project } = JSON.parse(String(row.project)) as Project;
    if (caller.kind !== "people") return { ...project, ...(removedAt !== undefined && { removedAt }) } as Project;
    const { members, archivedAt, createdAt, updatedAt, version, ...head } = project;
    const role = keys.includes(String(row.owner_key)) ? "owner" : "member";
    return { ...head, role, members, ...(archivedAt !== undefined && { archivedAt }), createdAt, updatedAt, version } as Project;
  });
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  const page: Page<Project> = { items, ...(last !== undefined && { next: `${Number(last.updated_at)}:${String(last.id)}` }) };
  return page as unknown as JsonValue;
}
