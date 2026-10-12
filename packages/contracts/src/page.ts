/**
 * Paging of a view of now: what a provider lists a page at a time (`agent.observe`'s conversations and
 * transcripts, `outbound.queue`'s pending pieces). Not a feed (`feed.ts`): a page reads what is there
 * when it is read, so an item that changes between two pages may be in neither, and a cursor is good
 * only for the provider that gave it.
 */

/** One page, and the cursor of the next (absent on the last page). */
export interface Page<T> {
  items: T[];
  next?: string;
}

/** What a page asks for. */
export interface PageRequest {
  /** At most this many items. Default: the provider's. */
  limit?: number;
  /** The `next` of the previous page. */
  cursor?: string;
}
