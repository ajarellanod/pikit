/**
 * memory-sql: what the agents of each space remember, and what each person prefers
 * (features/memory.md). It declares and provides `memory` (`contract.ts`).
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
 *   is in its own object.
 * - **An owner's actor answers only for that owner**, and checks every message on arrival (it crossed
 *   an actor as JSON): a call for another owner, a kind the owner does not keep, or a malformed call, is
 *   `invalid`.
 * - **Every query filters by owner.** The table is `memory_sql_memories`, created in `start`; nothing
 *   is held in memory between calls, so `stop` is never needed (K6).
 * - **Idempotent writes**: `remember` of an id already kept changes nothing (`ON CONFLICT DO NOTHING`);
 *   `approve` of an active memory leaves it active.
 * - **No secrets**: a text holding a known credential's shape (`credentialSettingProblem`) is refused
 *   here, for every writer, and the refusal never echoes it.
 * - **Search** is SQLite's FTS5 (`memory_sql_search`, an external-content index of the facts and
 *   summaries kept in step by triggers, so a row and its index change in one statement): BM25-ranked,
 *   with snippets. The query is cut into words (letters and digits), each quoted, and tried as all of
 *   them, then as the phrase, then as any of them: no text is a syntax error. Both targets' SQLite
 *   (node:sqlite on a server, a Durable Object's) have FTS5.
 *
 * Calls (each with `owner`): `memory-sql.list` `{ kinds, status?, limit }` -> `Memory[]`;
 * `memory-sql.get` `{ id }` -> `Memory | null`; `memory-sql.remember` `{ memory }` -> `null`;
 * `memory-sql.approve` `{ id, kind }` -> `boolean`; `memory-sql.forget` `{ id, kinds, status? }` ->
 * `boolean`; `memory-sql.search` `{ query, limit }` -> `MemoryMatch[]`.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { ActorCallError, type ConversationRef, credentialSettingProblem, isJsonObject, type JsonValue, spaceOf, type SqlRow } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import {
  type Memory,
  type MemoryFilter,
  MEMORY_ID_MAX,
  MEMORY_LIST_MAX,
  MEMORY_TEXT_MAX,
  type MemoryKind,
  type MemoryMatch,
  type MemoryOwner,
  type MemoryStatus,
  type MemoryStore,
} from "./contract.ts";

export const TABLE = "memory_sql_memories";
export const SEARCH = "memory_sql_search";

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
  search: "memory-sql.search",
} as const;

/** What each owner keeps: a space or an agent its facts, summaries and rules; a person their preferences. */
export const kindsOf = (owner: MemoryOwner): readonly MemoryKind[] => (owner.type === "person" ? ["preference"] : ["fact", "summary", "rule"]);
/** The kinds that are always active, and searched. */
const DATA: readonly MemoryKind[] = ["fact", "summary"];
const STATUSES: readonly MemoryStatus[] = ["active", "pending"];

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
const kindOf = (owner: MemoryOwner, value: unknown): MemoryKind => {
  const kinds = kindsOf(owner);
  if (!kinds.includes(value as MemoryKind)) throw invalid(`a ${owner.type}'s memory is of kind ${kinds.join(", ")}`);
  return value as MemoryKind;
};
const statusOf = (value: unknown): MemoryStatus => {
  if (!STATUSES.includes(value as MemoryStatus)) throw invalid(`"status" is one of ${STATUSES.join(", ")}`);
  return value as MemoryStatus;
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

/** A memory as it arrived in a call: checked, never echoed when it holds a credential. */
function memoryOf(owner: MemoryOwner, value: JsonValue | undefined): Memory {
  if (value === undefined || !isJsonObject(value)) throw invalid('"memory" is a JSON object');
  const { createdAt } = value;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) throw invalid('"memory.createdAt" is epoch milliseconds');
  const kind = kindOf(owner, value.kind);
  const status = statusOf(value.status);
  if (DATA.includes(kind) && status !== "active") throw invalid(`a ${kind} is always active`);
  const memory: Memory = { id: text(value.id, "memory.id", MEMORY_ID_MAX), kind, status, text: text(value.text, "memory.text", MEMORY_TEXT_MAX), createdAt };
  if (credentialSettingProblem(memory.text) !== undefined) throw invalid("the text holds what looks like a credential: a memory never keeps a secret");
  return memory;
}

const rowOf = (row: SqlRow): Memory => ({ id: String(row.id), kind: row.kind as MemoryKind, status: row.status as MemoryStatus, text: String(row.text), createdAt: Number(row.created_at) });

/** `AND kind IN (?, ...)` and `AND status = ?` for `filter`, and their parameters. */
const where = (filter: MemoryFilter) => ({
  sql: ` AND kind IN (${filter.kinds.map(() => "?").join(", ")})${filter.status === undefined ? "" : " AND status = ?"}`,
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

export default defineComponent({
  name: "memory-sql",
  config: Config,
  setup(pikit, config) {
    const sql = pikit.use("storage.sql");
    const mailbox = pikit.use("actor.mailbox");
    const inbox = pikit.use("actor.inbox");

    /** Every operation goes to the owner's actor: local on a server, an RPC on Cloudflare. */
    const call = (owner: MemoryOwner, type: string, fields: Record<string, JsonValue>, ctx: AppContext) =>
      mailbox.get().call(actorKey(owner), type, { owner, ...fields }, ctx);
    const filterFields = (filter: MemoryFilter): Record<string, JsonValue> => ({ kinds: [...filter.kinds], ...(filter.status !== undefined && { status: filter.status }) });

    pikit.provide("memory", {
      ownerOf: (conversation) => ownerOfConversation(config, conversation),
      list: async (owner, filter, limit, ctx) => (await call(owner, CALL.list, { ...filterFields(filter), limit }, ctx)) as Memory[],
      get: async (owner, id, ctx) => ((await call(owner, CALL.get, { id }, ctx)) as Memory | null) ?? undefined,
      remember: async (owner, memory, ctx) => void (await call(owner, CALL.remember, { memory }, ctx)),
      approve: async (owner, id, kind, ctx) => (await call(owner, CALL.approve, { id, kind }, ctx)) === true,
      forget: async (owner, id, filter, ctx) => (await call(owner, CALL.forget, { id, ...filterFields(filter) }, ctx)) === true,
      search: async (owner, query, limit, ctx) => (await call(owner, CALL.search, { query, limit }, ctx)) as MemoryMatch[],
    } satisfies MemoryStore);

    const columns = "id, kind, status, text, created_at";

    return {
      async start() {
        const db = sql.get();
        await db.run(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (n INTEGER PRIMARY KEY, owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, ` +
            "text TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE (owner, id))",
        );
        await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_recent ON ${TABLE} (owner, kind, status, created_at)`);
        // The facts and summaries, indexed for full-text search; the triggers keep the index in step
        // with the table in the statement that changes it. A memory's text and kind never change.
        await db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH} USING fts5(text, content='${TABLE}', content_rowid='n', tokenize='unicode61 remove_diacritics 2')`);
        await db.run(
          `CREATE TRIGGER IF NOT EXISTS ${TABLE}_indexed AFTER INSERT ON ${TABLE} WHEN new.kind IN ('fact', 'summary') ` +
            `BEGIN INSERT INTO ${SEARCH} (rowid, text) VALUES (new.n, new.text); END`,
        );
        await db.run(
          `CREATE TRIGGER IF NOT EXISTS ${TABLE}_unindexed AFTER DELETE ON ${TABLE} WHEN old.kind IN ('fact', 'summary') ` +
            `BEGIN INSERT INTO ${SEARCH} (${SEARCH}, rowid, text) VALUES ('delete', old.n, old.text); END`,
        );

        inbox.get().answer(CALL.list, async (key, message) => {
          const { owner, fields } = callOf(key, message);
          const filter = where(filterOf(owner, fields));
          const rows = await db.query(`SELECT ${columns} FROM ${TABLE} WHERE owner = ?${filter.sql} ORDER BY created_at DESC, id DESC LIMIT ?`, [
            ownerKey(owner),
            ...filter.params,
            limitOf(fields.limit),
          ]);
          return rows.map(rowOf).reverse();
        });
        inbox.get().answer(CALL.get, async (key, message) => {
          const { owner, fields } = callOf(key, message);
          const [row] = await db.query(`SELECT ${columns} FROM ${TABLE} WHERE owner = ? AND id = ?`, [ownerKey(owner), text(fields.id, "id", MEMORY_ID_MAX)]);
          return row === undefined ? null : rowOf(row);
        });
        inbox.get().answer(CALL.remember, async (key, message) => {
          const { owner, fields } = callOf(key, message);
          const m = memoryOf(owner, fields.memory);
          // Idempotent: the same id again (a replayed tool call, a retried summary, a proposal of an
          // active rule) changes nothing.
          await db.run(`INSERT INTO ${TABLE} (owner, id, kind, status, text, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, id) DO NOTHING`, [
            ownerKey(owner),
            m.id,
            m.kind,
            m.status,
            m.text,
            m.createdAt,
          ]);
          return null;
        });
        inbox.get().answer(CALL.approve, async (key, message) => {
          const { owner, fields } = callOf(key, message);
          const params = [ownerKey(owner), text(fields.id, "id", MEMORY_ID_MAX), kindOf(owner, fields.kind)];
          await db.run(`UPDATE ${TABLE} SET status = 'active' WHERE owner = ? AND id = ? AND kind = ? AND status = 'pending'`, params);
          const [row] = await db.query(`SELECT 1 AS found FROM ${TABLE} WHERE owner = ? AND id = ? AND kind = ? AND status = 'active'`, params);
          return row !== undefined;
        });
        inbox.get().answer(CALL.forget, async (key, message) => {
          const { owner, fields } = callOf(key, message);
          const filter = where(filterOf(owner, fields));
          const { changes } = await db.run(`DELETE FROM ${TABLE} WHERE owner = ? AND id = ?${filter.sql}`, [ownerKey(owner), text(fields.id, "id", MEMORY_ID_MAX), ...filter.params]);
          return changes > 0;
        });
        inbox.get().answer(CALL.search, async (key, message) => {
          const { owner, fields } = callOf(key, message);
          const query = text(fields.query, "query", MEMORY_TEXT_MAX);
          const limit = limitOf(fields.limit);
          for (const attempt of searchAttempts(query)) {
            const rows = await db.query(
              `SELECT m.id, m.kind, m.status, m.text, m.created_at, snippet(${SEARCH}, 0, '[', ']', '...', 16) AS snippet ` +
                `FROM ${SEARCH} JOIN ${TABLE} AS m ON m.n = ${SEARCH}.rowid WHERE ${SEARCH} MATCH ? AND m.owner = ? ` +
                `ORDER BY bm25(${SEARCH}), m.created_at DESC, m.id DESC LIMIT ?`,
              [attempt, ownerKey(owner), limit],
            );
            if (rows.length > 0) return rows.map((row): MemoryMatch => ({ ...rowOf(row), snippet: String(row.snippet) }));
          }
          return [];
        });
      },
    };
  },
});
