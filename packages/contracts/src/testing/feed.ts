/**
 * Feed conformance (SPEC §4.8, §14): what every `Feed` must do, whoever produces it. Runner-independent,
 * like the lifecycle suite:
 *
 *   for (const c of createFeedConformance(() => myFixture(), { prunes: true, restarts: true }))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The fixture commits facts the way its producer does (an outbox delivering a piece), and says how to
 * recognise each one when it is read back. Pruning and restarting are the producer's to do; the cases
 * that need them run only when the options say the fixture can.
 *
 * `createMemoryFeed` is the in-memory double: it passes this suite, and it stands in for a producer
 * in the tests of a component that reads a feed.
 */

import type { Feed, FeedItem, FeedPage } from "../feed.ts";
import { checker, expecter } from "./assert.ts";
import type { ConformanceCase } from "@pikit/core/testing";

/** A producer over fresh, empty records, built for one case. */
export interface FeedFixture<T> {
  /** The feed as the producer exposes it now; asked again after `restart()`. */
  feed(): Feed<T>;
  /** Makes the producer commit one new fact; resolves once it is committed, with its identity. */
  commit(): Promise<string>;
  /** The identity of a fact read back: what `commit` returned for it. */
  identify(fact: T): string;
  /** Prunes every fact committed so far, as the producer's retention would. Required by `prunes`. */
  prune?(): Promise<void>;
  /** A new process over the same records. Required by `restarts`. */
  restart?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface FeedConformanceOptions {
  /** The fixture can prune: check `gap`. */
  prunes?: boolean;
  /** The fixture can restart its producer: check that cursors survive it. */
  restarts?: boolean;
}

const GROUP = "feed";
const expect = expecter(GROUP);
const check = checker(GROUP);

export function createFeedConformance<T>(
  factory: () => FeedFixture<T> | Promise<FeedFixture<T>>,
  options: FeedConformanceOptions = {},
): readonly ConformanceCase[] {
  const feedCase = (name: string, run: (f: FeedFixture<T>) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      try {
        await run(fixture);
      } finally {
        await fixture.dispose?.();
      }
    },
  });
  const commitMany = async (f: FeedFixture<T>, n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await f.commit());
    return ids;
  };
  const ids = (f: FeedFixture<T>, page: FeedPage<T>): string[] => page.items.map((item) => f.identify(item.fact));

  const cases: ConformanceCase[] = [
    feedCase("an empty feed reads nothing, and no gap", async (f) => {
      const page = await f.feed().read(undefined, 10);
      expect(page.items.length, 0, "facts in an empty feed");
      expect(page.gap, false, "gap of an empty feed");
    }),

    feedCase("facts read back in the order they were committed", async (f) => {
      const committed = await commitMany(f, 5);
      const page = await f.feed().read(undefined, 100);
      expect(ids(f, page), committed, "the facts, in commit order");
      expect(page.gap, false, "gap");
      check(new Set(page.items.map((i) => i.cursor)).size === page.items.length, "every fact to have its own cursor");
    }),

    feedCase("reading after a cursor returns only the facts that follow it", async (f) => {
      const committed = await commitMany(f, 4);
      const all = await f.feed().read(undefined, 100);
      const second = all.items[1] as FeedItem<T>;
      const rest = await f.feed().read(second.cursor, 100);
      expect(ids(f, rest), committed.slice(2), "the facts after the second one");
      expect(rest.gap, false, "gap");
    }),

    feedCase("limit bounds a page, and paging returns every fact once", async (f) => {
      const committed = await commitMany(f, 7);
      const seen: string[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const page = await f.feed().read(after, 3);
        check(page.items.length <= 3, `a page of at most 3 facts, got ${page.items.length}`);
        if (page.items.length === 0) break;
        seen.push(...ids(f, page));
        after = (page.items.at(-1) as FeedItem<T>).cursor;
      }
      expect(seen, committed, "the facts read three at a time");
    }),

    feedCase("a fact committed after a read lands after that read's last cursor", async (f) => {
      await commitMany(f, 2);
      const first = await f.feed().read(undefined, 100);
      const last = (first.items.at(-1) as FeedItem<T>).cursor;
      expect((await f.feed().read(last, 100)).items.length, 0, "facts after the last cursor, before new ones");
      const later = await commitMany(f, 2);
      const next = await f.feed().read(last, 100);
      expect(ids(f, next), later, "the facts committed after the read");
      expect(next.gap, false, "gap");
    }),

    feedCase("reading changes nothing", async (f) => {
      await commitMany(f, 3);
      const a = await f.feed().read(undefined, 100);
      const b = await f.feed().read(undefined, 100);
      expect(ids(f, b), ids(f, a), "the same facts read twice");
      expect(
        b.items.map((i) => i.cursor),
        a.items.map((i) => i.cursor),
        "the same cursors read twice",
      );
      const after = (a.items[0] as FeedItem<T>).cursor;
      expect(ids(f, await f.feed().read(after, 100)), ids(f, await f.feed().read(after, 100)), "the same facts after a cursor, read twice");
    }),

    feedCase("a malformed cursor, or a limit below 1, rejects", async (f) => {
      await commitMany(f, 1);
      const rejects = (read: () => Promise<unknown>) =>
        read().then(
          () => false,
          () => true,
        );
      check(await rejects(() => f.feed().read("pikit feed conformance: not a cursor", 10)), "a malformed cursor to reject");
      check(await rejects(() => f.feed().read(undefined, 0)), "a limit of 0 to reject");
    }),
  ];

  if (options.restarts) {
    cases.push(
      feedCase("cursors survive a restart of the producer", async (f) => {
        if (f.restart === undefined) throw new Error(`${GROUP}: the fixture has no restart(), but the options say it restarts`);
        const committed = await commitMany(f, 3);
        const second = ((await f.feed().read(undefined, 100)).items[1] as FeedItem<T>).cursor;
        await f.restart();
        const later = await f.commit();
        const page = await f.feed().read(second, 100);
        expect(ids(f, page), [committed[2], later], "the facts after the saved cursor, across the restart");
        expect(page.gap, false, "gap");
      }),
    );
  }

  if (options.prunes) {
    cases.push(
      feedCase("gap says when facts after the cursor were pruned, and only then", async (f) => {
        if (f.prune === undefined) throw new Error(`${GROUP}: the fixture has no prune(), but the options say it prunes`);
        await commitMany(f, 3);
        const before = await f.feed().read(undefined, 100);
        const afterFirst = (before.items[0] as FeedItem<T>).cursor;
        const afterLast = (before.items.at(-1) as FeedItem<T>).cursor;
        await f.prune();
        const later = await f.commit();

        const behind = await f.feed().read(afterFirst, 100);
        expect(behind.gap, true, "gap for a reader whose unread facts were pruned");
        expect(ids(f, behind), [later], "what is left for that reader");

        const upToDate = await f.feed().read(afterLast, 100);
        expect(upToDate.gap, false, "gap for a reader that had read everything pruned");
        expect(ids(f, upToDate), [later], "what follows for that reader");

        const fresh = await f.feed().read(undefined, 100);
        expect(fresh.gap, false, "gap for a reader starting at what is retained");
        expect(ids(f, fresh), [later], "what is retained");
      }),
    );
  }

  return cases;
}

// ---------------------------------------------------------------------------------------------

/** An in-memory feed, for tests: the producer's side (`append`, `prune`) and the reader's (`feed`). */
export interface MemoryFeed<T> {
  readonly feed: Feed<T>;
  /** Commits `fact`; returns its cursor. */
  append(fact: T): string;
  /** Prunes every fact committed so far. */
  prune(): void;
}

/**
 * The in-memory double of `Feed`. Its records live as long as the object: it survives no process, so
 * it is only for tests (S9).
 */
export function createMemoryFeed<T>(): MemoryFeed<T> {
  const facts: { seq: number; fact: T }[] = [];
  let last = 0;
  let prunedThrough = 0;
  const feed: Feed<T> = {
    async read(after, limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`memory feed: limit must be an integer of at least 1, got ${limit}`);
      if (after !== undefined && !/^\d+$/.test(after)) throw new Error(`memory feed: malformed cursor "${after}"`);
      const from = after === undefined ? 0 : Number(after);
      return {
        items: facts.filter((f) => f.seq > from).slice(0, limit).map((f) => ({ cursor: String(f.seq), fact: f.fact })),
        gap: after !== undefined && from < prunedThrough,
      };
    },
  };
  return {
    feed,
    append(fact) {
      last += 1;
      facts.push({ seq: last, fact });
      return String(last);
    },
    prune() {
      prunedThrough = last;
      facts.length = 0;
    },
  };
}
