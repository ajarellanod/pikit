/**
 * The conversations' sandboxes this process holds, bounded. A sandbox is a few objects over files
 * that are on disk, so dropping one costs nothing but rebuilding it at its next `resolve`. Past
 * `keep` entries, the least recently resolved that is idle (no VM, no command running) is dropped; an
 * entry that is not idle is never dropped, so a conversation never gets a second VM beside its own.
 * Entries not idle are at most the VMs running, so the cache holds at most `keep` plus `maxVms`.
 */

export class SandboxCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(
    private readonly keep: number,
    /** Whether `value` holds nothing that a rebuilt one would not see (no VM, no running command). */
    private readonly idle: (value: T) => boolean,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** The entries held, by id; their order is unchanged. Every entry that is not idle is among them. */
  all(): IterableIterator<[string, T]> {
    return this.entries.entries();
  }

  /** The entry of `id`, made by `make` when there is none, now the most recently used. */
  get(id: string, make: () => T): T {
    const found = this.entries.get(id) ?? make();
    // Map keeps insertion order: deleting and setting again makes it the newest.
    this.entries.delete(id);
    this.entries.set(id, found);
    this.prune();
    return found;
  }

  private prune(): void {
    let excess = this.entries.size - this.keep;
    if (excess <= 0) return;
    for (const [id, value] of this.entries) {
      if (excess <= 0) return;
      if (!this.idle(value)) continue;
      this.entries.delete(id);
      excess--;
    }
  }
}
