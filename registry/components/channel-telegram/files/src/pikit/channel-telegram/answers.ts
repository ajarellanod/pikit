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
 * - each answer goes to its chat's lane: one chat's answers are delivered in order, and chats do not
 *   wait for each other (a chat waiting out Telegram's rate limit holds up only itself);
 * - an answer that could not be delivered stays in its lane and is tried again after 1 s, 5 s, 30 s,
 *   then every minute, and logged as an error from its 3rd failure: its chat's later answers wait
 *   behind it;
 * - the saved cursor only moves past answers that were delivered, so it never passes one that was
 *   not. Other chats go on while one is stuck, up to `WINDOW` answers read past it; then the reader
 *   waits for it too. Delivering is idempotent with `outbound-durable` (the answer's key is
 *   `answerKey(conversation, requestId)`); without a queue, the answers other chats got past a stuck
 *   one (at most `WINDOW`), or one sent just before a crash, are sent again after a restart.
 *
 * The first time the channel opens its cursor, it starts at the feed's end: the answers already there
 * ended before this reader existed, and were answered by events (an upgrade must not resend days of
 * them). No transaction spans the queue and the cursor: they are two components (SPEC §4.8).
 */

import type { Logger } from "@pikit/core";
import type { Feed, FeedItem, RunSettlement, SqlDatabase } from "@pikit/contracts";

const PAGE = 50;
/** How far the reader goes past an answer not delivered yet: what other chats may get meanwhile. */
const WINDOW = 200;
/** How long to wait after the 1st, 2nd, 3rd… failure in a row; the last repeats. */
const RETRY_MS: readonly number[] = [1_000, 5_000, 30_000, 60_000];
/** From this failure in a row on, an answer that cannot be delivered is an error, with its key. */
const BLOCKED_AFTER = 3;
/** A look at the feed with no wake: after a run's end was recorded late (the runtime retried it). */
const LOOK_EVERY_MS = 30_000;
/**
 * The saved cursor before the feed's first answer: the feed was empty when the channel first opened
 * it. A feed's cursors are opaque, but never empty.
 */
const FROM_START = "";

/** Where the reader's place in the feed is kept: one row of this channel's own table. */
export interface Cursors {
  get(): Promise<string | undefined>;
  save(cursor: string): Promise<void>;
}

/**
 * The channel's table in `storage.sql`, created if missing. With no row yet (the channel reads this
 * feed for the first time), its place is set at the feed's end.
 */
export async function openCursors(sql: SqlDatabase, answers: Feed<RunSettlement>): Promise<Cursors> {
  await sql.run("CREATE TABLE IF NOT EXISTS channel_telegram_cursors (reader TEXT PRIMARY KEY, cursor TEXT NOT NULL)");
  const reader = "answers";
  const cursors: Cursors = {
    async get() {
      const saved = (await sql.query<{ cursor: string }>("SELECT cursor FROM channel_telegram_cursors WHERE reader = ?", [reader]))[0]?.cursor;
      return saved === FROM_START ? undefined : saved;
    },
    async save(cursor) {
      await sql.run("INSERT INTO channel_telegram_cursors (reader, cursor) VALUES (?, ?) ON CONFLICT (reader) DO UPDATE SET cursor = excluded.cursor", [
        reader,
        cursor,
      ]);
    },
  };
  const rows = await sql.query("SELECT 1 FROM channel_telegram_cursors WHERE reader = ?", [reader]);
  if (rows.length === 0) {
    let end: string | undefined;
    for (;;) {
      const page = await answers.read(end, 500);
      end = page.items.at(-1)?.cursor ?? end;
      if (page.items.length < 500) break;
    }
    // Only if still missing: another process may have set it meanwhile.
    await sql.run("INSERT INTO channel_telegram_cursors (reader, cursor) VALUES (?, ?) ON CONFLICT (reader) DO NOTHING", [reader, end ?? FROM_START]);
  }
  return cursors;
}

export interface AnswerReader {
  /** Read now: a run ended. */
  wake(): void;
  /** Stop: answers being delivered end (a direct send is aborted by the bots' stop); saves how far it got. */
  halt(): Promise<void>;
}

export interface AnswerReaderOptions {
  answers: Feed<RunSettlement>;
  cursors: Cursors;
  /**
   * Hands one answer to its chat; resolves once it is delivered (or is not this channel's). Rejects
   * when it could not: the reader tries it again later.
   */
  deliver(answer: RunSettlement): Promise<void>;
  logger: Logger;
  /** Waits between tries of a failed answer or read; the last repeats. Tests shorten it. */
  retryMs?: readonly number[];
}

/** One answer read and not yet behind the cursor. */
interface Entry {
  cursor: string;
  delivered: boolean;
}

export function startAnswerReader(options: AnswerReaderOptions): AnswerReader {
  const { answers, cursors, deliver, logger } = options;
  const retryMs = options.retryMs ?? RETRY_MS;
  const backoff = (failures: number): number => retryMs[Math.min(failures, retryMs.length) - 1] as number;
  const halting = new AbortController();
  let woken = true;
  let failures = 0;
  let interrupt: (() => void) | undefined;
  /** Read from storage on the first drain; then what is saved, and what may be (everything before it delivered). */
  let loaded = false;
  let saved: string | undefined;
  let head: string | undefined;
  /** Where the next read starts: the last answer read. */
  let readTo: string | undefined;
  /** Answers read past `head`, in feed order. */
  const window: Entry[] = [];
  /** Each chat's last answer in flight, by conversation key. */
  const lanes = new Map<string, Promise<void>>();
  /** The cursor after which a gap was last reported: each gap once. */
  let gapAfter: string | null | undefined = null;

  /** Waits `ms`, or less when the reader halts. */
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (halting.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        halting.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      halting.signal.addEventListener("abort", done, { once: true });
    });

  const wake = (): void => {
    woken = true;
    interrupt?.();
  };

  /** Moves `head` past the answers delivered in a row from the window's start. */
  const advance = (): void => {
    const before = head;
    while (window[0]?.delivered) head = window.shift()?.cursor;
    if (head !== before) wake();
  };

  /** Delivers one answer, trying again until it is delivered or the reader halts. */
  const deliverUntilDone = async (answer: RunSettlement): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      if (halting.signal.aborted) throw new Error("channel-telegram: stopping");
      try {
        await deliver(answer);
        return;
      } catch (error) {
        if (halting.signal.aborted) throw error;
        const details = { conversation: answer.conversation.key, run: answer.requestId, failures: attempt, error: error instanceof Error ? error.message : String(error) };
        if (attempt >= BLOCKED_AFTER) {
          logger.error("channel-telegram: an answer still cannot be delivered; its chat's later answers wait for it, and the saved cursor stays before it", details);
        } else {
          logger.warn("channel-telegram: delivering an answer failed; trying again", details);
        }
        await pause(backoff(attempt));
      }
    }
  };

  /** Puts one answer read in its chat's lane, behind that chat's earlier ones. */
  const accept = (item: FeedItem<RunSettlement>): void => {
    const entry: Entry = { cursor: item.cursor, delivered: false };
    window.push(entry);
    const key = item.fact.conversation.key;
    const lane = (lanes.get(key) ?? Promise.resolve()).then(() => deliverUntilDone(item.fact));
    const settled = lane.then(
      () => {
        entry.delivered = true;
        advance();
      },
      // Halted before it was delivered: it stays after the saved cursor, for the next start.
      () => {},
    );
    lanes.set(key, settled);
    void settled.then(() => {
      if (lanes.get(key) === settled) lanes.delete(key);
    });
  };

  const drain = async (): Promise<void> => {
    if (!loaded) {
      saved = head = readTo = await cursors.get();
      loaded = true;
    }
    if (head !== undefined && head !== saved) {
      await cursors.save(head);
      saved = head;
    }
    while (!halting.signal.aborted && window.length < WINDOW) {
      const limit = Math.min(PAGE, WINDOW - window.length);
      const page = await answers.read(readTo, limit);
      if (page.gap && gapAfter !== readTo) {
        gapAfter = readTo;
        logger.warn("channel-telegram: answers were pruned before this channel read them; some may not have reached their chats", { after: readTo });
      }
      for (const item of page.items) {
        accept(item);
        readTo = item.cursor;
      }
      if (page.items.length < limit) return;
    }
  };

  const loop = async (): Promise<void> => {
    while (!halting.signal.aborted) {
      if (!woken) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, failures > 0 ? backoff(failures) : LOOK_EVERY_MS);
          function done() {
            clearTimeout(timer);
            interrupt = undefined;
            resolve();
          }
          interrupt = done;
        });
      }
      if (halting.signal.aborted) return;
      woken = false;
      try {
        await drain();
        failures = 0;
      } catch (error) {
        if (halting.signal.aborted) return;
        failures++;
        logger.warn("channel-telegram: reading answers or saving the cursor failed; trying again", { failures, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  const running = loop();

  return {
    wake,
    async halt() {
      halting.abort();
      interrupt?.();
      await running;
      await Promise.all(lanes.values());
      // What was delivered since the last save: not sent again at the next start.
      if (head !== undefined && head !== saved) {
        await cursors.save(head).catch((error: unknown) =>
          logger.warn("channel-telegram: saving the answers' cursor at stop failed; the last answers may be sent again", { error: String(error) }),
        );
      }
    },
  };
}
