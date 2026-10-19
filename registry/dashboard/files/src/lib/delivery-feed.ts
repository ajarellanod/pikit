/**
 * The outbound queue as the dashboard follows it, read once for every page that asks (the sidebar's
 * dot on Delivery, the Delivery view, a conversation's note): the pieces it holds now (`GET
 * /admin/api/delivery/pending`, every page) and its receipts (`GET /admin/api/delivery/receipts`: a
 * feed, read from the oldest the queue keeps, then on from its cursor), folded per answer
 * (`delivery.ts`: what is stuck, not delivered, possibly twice). It reads while a page uses it and the
 * operator is there (`usePolling`), at most once every `MIN_GAP_MS` however many pages ask.
 *
 * Without a queue to read here (`404 not_installed`: none is installed, or on Cloudflare, where each
 * conversation's queue is in its own Durable Object) it stops asking, and says why (`unavailable`).
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { every, usePolling } from "./activity.ts";
import { api, type ApiPage, type ApiPendingPiece, type ApiReceiptsPage, ApiFailure } from "./api.ts";
import { type DeliveryProblems, EMPTY_TALLY, problemsOf, type ReceiptsTally, tallyReceipts } from "./delivery.ts";

/** However many pages ask, the queue is read at most this often (ms). */
const MIN_GAP_MS = 3_000;
const PAGE = 500;
/** Pages of receipts read in one go: the rest at the next read. */
const RECEIPT_PAGES = 20;
/** Pages of pending pieces read: past them, `pendingMore`. */
const PENDING_PAGES = 10;

export interface DeliveryFeed {
  /** The pieces held now; `undefined` until read. */
  pending?: ApiPendingPiece[];
  /** More pieces are held than were read. */
  pendingMore: boolean;
  tally: ReceiptsTally;
  /** Every receipt the queue keeps was read once. */
  caughtUp: boolean;
  /** Some receipts were pruned before they were read: the count misses them. */
  gap: boolean;
  /** When it was last read, on this browser's clock. */
  readAt?: number;
  error?: Error;
  /** Why there is nothing to read here (the API's words), once it said so. */
  unavailable?: string;
}

let state: DeliveryFeed = { pendingMore: false, tally: EMPTY_TALLY, caughtUp: false, gap: false };
const listeners = new Set<() => void>();
let after: string | undefined;
let reading = false;
let started = 0;

const set = (change: Partial<DeliveryFeed>): void => {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function readPending(): Promise<{ items: ApiPendingPiece[]; more: boolean }> {
  const items: ApiPendingPiece[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < PENDING_PAGES; pages++) {
    const page = await api<ApiPage<ApiPendingPiece>>(`/delivery/pending?limit=${PAGE}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    items.push(...page.items);
    cursor = page.next;
    if (cursor === undefined) return { items, more: false };
  }
  return { items, more: true };
}

/** Reads the queue now, unless it was read within `MIN_GAP_MS`, is being read, or cannot be. */
export function refreshDelivery(): void {
  if (reading || state.unavailable !== undefined || Date.now() - started < MIN_GAP_MS) return;
  reading = true;
  started = Date.now();
  const read = async () => {
    const pending = await readPending();
    let tally = state.tally;
    let gap = state.gap;
    let caughtUp = false;
    for (let pages = 0; pages < RECEIPT_PAGES; pages++) {
      const page = await api<ApiReceiptsPage>(`/delivery/receipts?limit=${PAGE}${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`);
      tally = tallyReceipts(tally, page.items);
      gap ||= page.gap;
      after = page.next ?? after;
      if (page.items.length < PAGE) {
        caughtUp = true;
        break;
      }
    }
    set({ pending: pending.items, pendingMore: pending.more, tally, gap, caughtUp: state.caughtUp || caughtUp, readAt: Date.now(), error: undefined });
  };
  read()
    .catch((thrown: unknown) => {
      if (thrown instanceof ApiFailure && thrown.status === 404 && thrown.body.error === "not_installed") set({ unavailable: thrown.message, error: undefined });
      else set({ error: thrown instanceof Error ? thrown : new Error(String(thrown)) });
    })
    .finally(() => (reading = false));
}

/**
 * The queue, followed while `enabled` (the App has an `outbound.queue`), read again every `everyMs`
 * (slower on Cloudflare) while the operator is here; with its problems, per answer.
 */
export function useDelivery(enabled: boolean, everyMs = 30_000): { feed: DeliveryFeed; problems: DeliveryProblems | undefined } {
  const feed = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (enabled) refreshDelivery();
  }, [enabled]);
  usePolling(refreshDelivery, enabled ? every(everyMs) : undefined);
  const problems = useMemo(
    () => (feed.pending === undefined || feed.readAt === undefined ? undefined : problemsOf(feed.pending, feed.tally, feed.readAt)),
    [feed.pending, feed.tally, feed.readAt],
  );
  return { feed, problems };
}
