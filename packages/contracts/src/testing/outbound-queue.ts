/**
 * `outbound.queue` conformance: what every queue must do, wherever
 * it keeps its records. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createOutboundQueueConformance(() => myFixture(), { retry: MY_RETRY }))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * How long to wait and when to give up is the provider's policy, not the contract's:
 * the provider declares it (`retry`), and the suite holds it to what it declared. What every queue
 * must do is the rest: order, retry after a transient failure for as long as the piece is young enough
 * (never abandoned for their number), no retry after a permanent one, rate limits that do not count
 * as failures, possible duplicates marked, receipts.
 *
 * The suite owns the clock (`createManualClock`), so retries are checked to the millisecond without
 * waiting, and the transport, which it scripts: a piece's send succeeds, fails with a given kind, or
 * hangs until aborted. It observes only the capability and the `outbound.*` events.
 *
 * The queue's `receipts` are checked here too (SPEC K3): what they record, and the feed suite
 * (`createFeedConformance`) over them, restarts included. So is `pending`: what is not settled yet,
 * its states, and its pages.
 */

import {
  type App,
  type AppEvents,
  BACKGROUND_CONTEXT,
  type ComponentDefinition,
  defineApp,
  defineComponent,
  silentLogger,
  withAbortSignal,
} from "@pikit/core";
import {
  type ChannelTransport,
  DeliveryError,
  type DeliveryReceipt,
  type OutboundMessage,
  type OutboundPiece,
  type OutboundQueue,
  type PendingPiece,
} from "../outbound.ts";
import { checker, expecter } from "./assert.ts";
import { createFeedConformance } from "./feed.ts";
import { type ConformanceCase, createManualClock, type ManualClock } from "@pikit/core/testing";

/** Fresh, empty records, built for one case. */
export interface OutboundQueueFixture {
  /**
   * The component providing `outbound.queue`, and what it uses (its storage). The suite may create
   * several apps from them over the same records, one after the other, as a process that restarts:
   * the records live outside the components' setup (a file, a schema).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  dispose?(): Promise<void>;
}

const GROUP = "outbound.queue";
const expect = expecter(GROUP);
const check = checker(GROUP);

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
export interface OutboundQueueConformanceOptions {
  /** The provider's own retry policy, which the suite holds it to. */
  retry: {
    /**
     * The wait after each transient failure in a row, in order; at least one. The last repeats:
     * transient failures never abandon a piece, only its age does.
     */
    waitsMs: readonly number[];
    /** A piece not delivered this long after it was enqueued is abandoned, whatever the reason. */
    maxAgeMs: number;
  };
}

/** `90_000` → `1.5 min`: for the cases' names. */
function duration(ms: number): string {
  const units: [number, string][] = [
    [60 * MINUTE, "h"],
    [MINUTE, "min"],
    [SECOND, "s"],
  ];
  const [size, unit] = units.find(([size]) => ms >= size) ?? [1, "ms"];
  return `${Number((ms / size).toFixed(2))} ${unit}`;
}

export function createOutboundQueueConformance(
  factory: () => OutboundQueueFixture | Promise<OutboundQueueFixture>,
  options: OutboundQueueConformanceOptions,
): readonly ConformanceCase[] {
  const { waitsMs, maxAgeMs } = options.retry;
  if (waitsMs.length === 0 || waitsMs.some((wait) => !(wait > 0)) || !(maxAgeMs > 0)) {
    throw new Error("outbound.queue conformance: retry.waitsMs needs at least one positive wait, and retry.maxAgeMs must be positive");
  }
  const firstWait = waitsMs[0] as number;
  /** Every declared wait, then the last one three more times. */
  const waits = [...waitsMs, ...Array.from({ length: 3 }, () => waitsMs.at(-1) as number)];
  const queueCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const clock = createManualClock();
      const apps: App[] = [];
      try {
        await run(createSubject(fixture, clock, apps));
      } finally {
        for (const app of apps) await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  const cases: ConformanceCase[] = [
    queueCase("a message is stored, then its pieces are sent in order, each once", async (s) => {
      const w = await s.open();
      const transport = scripted();
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "one|two|three"));
      await eventually(() => w.delivered.length === 3, "three pieces delivered");
      expect(
        transport.calls.map((p) => [p.key, p.conversationKey, p.text, p.possibleDuplicate]),
        [
          ["m1#0", "chat:1", "one", false],
          ["m1#1", "chat:1", "two", false],
          ["m1#2", "chat:1", "three", false],
        ],
        "each piece sent once, in order, with its key",
      );
      expect(w.delivered.map((d) => d.key), ["m1#0", "m1#1", "m1#2"], "outbound.delivered for each piece");
      expect(w.delivered[0], { channel: "chat", conversationKey: "chat:1", key: "m1#0", attempts: 1, possibleDuplicate: false }, "the event's fields");
    }),

    queueCase("the same idempotencyKey enqueued again is sent once", async (s) => {
      const w = await s.open();
      const transport = scripted();
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => w.delivered.length === 1, "one delivery");
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await s.clock.advance(MINUTE);
      expect(transport.calls.length, 1, "sends of a message enqueued three times");
    }),

    queueCase("enqueue rejects when no transport is attached for the channel", async (s) => {
      const w = await s.open();
      const rejected = await w.queue.enqueue(message("m1", "nowhere:1", "hello", "nowhere")).then(
        () => false,
        () => true,
      );
      check(rejected, "enqueue for a channel with no transport to reject");
    }),

    queueCase("a conversation's pieces wait behind one being retried; other conversations do not", async (s) => {
      const w = await s.open();
      const transport = scripted({ "a1#0": [transient()] });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("a1", "chat:a", "first in a"));
      await w.queue.enqueue(message("a2", "chat:a", "second in a"));
      await w.queue.enqueue(message("b1", "chat:b", "only in b"));
      await eventually(() => w.delivered.some((d) => d.key === "b1#0"), "b's message delivered while a waits");
      await s.clock.advance(firstWait);
      await eventually(() => w.delivered.some((d) => d.key === "a2#0"), "a's messages delivered after the wait");
      expect(
        transport.calls.filter((p) => p.conversationKey === "chat:a").map((p) => p.key),
        ["a1#0", "a1#0", "a2#0"],
        "a's sends: the failed one, its retry, then the next one",
      );
    }),

    queueCase(`transient failures are retried after the declared waits (${waitsMs.map(duration).join(", ")}), the last repeating, and never abandoned for their number`, async (s) => {
      const w = await s.open();
      const transport = scripted({ "m1#0": waits.map(() => transient()) });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      for (const [i, wait] of waits.entries()) {
        await s.clock.advance(wait - 1);
        expect(transport.calls.length, i + 1, `attempts 1 ms before the wait of ${wait} ms ends`);
        await s.clock.advance(1);
        await eventually(() => transport.calls.length === i + 2, `attempt ${i + 2} once the wait ends`);
      }
      await eventually(() => w.delivered.length === 1, `delivered at attempt ${waits.length + 1}, once the platform answers`);
      expect(w.abandoned, [], "nothing abandoned for failing transiently");
      expect(w.delivered[0]?.attempts, waits.length + 1, "attempts of the delivered piece");
    }),

    queueCase("a permanent failure is abandoned at once, and its conversation moves on", async (s) => {
      const w = await s.open();
      const transport = scripted({ "m1#0": [new DeliveryError("permanent", "the chat blocked the bot")] });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "lost"));
      await w.queue.enqueue(message("m2", "chat:1", "next"));
      await eventually(() => w.delivered.some((d) => d.key === "m2#0"), "the next message delivered");
      expect(w.abandoned.map((a) => [a.key, a.attempts]), [["m1#0", 1]], "the permanent failure, abandoned after one attempt");
      expect(transport.calls.map((p) => p.key), ["m1#0", "m2#0"], "no retry of a permanent failure");
    }),

    queueCase("a rate limit waits what the platform asked, and is not counted as a failed attempt", async (s) => {
      const w = await s.open();
      const limited = () => new DeliveryError("rate_limited", "too many requests", { retryAfterMs: 3 * SECOND });
      const transport = scripted({ "m1#0": Array.from({ length: 7 }, limited) });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      for (let i = 1; i <= 7; i++) {
        await s.clock.advance(3 * SECOND - 1);
        expect(transport.calls.length, i, `sends before retry_after ends (${i})`);
        await s.clock.advance(1);
        await eventually(() => transport.calls.length === i + 1, `send ${i + 1} once retry_after ends`);
      }
      await eventually(() => w.delivered.length === 1, "delivered after seven rate limits");
      expect(w.abandoned, [], "nothing abandoned");
    }),

    queueCase(`a piece still undelivered after the declared age (${duration(maxAgeMs)}) is abandoned`, async (s) => {
      const w = await s.open();
      // Rate limits never count as failures, so only the age can end it: five steps reach it.
      const step = Math.ceil(maxAgeMs / 5);
      const limited = () => new DeliveryError("rate_limited", "too many requests", { retryAfterMs: step });
      const transport = scripted({ "m1#0": Array.from({ length: 20 }, limited) });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      for (let waited = step; waited <= maxAgeMs + 2 * step && w.abandoned.length === 0; waited += step) await s.clock.advance(step);
      await eventually(() => w.abandoned.length === 1, "the piece abandoned for its age");
      expect(w.delivered, [], "never delivered");
    }),

    queueCase("a send that may have reached the platform is retried as a possible duplicate", async (s) => {
      const w = await s.open();
      const transport = scripted({ "m1#0": [new DeliveryError("transient", "timed out after sending", { maybeSent: true })] });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      await s.clock.advance(firstWait);
      await eventually(() => w.delivered.length === 1, "the retry delivered");
      expect(transport.calls.map((p) => p.possibleDuplicate), [false, true], "the retry marked as a possible duplicate");
      expect(w.delivered[0]?.possibleDuplicate, true, "outbound.delivered says so");
    }),

    queueCase("what was stored survives the process: a send in flight is sent again as a possible duplicate", async (s) => {
      const first = await s.open();
      const hanging = scripted({ "m1#0": ["hang"] });
      first.queue.attach("chat", hanging);
      await first.queue.enqueue(message("m1", "chat:1", "in flight|behind it"));
      await eventually(() => hanging.calls.length === 1, "the send in flight");
      await s.stopAll();

      const second = await s.open();
      const transport = scripted();
      second.queue.attach("chat", transport);
      await eventually(() => second.delivered.length === 2, "both pieces delivered by the next process");
      expect(
        transport.calls.map((p) => [p.key, p.possibleDuplicate]),
        [
          ["m1#0", true],
          ["m1#1", false],
        ],
        "the piece in flight as a possible duplicate, the one behind it as new",
      );
    }),

    queueCase("a piece waiting to be retried survives the process, and is not marked a duplicate", async (s) => {
      const first = await s.open();
      first.queue.attach("chat", scripted({ "m1#0": [transient()] }));
      await first.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => first.delivered.length === 0 && first.attempts() === 1, "the failed attempt");
      await s.stopAll();

      const second = await s.open();
      const transport = scripted();
      second.queue.attach("chat", transport);
      await s.clock.advance(firstWait);
      await eventually(() => second.delivered.length === 1, "delivered by the next process after its wait");
      expect(transport.calls.map((p) => p.possibleDuplicate), [false], "a failure that never reached the platform is no duplicate");
    }),

    queueCase("detach waits for sends in flight; its signal aborts them, and they are sent again after attach", async (s) => {
      const w = await s.open();
      const hanging = scripted({ "m1#0": ["hang"] });
      w.queue.attach("chat", hanging);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => hanging.calls.length === 1, "the send in flight");
      const deadline = new AbortController();
      let detached = false;
      const detaching = w.queue.detach("chat", deadline.signal).then(() => void (detached = true));
      await s.clock.advance(1);
      check(!detached, "detach to wait while a send is in flight");
      deadline.abort(new Error("the channel's stop deadline"));
      await detaching;
      check(hanging.aborted === 1, "the send in flight to be aborted by detach's signal");

      const rejected = await w.queue.enqueue(message("m2", "chat:1", "after")).then(
        () => false,
        () => true,
      );
      check(rejected, "enqueue after detach to reject: no transport");
      const transport = scripted();
      w.queue.attach("chat", transport);
      await eventually(() => w.delivered.length === 1, "the aborted piece delivered after attach");
      expect(transport.calls.map((p) => [p.key, p.possibleDuplicate]), [["m1#0", true]], "sent again as a possible duplicate");
    }),

    queueCase("receipts: one per settled piece, in the order pieces settled, with what became of it", async (s) => {
      const w = await s.open();
      const transport = scripted({ "m2#0": [new DeliveryError("permanent", "the chat blocked the bot")] });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "one|two"));
      await w.queue.enqueue(message("m2", "chat:1", "lost"));
      await w.queue.enqueue(message("m3", "chat:1", "three"));
      await eventually(() => w.delivered.length === 3 && w.abandoned.length === 1, "three pieces delivered and one abandoned");
      const page = await w.queue.receipts.read(undefined, 100);
      expect(
        page.items.map(({ fact }) => [fact.idempotencyKey, fact.index, fact.outcome.kind]),
        [
          ["m1", 0, "delivered"],
          ["m1", 1, "delivered"],
          ["m2", 0, "abandoned"],
          ["m3", 0, "delivered"],
        ],
        "each piece's receipt, in the order it settled",
      );
      const sent = new Map(transport.calls.map((p, i) => [p.key, `platform-${i + 1}`]));
      expect(
        page.items[0]?.fact,
        {
          idempotencyKey: "m1",
          index: 0,
          channel: "chat",
          conversationKey: "chat:1",
          attempts: 1,
          outcome: { kind: "delivered", platformMessageId: sent.get("m1#0"), possibleDuplicate: false },
          at: s.clock.now(),
        },
        "a delivered piece's receipt, with the platform's message id",
      );
      const abandoned = page.items[2]?.fact.outcome;
      check(abandoned?.kind === "abandoned" && abandoned.reason !== "", "the abandoned piece's receipt to give its reason");
      expect(page.gap, false, "gap");
    }),

    queueCase("receipts: a piece being retried has none until it settles, and then says it may be a duplicate", async (s) => {
      const w = await s.open();
      const transport = scripted({ "m1#0": [new DeliveryError("transient", "timed out after sending", { maybeSent: true })] });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      expect((await w.queue.receipts.read(undefined, 100)).items, [], "receipts while the piece waits for its retry");
      await s.clock.advance(firstWait);
      await eventually(() => w.delivered.length === 1, "the retry delivered");
      const [receipt] = (await w.queue.receipts.read(undefined, 100)).items;
      expect(receipt?.fact.attempts, 2, "attempts on the receipt");
      expect(receipt?.fact.outcome, { kind: "delivered", platformMessageId: "platform-2", possibleDuplicate: true }, "the receipt of a retried send");
    }),

    queueCase("receipts survive the process", async (s) => {
      const first = await s.open();
      first.queue.attach("chat", scripted());
      await first.queue.enqueue(message("m1", "chat:1", "one|two"));
      await eventually(() => first.delivered.length === 2, "both pieces delivered");
      const before = await first.queue.receipts.read(undefined, 100);
      await s.stopAll();

      const second = await s.open();
      const after = await second.queue.receipts.read(undefined, 100);
      expect(after.items, before.items, "the receipts, read by the next process");
      expect((await second.queue.receipts.read(before.items.at(-1)?.cursor, 100)).items, [], "nothing after the last cursor");
    }),

    queueCase("pending: the piece being sent and the ones behind it, oldest first, without their text", async (s) => {
      const w = await s.open();
      const hanging = scripted({ "m1#0": ["hang"] });
      w.queue.attach("chat", hanging);
      await w.queue.enqueue(message("m1", "chat:1", "one|two"));
      await eventually(() => hanging.calls.length === 1, "the send in flight");
      const page = await w.queue.pending({});
      expect(
        page.items.map(shown),
        [
          { idempotencyKey: "m1", index: 0, channel: "chat", conversationKey: "chat:1", state: "sending", attempts: 1, possibleDuplicate: false, storedAt: s.clock.now() },
          { idempotencyKey: "m1", index: 1, channel: "chat", conversationKey: "chat:1", state: "queued", attempts: 0, possibleDuplicate: false, storedAt: s.clock.now() },
        ],
        "the pending pieces",
      );
      expect(page.items[0]?.nextAttemptAt, undefined, "nextAttemptAt of a piece being sent");
      expect(page.items[1]?.nextAttemptAt, s.clock.now(), "nextAttemptAt of a piece never tried");
      expect(page.items.map((p) => p.lastError), [undefined, undefined], "lastError before any failure");
      check(page.items.every((p) => !("text" in p)), "a pending piece to carry no text");
      expect(page.next, undefined, "next on the only page");
      await s.stopAll();
    }),

    queueCase("pending: a failed piece shows its attempts and why until its retry delivers it; then it is in receipts", async (s) => {
      const w = await s.open();
      const transport = scripted({ "m1#0": [transient()] });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      let piece: PendingPiece | undefined;
      await eventually(async () => {
        [piece] = (await w.queue.pending({})).items;
        return piece?.state === "retrying";
      }, "the failed piece waiting for its retry");
      expect(piece?.attempts, 1, "attempts of the failed piece");
      expect(piece?.nextAttemptAt, s.clock.now() + firstWait, "nextAttemptAt: the declared wait after a transient failure");
      check(piece?.lastError?.includes("503 from the platform") === true, `lastError to give the failure, got ${JSON.stringify(piece?.lastError)}`);
      expect(piece?.possibleDuplicate, false, "possibleDuplicate of a failure that never reached the platform");
      expect((await w.queue.receipts.read(undefined, 100)).items, [], "receipts while it waits");

      await s.clock.advance(firstWait);
      await eventually(() => w.delivered.length === 1, "the retry delivered");
      expect((await w.queue.pending({})).items, [], "pending once it settled");
      const [receipt] = (await w.queue.receipts.read(undefined, 100)).items;
      expect([receipt?.fact.idempotencyKey, receipt?.fact.index, receipt?.fact.attempts, receipt?.fact.outcome.kind], ["m1", 0, 2, "delivered"], "its receipt");
    }),

    queueCase("pending: with no transport attached, a stored piece waits, and one cut short by a stop waits as a possible duplicate", async (s) => {
      const first = await s.open();
      const hanging = scripted({ "m1#0": ["hang"] });
      first.queue.attach("chat", hanging);
      await first.queue.enqueue(message("m1", "chat:1", "in flight|behind it"));
      await eventually(() => hanging.calls.length === 1, "the send in flight");
      await s.stopAll();

      const second = await s.open();
      const page = await second.queue.pending({});
      expect(
        page.items.map((p) => [p.idempotencyKey, p.index, p.state, p.attempts, p.possibleDuplicate]),
        [
          ["m1", 0, "retrying", 1, true],
          ["m1", 1, "queued", 0, false],
        ],
        "the pieces the next process holds, before a transport is attached",
      );
      check(typeof page.items[0]?.lastError === "string" && page.items[0].lastError !== "", "the interrupted piece's lastError to say why it is sent again");

      second.queue.attach("chat", scripted());
      await eventually(() => second.delivered.length === 2, "both pieces delivered once a transport is attached");
      expect((await second.queue.pending({})).items, [], "pending once they settled");
    }),

    queueCase("pending: pages, oldest stored first across conversations, with a cursor; no next on the last page", async (s) => {
      const w = await s.open();
      const hanging = scripted({ "a#0": ["hang"], "b#0": ["hang"] });
      w.queue.attach("chat", hanging);
      await w.queue.enqueue(message("a", "chat:a", "1|2|3"));
      await w.queue.enqueue(message("b", "chat:b", "4|5"));
      await eventually(() => hanging.calls.length === 2, "both conversations' heads in flight");
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await w.queue.pending({ limit: 2, ...(cursor !== undefined && { cursor }) });
        pages.push(page.items.map((p) => `${p.idempotencyKey}#${p.index}`));
        check(pages.length <= 3, "at most three pages of two for five pieces");
        cursor = page.next;
      } while (cursor !== undefined);
      expect(pages, [["a#0", "a#1"], ["a#2", "b#0"], ["b#1"]], "the pages");
      expect((await w.queue.pending({ limit: 5 })).next, undefined, "next when the page holds every piece");
      const rejected = await w.queue.pending({ cursor: "not a cursor" }).then(
        () => false,
        () => true,
      );
      check(rejected, "pending to reject a cursor it did not give");
      await s.stopAll();
    }),
  ];

  // The receipts are a feed: the feed suite holds them to `Feed`'s rules, across restarts of the queue.
  const receipts = createFeedConformance<DeliveryReceipt>(
    async () => {
      const fixture = await factory();
      const apps: App[] = [];
      const subject = createSubject(fixture, createManualClock(), apps);
      const open = async () => {
        const w = await subject.open();
        w.queue.attach("chat", scripted());
        return w;
      };
      let w = await open();
      let n = 0;
      return {
        feed: () => w.queue.receipts,
        async commit() {
          const key = `fact-${++n}`;
          await w.queue.enqueue(message(key, "chat:1", `fact ${n}`));
          await eventually(() => w.delivered.some((d) => d.key === `${key}#0`), `${key} delivered`);
          return key;
        },
        identify: (receipt) => receipt.idempotencyKey,
        async restart() {
          await subject.stopAll();
          w = await open();
        },
        async dispose() {
          for (const app of apps) await app.stop().catch(() => {});
          await fixture.dispose?.();
        },
      };
    },
    { restarts: true },
  );
  for (const c of receipts) cases.push({ group: GROUP, name: `receipts as a feed: ${c.name}`, run: c.run });

  return cases;
}

// ---------------------------------------------------------------------------------------------

type Step = "ok" | "hang" | Error;

interface Scripted extends ChannelTransport {
  /** Every send, in order, as the transport received it. */
  calls: OutboundPiece[];
  /** Sends aborted by their signal. */
  aborted: number;
}

/** A transport that splits on `|` and answers each piece's sends by `script[key]`, in order; then "ok". */
function scripted(script: Record<string, Step[]> = {}, idempotent = false): Scripted {
  const left = new Map(Object.entries(script).map(([key, steps]) => [key, [...steps]]));
  const transport: Scripted = {
    idempotent,
    calls: [],
    aborted: 0,
    split: (text) => text.split("|"),
    send(piece, signal) {
      transport.calls.push({ ...piece });
      const step = left.get(piece.key)?.shift() ?? "ok";
      if (step === "ok") return Promise.resolve({ platformMessageId: `platform-${transport.calls.length}` });
      if (step instanceof Error) return Promise.reject(step);
      return new Promise((_, reject) => {
        const abort = () => {
          transport.aborted++;
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  return transport;
}

const transient = () => new DeliveryError("transient", "503 from the platform");

function message(key: string, conversationKey: string, text: string, channel = "chat"): OutboundMessage {
  return { idempotencyKey: key, channel, conversationKey, text };
}

/** What a pending piece shows, but when it is due and why it last failed (checked on their own). */
function shown({ nextAttemptAt: _due, lastError: _error, ...rest }: PendingPiece): Omit<PendingPiece, "nextAttemptAt" | "lastError"> {
  return rest;
}

/** Polls `condition` in real time: the queue's work is asynchronous even when the clock stands still. */
async function eventually(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${GROUP}: expected ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface Worker {
  queue: OutboundQueue;
  delivered: AppEvents["outbound.delivered"][];
  abandoned: AppEvents["outbound.abandoned"][];
  /** Every send any transport of this worker received, counted by the events and failures seen. */
  attempts(): number;
}

interface Subject {
  clock: ManualClock;
  /** Starts a new app (a process) over the fixture's records. */
  open(): Promise<Worker>;
  /** Stops every app started so far, as a process that exits: within a short stop deadline. */
  stopAll(): Promise<void>;
}

function createSubject(fixture: OutboundQueueFixture, clock: ManualClock, apps: App[]): Subject {
  return {
    clock,
    async open() {
      let queue: OutboundQueue | undefined;
      const delivered: AppEvents["outbound.delivered"][] = [];
      const abandoned: AppEvents["outbound.abandoned"][] = [];
      const observer = defineComponent({
        name: "outbound-queue-conformance",
        setup(pikit) {
          const handle = pikit.use("outbound.queue");
          pikit.on("outbound.delivered", (payload) => void delivered.push(payload));
          pikit.on("outbound.abandoned", (payload) => void abandoned.push(payload));
          return { start: () => void (queue = handle.get()) };
        },
      });
      const app = await defineApp({
        components: [...fixture.components, observer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
        clock,
      }).create();
      apps.push(app);
      await app.start();
      if (queue === undefined) throw new Error(`${GROUP}: outbound.queue was not resolved`);
      const attached: Scripted[] = [];
      const original = queue;
      const tracked: OutboundQueue = {
        receipts: original.receipts,
        pending: (page) => original.pending(page),
        enqueue: (m) => original.enqueue(m),
        attach(channel, transport) {
          attached.push(transport as Scripted);
          original.attach(channel, transport);
        },
        detach: (channel, signal) => original.detach(channel, signal),
      };
      return { queue: tracked, delivered, abandoned, attempts: () => attached.reduce((n, t) => n + t.calls.length, 0) };
    },
    async stopAll() {
      // A process that exits has a stop deadline (SPEC K2): a send still hanging is aborted, and
      // the stop is reported as late. The process exits all the same.
      for (const app of apps.splice(0)) await app.stop(withAbortSignal(AbortSignal.timeout(200), BACKGROUND_CONTEXT)).catch(() => {});
    },
  };
}
