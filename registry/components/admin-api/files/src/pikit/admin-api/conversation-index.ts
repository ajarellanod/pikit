/**
 * The conversation index, on Cloudflare: which conversation keys exist, and when each was last
 * active, so the Worker can list conversations that each live in a Durable Object of their own
 * (features/cloudflare-conversation-index.md).
 *
 * It is an actor like any conversation's, the object `admin-api:index` (`INDEX_KEY`) of the same class,
 * and keeps the index in that object's `storage.sql` (`admin_api_index`). Each conversation's object
 * tells it `admin-api.seen` `{ key, agent, at }` when a run starts and when it settles; the Worker asks
 * it `admin-api.list` for a page of keys, newest activity first, then each key's object for its
 * conversations.
 *
 * **What it may miss.** `seen` is sent from the runtime's events (`agent.started`, `agent.settled`),
 * which can be missed (SPEC K3): an object evicted between the run's commit and the send, or an index
 * that did not answer, leaves a key out or its time old. The next run of that conversation sends again.
 * So a conversation is listed once one of its runs started while admin-api was installed; one whose
 * every run was missed is not listed, though it can still be read by its id.
 *
 * `seen` is an upsert: sent twice, or late, it changes nothing a newer one wrote.
 */

import type { SqlDatabase } from "@pikit/contracts";
import { refusal } from "./backend.ts";

/** The actor that keeps the index: an object of the conversations' class, never a conversation. */
export const INDEX_KEY = "admin-api:index";
const TABLE = "admin_api_index";

/** One key the index knows. */
export interface IndexedKey {
  key: string;
  agent: string;
  /** Epoch ms of the newest `seen`. */
  at: number;
}

export interface IndexPage {
  items: IndexedKey[];
  next?: string;
}

export interface ConversationIndex {
  /** Records `entry`, unless the index already has a newer time for its key. */
  seen(entry: IndexedKey): Promise<void>;
  /** At most `limit` keys, the most recently active first. Throws `invalid_cursor`. */
  list(page: { limit: number; cursor?: string }): Promise<IndexPage>;
}

/** `{at}:{key}` of the last item of a page. */
const CURSOR = /^([0-9]+):(.+)$/s;

/** The index over `sql()` (the index object's `storage.sql`); its table is made at the first use. */
export function createConversationIndex(sql: () => SqlDatabase): ConversationIndex {
  let ready: Promise<void> | undefined;
  const db = async (): Promise<SqlDatabase> => {
    const database = sql();
    ready ??= (async () => {
      await database.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, agent TEXT NOT NULL, at BIGINT NOT NULL)`);
      await database.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_at ON ${TABLE} (at, key)`);
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return database;
  };

  return {
    async seen({ key, agent, at }) {
      await (await db()).run(
        `INSERT INTO ${TABLE} (key, agent, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET ` +
          `agent = CASE WHEN excluded.at >= ${TABLE}.at THEN excluded.agent ELSE ${TABLE}.agent END, ` +
          `at = CASE WHEN excluded.at > ${TABLE}.at THEN excluded.at ELSE ${TABLE}.at END`,
        [key, agent, at],
      );
    },

    async list({ limit, cursor }) {
      let after: { at: number; key: string } | undefined;
      if (cursor !== undefined) {
        const match = CURSOR.exec(cursor);
        if (match === null) throw refusal("invalid_cursor", "the cursor is not one this API gave");
        after = { at: Number(match[1]), key: match[2] as string };
      }
      const rows = await (await db()).query<{ key: string; agent: string; at: number }>(
        `SELECT key, agent, at FROM ${TABLE}${after === undefined ? "" : " WHERE at < ? OR (at = ? AND key > ?)"} ORDER BY at DESC, key ASC LIMIT ?`,
        after === undefined ? [limit + 1] : [after.at, after.at, after.key, limit + 1],
      );
      const items = rows.slice(0, limit).map(({ key, agent, at }) => ({ key, agent, at: Number(at) }));
      const last = items.at(-1);
      return { items, ...(rows.length > limit && last !== undefined && { next: `${last.at}:${last.key}` }) };
    },
  };
}
