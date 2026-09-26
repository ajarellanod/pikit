/**
 * `outbound.queue` conformance (SPEC §5 "Outbound delivery", §14): what every queue must do, wherever
 * it keeps its records. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createOutboundQueueConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite owns the clock (`createManualClock`), so retries are checked to the millisecond without
 * waiting, and the transport, which it scripts: a piece's send succeeds, fails with a given kind, or
 * hangs until aborted. It observes only the capability and the `outbound.*` events.
 */

import { type App, type ComponentDefinition, defineApp, defineComponent } from "../app.ts";
import { silentLogger } from "../contracts/logger.ts";
import {
  type ChannelTransport,
  DeliveryError,
  type OutboundMessage,
  type OutboundPiece,
  type OutboundQueue,
} from "../contracts/outbound.ts";
import type { AppEvents } from "../events.ts";
import { checker, expecter } from "./assert.ts";
import type { ConformanceCase } from "./lifecycle.ts";
import { createManualClock, type ManualClock } from "./manual-clock.ts";

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
/** SPEC §5: the waits after each transient failure; the fifth failure abandons. */
const BACKOFF = [5 * SECOND, 30 * SECOND, 2 * MINUTE, 10 * MINUTE];
const DAY = 24 * 60 * MINUTE;

export function createOutboundQueueConformance(factory: () => OutboundQueueFixture | Promise<OutboundQueueFixture>): readonly ConformanceCase[] {
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

  return [
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
      await s.clock.advance(BACKOFF[0] as number);
      await eventually(() => w.delivered.some((d) => d.key === "a2#0"), "a's messages delivered after the wait");
      expect(
        transport.calls.filter((p) => p.conversationKey === "chat:a").map((p) => p.key),
        ["a1#0", "a1#0", "a2#0"],
        "a's sends: the failed one, its retry, then the next one",
      );
    }),

    queueCase("transient failures are retried after 5 s, 30 s, 2 min and 10 min, then abandoned", async (s) => {
      const w = await s.open();
      const transport = scripted({ "m1#0": Array.from({ length: 10 }, () => transient()) });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      for (const [i, wait] of BACKOFF.entries()) {
        await s.clock.advance(wait - 1);
        expect(transport.calls.length, i + 1, `attempts 1 ms before the wait of ${wait} ms ends`);
        await s.clock.advance(1);
        await eventually(() => transport.calls.length === i + 2, `attempt ${i + 2} once the wait ends`);
      }
      await eventually(() => w.abandoned.length === 1, "the piece abandoned after its fifth failure");
      expect(w.abandoned[0]?.attempts, 5, "attempts of the abandoned piece");
      await s.clock.advance(DAY);
      expect(transport.calls.length, 5, "no attempt after it was abandoned");
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

    queueCase("a piece still undelivered after 24 hours is abandoned", async (s) => {
      const w = await s.open();
      const limited = () => new DeliveryError("rate_limited", "too many requests", { retryAfterMs: 5 * 60 * MINUTE });
      const transport = scripted({ "m1#0": Array.from({ length: 20 }, limited) });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      for (let hours = 5; hours <= 30 && w.abandoned.length === 0; hours += 5) await s.clock.advance(5 * 60 * MINUTE);
      await eventually(() => w.abandoned.length === 1, "the piece abandoned for its age");
      expect(w.delivered, [], "never delivered");
    }),

    queueCase("a send that may have reached the platform is retried as a possible duplicate", async (s) => {
      const w = await s.open();
      const transport = scripted({ "m1#0": [new DeliveryError("transient", "timed out after sending", { maybeSent: true })] });
      w.queue.attach("chat", transport);
      await w.queue.enqueue(message("m1", "chat:1", "hello"));
      await eventually(() => transport.calls.length === 1, "the first attempt");
      await s.clock.advance(BACKOFF[0] as number);
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
      await s.clock.advance(BACKOFF[0] as number);
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
  ];
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

/** Polls `condition` in real time: the queue's work is asynchronous even when the clock stands still. */
async function eventually(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
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
  /** Stops every app started so far, as a process that exits. */
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
      for (const app of apps.splice(0)) await app.stop();
    },
  };
}
