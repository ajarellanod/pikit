/**
 * Feeds (SPEC K3): facts a component records, read by others with a cursor of their own.
 *
 * Events are notices and can be missed: a listener that throws, or a process that dies between a
 * commit and the event about it, loses one (K3). A reaction that must not be lost reads the
 * producer's feed instead. It reads from its saved cursor when it starts and whenever an event
 * wakes it, and applies what it reads idempotently. Then it saves the new cursor, in one of two ways:
 * - **in the same transaction as what it did**, when both are in one database (its own records in
 *   `storage.sql`): nothing is ever applied twice;
 * - **after what it did**, when they cannot share a transaction (a platform's API, another
 *   component's storage): what it did is committed first, idempotently (a key the other side
 *   deduplicates, a mark of its own), and the cursor after. A crash between the two applies the same
 *   fact again, which the idempotency absorbs; it must say what is left (a send cut mid-flight may
 *   reach a platform twice, marked). `startAnswerDelivery` (`delivery.ts`) is this kind.
 *
 * Either way the cursor never passes a fact whose effect is not committed, so a crash only delays it.
 *
 * A feed is a contract type, not a capability: a producer exposes one inside its own contract
 * (`outbound.queue`'s `receipts`). There is no bus and no registry of feeds, and the core stores
 * nothing. Pi's durable runtime makes the same choice: what matters is committed state, and
 * observers converge to it.
 */

/** Facts in the order they were committed, read after a cursor. */
export interface Feed<T> {
  /**
   * Facts committed after `after`, in commit order, at most `limit` (at least 1). `undefined` reads
   * from the oldest fact retained. A fact committed after this read never appears before a cursor
   * it returned, so a reader that saved one misses nothing by reading after it. Reading changes
   * nothing. A malformed cursor rejects.
   */
  read(after: string | undefined, limit: number): Promise<FeedPage<T>>;
}

export interface FeedPage<T> {
  items: readonly FeedItem<T>[];
  /**
   * Facts after `after` were pruned before this read: the reader missed some and must say so (SPEC P5).
   * The page still holds what is left. Never true when reading from `undefined`.
   */
  gap: boolean;
}

export interface FeedItem<T> {
  /** Opaque, stable across restarts: read after it to get the facts that follow. */
  cursor: string;
  fact: T;
}
