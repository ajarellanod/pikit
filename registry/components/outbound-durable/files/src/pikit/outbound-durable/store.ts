/**
 * The outbox's records in `storage.sql`: one row per piece of an answer, from stored to delivered or
 * abandoned. All SQL of the component is here; the rest reads and writes `Piece`s.
 *
 * The dialect is SQLite's (`INTEGER PRIMARY KEY` as the order of arrival, `ON CONFLICT DO NOTHING`).
 * A Postgres port changes this file only.
 */

import type { SqlDatabase, SqlRow } from "@pikit/core";

/** `pending` → `sending` → `delivered` | `abandoned` (SPEC §5, "Outbound delivery"). */
export type PieceState = "pending" | "sending" | "delivered" | "abandoned";

export interface Piece {
  /** Order of arrival: a conversation's pieces go out in this order. */
  seq: number;
  /** `${idempotencyKey}#${index}`. */
  key: string;
  channel: string;
  conversationKey: string;
  text: string;
  state: PieceState;
  /** Sends tried, whatever came of them. */
  attempts: number;
  /** Transient failures only: the fifth abandons. A rate limit is not a failure. */
  failures: number;
  /** Not sent before this time (ms). */
  nextAttemptAt: number;
  /** It may have reached the platform already. */
  possibleDuplicate: boolean;
  createdAt: number;
}

interface PieceRow extends SqlRow {
  seq: number;
  key: string;
  channel: string;
  conversation_key: string;
  text: string;
  state: string;
  attempts: number;
  failures: number;
  next_attempt_at: number;
  possible_duplicate: number;
  created_at: number;
}

const COLUMNS = "seq, key, channel, conversation_key, text, state, attempts, failures, next_attempt_at, possible_duplicate, created_at";

export function createStore(db: SqlDatabase) {
  return {
    async migrate(): Promise<void> {
      await db.run(`CREATE TABLE IF NOT EXISTS outbound_pieces (
        seq INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        possible_duplicate INTEGER NOT NULL DEFAULT 0,
        platform_message_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      )`);
      await db.run("CREATE INDEX IF NOT EXISTS outbound_pieces_open ON outbound_pieces (state, conversation_key, seq)");
    },

    /** Stores a message's pieces in one transaction; keys already stored are left as they are. */
    async add(pieces: { key: string; channel: string; conversationKey: string; text: string }[], now: number): Promise<void> {
      await db.transaction(async (tx) => {
        for (const p of pieces) {
          await tx.run(
            "INSERT INTO outbound_pieces (key, channel, conversation_key, text, state, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (key) DO NOTHING",
            [p.key, p.channel, p.conversationKey, p.text, now, now],
          );
        }
      });
    },

    /**
     * A process that starts finds `sending` rows only if the last one died during their send: they
     * may have reached the platform, so they go back to `pending` as possible duplicates.
     */
    async recoverInterrupted(): Promise<number> {
      return (await db.run("UPDATE outbound_pieces SET state = 'pending', possible_duplicate = 1 WHERE state = 'sending'")).changes;
    },

    /** The first open piece of every conversation: only a conversation's head may be sent. */
    async heads(): Promise<Piece[]> {
      const rows = await db.query<PieceRow>(
        `SELECT ${COLUMNS} FROM outbound_pieces p
         WHERE p.state IN ('pending', 'sending')
           AND p.seq = (SELECT MIN(q.seq) FROM outbound_pieces q
                        WHERE q.conversation_key = p.conversation_key AND q.state IN ('pending', 'sending'))
         ORDER BY p.seq`,
      );
      return rows.map(toPiece);
    },

    /** Written before the platform call: if the process dies now, the next one knows it may have been sent. */
    async markSending(key: string): Promise<boolean> {
      return (await db.run("UPDATE outbound_pieces SET state = 'sending', attempts = attempts + 1 WHERE key = ? AND state = 'pending'", [key])).changes === 1;
    },

    async markDelivered(key: string, platformMessageId: string, now: number): Promise<void> {
      await db.run("UPDATE outbound_pieces SET state = 'delivered', platform_message_id = ?, last_error = NULL, settled_at = ? WHERE key = ?", [platformMessageId, now, key]);
    },

    /** Back to `pending`, to be tried at `nextAttemptAt`. */
    async retryLater(key: string, change: { nextAttemptAt: number; failed: boolean; possibleDuplicate: boolean; error: string }): Promise<void> {
      await db.run(
        `UPDATE outbound_pieces SET state = 'pending', next_attempt_at = ?, failures = failures + ?,
           possible_duplicate = MAX(possible_duplicate, ?), last_error = ? WHERE key = ?`,
        [change.nextAttemptAt, change.failed ? 1 : 0, change.possibleDuplicate ? 1 : 0, change.error, key],
      );
    },

    async abandon(key: string, reason: string, now: number): Promise<void> {
      await db.run("UPDATE outbound_pieces SET state = 'abandoned', last_error = ?, settled_at = ? WHERE key = ?", [reason, now, key]);
    },

    /** Delivered rows go after `deliveredMs`; abandoned ones stay readable for `abandonedMs`. */
    async prune(now: number, deliveredMs: number, abandonedMs: number): Promise<void> {
      await db.run("DELETE FROM outbound_pieces WHERE state = 'delivered' AND settled_at < ?", [now - deliveredMs]);
      await db.run("DELETE FROM outbound_pieces WHERE state = 'abandoned' AND settled_at < ?", [now - abandonedMs]);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

function toPiece(row: PieceRow): Piece {
  return {
    seq: row.seq,
    key: row.key,
    channel: row.channel,
    conversationKey: row.conversation_key,
    text: row.text,
    state: row.state as PieceState,
    attempts: row.attempts,
    failures: row.failures,
    nextAttemptAt: row.next_attempt_at,
    possibleDuplicate: row.possible_duplicate === 1,
    createdAt: row.created_at,
  };
}
