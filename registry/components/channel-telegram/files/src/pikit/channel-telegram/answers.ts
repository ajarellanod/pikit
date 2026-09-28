/**
 * Delivering answers from `agent.submissions`' feed (SPEC §4.8), with `submissions-sql` and
 * `storage.sql` installed.
 *
 * An answer used to reach the chat only through `agent.settled`, an event: one that ended while the
 * channel was stopped (a deploy stops the channels before the runtime), or whose delivery failed, or
 * whose process died in between, was lost. The runtime now records every run's end in
 * `agent.submissions`, and this reader delivers each one from a cursor it keeps in `storage.sql`:
 *
 * - it reads when the channel starts, whenever `agent.settled` / `agent.failed` wakes it, and every
 *   30 seconds (a wake the runtime could not give, after a record it wrote late);
 * - it applies each answer, then saves the cursor. Applying is idempotent with `outbound-durable`
 *   (the answer's key is `answerKey(conversation, requestId)`), so a crash between the two sends
 *   nothing twice; without a queue, the answer is sent directly and a crash there may send it again;
 * - a failure stops at that answer, which is tried again after 1 s, 5 s, 30 s, then every minute.
 *
 * No transaction spans the queue and the cursor: they are two components (SPEC §4.8).
 */

import type { Logger } from "@pikit/core";
import type { Feed, RunSettlement, SqlDatabase } from "@pikit/contracts";

const PAGE = 50;
/** How long to wait after the 1st, 2nd, 3rd… failure in a row; the last repeats. */
const RETRY_MS = [1_000, 5_000, 30_000, 60_000] as const;
/** A look at the feed with no wake: after a run's end was recorded late (the runtime retried it). */
const LOOK_EVERY_MS = 30_000;

/** Where the reader's place in the feed is kept: one row of this channel's own table. */
export interface Cursors {
  get(): Promise<string | undefined>;
  save(cursor: string): Promise<void>;
}

/** The channel's table in `storage.sql`, created if missing. */
export async function openCursors(sql: SqlDatabase): Promise<Cursors> {
  await sql.run("CREATE TABLE IF NOT EXISTS channel_telegram_cursors (reader TEXT PRIMARY KEY, cursor TEXT NOT NULL)");
  const reader = "answers";
  return {
    async get() {
      return (await sql.query<{ cursor: string }>("SELECT cursor FROM channel_telegram_cursors WHERE reader = ?", [reader]))[0]?.cursor;
    },
    async save(cursor) {
      await sql.run("INSERT INTO channel_telegram_cursors (reader, cursor) VALUES (?, ?) ON CONFLICT (reader) DO UPDATE SET cursor = excluded.cursor", [
        reader,
        cursor,
      ]);
    },
  };
}

export interface AnswerReader {
  /** Read now: a run ended. */
  wake(): void;
  /** Stop after the answer being applied; resolves when the reader has stopped. */
  halt(): Promise<void>;
}

export interface AnswerReaderOptions {
  answers: Feed<RunSettlement>;
  cursors: Cursors;
  /** Hands one answer to its chat. Rejects when it could not: the reader tries it again later. */
  deliver(answer: RunSettlement): Promise<void>;
  logger: Logger;
}

export function startAnswerReader(options: AnswerReaderOptions): AnswerReader {
  const { answers, cursors, deliver, logger } = options;
  let woken = true;
  let halted = false;
  let failures = 0;
  let gapReported = false;
  let interrupt: (() => void) | undefined;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        interrupt = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      interrupt = done;
    });

  const drain = async (): Promise<void> => {
    let cursor = await cursors.get();
    for (;;) {
      const page = await answers.read(cursor, PAGE);
      if (page.gap && !gapReported) {
        gapReported = true;
        logger.warn("channel-telegram: answers were pruned before this channel read them; some may not have reached their chats", { after: cursor });
      }
      for (const item of page.items) {
        if (halted) return;
        await deliver(item.fact);
        await cursors.save(item.cursor);
        cursor = item.cursor;
      }
      if (page.items.length < PAGE || halted) return;
    }
  };

  const loop = async (): Promise<void> => {
    while (!halted) {
      if (!woken) await wait(failures > 0 ? (RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] as number) : LOOK_EVERY_MS);
      if (halted) return;
      woken = false;
      try {
        await drain();
        failures = 0;
      } catch (error) {
        if (halted) return;
        failures++;
        logger.warn("channel-telegram: delivering an answer failed; trying again", { failures, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  const running = loop();

  return {
    wake() {
      woken = true;
      interrupt?.();
    },
    async halt() {
      halted = true;
      interrupt?.();
      await running;
    },
  };
}
