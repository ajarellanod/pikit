/**
 * What outbound-durable tells `health` (@pikit/contracts' health.ts), when one is installed: its state
 * is `degraded` while an answer is stuck (a piece of it held longer than `STUCK_AFTER_MS`: the queue
 * sends one in seconds, so it keeps failing, waits for a rate limit, or its channel has no transport
 * attached) or one was given up within `ABANDONED_WINDOW_MS` (a permanent refusal, or 24 hours), and
 * `up` otherwise. The reason says how many answers, and the platform's last words (never a text).
 *
 * It is checked at start and when each delivery run ends, from the queue's own records. A check also
 * says when its state may change with no run (a piece reaching the minute, an abandonment leaving the
 * hour): the run asks for its next wakeup by then. A check never throws and never blocks a delivery:
 * one that cannot read the records is logged and changes nothing.
 */

import type { HealthReporter } from "@pikit/contracts";
import type { Logger } from "@pikit/core";
import type { Store } from "./store.ts";

/** An answer held this long (ms) without being delivered is stuck. The dashboard's Delivery says so too. */
export const STUCK_AFTER_MS = 60_000;
/** An answer given up keeps the queue `degraded` this long (ms). */
export const ABANDONED_WINDOW_MS = 60 * 60_000;
/** The platform's words in a reason, at most. */
const ERROR_LENGTH = 120;

/** `${idempotencyKey}#${index}` → its answer's key. */
const answerOf = (pieceKey: string): string => pieceKey.slice(0, pieceKey.lastIndexOf("#"));
const answers = (keys: readonly string[]): string => {
  const count = new Set(keys.map(answerOf)).size;
  return `${count} answer${count === 1 ? "" : "s"}`;
};
const short = (text: string): string => (text.length > ERROR_LENGTH ? `${text.slice(0, ERROR_LENGTH - 1)}…` : text);

export function createHealth(store: Pick<Store, "healthRows">, reporter: HealthReporter, logger: Logger) {
  return {
    /** Reports what the queue holds at `now`; when that may change with no run (ms), or `undefined`. Never throws. */
    async check(now: number): Promise<number | undefined> {
      try {
        const { open, abandoned } = await store.healthRows(now - ABANDONED_WINDOW_MS);
        const stuck = open.filter((piece) => now - piece.createdAt > STUCK_AFTER_MS);
        const reasons: string[] = [];
        if (stuck.length > 0) {
          const error = stuck.find((piece) => piece.lastError !== undefined)?.lastError;
          reasons.push(`${answers(stuck.map((piece) => piece.key))} not delivered for over a minute${error === undefined ? "" : ` (last error: ${short(error)})`}`);
        }
        const latest = abandoned[0];
        if (latest !== undefined) reasons.push(`${answers(abandoned.map((piece) => piece.key))} given up in the last hour (${short(latest.reason)})`);
        if (reasons.length === 0) reporter.up();
        else reporter.degraded(reasons.join("; "));
        const changes = [
          ...open.filter((piece) => now - piece.createdAt <= STUCK_AFTER_MS).map((piece) => piece.createdAt + STUCK_AFTER_MS + 1),
          ...abandoned.map((piece) => piece.at + ABANDONED_WINDOW_MS + 1),
        ];
        return changes.length === 0 ? undefined : Math.min(...changes);
      } catch (error) {
        logger.warn("outbound-durable: could not check its health; its last report stands", { error: String(error) });
        return undefined;
      }
    },
  };
}
