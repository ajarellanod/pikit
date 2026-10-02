/**
 * The answers log: `agent.submissions`' `answers` feed (SPEC K3), kept by the runtime in `storage.sql`
 * next to pi-durable's tables. All its SQL is here.
 *
 * It is an index derived from pi-durable, which holds every submission and its settlement: one row
 * per run, named by its **run key** (`runKey` in runtime.ts), so appending a run again changes nothing
 * (`UNIQUE`). Rows go after `keepSettledDays`; the highest `seq` pruned is remembered, so a reader
 * behind it learns it missed some (`gap`). What has been logged is the runtime's to remember
 * (`AdmissionsDoc`): a run pruned here is never appended again.
 *
 * - `runtime_pi_answers`: `seq` is the feed's cursor. `AUTOINCREMENT` never reuses a value, even once
 *   every row is pruned, and one writer at a time (SQLite) commits them in order.
 * - `runtime_pi_answers_meta`: `pruned_through`.
 *
 * The dialect is SQLite's (`AUTOINCREMENT`, `INSERT … ON CONFLICT DO NOTHING`), as pi-durable's own
 * storage is: the runtime runs on SQLite only (storage-sqlite, storage-do).
 */

import type { FeedPage, RunSettlement, SqlDatabase, SqlRow } from "@pikit/contracts";

const TABLE = "runtime_pi_answers";
const META = "runtime_pi_answers_meta";

interface AnswerRow extends SqlRow {
  seq: number;
  conversation_id: string;
  conversation_key: string;
  agent: string;
  request_id: string;
  request_ids: string;
  kind: string;
  text: string | null;
  error_code: string | null;
  error_message: string | null;
}

/** A run to append: its settlement, and the key that names it (appending the same key again changes nothing). */
export interface LoggedRun {
  key: string;
  run: RunSettlement;
}

export interface AnswerLog {
  /** Creates the tables if they are missing. Idempotent. */
  ensure(): Promise<void>;
  /** Appends `runs` in this order, in one transaction; a run whose key is logged already is skipped. */
  append(runs: readonly LoggedRun[], now: number): Promise<void>;
  /** The first logged run that took `requestId` in the conversation, if it is still kept. */
  find(conversationId: string, requestId: string): Promise<RunSettlement | undefined>;
  /** `Feed.read`. */
  read(after: string | undefined, limit: number): Promise<FeedPage<RunSettlement>>;
  /** Removes the runs logged before `before` (epoch ms). */
  prune(before: number): Promise<void>;
}

export function createAnswerLog(db: SqlDatabase): AnswerLog {
  return {
    async ensure() {
      await db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_key TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_ids TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT,
        error_code TEXT,
        error_message TEXT,
        settled_at INTEGER NOT NULL
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_conversation ON ${TABLE} (conversation_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_settled_at ON ${TABLE} (settled_at)`);
      await db.run(`CREATE TABLE IF NOT EXISTS ${META} (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
    },

    async append(runs, now) {
      if (runs.length === 0) return;
      await db.transaction(async (tx) => {
        for (const { key, run } of runs) {
          await tx.run(
            `INSERT INTO ${TABLE} (run_key, conversation_id, conversation_key, agent, request_id, request_ids, kind, text, error_code, error_message, settled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_key) DO NOTHING`,
            [
              key,
              run.conversation.conversationId,
              run.conversation.key,
              run.conversation.agent,
              run.requestId,
              JSON.stringify(run.requestIds),
              run.kind,
              run.text ?? null,
              run.error?.code ?? null,
              run.error?.message ?? null,
              now,
            ],
          );
        }
      });
    },

    async find(conversationId, requestId) {
      // `instr` narrows the rows to those whose JSON names the id; parsing them keeps only exact matches.
      const rows = await db.query<AnswerRow>(`SELECT * FROM ${TABLE} WHERE conversation_id = ? AND instr(request_ids, ?) > 0 ORDER BY seq`, [
        conversationId,
        JSON.stringify(requestId),
      ]);
      const row = rows.find((candidate) => (JSON.parse(candidate.request_ids) as string[]).includes(requestId));
      return row === undefined ? undefined : settlementOf(row);
    },

    async read(after, limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`answers: limit must be an integer of at least 1, got ${limit}`);
      if (after !== undefined && !/^\d+$/.test(after)) throw new Error(`answers: "${after}" is not an answers cursor`);
      const from = after === undefined ? 0 : Number(after);
      // One snapshot: a prune between the two reads would otherwise hide a gap.
      return db.transaction(async (tx) => {
        const rows = await tx.query<AnswerRow>(`SELECT * FROM ${TABLE} WHERE seq > ? ORDER BY seq LIMIT ?`, [from, limit]);
        const [pruned] = await tx.query<{ value: number }>(`SELECT value FROM ${META} WHERE name = 'pruned_through'`);
        return {
          items: rows.map((row) => ({ cursor: String(row.seq), fact: settlementOf(row) })),
          gap: after !== undefined && from < (pruned?.value ?? 0),
        };
      });
    },

    async prune(before) {
      await db.transaction(async (tx) => {
        const [row] = await tx.query<{ last: number | null }>(`SELECT MAX(seq) AS last FROM ${TABLE} WHERE settled_at < ?`, [before]);
        if (row?.last == null) return;
        await tx.run(`DELETE FROM ${TABLE} WHERE settled_at < ?`, [before]);
        await tx.run(
          `INSERT INTO ${META} (name, value) VALUES ('pruned_through', ?) ON CONFLICT (name) DO UPDATE SET value = MAX(value, excluded.value)`,
          [row.last],
        );
      });
    },
  };
}

function settlementOf(row: AnswerRow): RunSettlement {
  return {
    conversation: { key: row.conversation_key, agent: row.agent, conversationId: row.conversation_id },
    requestId: row.request_id,
    requestIds: JSON.parse(row.request_ids) as string[],
    kind: row.kind as RunSettlement["kind"],
    ...(row.text !== null && { text: row.text }),
    ...(row.error_code !== null && { error: { code: row.error_code, message: row.error_message ?? "" } }),
  };
}
