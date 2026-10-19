/**
 * Delivery's problems (SPEC §5), worked out from what the outbound queue says (`ApiPendingPiece`,
 * `ApiReceipt`) with no imports but types, so the kit's tests read it as it is. Per answer, never per
 * piece: an answer's pieces share its `idempotencyKey` (`answerKey`: `${conversationId}:${requestId}`).
 *
 * - **Stuck**: an answer with a piece the queue still holds that was tried and waits to go again
 *   (`retrying`: it failed, the platform asked to wait, or a stop cut it), or that has waited longer
 *   than `STUCK_AFTER_MS` (the queue sends one in seconds: its channel has no transport attached, or it
 *   waits behind a stuck one of its conversation).
 * - **Not delivered**: an answer with a piece the queue gave up (`abandoned`: a permanent refusal, or
 *   24 hours), with why and when.
 * - **Possibly twice**: an answer delivered with a piece the platform may have received twice
 *   (`possibleDuplicate`): nothing to do, said for what a person may have seen.
 * - Every other answer the receipts name was **delivered**: counted, never listed. The receipts are
 *   pruned (outbound-durable keeps 7 days of deliveries, 30 of abandoned pieces), so the count holds
 *   since the oldest delivered receipt read (`since`), and less when some were pruned before they were
 *   read (`gap`).
 */

import type { ApiPendingPiece, ApiReceipt } from "./admin-api.ts";

/** An answer whose pieces have waited this long (ms) without being delivered is stuck. */
export const STUCK_AFTER_MS = 60_000;
/** An answer given up within this long (ms) still asks for a look (the sidebar's dot). */
export const RECENT_MS = 24 * 60 * 60_000;

/** One answer: its key, its conversation (the API's id, when the key is a run's answer), its channel. */
export interface AnswerRef {
  key: string;
  conversationId?: string;
  conversationKey: string;
  channel: string;
}

export interface StuckAnswer extends AnswerRef {
  /** Its pieces still held. */
  pieces: number;
  /** One was tried and waits to go again; otherwise none was tried yet. */
  retrying: boolean;
  /** The most sends one of its pieces had. */
  attempts: number;
  /** Why its last try did not deliver it, short. */
  lastError?: string;
  /** When the queue tries again (its soonest piece), on the App's clock; absent while sending. */
  nextAttemptAt?: number;
  /** When its oldest held piece was stored. */
  since: number;
  /** Its next send may repeat one that reached the platform. */
  possibleDuplicate: boolean;
}

export interface UndeliveredAnswer extends AnswerRef {
  /** Why its first abandoned piece was given up. */
  reason: string;
  /** When the queue gave its first piece up. */
  at: number;
  /** The most sends one of its abandoned pieces had. */
  attempts: number;
  /** Its pieces given up, and those delivered (a person got part of it). */
  abandoned: number;
  delivered: number;
}

export interface DuplicateAnswer extends AnswerRef {
  /** Its pieces that may have been received twice. */
  pieces: number;
  /** When the last of them was delivered. */
  at: number;
}

/** What the receipts read so far say, folded per answer as the feed is read on (`tallyReceipts`). */
export interface ReceiptsTally {
  /** Pieces delivered, per answer with any. */
  delivered: ReadonlyMap<string, number>;
  abandoned: ReadonlyMap<string, UndeliveredAnswer>;
  duplicates: ReadonlyMap<string, DuplicateAnswer>;
  /** When the oldest delivered receipt read settled: since when the count holds. */
  since?: number;
}

export const EMPTY_TALLY: ReceiptsTally = { delivered: new Map(), abandoned: new Map(), duplicates: new Map() };

const refOf = (piece: { idempotencyKey: string; conversationId?: string; conversationKey: string; channel: string }): AnswerRef => ({
  key: piece.idempotencyKey,
  ...(piece.conversationId !== undefined && { conversationId: piece.conversationId }),
  conversationKey: piece.conversationKey,
  channel: piece.channel,
});

/** `tally` with `receipts` (in the order they settled) folded in; `tally` itself is left as it was. */
export function tallyReceipts(tally: ReceiptsTally, receipts: readonly ApiReceipt[]): ReceiptsTally {
  if (receipts.length === 0) return tally;
  const delivered = new Map(tally.delivered);
  const abandoned = new Map(tally.abandoned);
  const duplicates = new Map(tally.duplicates);
  let since = tally.since;
  for (const receipt of receipts) {
    const key = receipt.idempotencyKey;
    if (receipt.outcome.kind === "abandoned") {
      const before = abandoned.get(key);
      abandoned.set(
        key,
        before === undefined
          ? { ...refOf(receipt), reason: receipt.outcome.reason, at: receipt.at, attempts: receipt.attempts, abandoned: 1, delivered: delivered.get(key) ?? 0 }
          : { ...before, attempts: Math.max(before.attempts, receipt.attempts), abandoned: before.abandoned + 1 },
      );
      continue;
    }
    delivered.set(key, (delivered.get(key) ?? 0) + 1);
    const given = abandoned.get(key);
    if (given !== undefined) abandoned.set(key, { ...given, delivered: given.delivered + 1 });
    since = since === undefined ? receipt.at : Math.min(since, receipt.at);
    if (receipt.outcome.possibleDuplicate) {
      const before = duplicates.get(key);
      duplicates.set(key, { ...refOf(receipt), pieces: (before?.pieces ?? 0) + 1, at: Math.max(before?.at ?? 0, receipt.at) });
    }
  }
  return { delivered, abandoned, duplicates, ...(since !== undefined && { since }) };
}

export interface DeliveryProblems {
  /** The oldest first. */
  stuck: StuckAnswer[];
  /** The latest given up first. */
  undelivered: UndeliveredAnswer[];
  /** The latest first; none given up. */
  duplicates: DuplicateAnswer[];
  /** Answers on their way: held for less than `STUCK_AFTER_MS`, never tried yet. */
  onTheirWay: number;
  /** Answers the receipts say were delivered whole: none held, none given up. */
  delivered: number;
  /** When the oldest delivered receipt read settled. */
  since?: number;
}

/** The answers that need a look, from the pieces held now (`pending`) and the receipts read, at `now`. */
export function problemsOf(pending: readonly ApiPendingPiece[], tally: ReceiptsTally, now: number): DeliveryProblems {
  const held = new Map<string, ApiPendingPiece[]>();
  for (const piece of pending) held.set(piece.idempotencyKey, [...(held.get(piece.idempotencyKey) ?? []), piece]);

  const stuck: StuckAnswer[] = [];
  let onTheirWay = 0;
  for (const [, pieces] of held) {
    const first = pieces[0] as ApiPendingPiece;
    const since = Math.min(...pieces.map((piece) => piece.storedAt));
    const retrying = pieces.some((piece) => piece.state === "retrying");
    if (!retrying && now - since <= STUCK_AFTER_MS) {
      onTheirWay += 1;
      continue;
    }
    const failed = [...pieces].sort((a, b) => a.index - b.index).find((piece) => piece.lastError !== undefined);
    const next = pieces.flatMap((piece) => (piece.nextAttemptAt === undefined ? [] : [piece.nextAttemptAt]));
    stuck.push({
      ...refOf(first),
      pieces: pieces.length,
      retrying,
      attempts: Math.max(...pieces.map((piece) => piece.attempts)),
      ...(failed?.lastError !== undefined && { lastError: failed.lastError }),
      ...(next.length > 0 && { nextAttemptAt: Math.min(...next) }),
      since,
      possibleDuplicate: pieces.some((piece) => piece.possibleDuplicate),
    });
  }
  stuck.sort((a, b) => a.since - b.since);

  const undelivered = [...tally.abandoned.values()].sort((a, b) => b.at - a.at);
  const duplicates = [...tally.duplicates.values()].filter((answer) => !tally.abandoned.has(answer.key)).sort((a, b) => b.at - a.at);
  let delivered = 0;
  for (const key of tally.delivered.keys()) if (!tally.abandoned.has(key) && !held.has(key)) delivered += 1;
  return { stuck, undelivered, duplicates, onTheirWay, delivered, ...(tally.since !== undefined && { since: tally.since }) };
}

/** Whether an operator should look now: an answer stuck, or one given up within `RECENT_MS`. */
export function needsAttention(problems: DeliveryProblems, now: number): boolean {
  return problems.stuck.length > 0 || problems.undelivered.some((answer) => now - answer.at <= RECENT_MS);
}
