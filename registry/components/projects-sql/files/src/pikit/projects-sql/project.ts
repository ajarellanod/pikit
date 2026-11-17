/**
 * The project's actor, `projects:space:<space>`: what every call of one project does, over its
 * App's `storage.sql`. The one place a project's guarantees are enforced (`projects.ts`' header):
 *
 * - **Every call is checked here**, against the caller's kind and role (`access`): a people caller
 *   with no current role (`roleOfMembers`), a removed project or none at all is `not_found`, the same
 *   answer, before anything is read or written; an owner's act by a member is `forbidden`; an agent
 *   outside its space, or calling anything but its reads and `addLink`, is `forbidden`.
 * - **A write and its log entry are one transaction** (`db.transaction`), with the author
 *   `authorOf(caller)`; the project's `version` is bumped in it. A write that changes nothing (the same
 *   instructions, document, link or member again) logs nothing.
 * - **Restore is exact**: every entry keeps the state before it (`before`: the version that was
 *   current, the link or member as it was, the record), `restore(n)` applies it and logs the state it
 *   replaced, so a restore can be restored. A version is restored as a new version holding the old
 *   one's title, mode, source, text and author.
 * - **Authors are parsed on the way in and out** (`parseCaller` on arrival, `parseAuthor` on every
 *   stored author read back).
 */

import {
  type Author,
  authorOf,
  type Caller,
  type Change,
  type ChangeAction,
  ChangeInputError,
  CONTEXT_MEMBERS,
  changeTitle,
  credentialSettingProblem,
  DOCUMENT_MAX,
  DOCUMENT_TITLE_MAX,
  type DocumentMode,
  type DocumentRead,
  estimateTokens,
  formatItemRef,
  INSTRUCTIONS_MAX,
  type Instructions,
  type ItemVersion,
  isJsonObject,
  isProjectId,
  type JsonValue,
  LINK_NOTE_MAX,
  type Link,
  linkUrlProblem,
  type Member,
  memberIsCurrent,
  OWNER_RESTORES,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_DOCUMENTS_MAX,
  PROJECT_LINKS_MAX,
  PROJECT_TEXT_MAX,
  PROJECT_TEXT_WITH_VERSIONS_MAX,
  PROJECT_TOMBSTONE_DAYS,
  type Principal,
  type Project,
  type ProjectContext,
  type ProjectDocument,
  ProjectError,
  type ProjectErrorCode,
  type ProjectRole,
  type ProjectSearchHit,
  parseAuthor,
  parseCaller,
  parseChangePageRequest,
  parsePrincipal,
  pastRetention,
  principalKey,
  projectNameProblem,
  projectSpace,
  READ_PART,
  roleOfMembers,
  SEARCH_MAX,
  SEARCH_PART,
  type SqlDatabase,
  type SqlRow,
  type SqlStatements,
  type SqlValue,
} from "@pikit/contracts";
import { CHANGES, ITEMS, LINKS, MEMBERS, PARTS, PROJECT_TABLES, PROJECTS, SEARCH, VERSIONS } from "./tables.ts";

/** What the provider's config decides (the suite's `staleAfterMs` and `coreTokens`). */
export type ProjectsSqlOptions = { coreTokens: number; staleAfterMs: number };

/** What a project's actor runs on: its database and the App's clock. */
export type ProjectActorEnv = { db: SqlDatabase; now(): number; options: ProjectsSqlOptions };

/** What the directory keeps of a project, sent by its actor after each change (newer versions win). */
export type IndexEntry = {
  project: Project;
  ownerKey: string;
  members: { key: string; source: string; checkedAt: number }[];
};

/** A project actor's answer, and what the component does after the commit: tell the directory, plan a purge. */
export type ProjectAnswer = { answer: JsonValue; indexed?: IndexEntry; removed?: boolean };

/** The actor of `space`'s project. */
export const projectKey = (space: string): string => `projects:space:${space}`;

/** The longest space a project may have, in characters. */
export const SPACE_MAX = 1024;
/** The most principals one `syncMembers` names. */
export const SYNC_MAX = 2_000;
/** The longest query `search` reads, in characters. */
const QUERY_MAX = 500;
const DAY = 86_400_000;
const INSTRUCTIONS_ID = "instructions";

const fail = (code: ProjectErrorCode, message: string) => new ProjectError(code, `projects-sql: ${message}`);
const invalid = (message: string) => fail("invalid", message);

// What crosses as JSON, checked.

type Fields = Record<string, JsonValue | undefined>;

function text(value: unknown, what: string, max: number, options: { empty?: boolean } = {}): string {
  if (typeof value !== "string" || value.length > max || (!options.empty && value.trim() === "")) {
    throw invalid(`${what} is ${options.empty ? "a string" : "a non-empty string"} of at most ${max} characters`);
  }
  return value;
}

function integer(value: unknown, what: string, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw invalid(`${what} is an integer of at least ${min}`);
  return value;
}

/**
 * A value people wrote, refused when it has a known credential's shape, alone, as a word, or as a part
 * of a URL (`?key=sk-...`); the refusal never quotes it.
 */
function noCredential(value: string, what: string): void {
  if (credentialSettingProblem(value) !== undefined || credentialSettingProblem(value.replace(/[?&=#/;,]+/g, " ")) !== undefined) {
    throw fail("refused", `${what} looks like it holds a credential: a project never keeps a secret`);
  }
}

const principalOf = (value: unknown, what: string): Principal => {
  try {
    return parsePrincipal(value, what);
  } catch (error) {
    if (error instanceof ChangeInputError) throw invalid(error.message);
    throw error;
  }
};

/** Splits `text` at `size` characters, never inside a surrogate pair; one empty part for no text. */
function cut(value: string, size: number): { offset: number; text: string }[] {
  const parts: { offset: number; text: string }[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + size);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end -= 1;
    parts.push({ offset: start, text: value.slice(start, end) });
    start = end;
  }
  return parts.length === 0 ? [{ offset: 0, text: "" }] : parts;
}

/** A read part's search parts: about `SEARCH_PART` characters, cut at a space when there is one. */
function searchParts(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + SEARCH_PART);
    if (end < value.length) {
      const space = value.lastIndexOf(" ", end);
      if (space > start + SEARCH_PART / 2) end = space;
      else if (/[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end -= 1;
    }
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * The FTS5 queries `query` is tried as, most precise first: all of its words, the phrase, any of them
 * (memory-sql's `searchAttempts`). Words are runs of letters and digits, each quoted: no query is a
 * syntax error. None when it has no word.
 */
export function searchAttempts(query: string): string[] {
  const words = query.slice(0, QUERY_MAX).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const quoted = words.map((word) => `"${word}"`);
  return [...new Set([quoted.join(" AND "), `"${words.join(" ")}"`, quoted.join(" OR ")])];
}

// Rows.

type ProjectRow = {
  space: string;
  id: string;
  name: string;
  description: string;
  agents: string[];
  archivedAt?: number;
  removedAt?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
};
type MemberRow = Member & { key: string };
/** The record as a `project` entry keeps it. */
type ProjectRecord = { name: string; description: string; agents: string[]; archivedAt: number | null };
type VersionKind = "instructions" | "document";
type VersionRow = { version: number; title: string; mode?: DocumentMode; source?: ProjectDocument["source"]; chars: number; by: Author; at: number; redacted: boolean };

/** The state an entry keeps of its item before the change: what `restore` puts back. */
type Before =
  | { version: number | null }
  | { link: Link | null }
  | { member: MemberRow | null }
  | { record: ProjectRecord; members?: { key: string; member: MemberRow | null }[] };

const optionalNumber = (value: SqlValue | undefined): number | undefined => (value === null || value === undefined ? undefined : Number(value));
const authorFrom = (value: SqlValue | undefined): Author => parseAuthor(JSON.parse(String(value)));

const projectRowOf = (row: SqlRow): ProjectRow => {
  const project: ProjectRow = {
    space: String(row.space),
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    agents: JSON.parse(String(row.agents)) as string[],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version),
  };
  const archivedAt = optionalNumber(row.archived_at);
  const removedAt = optionalNumber(row.removed_at);
  if (archivedAt !== undefined) project.archivedAt = archivedAt;
  if (removedAt !== undefined) project.removedAt = removedAt;
  return project;
};

const memberRowOf = (row: SqlRow): MemberRow => ({
  key: String(row.key),
  principal: parsePrincipalStored(row.principal),
  role: String(row.role) as ProjectRole,
  source: String(row.source),
  checkedAt: Number(row.checked_at),
  by: authorFrom(row.by),
  at: Number(row.at),
});

function parsePrincipalStored(value: SqlValue | undefined): Principal {
  return parsePrincipal(JSON.parse(String(value)));
}

const memberOf = ({ key: _key, ...member }: MemberRow): Member => member;

const versionRowOf = (row: SqlRow): VersionRow => {
  const version: VersionRow = { version: Number(row.version), title: String(row.title), chars: Number(row.chars), by: authorFrom(row.by), at: Number(row.at), redacted: Number(row.redacted) === 1 };
  if (row.mode !== null && row.mode !== undefined) version.mode = String(row.mode) as DocumentMode;
  if (row.source !== null && row.source !== undefined) version.source = JSON.parse(String(row.source)) as ProjectDocument["source"];
  return version;
};

const linkOf = (row: SqlRow): Link => {
  const link: Link = { id: String(row.id), url: String(row.url), title: String(row.title), by: authorFrom(row.by), at: Number(row.at) };
  if (row.note !== null && row.note !== undefined) link.note = String(row.note);
  return link;
};

const documentOf = (id: string, version: VersionRow): ProjectDocument => ({
  id,
  title: version.title,
  mode: version.mode ?? "reference",
  chars: version.chars,
  tokens: estimateTokens(version.chars),
  version: version.version,
  ...(version.source !== undefined && { source: version.source }),
  by: version.by,
  at: version.at,
});

// The actor.

/** One call to a project's actor, from `message` as it arrived at `key`. */
export async function answerProject(env: ProjectActorEnv, key: string, message: JsonValue): Promise<ProjectAnswer> {
  if (!isJsonObject(message)) throw invalid("a call is a JSON object");
  const space = text(message.space, "space", SPACE_MAX);
  if (key !== projectKey(space)) throw invalid(`${key} does not hold the project of this space`);
  const op = message.op;
  if (typeof op !== "string" || !Object.hasOwn(OPS, op)) throw invalid(`op is one of ${Object.keys(OPS).join(", ")}`);
  const run = OPS[op as keyof typeof OPS];
  return env.db.transaction((tx) => run(new Project_(tx, env, space), message));
}

/** One call's view of the project: its rows, read and written in the call's transaction. */
class Project_ {
  constructor(
    readonly tx: SqlStatements,
    readonly env: ProjectActorEnv,
    readonly space: string,
  ) {}

  now = () => this.env.now();

  async row(): Promise<ProjectRow | undefined> {
    const [row] = await this.tx.query(`SELECT * FROM ${PROJECTS} WHERE space = ?`, [this.space]);
    return row === undefined ? undefined : projectRowOf(row);
  }

  async members(): Promise<MemberRow[]> {
    const rows = await this.tx.query(`SELECT * FROM ${MEMBERS} WHERE space = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, at, rowid`, [this.space]);
    return rows.map(memberRowOf);
  }

  async member(key: string): Promise<MemberRow | undefined> {
    const [row] = await this.tx.query(`SELECT * FROM ${MEMBERS} WHERE space = ? AND key = ?`, [this.space, key]);
    return row === undefined ? undefined : memberRowOf(row);
  }

  current = (member: MemberRow) => memberIsCurrent(member, this.now(), this.env.options.staleAfterMs);

  /** `row` as `caller` sees it. */
  project(row: ProjectRow, members: MemberRow[], caller: Caller | undefined, role?: ProjectRole): Project {
    const owner = members.find((member) => member.role === "owner");
    if (owner === undefined) throw fail("conflict", "the project has no owner");
    return {
      id: row.id,
      space: row.space,
      name: row.name,
      description: row.description,
      agents: row.agents,
      owner: owner.principal,
      ...(role !== undefined && { role }),
      members: members.filter(this.current).length,
      ...(row.archivedAt !== undefined && { archivedAt: row.archivedAt }),
      ...(row.removedAt !== undefined && caller?.kind === "operator" && { removedAt: row.removedAt }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      coreTokens: this.env.options.coreTokens,
    };
  }

  /** What the directory keeps after this call. */
  async indexEntry(): Promise<IndexEntry | undefined> {
    const row = await this.row();
    if (row === undefined) return undefined;
    const members = await this.members();
    const project = this.project(row, members, { kind: "operator", id: "projects-sql" });
    return { project, ownerKey: principalKey(project.owner), members: members.map((member) => ({ key: member.key, source: member.source, checkedAt: member.checkedAt })) };
  }

  /** Appends one entry: `n` the next of this space's log, gapless. */
  async log(entry: { by: Author; action: ChangeAction; kind: string; item: string; title: string; version?: number; restores?: number; before: Before | null; restorable: boolean }): Promise<number> {
    const [last] = await this.tx.query(`SELECT COALESCE(MAX(n), 0) AS n FROM ${CHANGES} WHERE space = ?`, [this.space]);
    const n = Number(last?.n ?? 0) + 1;
    await this.tx.run(
      `INSERT INTO ${CHANGES} (space, n, at, by, action, kind, item, title, version, restores, before, restorable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.space,
        n,
        this.now(),
        JSON.stringify(entry.by),
        entry.action,
        entry.kind,
        entry.item,
        changeTitle(entry.title),
        entry.version ?? null,
        entry.restores ?? null,
        entry.before === null ? null : JSON.stringify(entry.before),
        entry.restorable ? 1 : 0,
      ],
    );
    return n;
  }

  /** The project's version and time, after a change. */
  async bump(): Promise<void> {
    await this.tx.run(`UPDATE ${PROJECTS} SET version = version + 1, updated_at = ? WHERE space = ?`, [this.now(), this.space]);
  }

  changeOf(row: SqlRow): Change {
    const at = Number(row.at);
    const redactedAt = optionalNumber(row.redacted_at);
    const version = optionalNumber(row.version);
    const restores = optionalNumber(row.restores);
    return {
      n: Number(row.n),
      at,
      by: authorFrom(row.by),
      action: String(row.action) as ChangeAction,
      item: { kind: String(row.kind), id: String(row.item), title: String(row.title) },
      ...(version !== undefined && { version }),
      ...(restores !== undefined && { restores }),
      restorable: Number(row.restorable) === 1 && redactedAt === undefined && !pastRetention(at, this.now()),
      ...(redactedAt !== undefined && { redacted: { at: redactedAt, by: authorFrom(row.redacted_by) } }),
    };
  }

  // Versioned items: the instructions and each document.

  async currentVersion(kind: VersionKind, id: string): Promise<number | undefined> {
    const [row] = await this.tx.query(`SELECT version FROM ${ITEMS} WHERE space = ? AND kind = ? AND id = ?`, [this.space, kind, id]);
    return row === undefined ? undefined : Number(row.version);
  }

  async version(kind: VersionKind, id: string, version: number): Promise<VersionRow | undefined> {
    const [row] = await this.tx.query(`SELECT * FROM ${VERSIONS} WHERE space = ? AND kind = ? AND id = ? AND version = ?`, [this.space, kind, id, version]);
    return row === undefined ? undefined : versionRowOf(row);
  }

  async text(kind: VersionKind, id: string, version: number): Promise<string> {
    const rows = await this.tx.query(`SELECT text FROM ${PARTS} WHERE space = ? AND kind = ? AND id = ? AND version = ? ORDER BY part`, [this.space, kind, id, version]);
    return rows.map((row) => String(row.text)).join("");
  }

  async parts(kind: VersionKind, id: string, version: number): Promise<number> {
    const [row] = await this.tx.query(`SELECT COUNT(*) AS parts FROM ${PARTS} WHERE space = ? AND kind = ? AND id = ? AND version = ?`, [this.space, kind, id, version]);
    return Math.max(1, Number(row?.parts ?? 1));
  }

  /** A new current version of the item, its text in parts, indexed for search. */
  async writeVersion(kind: VersionKind, id: string, content: { title: string; mode?: DocumentMode; source?: ProjectDocument["source"]; text: string; by: Author }): Promise<number> {
    const [last] = await this.tx.query(`SELECT COALESCE(MAX(version), 0) AS version FROM ${VERSIONS} WHERE space = ? AND kind = ? AND id = ?`, [this.space, kind, id]);
    const version = Number(last?.version ?? 0) + 1;
    await this.tx.run(`INSERT INTO ${VERSIONS} (space, kind, id, version, title, mode, source, chars, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      this.space,
      kind,
      id,
      version,
      content.title,
      content.mode ?? null,
      content.source === undefined ? null : JSON.stringify(content.source),
      content.text.length,
      JSON.stringify(content.by),
      this.now(),
    ]);
    const parts = cut(content.text, READ_PART);
    for (const [index, part] of parts.entries()) {
      await this.tx.run(`INSERT INTO ${PARTS} (space, kind, id, version, part, text) VALUES (?, ?, ?, ?, ?, ?)`, [this.space, kind, id, version, index + 1, part.text]);
    }
    await this.tx.run(`INSERT INTO ${ITEMS} (space, kind, id, version) VALUES (?, ?, ?, ?) ON CONFLICT (space, kind, id) DO UPDATE SET version = excluded.version`, [
      this.space,
      kind,
      id,
      version,
    ]);
    await this.unindex(kind, id);
    for (const [index, part] of parts.entries()) {
      for (const piece of searchParts(part.text)) {
        await this.tx.run(`INSERT INTO ${SEARCH} (text, space, kind, item, version, part) VALUES (?, ?, ?, ?, ?, ?)`, [
          kind === "document" ? `${content.title}\n${piece}` : piece,
          this.space,
          kind,
          id,
          version,
          index + 1,
        ]);
      }
    }
    await this.dropOldVersions();
    return version;
  }

  async unindex(kind: string, id: string): Promise<void> {
    await this.tx.run(`DELETE FROM ${SEARCH} WHERE space = ? AND kind = ? AND item = ?`, [this.space, kind, id]);
  }

  /** Takes an item out of the current ones (its versions stay, for restore). */
  async dropCurrent(kind: VersionKind, id: string): Promise<void> {
    await this.tx.run(`DELETE FROM ${ITEMS} WHERE space = ? AND kind = ? AND id = ?`, [this.space, kind, id]);
    await this.unindex(kind, id);
  }

  /** Past `PROJECT_TEXT_WITH_VERSIONS_MAX` characters with versions, the oldest earlier versions go; their entries are not restorable any more. */
  async dropOldVersions(): Promise<void> {
    const [total] = await this.tx.query(`SELECT COALESCE(SUM(chars), 0) AS chars FROM ${VERSIONS} WHERE space = ?`, [this.space]);
    let excess = Number(total?.chars ?? 0) - PROJECT_TEXT_WITH_VERSIONS_MAX;
    if (excess <= 0) return;
    const old = await this.tx.query(
      `SELECT v.kind, v.id, v.version, v.chars FROM ${VERSIONS} AS v LEFT JOIN ${ITEMS} AS i ON i.space = v.space AND i.kind = v.kind AND i.id = v.id AND i.version = v.version ` +
        "WHERE v.space = ? AND i.version IS NULL ORDER BY v.at, v.version",
      [this.space],
    );
    for (const row of old) {
      if (excess <= 0) break;
      const [kind, id, version] = [String(row.kind), String(row.id), Number(row.version)];
      await this.tx.run(`DELETE FROM ${VERSIONS} WHERE space = ? AND kind = ? AND id = ? AND version = ?`, [this.space, kind, id, version]);
      await this.tx.run(`DELETE FROM ${PARTS} WHERE space = ? AND kind = ? AND id = ? AND version = ?`, [this.space, kind, id, version]);
      await this.tx.run(`UPDATE ${CHANGES} SET restorable = 0 WHERE space = ? AND kind = ? AND item = ? AND before = ?`, [this.space, kind, id, JSON.stringify({ version })]);
      excess -= Number(row.chars);
    }
  }

  async documentsNow(): Promise<{ document: ProjectDocument; core: boolean }[]> {
    const rows = await this.tx.query(
      `SELECT v.* FROM ${ITEMS} AS i JOIN ${VERSIONS} AS v ON v.space = i.space AND v.kind = i.kind AND v.id = i.id AND v.version = i.version ` +
        "WHERE i.space = ? AND i.kind = 'document' ORDER BY CASE v.mode WHEN 'core' THEN 0 ELSE 1 END, v.title, v.id",
      [this.space],
    );
    return rows.map((row) => {
      const document = documentOf(String(row.id), versionRowOf(row));
      return { document, core: document.mode === "core" };
    });
  }

  /** Whether a document of `chars` characters, in `mode`, fits the project in place of document `id`'s current text; `limit` otherwise. */
  async checkFits(id: string | undefined, chars: number, mode: DocumentMode): Promise<void> {
    const documents = (await this.documentsNow()).filter(({ document }) => document.id !== id);
    if (id === undefined || !(await this.currentVersion("document", id))) {
      if (documents.length >= PROJECT_DOCUMENTS_MAX) throw fail("limit", `a project holds at most ${PROJECT_DOCUMENTS_MAX} documents`);
    }
    const total = documents.reduce((sum, { document }) => sum + document.chars, 0);
    if (total + chars > PROJECT_TEXT_MAX) throw fail("limit", `a project holds at most ${PROJECT_TEXT_MAX} characters of documents; ${Math.max(0, PROJECT_TEXT_MAX - total)} are left`);
    if (mode === "core") {
      const used = documents.reduce((sum, { document }) => sum + (document.mode === "core" ? document.tokens : 0), 0);
      const left = Math.max(0, this.env.options.coreTokens - used);
      const tokens = estimateTokens(chars);
      if (tokens > left) {
        throw fail("limit", `a core document of about ${tokens} tokens does not fit: ${left} of the ${this.env.options.coreTokens} tokens of core documents are left; keep it as reference`);
      }
    }
  }

  // Links.

  async link(id: string): Promise<Link | undefined> {
    const [row] = await this.tx.query(`SELECT * FROM ${LINKS} WHERE space = ? AND id = ?`, [this.space, id]);
    return row === undefined ? undefined : linkOf(row);
  }

  async putLink(link: Link): Promise<void> {
    await this.tx.run(
      `INSERT INTO ${LINKS} (space, id, url, title, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?) ` +
        "ON CONFLICT (space, id) DO UPDATE SET url = excluded.url, title = excluded.title, note = excluded.note, by = excluded.by, at = excluded.at",
      [this.space, link.id, link.url, link.title, link.note ?? null, JSON.stringify(link.by), link.at],
    );
    await this.unindex("link", link.id);
    await this.tx.run(`INSERT INTO ${SEARCH} (text, space, kind, item, version, part) VALUES (?, ?, 'link', ?, NULL, NULL)`, [
      [link.title, link.url, link.note ?? ""].join("\n"),
      this.space,
      link.id,
    ]);
  }

  async dropLink(id: string): Promise<void> {
    await this.tx.run(`DELETE FROM ${LINKS} WHERE space = ? AND id = ?`, [this.space, id]);
    await this.unindex("link", id);
  }

  // Members.

  async putMember(member: MemberRow): Promise<void> {
    await this.tx.run(
      `INSERT INTO ${MEMBERS} (space, key, principal, role, source, checked_at, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ` +
        "ON CONFLICT (space, key) DO UPDATE SET principal = excluded.principal, role = excluded.role, source = excluded.source, checked_at = excluded.checked_at, by = excluded.by, at = excluded.at",
      [this.space, member.key, JSON.stringify(member.principal), member.role, member.source, member.checkedAt, JSON.stringify(member.by), member.at],
    );
  }

  async dropMember(key: string): Promise<void> {
    await this.tx.run(`DELETE FROM ${MEMBERS} WHERE space = ? AND key = ?`, [this.space, key]);
  }

  /** Exactly one owner, a manual member: checked after every change of members, which rolls back otherwise. */
  async oneOwner(): Promise<void> {
    const owners = (await this.members()).filter((member) => member.role === "owner");
    if (owners.length !== 1 || owners[0]?.source !== "manual") throw fail("conflict", "a project has exactly one owner, a manual member: this change would leave it otherwise");
  }

  // The record.

  record(row: ProjectRow): ProjectRecord {
    return { name: row.name, description: row.description, agents: row.agents, archivedAt: row.archivedAt ?? null };
  }

  async putRecord(record: ProjectRecord): Promise<void> {
    await this.tx.run(`UPDATE ${PROJECTS} SET name = ?, description = ?, agents = ?, archived_at = ? WHERE space = ?`, [
      record.name,
      record.description,
      JSON.stringify(record.agents),
      record.archivedAt,
      this.space,
    ]);
  }

  // Snapshots: what an entry keeps, and what restore puts back.

  async capture(kind: string, item: string, like: Before | null): Promise<Before> {
    switch (kind) {
      case "instructions":
      case "document":
        return { version: (await this.currentVersion(kind, item)) ?? null };
      case "link":
        return { link: (await this.link(item)) ?? null };
      case "member":
        return { member: (await this.member(item)) ?? null };
      default: {
        const row = (await this.row()) as ProjectRow;
        const keys = like !== null && "members" in like && like.members !== undefined ? like.members.map((each) => each.key) : [];
        if (keys.length === 0) return { record: this.record(row) };
        return { record: this.record(row), members: await Promise.all(keys.map(async (key) => ({ key, member: (await this.member(key)) ?? null }))) };
      }
    }
  }

  /** Puts `before` back; the new version's number when the item is versioned and present. */
  async apply(kind: string, item: string, before: Before): Promise<{ version?: number; title: string }> {
    if ("version" in before) {
      const versioned = kind as VersionKind;
      if (before.version === null) {
        const current = await this.currentVersion(versioned, item);
        const title = current === undefined ? item : ((await this.version(versioned, item, current))?.title ?? item);
        await this.dropCurrent(versioned, item);
        return { title };
      }
      const old = await this.version(versioned, item, before.version);
      if (old === undefined || old.redacted) throw fail("gone", "the state before this change is no longer kept");
      const words = await this.text(versioned, item, before.version);
      if (versioned === "document") await this.checkFits(item, words.length, old.mode ?? "reference");
      const version = await this.writeVersion(versioned, item, {
        title: old.title,
        ...(old.mode !== undefined && { mode: old.mode }),
        ...(old.source !== undefined && { source: old.source }),
        text: words,
        by: old.by,
      });
      return { version, title: old.title };
    }
    if ("link" in before) {
      if (before.link === null) {
        const title = (await this.link(item))?.title ?? item;
        await this.dropLink(item);
        return { title };
      }
      const [other] = await this.tx.query(`SELECT id FROM ${LINKS} WHERE space = ? AND url = ? AND id <> ?`, [this.space, before.link.url, item]);
      if (other !== undefined) throw fail("conflict", "another link of the project has this URL now");
      if ((await this.link(item)) === undefined) await this.checkLinks();
      await this.putLink(before.link);
      return { title: before.link.title };
    }
    if ("member" in before) {
      const now = await this.member(item);
      if (before.member === null) {
        if (now !== undefined) await this.dropMember(item);
      } else {
        await this.putMember(before.member);
      }
      await this.oneOwner();
      const principal = before.member?.principal ?? now?.principal;
      return { title: principal === undefined ? item : memberTitle(principal) };
    }
    await this.putRecord(before.record);
    const members = before.members ?? [];
    if (members.some((each) => each.member?.role === "owner")) await this.tx.run(`UPDATE ${MEMBERS} SET role = 'member' WHERE space = ? AND role = 'owner'`, [this.space]);
    for (const { key, member } of members) {
      if (member === null) await this.dropMember(key);
      else await this.putMember(member);
    }
    if (members.length > 0) await this.oneOwner();
    return { title: before.record.name };
  }

  async checkLinks(): Promise<void> {
    const [count] = await this.tx.query(`SELECT COUNT(*) AS links FROM ${LINKS} WHERE space = ?`, [this.space]);
    if (Number(count?.links ?? 0) >= PROJECT_LINKS_MAX) throw fail("limit", `a project keeps at most ${PROJECT_LINKS_MAX} links`);
  }
}

const memberTitle = (principal: Principal): string => principal.name ?? `${principal.channel}:${principal.id}`;

// Who may call what.

/** How each caller kind may call an op. `member`: any current member; `owner`: the owner; `never`. */
type Rule = { people: "member" | "owner" | "never"; agent: boolean; operator: boolean; component: boolean; write: boolean };
const READ: Rule = { people: "member", agent: false, operator: true, component: true, write: false };
const AGENT_READ: Rule = { ...READ, agent: true };
const WRITE: Rule = { people: "member", agent: false, operator: true, component: true, write: true };
const OWNER: Rule = { people: "owner", agent: false, operator: true, component: true, write: true };

/** What `access` found: the project, its members, the caller and its role (people). */
type Access = { row: ProjectRow; members: MemberRow[]; caller: Caller; role?: ProjectRole };

/** The project as `caller` may act on it under `rule`, or the refusal; `undefined` for an absent project when `absent` allows it. */
async function access(p: Project_, message: Fields, rule: Rule, options: { absent?: boolean } = {}): Promise<Access | undefined> {
  const caller = parseCaller(message.caller);
  if (caller.kind === "agent") {
    if (caller.space !== p.space) throw fail("forbidden", "an agent acts only in the space it works in");
    if (!rule.agent) throw fail("forbidden", "an agent reads the project and adds links; the rest is people's");
  }
  if (caller.kind === "operator" && !rule.operator) throw fail("forbidden", "operators do not make this call");
  if (caller.kind === "component" && !rule.component) throw fail("forbidden", "components do not make this call");
  const row = await p.row();
  const gone = row === undefined || (row.removedAt !== undefined && caller.kind !== "operator");
  if (gone) {
    if (options.absent) return undefined;
    throw fail("not_found", "no such project");
  }
  const members = await p.members();
  let role: ProjectRole | undefined;
  if (caller.kind === "people") {
    role = roleOfMembers(members, caller.principals, p.now(), p.env.options.staleAfterMs);
    if (role === undefined) {
      if (options.absent) return undefined;
      throw fail("not_found", "no such project");
    }
    if (rule.people === "never") throw fail("forbidden", "people do not make this call");
    if (rule.people === "owner" && role !== "owner") throw fail("forbidden", "this is the owner's to do");
  }
  if (rule.write && row.removedAt !== undefined) throw fail("forbidden", "the project was removed: recover it first");
  return { row, members, caller, ...(role !== undefined && { role }) };
}

/** Content writes stop while the project is archived (read-only); the owner unarchives it. */
const notArchived = (row: ProjectRow) => {
  if (row.archivedAt !== undefined) throw fail("forbidden", "the project is archived (read-only): the owner unarchives it first");
};

/** The answer and the directory's entry after a change. */
async function changed(p: Project_, answer: JsonValue): Promise<ProjectAnswer> {
  await p.bump();
  const indexed = await p.indexEntry();
  return { answer, ...(indexed !== undefined && { indexed }) };
}

const toJson = (value: unknown): JsonValue => value as JsonValue;

/** A document's title and text as people give them, checked. */
function documentInput(fields: Fields) {
  const input = fields.input;
  if (!isJsonObject(input)) throw invalid("input is a JSON object");
  const title = text(input.title, "a document's title", DOCUMENT_TITLE_MAX);
  if (/[\r\n]/.test(title)) throw invalid("a document's title is one line");
  if (typeof input.text !== "string") throw invalid("a document's text is a string");
  if (input.text.length > DOCUMENT_MAX) throw fail("limit", `a document holds at most ${DOCUMENT_MAX} characters`);
  if (input.mode !== "core" && input.mode !== "reference") throw invalid('a document\'s mode is "core" or "reference"');
  noCredential(title, "the title");
  noCredential(input.text, "the text");
  let source: ProjectDocument["source"];
  if (input.source !== undefined && input.source !== null) {
    if (!isJsonObject(input.source)) throw invalid("source is { file, fileVersion }");
    source = { file: text(input.source.file, "source.file", 1024), fileVersion: integer(input.source.fileVersion, "source.fileVersion", 1) };
  }
  const id = input.id === undefined || input.id === null ? undefined : text(input.id, "a document's id", 64);
  const ifVersion = input.ifVersion === undefined || input.ifVersion === null ? undefined : integer(input.ifVersion, "ifVersion");
  return { id, title, text: input.text, mode: input.mode as DocumentMode, source, ifVersion };
}

function recordInput(change: JsonValue | undefined): { name?: string; description?: string; agents?: string[]; archived?: boolean } {
  if (!isJsonObject(change)) throw invalid("change is a JSON object");
  const out: { name?: string; description?: string; agents?: string[]; archived?: boolean } = {};
  if (change.name !== undefined && change.name !== null) {
    if (typeof change.name !== "string") throw invalid("name is a string");
    noCredential(change.name, "the name");
    const problem = projectNameProblem(change.name);
    if (problem !== undefined) throw invalid(problem);
    out.name = change.name.trim();
  }
  if (change.description !== undefined && change.description !== null) {
    out.description = text(change.description, "description", PROJECT_DESCRIPTION_MAX, { empty: true });
    noCredential(out.description, "the description");
  }
  if (change.agents !== undefined && change.agents !== null) {
    if (!Array.isArray(change.agents) || change.agents.length > 100) throw invalid("agents is a list of at most 100 agent names");
    out.agents = [...new Set(change.agents.map((agent) => text(agent, "an agent's name", 200)))];
  }
  if (change.archived !== undefined && change.archived !== null) {
    if (typeof change.archived !== "boolean") throw invalid("archived is true or false");
    out.archived = change.archived;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

type Op = (p: Project_, message: Fields) => Promise<ProjectAnswer>;

const OPS = {
  /** From the directory's `create`: the project of this space, made once (the same id again: as it is). */
  async init(p, message) {
    const caller = parseCaller(message.caller);
    if (caller.kind === "agent") throw fail("forbidden", "agents do not make projects");
    const input = message.project;
    if (!isJsonObject(input)) throw invalid("project is a JSON object");
    const id = input.id;
    if (!isProjectId(id)) throw invalid("a project's id is 32 lowercase hex");
    const owner = principalOf(input.owner, "owner");
    if (caller.kind === "people" && (p.space !== projectSpace(id) || !same(principalOf(caller.principals[0], "caller"), owner))) {
      throw fail("forbidden", "people make projects in a new space, owned by themselves");
    }
    const record = recordInput({ name: input.name ?? null, description: input.description ?? "", agents: input.agents ?? [] });
    if (record.name === undefined) throw invalid("a project has a name");
    const existing = await p.row();
    if (existing !== undefined) {
      if (existing.id !== id) throw fail("space_taken", "this space already has a project");
      return { answer: toJson({ project: p.project(existing, await p.members(), caller), indexed: await p.indexEntry() }) };
    }
    const now = p.now();
    const by = authorOf(caller);
    await p.tx.run(`INSERT INTO ${PROJECTS} (space, id, name, description, agents, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [
      p.space,
      id,
      record.name,
      record.description ?? "",
      JSON.stringify(record.agents ?? []),
      now,
      now,
    ]);
    await p.putMember({ key: principalKey(owner), principal: owner, role: "owner", source: "manual", checkedAt: now, by, at: now });
    await p.log({ by, action: "added", kind: "project", item: id, title: record.name, before: null, restorable: false });
    // The directory keeps what this answers (it made the call): no `indexed` to send it.
    const project = p.project((await p.row()) as ProjectRow, await p.members(), caller, caller.kind === "people" ? "owner" : undefined);
    return { answer: toJson({ project, indexed: await p.indexEntry() }) };
  },

  async get(p, message) {
    const found = await access(p, message, AGENT_READ, { absent: true });
    if (found === undefined) return { answer: null };
    return { answer: toJson(p.project(found.row, found.members, found.caller, found.role)) };
  },

  /** For trusted components: the best role of `principals` now. */
  async roleOf(p, message) {
    if (!Array.isArray(message.principals) || message.principals.length > 20) throw invalid("principals is a list of at most 20 principals");
    const principals = message.principals.map((each) => principalOf(each, "principals[]"));
    const row = await p.row();
    if (row === undefined || row.removedAt !== undefined) return { answer: null };
    return { answer: roleOfMembers(await p.members(), principals, p.now(), p.env.options.staleAfterMs) ?? null };
  },

  async update(p, message) {
    const change = recordInput(message.change);
    const owners = change.agents !== undefined || change.archived !== undefined;
    const { row, members, caller, role } = (await access(p, message, owners ? OWNER : WRITE)) as Access;
    if (row.archivedAt !== undefined && !(change.archived === false)) notArchived(row);
    const before = p.record(row);
    const after: ProjectRecord = {
      name: change.name ?? before.name,
      description: change.description ?? before.description,
      agents: change.agents ?? before.agents,
      archivedAt: change.archived === undefined ? before.archivedAt : change.archived ? (before.archivedAt ?? p.now()) : null,
    };
    if (same(before, after)) return { answer: toJson(p.project(row, members, caller, role)) };
    await p.putRecord(after);
    await p.log({ by: authorOf(caller), action: "changed", kind: "project", item: row.id, title: after.name, before: { record: before }, restorable: true });
    const result = await changed(p, null);
    return { ...result, answer: toJson(p.project((await p.row()) as ProjectRow, members, caller, role)) };
  },

  async members(p, message) {
    const { members, caller } = (await access(p, message, READ)) as Access;
    const page = isJsonObject(message.page) ? message.page : {};
    const limit = page.limit === undefined || page.limit === null ? 50 : integer(page.limit, "limit", 1);
    if (limit > 200) throw invalid("limit is at most 200");
    const start = page.cursor === undefined || page.cursor === null ? 0 : integer(Number(page.cursor), "cursor");
    const shown = caller.kind === "operator" ? members : members.filter(p.current);
    const items = shown.slice(start, start + limit).map(memberOf);
    return { answer: toJson({ items, ...(start + limit < shown.length && { next: String(start + limit) }) }) };
  },

  async addMember(p, message) {
    const principal = principalOf(message.principal, "principal");
    const { row, caller } = (await access(p, message, WRITE)) as Access;
    notArchived(row);
    const key = principalKey(principal);
    const existing = await p.member(key);
    if (existing !== undefined && p.current(existing)) return { answer: toJson(memberOf(existing)) };
    const now = p.now();
    const member: MemberRow = { key, principal, role: "member", source: "manual", checkedAt: now, by: authorOf(caller), at: now };
    await p.putMember(member);
    await p.log({ by: member.by, action: existing === undefined ? "added" : "changed", kind: "member", item: key, title: memberTitle(principal), before: { member: existing ?? null }, restorable: true });
    return changed(p, toJson(memberOf(member)));
  },

  async removeMember(p, message) {
    const principal = principalOf(message.principal, "principal");
    const { row, caller, role } = (await access(p, message, WRITE)) as Access;
    notArchived(row);
    const key = principalKey(principal);
    const self = caller.kind === "people" && caller.principals.some((each) => principalKey(each) === key);
    if (caller.kind === "people" && !self && role !== "owner") throw fail("forbidden", "the owner removes other members; anyone leaves");
    const existing = await p.member(key);
    if (existing === undefined) return { answer: false };
    if (existing.role === "owner") throw fail("forbidden", "the owner leaves only after transferring the ownership");
    if (existing.source !== "manual") throw fail("forbidden", `this member comes from ${existing.source}: it changes there, never by hand`);
    await p.dropMember(key);
    await p.log({ by: authorOf(caller), action: "removed", kind: "member", item: key, title: memberTitle(existing.principal), before: { member: existing }, restorable: true });
    return changed(p, true);
  },

  async transferOwnership(p, message) {
    const principal = principalOf(message.principal, "principal");
    const { row, members, caller, role } = (await access(p, message, OWNER)) as Access;
    notArchived(row);
    const key = principalKey(principal);
    const target = members.find((member) => member.key === key);
    if (target === undefined || !p.current(target)) throw invalid("the ownership goes to a current member");
    const owner = members.find((member) => member.role === "owner") as MemberRow;
    if (owner.key === key) return { answer: toJson(p.project(row, members, caller, role)) };
    const before: Before = { record: p.record(row), members: [{ key: owner.key, member: owner }, { key, member: target }] };
    await p.putMember({ ...owner, role: "member" });
    await p.putMember({ ...target, role: "owner", source: "manual", checkedAt: p.now() });
    await p.oneOwner();
    await p.log({ by: authorOf(caller), action: "changed", kind: "project", item: row.id, title: row.name, before, restorable: true });
    const result = await changed(p, null);
    const roleNow = caller.kind === "people" ? roleOfMembers(await p.members(), caller.principals, p.now(), p.env.options.staleAfterMs) : undefined;
    return { ...result, answer: toJson(p.project((await p.row()) as ProjectRow, await p.members(), caller, roleNow)) };
  },

  async syncMembers(p, message) {
    const { caller } = (await access(p, message, { people: "never", agent: false, operator: false, component: true, write: true })) as Access;
    const sync = message.sync;
    if (!isJsonObject(sync)) throw invalid("sync is { source, principals, checkedAt }");
    const source = text(sync.source, "sync.source", 200);
    if (source === "manual") throw invalid('"manual" is not a source');
    const checkedAt = integer(sync.checkedAt, "sync.checkedAt");
    if (!Array.isArray(sync.principals) || sync.principals.length > SYNC_MAX) throw invalid(`sync.principals is a list of at most ${SYNC_MAX} principals`);
    const principals = new Map(sync.principals.map((each) => principalOf(each, "sync.principals[]")).map((principal) => [principalKey(principal), principal]));
    const by = authorOf(caller);
    let count = 0;
    for (const member of await p.members()) {
      if (member.source === source && !principals.has(member.key)) {
        await p.dropMember(member.key);
        await p.log({ by, action: "removed", kind: "member", item: member.key, title: memberTitle(member.principal), before: { member }, restorable: true });
        count++;
      }
    }
    for (const [key, principal] of principals) {
      const existing = await p.member(key);
      if (existing !== undefined && existing.source !== source) continue;
      const member: MemberRow = { key, principal, role: "member", source, checkedAt, by: existing?.by ?? by, at: existing?.at ?? p.now() };
      await p.putMember(member);
      if (existing === undefined) {
        await p.log({ by, action: "added", kind: "member", item: key, title: memberTitle(principal), before: { member: null }, restorable: true });
        count++;
      }
    }
    if (count === 0) return { answer: null };
    return changed(p, null);
  },

  async instructions(p, message) {
    await access(p, message, AGENT_READ);
    const query = isJsonObject(message.query) ? message.query : {};
    const version = query.version === undefined || query.version === null ? await p.currentVersion("instructions", INSTRUCTIONS_ID) : integer(query.version, "version", 1);
    if (version === undefined) return { answer: null };
    const row = await p.version("instructions", INSTRUCTIONS_ID, version);
    if (row === undefined) return { answer: null };
    const instructions: Instructions = { text: await p.text("instructions", INSTRUCTIONS_ID, version), version, by: row.by, at: row.at };
    return { answer: toJson(instructions) };
  },

  async setInstructions(p, message) {
    const input = isJsonObject(message.input) ? message.input : {};
    if (typeof input.text !== "string") throw invalid("text is a string");
    const ifVersion = integer(input.ifVersion, "ifVersion");
    const { row, caller } = (await access(p, message, WRITE)) as Access;
    notArchived(row);
    if (input.text.length > INSTRUCTIONS_MAX) throw fail("limit", `instructions hold at most ${INSTRUCTIONS_MAX} characters`);
    noCredential(input.text, "the instructions");
    const current = await p.currentVersion("instructions", INSTRUCTIONS_ID);
    if ((current ?? 0) !== ifVersion) throw fail("conflict", `the instructions changed meanwhile (version ${current ?? 0}, not ${ifVersion})`);
    const answer = async (version: number) => {
      const stored = (await p.version("instructions", INSTRUCTIONS_ID, version)) as VersionRow;
      return toJson({ text: await p.text("instructions", INSTRUCTIONS_ID, version), version, by: stored.by, at: stored.at } satisfies Instructions);
    };
    if (current !== undefined && (await p.text("instructions", INSTRUCTIONS_ID, current)) === input.text) return { answer: await answer(current) };
    const by = authorOf(caller);
    const version = await p.writeVersion("instructions", INSTRUCTIONS_ID, { title: "Instructions", text: input.text, by });
    await p.log({
      by,
      action: current === undefined ? "added" : "changed",
      kind: "instructions",
      item: INSTRUCTIONS_ID,
      title: input.text.trim() === "" ? "Instructions" : input.text,
      version,
      before: { version: current ?? null },
      restorable: true,
    });
    return changed(p, await answer(version));
  },

  async documents(p, message) {
    await access(p, message, READ);
    return { answer: toJson((await p.documentsNow()).map(({ document }) => document)) };
  },

  async putDocument(p, message) {
    const input = documentInput(message);
    const { row, caller } = (await access(p, message, WRITE)) as Access;
    notArchived(row);
    const current = input.id === undefined ? undefined : await p.currentVersion("document", input.id);
    if (input.id !== undefined && current === undefined) throw fail("not_found", "no such document");
    if (input.ifVersion !== undefined && current !== undefined && input.ifVersion !== current) throw fail("conflict", `the document changed meanwhile (version ${current}, not ${input.ifVersion})`);
    const id = input.id ?? `d-${randomHex(8)}`;
    if (current !== undefined) {
      const old = (await p.version("document", id, current)) as VersionRow;
      const unchanged = old.title === input.title && (old.mode ?? "reference") === input.mode && same(old.source, input.source) && (await p.text("document", id, current)) === input.text;
      if (unchanged) return { answer: toJson(documentOf(id, old)) };
    }
    await p.checkFits(input.id, input.text.length, input.mode);
    const by = authorOf(caller);
    const version = await p.writeVersion("document", id, { title: input.title, mode: input.mode, ...(input.source !== undefined && { source: input.source }), text: input.text, by });
    await p.log({ by, action: current === undefined ? "added" : "changed", kind: "document", item: id, title: input.title, version, before: { version: current ?? null }, restorable: true });
    return changed(p, toJson(documentOf(id, (await p.version("document", id, version)) as VersionRow)));
  },

  async removeDocument(p, message) {
    const id = text(message.id, "id", 64);
    const { row, caller } = (await access(p, message, WRITE)) as Access;
    notArchived(row);
    const current = await p.currentVersion("document", id);
    if (current === undefined) return { answer: false };
    const old = (await p.version("document", id, current)) as VersionRow;
    await p.dropCurrent("document", id);
    await p.log({ by: authorOf(caller), action: "removed", kind: "document", item: id, title: old.title, before: { version: current }, restorable: true });
    return changed(p, true);
  },

  async read(p, message) {
    const id = text(message.id, "id", 64);
    await access(p, message, AGENT_READ);
    const query = isJsonObject(message.query) ? message.query : {};
    const part = integer(query.part ?? 1, "part", 1);
    const current = await p.currentVersion("document", id);
    if (current === undefined) return { answer: null };
    const version = query.version === undefined || query.version === null ? current : integer(query.version, "version", 1);
    const row = await p.version("document", id, version);
    if (row === undefined) return { answer: null };
    const parts = await p.parts("document", id, version);
    if (part > parts) return { answer: null };
    const [stored] = await p.tx.query(`SELECT text FROM ${PARTS} WHERE space = ? AND kind = 'document' AND id = ? AND version = ? AND part = ?`, [p.space, id, version, part]);
    const read: DocumentRead = { document: documentOf(id, row), text: stored === undefined ? "" : String(stored.text), part, parts };
    return { answer: toJson(read) };
  },

  async versions(p, message) {
    await access(p, message, READ);
    const item = message.item;
    if (!isJsonObject(item) || (item.kind !== "instructions" && item.kind !== "document")) throw invalid('item is { kind: "instructions" } or { kind: "document", id }');
    const kind = item.kind as VersionKind;
    const id = kind === "instructions" ? INSTRUCTIONS_ID : text(item.id, "item.id", 64);
    const rows = await p.tx.query(`SELECT * FROM ${VERSIONS} WHERE space = ? AND kind = ? AND id = ? ORDER BY version`, [p.space, kind, id]);
    const versions = rows.map((row): ItemVersion => {
      const version = versionRowOf(row);
      const out: ItemVersion = { version: version.version, by: version.by, at: version.at, chars: version.chars };
      if (kind === "document") {
        out.title = version.title;
        if (version.mode !== undefined) out.mode = version.mode;
      }
      return out;
    });
    return { answer: toJson(versions) };
  },

  async search(p, message) {
    const query = text(message.query, "query", 4_000);
    const limit = integer(message.limit, "limit", 1);
    if (limit > SEARCH_MAX) throw invalid(`limit is at most ${SEARCH_MAX}`);
    await access(p, message, AGENT_READ);
    for (const attempt of searchAttempts(query)) {
      const rows = await p.tx.query(
        `SELECT kind, item, version, part, snippet(${SEARCH}, 0, '[', ']', '...', 16) AS snippet FROM ${SEARCH} WHERE ${SEARCH} MATCH ? AND space = ? ORDER BY bm25(${SEARCH}) LIMIT ?`,
        [attempt, p.space, limit * 4],
      );
      if (rows.length === 0) continue;
      const hits: ProjectSearchHit[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (hits.length === limit) break;
        const kind = String(row.kind) as "instructions" | "document" | "link";
        const id = String(row.item);
        const ref = formatItemRef({ kind, id });
        if (seen.has(ref)) continue;
        seen.add(ref);
        const snippet = String(row.snippet);
        if (kind === "link") {
          const link = await p.link(id);
          if (link !== undefined) hits.push({ ref, kind, title: changeTitle(link.title), snippet, by: link.by, at: link.at });
          continue;
        }
        const version = await p.version(kind, id, Number(row.version));
        if (version === undefined) continue;
        hits.push({ ref, kind, title: changeTitle(version.title), snippet, by: version.by, version: version.version, ...(kind === "document" && { part: Number(row.part) }), at: version.at });
      }
      return { answer: toJson(hits) };
    }
    return { answer: [] };
  },

  async links(p, message) {
    await access(p, message, AGENT_READ);
    const rows = await p.tx.query(`SELECT * FROM ${LINKS} WHERE space = ? ORDER BY at, id`, [p.space]);
    return { answer: toJson(rows.map(linkOf)) };
  },

  async addLink(p, message) {
    const input = isJsonObject(message.link) ? message.link : {};
    if (typeof input.url !== "string") throw invalid("url is a string");
    noCredential(input.url, "the URL");
    const problem = linkUrlProblem(input.url);
    if (problem !== undefined) throw invalid(problem);
    const title = text(input.title, "a link's title", DOCUMENT_TITLE_MAX);
    noCredential(title, "the title");
    const note = input.note === undefined || input.note === null ? undefined : text(input.note, "a link's note", LINK_NOTE_MAX, { empty: true });
    if (note !== undefined) noCredential(note, "the note");
    const { row, caller } = (await access(p, message, { ...WRITE, agent: true })) as Access;
    notArchived(row);
    const [existing] = await p.tx.query(`SELECT * FROM ${LINKS} WHERE space = ? AND url = ?`, [p.space, input.url]);
    if (existing !== undefined) return { answer: toJson(linkOf(existing)) };
    await p.checkLinks();
    const link: Link = { id: `l-${randomHex(8)}`, url: input.url, title: title.replace(/\s+/g, " ").trim(), ...(note !== undefined && note !== "" && { note }), by: authorOf(caller), at: p.now() };
    await p.putLink(link);
    await p.log({ by: link.by, action: "added", kind: "link", item: link.id, title: link.title, before: { link: null }, restorable: true });
    return changed(p, toJson(link));
  },

  async removeLink(p, message) {
    const id = text(message.id, "id", 64);
    const { row, caller } = (await access(p, message, WRITE)) as Access;
    notArchived(row);
    const link = await p.link(id);
    if (link === undefined) return { answer: false };
    await p.dropLink(id);
    await p.log({ by: authorOf(caller), action: "removed", kind: "link", item: id, title: link.title, before: { link }, restorable: true });
    return changed(p, true);
  },

  async context(p, message) {
    const known = message.known === undefined || message.known === null ? undefined : integer(message.known, "known");
    const found = await access(p, message, AGENT_READ, { absent: true });
    if (found === undefined) return { answer: null };
    const { row, members, caller, role } = found;
    if (known === row.version) return { answer: "unchanged" };
    const documents = await p.documentsNow();
    const core = [];
    for (const { document } of documents.filter((each) => each.core)) core.push({ document, text: await p.text("document", document.id, document.version) });
    const instructions = (await OPS.instructions(p, { ...message, query: {} })).answer as Instructions | null;
    const context: ProjectContext = {
      project: p.project(row, members, caller, role),
      members: members.filter(p.current).slice(0, CONTEXT_MEMBERS).map(memberOf),
      links: (await p.tx.query(`SELECT * FROM ${LINKS} WHERE space = ? ORDER BY at, id`, [p.space])).map(linkOf),
      ...(instructions !== null && { instructions }),
      core,
      reference: documents.filter((each) => !each.core).map(({ document }) => document),
    };
    return { answer: toJson(context) };
  },

  async changes(p, message) {
    let page: { before?: number; limit: number };
    try {
      page = parseChangePageRequest(message.page);
    } catch (error) {
      if (error instanceof ChangeInputError) throw invalid(error.message);
      throw error;
    }
    await access(p, message, READ);
    const rows = await p.tx.query(`SELECT * FROM ${CHANGES} WHERE space = ? ${page.before === undefined ? "" : "AND n < ?"} ORDER BY n DESC LIMIT ?`, [
      p.space,
      ...(page.before === undefined ? [] : [page.before]),
      page.limit + 1,
    ]);
    const items = rows.slice(0, page.limit).map((row) => p.changeOf(row));
    const last = items.at(-1);
    return { answer: toJson({ items, ...(rows.length > page.limit && last !== undefined && { next: last.n }) }) };
  },

  async restore(p, message) {
    const n = integer(message.n, "n", 1);
    const { row, caller, role } = (await access(p, message, WRITE)) as Access;
    const [stored] = await p.tx.query(`SELECT * FROM ${CHANGES} WHERE space = ? AND n = ?`, [p.space, n]);
    if (stored === undefined) throw fail("not_found", "no such change");
    const entry = p.changeOf(stored);
    if (OWNER_RESTORES.includes(entry.item.kind) && caller.kind === "people" && role !== "owner") throw fail("forbidden", "restoring the project's record and its members is the owner's");
    if (!entry.restorable || stored.before === null) throw fail("gone", "the state before this change is no longer kept (past retention, redacted or never restorable)");
    // Restoring an archive is how the owner unarchives; any other restore waits until then.
    if (!(entry.item.kind === "project" && row.archivedAt !== undefined)) notArchived(row);
    const before = JSON.parse(String(stored.before)) as Before;
    const replaced = await p.capture(entry.item.kind, entry.item.id, before);
    const applied = await p.apply(entry.item.kind, entry.item.id, before);
    const restored = await p.log({
      by: authorOf(caller),
      action: "restored",
      kind: entry.item.kind,
      item: entry.item.id,
      title: applied.title,
      ...(applied.version !== undefined && { version: applied.version }),
      restores: n,
      before: replaced,
      restorable: true,
    });
    const [written] = await p.tx.query(`SELECT * FROM ${CHANGES} WHERE space = ? AND n = ?`, [p.space, restored]);
    return changed(p, toJson(p.changeOf(written as SqlRow)));
  },

  async redact(p, message) {
    const n = integer(message.n, "n", 1);
    const { caller } = (await access(p, message, { people: "never", agent: false, operator: true, component: false, write: false })) as Access;
    const [stored] = await p.tx.query(`SELECT * FROM ${CHANGES} WHERE space = ? AND n = ?`, [p.space, n]);
    if (stored === undefined) throw fail("not_found", "no such change");
    if (stored.redacted_at !== null && stored.redacted_at !== undefined) return { answer: null };
    const kind = String(stored.kind);
    const item = String(stored.item);
    const version = optionalNumber(stored.version);
    // The version this change wrote, unless it is the current one (change the item first): its text blanked.
    if ((kind === "document" || kind === "instructions") && version !== undefined && (await p.currentVersion(kind, item)) !== version) {
      await p.tx.run(`UPDATE ${VERSIONS} SET redacted = 1, title = '' WHERE space = ? AND kind = ? AND id = ? AND version = ?`, [p.space, kind, item, version]);
      await p.tx.run(`UPDATE ${PARTS} SET text = '' WHERE space = ? AND kind = ? AND id = ? AND version = ?`, [p.space, kind, item, version]);
      await p.tx.run(`UPDATE ${CHANGES} SET restorable = 0 WHERE space = ? AND kind = ? AND item = ? AND before = ?`, [p.space, kind, item, JSON.stringify({ version })]);
    }
    await p.tx.run(`UPDATE ${CHANGES} SET title = '', before = NULL, restorable = 0, redacted_at = ?, redacted_by = ? WHERE space = ? AND n = ?`, [
      p.now(),
      JSON.stringify(authorOf(caller)),
      p.space,
      n,
    ]);
    return { answer: null };
  },

  async remove(p, message) {
    const { row, caller } = (await access(p, message, OWNER)) as Access;
    const now = p.now();
    await p.tx.run(`UPDATE ${PROJECTS} SET removed_at = ?, purge_at = ? WHERE space = ?`, [now, now + PROJECT_TOMBSTONE_DAYS * DAY, p.space]);
    await p.log({ by: authorOf(caller), action: "removed", kind: "project", item: row.id, title: row.name, before: null, restorable: false });
    return { ...(await changed(p, null)), removed: true };
  },

  async recover(p, message) {
    const { row, caller } = (await access(p, message, { people: "never", agent: false, operator: true, component: false, write: false })) as Access;
    if (row.removedAt === undefined) return { answer: toJson(p.project(row, await p.members(), caller)) };
    await p.tx.run(`UPDATE ${PROJECTS} SET removed_at = NULL, purge_at = NULL WHERE space = ?`, [p.space]);
    const [removal] = await p.tx.query(`SELECT n FROM ${CHANGES} WHERE space = ? AND kind = 'project' AND action = 'removed' ORDER BY n DESC LIMIT 1`, [p.space]);
    await p.log({ by: authorOf(caller), action: "restored", kind: "project", item: row.id, title: row.name, ...(removal !== undefined && { restores: Number(removal.n) }), before: null, restorable: false });
    const result = await changed(p, null);
    return { ...result, answer: toJson(p.project((await p.row()) as ProjectRow, await p.members(), caller)) };
  },

  /** The purge of a removed project past its tombstone (the component's wakeup): every row of the space. */
  async purge(p, message) {
    if (message.caller !== "projects-sql") throw invalid("the purge is projects-sql's own");
    const row = await p.row();
    if (row === undefined) return { answer: true };
    const [due] = await p.tx.query(`SELECT purge_at FROM ${PROJECTS} WHERE space = ?`, [p.space]);
    if (row.removedAt === undefined || due?.purge_at === null || Number(due?.purge_at) > p.now()) return { answer: false };
    for (const table of PROJECT_TABLES) await p.tx.run(`DELETE FROM ${table} WHERE space = ?`, [p.space]);
    return { answer: true };
  },
} satisfies Record<string, Op>;

/** The spaces whose projects are past their tombstone at `now`, and the next purge after them. */
export async function purgeDue(db: SqlStatements, now: number): Promise<{ due: string[]; next?: number }> {
  const due = await db.query(`SELECT space FROM ${PROJECTS} WHERE removed_at IS NOT NULL AND purge_at IS NOT NULL AND purge_at <= ? ORDER BY purge_at`, [now]);
  const [next] = await db.query(`SELECT MIN(purge_at) AS at FROM ${PROJECTS} WHERE removed_at IS NOT NULL AND purge_at > ?`, [now]);
  const at = optionalNumber(next?.at);
  return { due: due.map((row) => String(row.space)), ...(at !== undefined && { next: at }) };
}

/** The id of the project of `space` held here, for the purge's message to the directory. */
export async function projectIdOf(db: SqlStatements, space: string): Promise<string | undefined> {
  const [row] = await db.query(`SELECT id FROM ${PROJECTS} WHERE space = ?`, [space]);
  return row === undefined ? undefined : String(row.id);
}
