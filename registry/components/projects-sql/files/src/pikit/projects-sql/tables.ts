/**
 * projects-sql's tables, created by every App it runs in (`createTables`, in `start`). Every row of
 * a project's tables names its space: on a server one database holds every project (mailbox-local:
 * every key is the App); on Cloudflare each project's object holds its own, and the index object the
 * directory.
 */

import type { SqlDatabase } from "@pikit/contracts";

/** A project's record (one row per space). */
export const PROJECTS = "projects_sql_projects";
/** Its members, one row per principal (`principalKey`). */
export const MEMBERS = "projects_sql_members";
/** The current instructions and documents (`kind`, `id`), and the version that is current. */
export const ITEMS = "projects_sql_items";
/** Every version of the instructions and of each document, kept for `read`, `versions` and restore. */
export const VERSIONS = "projects_sql_versions";
/** A version's text in `READ_PART`-character parts (a row far below an object's 2 MB). */
export const PARTS = "projects_sql_parts";
export const LINKS = "projects_sql_links";
/** The append-only change log, per space. */
export const CHANGES = "projects_sql_changes";
/** FTS5 over the current instructions, documents (in parts of about `SEARCH_PART`) and links. */
export const SEARCH = "projects_sql_search";
/** The directory (`projects:index`): one row per project, and its members by principal for `list`. */
export const INDEX = "projects_sql_index";
export const INDEX_MEMBERS = "projects_sql_index_members";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${PROJECTS} (space TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, agents TEXT NOT NULL, ` +
    "archived_at BIGINT, removed_at BIGINT, purge_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, version INTEGER NOT NULL)",
  `CREATE INDEX IF NOT EXISTS ${PROJECTS}_purge ON ${PROJECTS} (purge_at)`,
  `CREATE TABLE IF NOT EXISTS ${MEMBERS} (space TEXT NOT NULL, key TEXT NOT NULL, principal TEXT NOT NULL, role TEXT NOT NULL, source TEXT NOT NULL, ` +
    "checked_at BIGINT NOT NULL, by TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (space, key))",
  `CREATE TABLE IF NOT EXISTS ${ITEMS} (space TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (space, kind, id))`,
  `CREATE TABLE IF NOT EXISTS ${VERSIONS} (space TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, mode TEXT, ` +
    "source TEXT, chars INTEGER NOT NULL, by TEXT NOT NULL, at BIGINT NOT NULL, redacted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (space, kind, id, version))",
  `CREATE TABLE IF NOT EXISTS ${PARTS} (space TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL, ` +
    "PRIMARY KEY (space, kind, id, version, part))",
  `CREATE TABLE IF NOT EXISTS ${LINKS} (space TEXT NOT NULL, id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, note TEXT, by TEXT NOT NULL, at BIGINT NOT NULL, ` +
    "PRIMARY KEY (space, id), UNIQUE (space, url))",
  `CREATE TABLE IF NOT EXISTS ${CHANGES} (space TEXT NOT NULL, n INTEGER NOT NULL, at BIGINT NOT NULL, by TEXT NOT NULL, action TEXT NOT NULL, kind TEXT NOT NULL, ` +
    "item TEXT NOT NULL, title TEXT NOT NULL, version INTEGER, restores INTEGER, before TEXT, restorable INTEGER NOT NULL, redacted_at BIGINT, redacted_by TEXT, " +
    "PRIMARY KEY (space, n))",
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH} USING fts5(text, space UNINDEXED, kind UNINDEXED, item UNINDEXED, version UNINDEXED, part UNINDEXED, ` +
    "tokenize='unicode61 remove_diacritics 2')",
  `CREATE TABLE IF NOT EXISTS ${INDEX} (id TEXT PRIMARY KEY, space TEXT NOT NULL UNIQUE, owner_key TEXT NOT NULL, project TEXT NOT NULL, archived INTEGER NOT NULL, ` +
    "removed INTEGER NOT NULL, updated_at BIGINT NOT NULL, version INTEGER NOT NULL)",
  `CREATE INDEX IF NOT EXISTS ${INDEX}_recent ON ${INDEX} (archived, updated_at, id)`,
  `CREATE INDEX IF NOT EXISTS ${INDEX}_owner ON ${INDEX} (owner_key)`,
  `CREATE TABLE IF NOT EXISTS ${INDEX_MEMBERS} (space TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, checked_at BIGINT NOT NULL, PRIMARY KEY (space, key))`,
  `CREATE INDEX IF NOT EXISTS ${INDEX_MEMBERS}_key ON ${INDEX_MEMBERS} (key)`,
];

/** Creates every table and index, if missing. */
export async function createTables(db: SqlDatabase): Promise<void> {
  for (const statement of STATEMENTS) await db.run(statement);
}

/** Every table a project's actor keeps rows of `space` in (the purge's list). */
export const PROJECT_TABLES = [PROJECTS, MEMBERS, ITEMS, VERSIONS, PARTS, LINKS, CHANGES, SEARCH] as const;
