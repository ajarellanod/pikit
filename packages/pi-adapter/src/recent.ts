/**
 * A map that keeps only its `limit` most recently used entries: a cache whose misses its user can
 * afford (the runtime's `ConversationRef`s, read again from their `pikit.conversation` document).
 * Reading an entry (`get`) or writing it (`set`) makes it the most recent; a write past the limit drops
 * the least recently used one. A `Map` iterates in insertion order, so moving an entry is deleting and
 * inserting it again.
 */
export class RecentMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`RecentMap: the limit is a positive integer, got ${limit}`);
  }

  /** The value of `key`, now the most recently used; `undefined` when it was never set or was dropped. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Sets `key`, the most recently used now; drops the least recently used entry past the limit. */
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as K);
  }

  /** How many entries it holds: never more than `limit`. */
  get size(): number {
    return this.entries.size;
  }
}
