/**
 * memory-sql: what the agents of each space remember, and what each person prefers
 * (features/memory.md), with who kept each memory and a change log per owner (features/projects.md,
 * "History, versions and undo"). It declares and provides `memory` (`contract.ts`).
 *
 * - **Whose memory** (`ownerOf`): a conversation's space (`spaceOf`), shared by every agent working
 *   there, unless its agent is one of `agentScope` (config): that agent keeps a memory of its own across
 *   every space it works in. The one place this is decided: memory-recall and memory-summaries ask it.
 * - **One actor per owner**, `memory:space:<space>`, `memory:agent:<agent>` or
 *   `memory:person:<channel>:<id>` (the channel URI-encoded, so no two owners share a key): every
 *   operation is `mailbox.call(<owner's key>, "memory-sql.<op>", ...)`, answered by the handler this
 *   component registers with `actor.inbox`'s `answer`, over the `storage.sql` of the App the actor runs
 *   in. On a server (mailbox-local) every key's actor is the App itself, one database; on Cloudflare
 *   (actors-do) it is the Durable Object of that key, so an owner's writes are ordered and its memory
 *   is in its own object. The Worker's App, which has no `storage.sql`, gets `memory` from the Worker
 *   half (`worker`): the same calls, from `memoryOver`.
 * - **An owner's actor answers only for that owner**, and checks every message on arrival (it crossed
 *   an actor as JSON): a call for another owner, a kind the owner does not keep, an author `parseAuthor`
 *   refuses, or a malformed call, is `invalid`.
 * - **Every query filters by owner.** The tables (`memory_sql_memories`, `memory_sql_changes`,
 *   `memory_sql_logs`) are created in `start`; nothing is held in memory between calls, so `stop` is
 *   never needed (K6).
 * - **Who and when**: each memory keeps its author (`by`, checked with `parseAuthor`) and `updatedAt`
 *   (its status or words changed: the store's clock).
 * - **The change log** (`Change` of `@pikit/contracts`): every write that changes something appends one
 *   entry in the same transaction as the change (item kind `MEMORY_CHANGE_KIND`, title `changeTitle` of
 *   its words), numbered per owner from `memory_sql_logs` (never reused, even past retention). Each
 *   entry keeps the states of the memories it touched, before and after (`states`), so `restore(n)`
 *   puts back exactly the state before `n` (every field, the original author included) and appends a
 *   `restored` entry whose own states make it restorable in turn. Entries past `CHANGE_RETENTION_DAYS`
 *   are not restorable (`gone`), and are dropped at the owner's next write; `redact` (operators only)
 *   blanks an entry's states and title, keeping who and when. `purge` deletes an owner's memories and
 *   log for good.
 * - **Idempotent writes**: `remember` of an id already kept changes nothing and logs nothing; `approve`
 *   of an active memory leaves it active; `forget` of nothing logs nothing; `replace` with the same id
 *   and words logs nothing.
 * - **No secrets**: a text holding a known credential's shape (`credentialSettingProblem`) is refused
 *   here, for every writer, and the refusal never echoes it.
 * - **Search** is SQLite's FTS5 (`memory_sql_search`, an external-content index of every memory kept in
 *   step by triggers, so a row and its index change in one statement), filtered by kind and status
 *   (by default `MEMORY_SEARCH_DEFAULT`: facts and summaries): BM25-ranked, with snippets. The query is
 *   cut into words (letters and digits), each quoted, and tried as all of them, then as the phrase,
 *   then as any of them: no text is a syntax error. Both targets' SQLite (node:sqlite on a server, a
 *   Durable Object's) have FTS5.
 *
 * Calls (each with `owner`): `memory-sql.list` `{ kinds, status?, limit }` -> `Memory[]`;
 * `memory-sql.get` `{ id }` -> `Memory | null`; `memory-sql.remember` `{ memory }` -> `null`;
 * `memory-sql.approve` `{ id, kind, by }` -> `boolean`; `memory-sql.forget` `{ id, kinds, status?, by }`
 * -> `boolean`; `memory-sql.replace` `{ id, memory }` -> `Memory | null`; `memory-sql.search` `{ query,
 * limit, kinds?, status? }` -> `MemoryMatch[]`; `memory-sql.changes` `{ before?, limit }` ->
 * `ChangePage`; `memory-sql.restore` `{ n, by }` -> `Change`; `memory-sql.redact` `{ n, by }` -> `null`;
 * `memory-sql.purge` `{}` -> `null`.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import {
  ActorCallError,
  type ActorMailbox,
  type Author,
  type Change,
  CHANGE_RETENTION_DAYS,
  ChangeInputError,
  type ChangeItem,
  type ChangePage,
  type ConversationRef,
  changeTitle,
  credentialSettingProblem,
  isJsonObject,
  type JsonValue,
  parseAuthor,
  parseChangePageRequest,
  pastRetention,
  type SqlRow,
  type SqlStatements,
  spaceOf,
} from "@pikit/contracts";
import Type, { type Static } from "typebox";
import {
  type Memory,
  MEMORY_CHANGE_KIND,
  MEMORY_ID_MAX,
  MEMORY_LIST_MAX,
  MEMORY_SEARCH_DEFAULT,
  MEMORY_TEXT_MAX,
  type MemoryFilter,
  type MemoryKind,
  type MemoryMatch,
  type MemoryOwner,
  type MemoryStatus,
  type MemoryStore,
  type NewMemory,
} from "./contract.ts";

export const TABLE = "memory_sql_memories";
export const SEARCH = "memory_sql_search";
export const CHANGES = "memory_sql_changes";
export const LOGS = "memory_sql_logs";

const Config = Type.Object({
  /**
   * The agents that keep a memory of their own, across every space they work in (their facts, summaries
   * and rules follow them); every other agent shares its space's memory with the agents working there.
   */
  agentScope: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
});

export type MemorySqlConfig = Static<typeof Config>;

/** The owner's part of its actor's key, and its rows' `owner`: one string per owner, never two owners' the same. */
export const ownerKey = (owner: MemoryOwner): string =>
  owner.type === "space" ? `space:${owner.space}` : owner.type === "agent" ? `agent:${owner.agent}` : `person:${encodeURIComponent(owner.channel)}:${owner.id}`;

/** The actor that holds one owner's memory. */
export const actorKey = (owner: MemoryOwner): string => `memory:${ownerKey(owner)}`;

/** The calls an owner's actor answers. */
export const CALL = {
  list: "memory-sql.list",
  get: "memory-sql.get",
  remember: "memory-sql.remember",
  approve: "memory-sql.approve",
  forget: "memory-sql.forget",
  replace: "memory-sql.replace",
  search: "memory-sql.search",
  changes: "memory-sql.changes",
  restore: "memory-sql.restore",
  redact: "memory-sql.redact",
  purge: "memory-sql.purge",
} as const;

/** What each owner keeps: a space or an agent its facts, summaries and rules; a person their preferences. */
export const kindsOf = (owner: MemoryOwner): readonly MemoryKind[] => (owner.type === "person" ? ["preference"] : ["fact", "summary", "rule"]);
/** The kinds that are always active. */
const DATA: readonly MemoryKind[] = ["fact", "summary"];
const STATUSES: readonly MemoryStatus[] = ["active", "pending"];
/** The title a redacted entry keeps. */
export const REDACTED_TITLE = "(redacted)";
const RETENTION_MS = CHANGE_RETENTION_DAYS * 86_400_000;

/** The owner of `conversation`'s shared memory, under `config`: its agent's own, or its space's. */
export function ownerOfConversation(config: MemorySqlConfig, conversation: ConversationRef): MemoryOwner {
  return config.agentScope.includes(conversation.agent) ? { type: "agent", agent: conversation.agent } : { type: "space", space: spaceOf(conversation) };
}

const invalid = (what: string) => new ActorCallError("invalid", `memory-sql: ${what}`);
const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw invalid(`"${name}" is a non-empty string of at most ${max} characters`);
  return value;
};
const limitOf = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MEMORY_LIST_MAX) throw invalid(`"limit" is an integer from 1 to ${MEMORY_LIST_MAX}`);
  return value;
};
const numberOf = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalid('"n" is a positive integer');
  return value;
};
const kindOf = (owner: MemoryOwner, value: unknown): MemoryKind => {
  const kinds = kindsOf(owner);
  if (!kinds.includes(value as MemoryKind)) throw invalid(`a ${owner.type}'s memory is of kind ${kinds.join(", ")}`);
  return value as MemoryKind;
};
const statusOf = (value: unknown): MemoryStatus => {
  if (!STATUSES.includes(value as MemoryStatus)) throw invalid(`"status" is one of ${STATUSES.join(", ")}`);
  return value as MemoryStatus;
};
/** An author as it arrived (a call) or was stored: `parseAuthor`'s copy, its refusal `invalid` (never quoting it). */
const authorOf = (value: unknown, name: string): Author => {
  try {
    return parseAuthor(value);
  } catch (error) {
    if (error instanceof ChangeInputError) throw invalid(`"${name}": ${error.message}`);
    throw error;
  }
};

/** An owner as it arrived in a call: checked. */
function ownerOf(value: JsonValue | undefined): MemoryOwner {
  if (value === undefined || !isJsonObject(value)) throw invalid('"owner" is a JSON object');
  switch (value.type) {
    case "space":
      return { type: "space", space: text(value.space, "owner.space", MEMORY_ID_MAX) };
    case "agent":
      return { type: "agent", agent: text(value.agent, "owner.agent", MEMORY_ID_MAX) };
    case "person":
      return { type: "person", channel: text(value.channel, "owner.channel", MEMORY_ID_MAX), id: text(value.id, "owner.id", MEMORY_ID_MAX) };
    default:
      throw invalid('"owner.type" is space, agent or person');
  }
}

/** The owner and fields of a call to `key`'s actor; refused when it is another owner's actor, or malformed. */
export function callOf(key: string, message: JsonValue): { owner: MemoryOwner; fields: Record<string, JsonValue | undefined> } {
  if (!isJsonObject(message)) throw invalid("a call is a JSON object");
  const owner = ownerOf(message.owner);
  if (key !== actorKey(owner)) throw invalid(`${key} does not hold this owner's memory`);
  return { owner, fields: message };
}

/** A filter as it arrived in a call: its kinds the owner's, its status one of two. */
function filterOf(owner: MemoryOwner, fields: Record<string, JsonValue | undefined>): MemoryFilter {
  const { kinds, status } = fields;
  if (!Array.isArray(kinds) || kinds.length === 0) throw invalid('"kinds" is a non-empty list');
  return { kinds: [...new Set(kinds.map((kind) => kindOf(owner, kind)))], ...(status !== undefined && status !== null && { status: statusOf(status) }) };
}

/** A memory as it arrived in a call: checked (its author with `parseAuthor`), never echoed when it holds a credential. */
function memoryOf(owner: MemoryOwner, value: JsonValue | undefined): NewMemory {
  if (value === undefined || !isJsonObject(value)) throw invalid('"memory" is a JSON object');
  const { createdAt } = value;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) throw invalid('"memory.createdAt" is epoch milliseconds');
  const kind = kindOf(owner, value.kind);
  const status = statusOf(value.status);
  if (DATA.includes(kind) && status !== "active") throw invalid(`a ${kind} is always active`);
  const memory: NewMemory = { id: text(value.id, "memory.id", MEMORY_ID_MAX), kind, status, text: text(value.text, "memory.text", MEMORY_TEXT_MAX), createdAt, by: authorOf(value.by, "memory.by") };
  if (credentialSettingProblem(memory.text) !== undefined) throw invalid("the text holds what looks like a credential: a memory never keeps a secret");
  return memory;
}

/** A memory as `Memory`, its fields in one order (what crosses, and what an entry's states keep). */
const shaped = (m: Memory): Memory => ({
  id: m.id,
  kind: m.kind,
  status: m.status,
  text: m.text,
  createdAt: m.createdAt,
  ...(m.updatedAt !== undefined && { updatedAt: m.updatedAt }),
  ...(m.by !== undefined && { by: m.by }),
});

const rowOf = (row: SqlRow): Memory =>
  shaped({
    id: String(row.id),
    kind: row.kind as MemoryKind,
    status: row.status as MemoryStatus,
    text: String(row.text),
    createdAt: Number(row.created_at),
    ...(row.updated_at !== null && row.updated_at !== undefined && { updatedAt: Number(row.updated_at) }),
    ...(row.author !== null && row.author !== undefined && { by: authorOf(JSON.parse(String(row.author)), "stored author") }),
  });

/** A memory an entry's states kept, as stored JSON: read back as it was written. */
const storedMemory = (value: JsonValue): Memory => {
  if (!isJsonObject(value)) throw new ActorCallError("failed", "memory-sql: a change's stored state is malformed");
  return rowOf({
    id: value.id as string,
    kind: value.kind as string,
    status: value.status as string,
    text: value.text as string,
    created_at: value.createdAt as number,
    updated_at: (value.updatedAt ?? null) as number | null,
    author: value.by === undefined ? null : JSON.stringify(value.by),
  });
};

/** `AND kind IN (?, ...)` and `AND status = ?` for `filter`, and their parameters. */
const where = (filter: MemoryFilter, column = "") => ({
  sql: ` AND ${column}kind IN (${filter.kinds.map(() => "?").join(", ")})${filter.status === undefined ? "" : ` AND ${column}status = ?`}`,
  params: [...filter.kinds, ...(filter.status === undefined ? [] : [filter.status])],
});

/** The longest query `search` reads, in characters. */
const QUERY_MAX = 500;

/**
 * The FTS5 queries `query` is tried as, most precise first: all of its words, the phrase, any of them.
 * Words are runs of letters and digits, each quoted (a quote inside doubled): an email, a URL, a path
 * or a hyphenated id is its words, and no query is an FTS5 syntax error. None when it has no word.
 */
export function searchAttempts(query: string): string[] {
  const words = query.slice(0, QUERY_MAX).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const quoted = words.map((word) => `"${word}"`);
  return [...new Set([quoted.join(" AND "), `"${words.join(" ")}"`, quoted.join(" OR ")])];
}

/** The states a change touched: each memory id, absent (`null`) or as it was; `before` the change and `after` it. */
type States = { before: [string, Memory | null][]; after: [string, Memory | null][] };

const statesOf = (value: string): States => {
  const parsed = JSON.parse(value) as { before: [string, JsonValue][]; after: [string, JsonValue][] };
  const side = (list: [string, JsonValue][]) => list.map(([id, state]): [string, Memory | null] => [id, state === null ? null : storedMemory(state)]);
  return { before: side(parsed.before), after: side(parsed.after) };
};

/** The item an entry is about: the memory's log kind (a fact is a `note`), its id, its first words. */
const itemOf = (m: Memory): ChangeItem => ({ kind: MEMORY_CHANGE_KIND[m.kind], id: m.id, title: changeTitle(m.text) });

/** An entry of the log as a `Change`: its fields in one order, `restorable` as of `now`. */
function changeOf(row: SqlRow, now: number): Change {
  const redacted = row.redacted === null || row.redacted === undefined ? undefined : (JSON.parse(String(row.redacted)) as { at: number; by: JsonValue });
  return {
    n: Number(row.n),
    at: Number(row.at),
    by: authorOf(JSON.parse(String(row.author)), "stored author"),
    action: String(row.action) as Change["action"],
    item: { kind: String(row.item_kind), id: String(row.item_id), title: String(row.title) },
    ...(row.restores !== null && row.restores !== undefined && { restores: Number(row.restores) }),
    restorable: redacted === undefined && row.states !== null && !pastRetention(Number(row.at), now),
    ...(redacted !== undefined && { redacted: { at: redacted.at, by: authorOf(redacted.by, "stored author") } }),
  };
}

const CHANGE_COLUMNS = "n, at, author, action, item_kind, item_id, title, restores, states, redacted";

/** `memory` over `mailbox`: every operation a call to the owner's actor, from any App with a mailbox (the default export's and the Worker half's). */
export function memoryOver(mailbox: () => ActorMailbox, config: MemorySqlConfig): MemoryStore {
  const call = (owner: MemoryOwner, type: string, fields: Record<string, JsonValue>, ctx: AppContext) => mailbox().call(actorKey(owner), type, { owner, ...fields }, ctx);
  const filterFields = (filter: MemoryFilter): Record<string, JsonValue> => ({ kinds: [...filter.kinds], ...(filter.status !== undefined && { status: filter.status }) });
  const json = (value: unknown) => value as JsonValue;
  return {
    ownerOf: (conversation) => ownerOfConversation(config, conversation),
    list: async (owner, filter, limit, ctx) => (await call(owner, CALL.list, { ...filterFields(filter), limit }, ctx)) as Memory[],
    get: async (owner, id, ctx) => ((await call(owner, CALL.get, { id }, ctx)) as Memory | null) ?? undefined,
    remember: async (owner, memory, ctx) => void (await call(owner, CALL.remember, { memory: json(memory) }, ctx)),
    approve: async (owner, id, kind, by, ctx) => (await call(owner, CALL.approve, { id, kind, by: json(by) }, ctx)) === true,
    forget: async (owner, id, filter, by, ctx) => (await call(owner, CALL.forget, { id, ...filterFields(filter), by: json(by) }, ctx)) === true,
    replace: async (owner, id, memory, ctx) => ((await call(owner, CALL.replace, { id, memory: json(memory) }, ctx)) as Memory | null) ?? undefined,
    search: async (owner, query, limit, ctx, filter) => (await call(owner, CALL.search, { query, limit, ...(filter !== undefined && filterFields(filter)) }, ctx)) as MemoryMatch[],
    changes: async (owner, page, ctx) => (await call(owner, CALL.changes, json(page) as Record<string, JsonValue>, ctx)) as ChangePage,
    restore: async (owner, n, by, ctx) => (await call(owner, CALL.restore, { n, by: json(by) }, ctx)) as Change,
    redact: async (owner, n, by, ctx) => void (await call(owner, CALL.redact, { n, by: json(by) }, ctx)),
    purge: async (owner, ctx) => void (await call(owner, CALL.purge, {}, ctx)),
  };
}

/**
 * The Worker half, on `durable`: `memory` for the Worker's App (channel-web's project routes, an admin
 * route), which has no `storage.sql`. Every operation is the same call to the owner's object as from a
 * conversation's object (`memoryOver`); the owner's object, which runs the default export, answers it.
 * Its config is the default export's (`agentScope`, under `memory-sql-worker`), so `ownerOf` answers
 * the same in both Apps. `component.json`'s `apps.worker` names this export.
 */
export const worker = defineComponent({
  name: "memory-sql-worker",
  config: Config,
  setup(pikit, config) {
    const mailbox = pikit.use("actor.mailbox");
    pikit.provide("memory", memoryOver(() => mailbox.get(), config));
  },
});

export default defineComponent({
  name: "memory-sql",
  config: Config,
  setup(pikit, config) {
    const sql = pikit.use("storage.sql");
    const mailbox = pikit.use("actor.mailbox");
    const inbox = pikit.use("actor.inbox");
    const now = () => pikit.clock.now();

    pikit.provide("memory", memoryOver(() => mailbox.get(), config));

    const columns = "id, kind, status, text, created_at, updated_at, author";

    /** `owner`'s memory `id` as it is now, or `undefined`. */
    const current = async (tx: SqlStatements, owner: MemoryOwner, id: string): Promise<Memory | undefined> => {
      const [row] = await tx.query(`SELECT ${columns} FROM ${TABLE} WHERE owner = ? AND id = ?`, [ownerKey(owner), id]);
      return row === undefined ? undefined : rowOf(row);
    };
    /** Puts `owner`'s memory `id` in `state`: removed (`null`), or kept exactly so (its author and times included). */
    const put = async (tx: SqlStatements, owner: MemoryOwner, id: string, state: Memory | null): Promise<void> => {
      await tx.run(`DELETE FROM ${TABLE} WHERE owner = ? AND id = ?`, [ownerKey(owner), id]);
      if (state === null) return;
      await tx.run(`INSERT INTO ${TABLE} (owner, id, kind, status, text, created_at, updated_at, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        ownerKey(owner),
        state.id,
        state.kind,
        state.status,
        state.text,
        state.createdAt,
        state.updatedAt ?? null,
        state.by === undefined ? null : JSON.stringify(state.by),
      ]);
    };
    /**
     * Appends one entry to `owner`'s log, in `tx` (the change's own transaction): numbered after the
     * owner's last (`memory_sql_logs`: never reused, even once older entries are dropped), and drops the
     * entries past retention. Answers the entry as `changes` shows it.
     */
    const append = async (
      tx: SqlStatements,
      owner: MemoryOwner,
      entry: { by: Author; action: Change["action"]; item: ChangeItem; restores?: number; states: States },
    ): Promise<Change> => {
      const key = ownerKey(owner);
      const at = now();
      const [head] = await tx.query(`SELECT last FROM ${LOGS} WHERE owner = ?`, [key]);
      const n = (head === undefined ? 0 : Number(head.last)) + 1;
      await tx.run(`INSERT INTO ${LOGS} (owner, last) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET last = excluded.last`, [key, n]);
      await tx.run(`DELETE FROM ${CHANGES} WHERE owner = ? AND at < ?`, [key, at - RETENTION_MS]);
      await tx.run(`INSERT INTO ${CHANGES} (owner, ${CHANGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [
        key,
        n,
        at,
        JSON.stringify(entry.by),
        entry.action,
        entry.item.kind,
        entry.item.id,
        entry.item.title,
        entry.restores ?? null,
        JSON.stringify(entry.states),
      ]);
      const [row] = await tx.query(`SELECT ${CHANGE_COLUMNS} FROM ${CHANGES} WHERE owner = ? AND n = ?`, [key, n]);
      if (row === undefined) throw new ActorCallError("failed", "memory-sql: the change just appended is missing");
      return changeOf(row, at);
    };

    return {
      async start() {
        const db = sql.get();
        await db.run(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (n INTEGER PRIMARY KEY, owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, ` +
            "text TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT, author TEXT, UNIQUE (owner, id))",
        );
        await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_recent ON ${TABLE} (owner, kind, status, created_at)`);
        // Every memory, indexed for full-text search (the search filters by kind and status); the
        // triggers keep the index in step with the table in the statement that changes it. A row's text
        // never changes in place: a new text is a new row (replace, restore).
        await db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH} USING fts5(text, content='${TABLE}', content_rowid='n', tokenize='unicode61 remove_diacritics 2')`);
        await db.run(`CREATE TRIGGER IF NOT EXISTS ${TABLE}_indexed AFTER INSERT ON ${TABLE} BEGIN INSERT INTO ${SEARCH} (rowid, text) VALUES (new.n, new.text); END`);
        await db.run(
          `CREATE TRIGGER IF NOT EXISTS ${TABLE}_unindexed AFTER DELETE ON ${TABLE} BEGIN INSERT INTO ${SEARCH} (${SEARCH}, rowid, text) VALUES ('delete', old.n, old.text); END`,
        );
        // The log: one entry per change, per owner, with the states it touched (NULL once redacted).
        await db.run(
          `CREATE TABLE IF NOT EXISTS ${CHANGES} (owner TEXT NOT NULL, n INTEGER NOT NULL, at BIGINT NOT NULL, author TEXT NOT NULL, action TEXT NOT NULL, ` +
            "item_kind TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, restores INTEGER, states TEXT, redacted TEXT, PRIMARY KEY (owner, n))",
        );
        await db.run(`CREATE TABLE IF NOT EXISTS ${LOGS} (owner TEXT PRIMARY KEY, last INTEGER NOT NULL)`);

        const answer = (type: string, handler: (owner: MemoryOwner, fields: Record<string, JsonValue | undefined>) => Promise<JsonValue>) =>
          inbox.get().answer(type, async (key, message) => {
            const { owner, fields } = callOf(key, message);
            return handler(owner, fields);
          });

        answer(CALL.list, async (owner, fields) => {
          const filter = where(filterOf(owner, fields));
          const rows = await db.query(`SELECT ${columns} FROM ${TABLE} WHERE owner = ?${filter.sql} ORDER BY created_at DESC, id DESC LIMIT ?`, [
            ownerKey(owner),
            ...filter.params,
            limitOf(fields.limit),
          ]);
          return rows.map(rowOf).reverse();
        });
        answer(CALL.get, async (owner, fields) => (await current(db, owner, text(fields.id, "id", MEMORY_ID_MAX))) ?? null);
        answer(CALL.remember, async (owner, fields) => {
          const m = memoryOf(owner, fields.memory);
          // Idempotent: the same id again (a replayed tool call, a retried summary, a proposal of an
          // active rule) changes nothing, and logs nothing.
          await db.transaction(async (tx) => {
            const kept = shaped(m);
            const { changes } = await tx.run(
              `INSERT INTO ${TABLE} (owner, id, kind, status, text, created_at, updated_at, author) VALUES (?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (owner, id) DO NOTHING`,
              [ownerKey(owner), m.id, m.kind, m.status, m.text, m.createdAt, JSON.stringify(m.by)],
            );
            if (changes > 0) await append(tx, owner, { by: m.by, action: "added", item: itemOf(kept), states: { before: [[m.id, null]], after: [[m.id, kept]] } });
          });
          return null;
        });
        answer(CALL.approve, async (owner, fields) => {
          const id = text(fields.id, "id", MEMORY_ID_MAX);
          const kind = kindOf(owner, fields.kind);
          const by = authorOf(fields.by, "by");
          return db.transaction(async (tx) => {
            const before = await current(tx, owner, id);
            if (before === undefined || before.kind !== kind) return false;
            if (before.status === "active") return true;
            const after = shaped({ ...before, status: "active", updatedAt: now() });
            await tx.run(`UPDATE ${TABLE} SET status = 'active', updated_at = ? WHERE owner = ? AND id = ?`, [after.updatedAt ?? null, ownerKey(owner), id]);
            await append(tx, owner, { by, action: "changed", item: itemOf(after), states: { before: [[id, before]], after: [[id, after]] } });
            return true;
          });
        });
        answer(CALL.forget, async (owner, fields) => {
          const id = text(fields.id, "id", MEMORY_ID_MAX);
          const filter = filterOf(owner, fields);
          const by = authorOf(fields.by, "by");
          return db.transaction(async (tx) => {
            const before = await current(tx, owner, id);
            if (before === undefined || !filter.kinds.includes(before.kind) || (filter.status !== undefined && before.status !== filter.status)) return false;
            await put(tx, owner, id, null);
            await append(tx, owner, { by, action: "removed", item: itemOf(before), states: { before: [[id, before]], after: [[id, null]] } });
            return true;
          });
        });
        answer(CALL.replace, async (owner, fields) => {
          const id = text(fields.id, "id", MEMORY_ID_MAX);
          const given = memoryOf(owner, fields.memory);
          return db.transaction(async (tx) => {
            const before = await current(tx, owner, id);
            if (before === undefined) return null;
            // The kept memory: `id`'s kind, status and place in lists (`createdAt`), the new words, by the replacer.
            const after = shaped({ id: given.id, kind: before.kind, status: before.status, text: given.text, createdAt: before.createdAt, updatedAt: now(), by: given.by });
            if (given.id === id && given.text === before.text) return before;
            if (given.id !== id && (await current(tx, owner, given.id)) !== undefined) {
              throw invalid(`another memory is kept under ${given.id}: forget one of them first`);
            }
            await put(tx, owner, id, null);
            await put(tx, owner, after.id, after);
            const states: States =
              given.id === id
                ? { before: [[id, before]], after: [[id, after]] }
                : {
                    before: [
                      [id, before],
                      [after.id, null],
                    ],
                    after: [
                      [id, null],
                      [after.id, after],
                    ],
                  };
            // The entry is about the memory replaced (`id`), titled with its new words.
            await append(tx, owner, { by: given.by, action: "changed", item: { ...itemOf(after), id }, states });
            return after;
          });
        });
        answer(CALL.search, async (owner, fields) => {
          const query = text(fields.query, "query", MEMORY_TEXT_MAX);
          const limit = limitOf(fields.limit);
          // No filter: the default's kinds this owner keeps (none of a person's: nothing found).
          const given = fields.kinds === undefined || fields.kinds === null ? undefined : filterOf(owner, fields);
          const kinds = given?.kinds ?? MEMORY_SEARCH_DEFAULT.kinds.filter((kind) => kindsOf(owner).includes(kind));
          if (kinds.length === 0) return [];
          const filter = where({ kinds, ...(given?.status !== undefined && { status: given.status }) }, "m.");
          for (const attempt of searchAttempts(query)) {
            const rows = await db.query(
              `SELECT m.id, m.kind, m.status, m.text, m.created_at, m.updated_at, m.author, snippet(${SEARCH}, 0, '[', ']', '...', 16) AS snippet ` +
                `FROM ${SEARCH} JOIN ${TABLE} AS m ON m.n = ${SEARCH}.rowid WHERE ${SEARCH} MATCH ? AND m.owner = ?${filter.sql} ` +
                `ORDER BY bm25(${SEARCH}), m.created_at DESC, m.id DESC LIMIT ?`,
              [attempt, ownerKey(owner), ...filter.params, limit],
            );
            if (rows.length > 0) return rows.map((row): MemoryMatch => ({ ...rowOf(row), snippet: String(row.snippet) }));
          }
          return [];
        });
        answer(CALL.changes, async (owner, fields) => {
          let page: ReturnType<typeof parseChangePageRequest>;
          try {
            page = parseChangePageRequest({ limit: fields.limit, ...(fields.before !== undefined && { before: fields.before }) });
          } catch (error) {
            throw error instanceof ChangeInputError ? invalid(error.message) : error;
          }
          const rows = await db.query(`SELECT ${CHANGE_COLUMNS} FROM ${CHANGES} WHERE owner = ?${page.before === undefined ? "" : " AND n < ?"} ORDER BY n DESC LIMIT ?`, [
            ownerKey(owner),
            ...(page.before === undefined ? [] : [page.before]),
            page.limit + 1,
          ]);
          const at = now();
          const items = rows.slice(0, page.limit).map((row) => changeOf(row, at));
          const last = items.at(-1);
          return (rows.length > page.limit && last !== undefined ? { items, next: last.n } : { items }) as unknown as JsonValue;
        });
        /** Entry `n` of `owner`'s log, or why there is none: `gone` once dropped by retention, `not_found` never logged. */
        const entry = async (tx: SqlStatements, owner: MemoryOwner, n: number): Promise<SqlRow> => {
          const [row] = await tx.query(`SELECT ${CHANGE_COLUMNS} FROM ${CHANGES} WHERE owner = ? AND n = ?`, [ownerKey(owner), n]);
          if (row !== undefined) return row;
          const [head] = await tx.query(`SELECT last FROM ${LOGS} WHERE owner = ?`, [ownerKey(owner)]);
          if (head !== undefined && n <= Number(head.last)) throw new ActorCallError("gone", `memory-sql: change ${n} is past retention`);
          throw new ActorCallError("not_found", `memory-sql: no change ${n}`);
        };
        answer(CALL.restore, async (owner, fields) => {
          const n = numberOf(fields.n);
          const by = authorOf(fields.by, "by");
          const change = await db.transaction(async (tx) => {
            const row = await entry(tx, owner, n);
            const restored = changeOf(row, now());
            if (!restored.restorable || row.states === null) throw new ActorCallError("gone", `memory-sql: change ${n} is ${restored.redacted !== undefined ? "redacted" : "past retention"}`);
            const { before: wanted } = statesOf(String(row.states));
            // The state it replaces, kept with the restore, so the restore is restorable in turn.
            const replaced: [string, Memory | null][] = [];
            for (const [id, state] of wanted) {
              replaced.push([id, (await current(tx, owner, id)) ?? null]);
              await put(tx, owner, id, state);
            }
            return append(tx, owner, { by, action: "restored", item: restored.item, restores: n, states: { before: replaced, after: wanted } });
          });
          return change as unknown as JsonValue;
        });
        answer(CALL.redact, async (owner, fields) => {
          const n = numberOf(fields.n);
          const by = authorOf(fields.by, "by");
          if (by.kind !== "operator") throw new ActorCallError("forbidden", "memory-sql: only an operator redacts a change");
          await db.transaction(async (tx) => {
            const row = await entry(tx, owner, n);
            if (row.redacted !== null) return;
            await tx.run(`UPDATE ${CHANGES} SET states = NULL, title = ?, redacted = ? WHERE owner = ? AND n = ?`, [REDACTED_TITLE, JSON.stringify({ at: now(), by }), ownerKey(owner), n]);
          });
          return null;
        });
        answer(CALL.purge, async (owner) => {
          await db.transaction(async (tx) => {
            for (const table of [TABLE, CHANGES, LOGS]) await tx.run(`DELETE FROM ${table} WHERE owner = ?`, [ownerKey(owner)]);
          });
          return null;
        });
      },
    };
  },
});
