/**
 * memory-sql: what each agent remembers of each person, across their conversations
 * (features/memory.md). It declares and provides `memory` (`contract.ts`).
 *
 * - **One actor per person**, `memory:<person>`: every operation is
 *   `mailbox.call("memory:<person>", "memory-sql.<op>", …)`, answered by the handler this component
 *   registers with `actor.inbox`'s `answer`, over the `storage.sql` of the App the actor runs in. On a
 *   server (mailbox-local) every key's actor is the App itself, one database; on Cloudflare (actors-do)
 *   it is the Durable Object `memory:<person>`, so a person's writes are ordered and their memory is in
 *   their own object.
 * - **A person's actor answers only for that person**, and checks every message on arrival (it crossed
 *   an actor as JSON): a call for another person, or a malformed one, is `invalid`.
 * - **Every query filters by agent and person.** The table is `memory_sql_items`, created in `start`;
 *   nothing is held in memory between calls, so `stop` is never needed (K6).
 * - **Idempotent writes**: `remember` of an id already kept changes nothing (`ON CONFLICT DO NOTHING`).
 * - **No secrets**: a text holding a known credential's shape (`credentialSettingProblem`) is refused
 *   here, for every writer, and the refusal never echoes it.
 * - **Search** is `LIKE` (its `%` and `_` taken literally): SQLite ignores ASCII case. FTS5 is open.
 *
 * Calls: `memory-sql.list` `{ agent, person, kind, limit }` → `Memory[]`; `memory-sql.remember`
 * `{ agent, person, memory }` → `null`; `memory-sql.forget` `{ agent, person, id }` → `null`;
 * `memory-sql.search` `{ agent, person, query, limit }` → `Memory[]`.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { ActorCallError, credentialSettingProblem, isJsonObject, type JsonValue, type SqlRow } from "@pikit/contracts";
import { type Memory, MEMORY_ID_MAX, MEMORY_LIST_MAX, MEMORY_TEXT_MAX, type MemoryKind, type MemoryScope } from "./contract.ts";

export const TABLE = "memory_sql_items";

/** The actor that owns one person's memory. */
export const actorKey = (person: string): string => `memory:${person}`;

/** The calls a person's actor answers. */
export const CALL = { list: "memory-sql.list", remember: "memory-sql.remember", forget: "memory-sql.forget", search: "memory-sql.search" } as const;

const KINDS: readonly MemoryKind[] = ["fact", "summary"];

const invalid = (what: string) => new ActorCallError("invalid", `memory-sql: ${what}`);
const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw invalid(`"${name}" is a non-empty string of at most ${max} characters`);
  return value;
};
const limitOf = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MEMORY_LIST_MAX) throw invalid(`"limit" is an integer from 1 to ${MEMORY_LIST_MAX}`);
  return value;
};
const kindOf = (value: unknown): MemoryKind => {
  if (!KINDS.includes(value as MemoryKind)) throw invalid(`"kind" is one of ${KINDS.join(", ")}`);
  return value as MemoryKind;
};

/** The scope and fields of a call to `key`'s actor; refused when it is another person's actor, or malformed. */
export function scopeOf(key: string, message: JsonValue): MemoryScope & { fields: Record<string, JsonValue | undefined> } {
  if (!isJsonObject(message)) throw invalid("a call is a JSON object");
  const agent = text(message.agent, "agent", MEMORY_ID_MAX);
  const person = text(message.person, "person", MEMORY_ID_MAX);
  if (key !== actorKey(person)) throw invalid(`${key} does not hold this person's memory`);
  return { agent, person, fields: message };
}

/** A memory as it arrived in a call: checked, never echoed when it holds a credential. */
function memoryOf(value: JsonValue | undefined): Memory {
  if (value === undefined || !isJsonObject(value)) throw invalid('"memory" is a JSON object');
  const { createdAt } = value;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) throw invalid('"memory.createdAt" is epoch milliseconds');
  const memory: Memory = { id: text(value.id, "memory.id", MEMORY_ID_MAX), kind: kindOf(value.kind), text: text(value.text, "memory.text", MEMORY_TEXT_MAX), createdAt };
  if (credentialSettingProblem(memory.text) !== undefined) throw invalid("the text holds what looks like a credential: a memory never keeps a secret");
  return memory;
}

const rowOf = (row: SqlRow): Memory => ({ id: String(row.id), kind: row.kind as MemoryKind, text: String(row.text), createdAt: Number(row.created_at) });

/** `query` for `LIKE … ESCAPE '\'`: its `%`, `_` and `\` taken literally. */
const likeOf = (query: string): string => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export default defineComponent({
  name: "memory-sql",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    const mailbox = pikit.use("actor.mailbox");
    const inbox = pikit.use("actor.inbox");

    /** Every operation goes to the person's actor: local on a server, an RPC on Cloudflare. */
    const call = (scope: MemoryScope, type: string, fields: Record<string, JsonValue>, ctx: AppContext) =>
      mailbox.get().call(actorKey(scope.person), type, { agent: scope.agent, person: scope.person, ...fields }, ctx);

    pikit.provide("memory", {
      list: async (scope, kind, limit, ctx) => (await call(scope, CALL.list, { kind, limit }, ctx)) as Memory[],
      remember: async (scope, memory, ctx) => void (await call(scope, CALL.remember, { memory }, ctx)),
      forget: async (scope, id, ctx) => void (await call(scope, CALL.forget, { id }, ctx)),
      search: async (scope, query, limit, ctx) => (await call(scope, CALL.search, { query, limit }, ctx)) as Memory[],
    });

    return {
      async start() {
        await sql.get().run(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (agent TEXT NOT NULL, person TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, ` +
            "text TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (agent, person, id))",
        );
        await sql.get().run(`CREATE INDEX IF NOT EXISTS ${TABLE}_recent ON ${TABLE} (agent, person, kind, created_at)`);

        inbox.get().answer(CALL.list, async (key, message) => {
          const { agent, person, fields } = scopeOf(key, message);
          const rows = await sql
            .get()
            .query(`SELECT id, kind, text, created_at FROM ${TABLE} WHERE agent = ? AND person = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [
              agent,
              person,
              kindOf(fields.kind),
              limitOf(fields.limit),
            ]);
          return rows.map(rowOf).reverse();
        });
        inbox.get().answer(CALL.remember, async (key, message) => {
          const { agent, person, fields } = scopeOf(key, message);
          const m = memoryOf(fields.memory);
          // Idempotent: the same id again (a replayed tool call, a retried summary) changes nothing.
          await sql
            .get()
            .run(`INSERT INTO ${TABLE} (agent, person, id, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent, person, id) DO NOTHING`, [
              agent,
              person,
              m.id,
              m.kind,
              m.text,
              m.createdAt,
            ]);
          return null;
        });
        inbox.get().answer(CALL.forget, async (key, message) => {
          const { agent, person, fields } = scopeOf(key, message);
          await sql.get().run(`DELETE FROM ${TABLE} WHERE agent = ? AND person = ? AND id = ?`, [agent, person, text(fields.id, "id", MEMORY_ID_MAX)]);
          return null;
        });
        inbox.get().answer(CALL.search, async (key, message) => {
          const { agent, person, fields } = scopeOf(key, message);
          const rows = await sql
            .get()
            .query(`SELECT id, kind, text, created_at FROM ${TABLE} WHERE agent = ? AND person = ? AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT ?`, [
              agent,
              person,
              likeOf(text(fields.query, "query", MEMORY_TEXT_MAX)),
              limitOf(fields.limit),
            ]);
          return rows.map(rowOf);
        });
      },
    };
  },
});
