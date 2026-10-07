/**
 * The conversation index: every conversation admin-api has seen, and when each was last active, so the
 * list is newest activity first and paged on every host (features/cloudflare-conversation-index.md).
 * The runtime keeps no such order (`agent.observe` lists in creation order).
 *
 * It is a table, `admin_api_conversations` in `storage.sql`, of one row per conversation: its key, its
 * id in the runtime, its agent, and the time of the newest activity seen.
 * - **On a server** it is the App's own `storage.sql`; admin-api writes it from the runtime's events.
 * - **On Cloudflare** it is the `storage.sql` of one object, `admin-api:index` (`INDEX_KEY`), of the
 *   conversations' class: each conversation's object sends it `admin-api.seen`, and the Worker asks it
 *   `admin-api.list`. A row's id is then the object's own (`1`), which only its key makes unique.
 *
 * **When a row is written** (`index.ts`): when a message is dispatched (in the caller's context, once
 * it is durable), when a run starts, settles or fails, when a reset points a key to a new
 * conversation, and when the App starts, from what `agent.observe` holds (a server's every
 * conversation, in the background; an object's own): so a conversation made before admin-api was
 * installed, or whose events were missed (SPEC K3), is listed once its App starts again.
 *
 * `seen` is an upsert: sent twice, or late, it changes nothing a newer one wrote.
 */

import type { SqlDatabase } from "@pikit/contracts";
import { refusal } from "./backend.ts";

/** The actor that keeps the index on Cloudflare: an object of the conversations' class, never a conversation. */
export const INDEX_KEY = "admin-api:index";
const TABLE = "admin_api_conversations";

/** One conversation the index knows. */
export interface IndexedConversation {
  key: string;
  /** The runtime's id: on Cloudflare its object's own, unique with its key. */
  conversationId: string;
  agent: string;
  /** Epoch ms of the newest activity seen. */
  at: number;
}

export interface IndexPage {
  items: IndexedConversation[];
  next?: string;
}

export interface ConversationIndex {
  /** Records each entry, unless the index already has a newer time for its conversation. */
  seen(entries: readonly IndexedConversation[]): Promise<void>;
  /** At most `limit` conversations, the most recently active first. Throws `invalid_cursor`. */
  list(page: { limit: number; cursor?: string }): Promise<IndexPage>;
  /**
   * The key of conversation `conversationId`, its newest row's: a server's ids are unique (on
   * Cloudflare an object's are not, and only the index object has rows).
   */
  keyOf(conversationId: string): Promise<string | undefined>;
}

/** `{at}:{key}:{conversationId}` of a page's last item, the key and id URI-encoded (`:` never appears in them). */
const cursorOf = ({ at, key, conversationId }: IndexedConversation): string => `${at}:${encodeURIComponent(key)}:${encodeURIComponent(conversationId)}`;

function parseCursor(cursor: string): { at: number; key: string; conversationId: string } {
  const parts = cursor.split(":");
  if (parts.length === 3 && /^[0-9]+$/.test(parts[0] as string)) {
    try {
      return { at: Number(parts[0]), key: decodeURIComponent(parts[1] as string), conversationId: decodeURIComponent(parts[2] as string) };
    } catch {
      // Not ours: below.
    }
  }
  throw refusal("invalid_cursor", "the cursor is not one this API gave");
}

/** The index over `sql()` (`storage.sql`); its table is made at the first use. */
export function createConversationIndex(sql: () => SqlDatabase): ConversationIndex {
  let ready: Promise<void> | undefined;
  const db = async (): Promise<SqlDatabase> => {
    const database = sql();
    ready ??= (async () => {
      await database.run(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT NOT NULL, conversation TEXT NOT NULL, agent TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (key, conversation))`,
      );
      await database.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_at ON ${TABLE} (at, key, conversation)`);
      await database.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_conversation ON ${TABLE} (conversation)`);
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return database;
  };

  return {
    async seen(entries) {
      if (entries.length === 0) return;
      const database = await db();
      await database.transaction(async (tx) => {
        for (const { key, conversationId, agent, at } of entries) {
          await tx.run(
            `INSERT INTO ${TABLE} (key, conversation, agent, at) VALUES (?, ?, ?, ?) ON CONFLICT (key, conversation) DO UPDATE SET ` +
              `agent = CASE WHEN excluded.at >= ${TABLE}.at THEN excluded.agent ELSE ${TABLE}.agent END, ` +
              `at = CASE WHEN excluded.at > ${TABLE}.at THEN excluded.at ELSE ${TABLE}.at END`,
            [key, conversationId, agent, Math.max(0, Math.floor(at))],
          );
        }
      });
    },

    async list({ limit, cursor }) {
      const after = cursor === undefined ? undefined : parseCursor(cursor);
      const rows = await (await db()).query<{ key: string; conversation: string; agent: string; at: number }>(
        `SELECT key, conversation, agent, at FROM ${TABLE}` +
          (after === undefined ? "" : " WHERE at < ? OR (at = ? AND (key > ? OR (key = ? AND conversation > ?)))") +
          " ORDER BY at DESC, key ASC, conversation ASC LIMIT ?",
        after === undefined ? [limit + 1] : [after.at, after.at, after.key, after.key, after.conversationId, limit + 1],
      );
      const items = rows.slice(0, limit).map(({ key, conversation, agent, at }) => ({ key, conversationId: conversation, agent, at: Number(at) }));
      const last = items.at(-1);
      return { items, ...(rows.length > limit && last !== undefined && { next: cursorOf(last) }) };
    },

    async keyOf(conversationId) {
      const rows = await (await db()).query<{ key: string }>(`SELECT key FROM ${TABLE} WHERE conversation = ? ORDER BY at DESC LIMIT 1`, [conversationId]);
      return rows[0]?.key;
    },
  };
}
