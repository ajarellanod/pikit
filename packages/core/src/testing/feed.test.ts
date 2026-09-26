/**
 * The feed suite against its in-memory double: it proves the suite asks only what the contract
 * promises (S12). `outbound-durable`'s receipts are the first real feed.
 */

import { test } from "bun:test";
import { createFeedConformance, createMemoryFeed } from "./feed.ts";

for (const c of createFeedConformance(
  () => {
    const memory = createMemoryFeed<{ id: string }>();
    let n = 0;
    return {
      feed: () => memory.feed,
      commit: async () => {
        const id = `fact-${++n}`;
        memory.append({ id });
        return id;
      },
      identify: (fact) => fact.id,
      prune: async () => memory.prune(),
    };
  },
  { prunes: true },
)) {
  test(`memory ${c.group}: ${c.name}`, () => c.run());
}
