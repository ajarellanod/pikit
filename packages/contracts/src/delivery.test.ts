/**
 * `startAnswerDelivery` on its own: a memory feed, `storage.kv` in memory, a platform whose transport
 * the test controls (a text's pieces are separated by `|`), driven by a timer or by `wakeups`. The
 * channels' tests and the channel suite (`@pikit/contracts/testing`) run it inside real channels.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, defineApp, defineComponent, type Logger } from "@pikit/core";
import { type AnswerDelivery, type DeliveryPolicy, startAnswerDelivery } from "./delivery.ts";
import { type ChannelTransport, DeliveryError, type OutboundPiece, type OutboundQueue } from "./outbound.ts";
import type { KeyValueStore } from "./storage.ts";
import type { RunSettlement } from "./submissions.ts";
import type { Wakeups } from "./wakeups.ts";
import { createMemoryFeed, type MemoryFeed } from "./testing/feed.ts";
import { createMemoryKeyValueStorage } from "./testing/storage-kv.ts";
import { createMemoryWakeups } from "./testing/wakeups.ts";

const POLICY: DeliveryPolicy = { retryMs: [20, 40], blockedAfter: 3, window: 200, piecesPerRun: 20, sendTimeoutMs: 1_000 };

function answer(chat: string, requestId: string, text = `to ${requestId}`): RunSettlement {
  return { conversation: { key: chat, agent: "assistant", conversationId: `s-${chat}` }, requestId, requestIds: [requestId], kind: "completed", text };
}

/** A platform whose sends the test scripts per conversation: `ok`, an error, or `hang` (it got the piece, and never answers). */
function fakePlatform() {
  const sent: OutboundPiece[] = [];
  const script = new Map<string, (Error | "hang" | "ok")[]>();
  const transport: ChannelTransport = {
    idempotent: true,
    split: (text) => text.split("|"),
    async send(piece, signal) {
      const next = script.get(piece.conversationKey)?.shift();
      if (next === "hang") {
        sent.push(piece);
        return await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (next instanceof Error) throw next;
      sent.push(piece);
      return { platformMessageId: String(sent.length) };
    },
  };
  return {
    transport,
    sent,
    texts: (chat: string) => sent.filter((p) => p.conversationKey === chat).map((p) => p.text),
    script(chat: string, ...steps: (Error | "hang" | "ok")[]) {
      script.set(chat, [...(script.get(chat) ?? []), ...steps]);
    },
  };
}

function recordingLogger(): Logger & { lines: { level: string; message: string; fields: unknown }[] } {
  const lines: { level: string; message: string; fields: unknown }[] = [];
  const log = (level: string) => (message: string, fields?: unknown) => void lines.push({ level, message, fields });
  return { debug() {}, info() {}, warn: log("warn"), error: log("error"), lines };
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

const apps: App[] = [];
const deliveries: AnswerDelivery[] = [];
afterEach(async () => {
  for (const delivery of deliveries.splice(0)) await delivery.stop();
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

interface HarnessOptions {
  feed?: MemoryFeed<RunSettlement>;
  store?: KeyValueStore;
  platform?: ReturnType<typeof fakePlatform>;
  queue?: OutboundQueue;
  wakeups?: boolean;
  policy?: Partial<DeliveryPolicy>;
  /** A slice deadline for each wakeup run: its context is cancelled after this long. */
  sliceMs?: number;
}

/** Delivery for the conversations `chat:*`, through the instance `chat`, started in an App of its own. */
async function harness(options: HarnessOptions = {}) {
  const feed = options.feed ?? createMemoryFeed<RunSettlement>();
  const store = options.store ?? createMemoryKeyValueStorage().namespace("channel-test");
  const platform = options.platform ?? fakePlatform();
  const logger = recordingLogger();
  const seen: { wakeups?: Wakeups } = {};
  const sliced = (wakeups: Wakeups): Wakeups => ({
    ...wakeups,
    // As a Durable Object's provider does: the handler's context is cancelled at the slice's deadline.
    handle: (name, handler) =>
      wakeups.handle(name, (ctx) => {
        if (options.sliceMs === undefined) return handler(ctx);
        const cut = new AbortController();
        setTimeout(() => cut.abort(new Error("the slice deadline passed")), options.sliceMs);
        return handler(ctx.derive((inner) => ({ abortSignal: cut.signal, value: (key) => inner.value(key), toString: () => `${inner}.Slice` })));
      }),
  });
  const user = defineComponent({
    name: "wakeups-user",
    setup(pikit) {
      const wakeups = pikit.use("wakeups");
      return { start: () => void (seen.wakeups = sliced(wakeups.get())) };
    },
  });
  const app = await defineApp({ components: options.wakeups ? [createMemoryWakeups({ retryMs: 20 }), user] : [], logger }).create();
  apps.push(app);
  await app.start();
  const ctx: AppContext = app.context();
  const delivery = await startAnswerDelivery(ctx, {
    name: "channel-test",
    answers: feed.feed,
    store,
    transports: new Map([["chat", platform.transport]]),
    route: (key) => (key.startsWith("chat:") ? "chat" : undefined),
    text: (fact) => (fact.text === "" ? undefined : fact.text),
    queue: options.queue,
    wakeups: seen.wakeups,
    policy: { ...POLICY, ...options.policy },
  });
  deliveries.push(delivery);
  return { feed, store, platform, logger, delivery, ctx, wake: () => delivery.wake(ctx) };
}

test("each answer of its conversations is sent once, in order, with its key; others' are passed over and the cursor moves past them all", async () => {
  const h = await harness();
  h.feed.append(answer("chat:1", "r1", "one|two"));
  h.feed.append(answer("http:1", "h1"));
  h.feed.append(answer("chat:1", "r2", ""));
  const last = h.feed.append(answer("chat:1", "r3"));
  await h.wake();

  await until(async () => (await h.store.get("answers-cursor")) === last, "the cursor at the end");
  expect(h.platform.sent).toEqual([
    { key: "s-chat:1:r1#0", conversationKey: "chat:1", text: "one", possibleDuplicate: false },
    { key: "s-chat:1:r1#1", conversationKey: "chat:1", text: "two", possibleDuplicate: false },
    { key: "s-chat:1:r3#0", conversationKey: "chat:1", text: "to r3", possibleDuplicate: false },
  ]);
  // Once the cursor is past them, their marks are gone.
  await until(async () => (await h.store.get("answer:s-chat:1:r3")) === undefined, "the marks deleted");
  expect(await h.store.get("piece:s-chat:1:r1#0")).toBeUndefined();
  await h.wake();
  await Bun.sleep(30);
  expect(h.platform.sent).toHaveLength(3);
});

test("an answer that ended before the delivery started is delivered at start, from the feed's oldest answer", async () => {
  const feed = createMemoryFeed<RunSettlement>();
  feed.append(answer("chat:1", "while-stopped"));
  const h = await harness({ feed });
  await until(() => h.platform.sent.length === 1, "the answer");
  expect(h.platform.texts("chat:1")).toEqual(["to while-stopped"]);
});

test("a conversation whose answer cannot be delivered holds up only itself, and the cursor never passes that answer", async () => {
  const h = await harness();
  h.platform.script("chat:1", new DeliveryError("transient", "unreachable"), new DeliveryError("transient", "unreachable"), new DeliveryError("transient", "unreachable"));
  h.feed.append(answer("chat:1", "a1"));
  h.feed.append(answer("chat:2", "b1"));
  h.feed.append(answer("chat:1", "a2"));
  const end = h.feed.append(answer("chat:2", "b2"));
  await h.wake();

  await until(() => h.platform.texts("chat:2").length === 2, "chat 2's answers");
  await until(() => h.logger.lines.some((line) => line.level === "error"), "the blocked answer's error");
  expect(h.platform.texts("chat:1")).toEqual([]);
  expect(await h.store.get("answers-cursor")).toBeUndefined();
  expect(h.logger.lines.find((line) => line.level === "error")?.fields).toMatchObject({ conversation: "chat:1", run: "a1", failures: 3 });

  // Chat 1 recovers: its answers in order, and the cursor at the end; chat 2's are not sent again.
  await until(() => h.platform.texts("chat:1").length === 2, "chat 1's answers");
  expect(h.platform.texts("chat:1")).toEqual(["to a1", "to a2"]);
  await until(async () => (await h.store.get("answers-cursor")) === end, "the cursor at the end");
  expect(h.platform.texts("chat:2")).toEqual(["to b1", "to b2"]);
});

test("a rate limit waits what the platform asked and is no failure; a permanent refusal is logged, given up, and passed", async () => {
  const h = await harness({ policy: { retryMs: [5_000] } });
  h.platform.script("chat:1", new DeliveryError("rate_limited", "too many", { retryAfterMs: 50 }));
  h.platform.script("chat:2", new DeliveryError("permanent", "blocked by the user"));
  h.feed.append(answer("chat:1", "r1"));
  const end = h.feed.append(answer("chat:2", "r2"));
  const started = Date.now();
  await h.wake();

  await until(() => h.platform.texts("chat:1").length === 1, "the rate-limited answer", 2_000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  await until(async () => (await h.store.get("answers-cursor")) === end, "the cursor past the refused answer");
  expect(h.platform.texts("chat:2")).toEqual([]);
  // The two conversations' lanes go at the same time: their lines in either order.
  expect(h.logger.lines.map((line) => [line.level, line.message]).sort()).toEqual([
    ["error", "channel-test: the platform refused an answer for good; it is not sent"],
    ["warn", "channel-test: delivering an answer failed; trying again"],
  ]);
  expect(h.logger.lines.find((line) => line.level === "warn")?.fields).toMatchObject({ conversation: "chat:1", failures: 0 });
});

test("a send cut by a stop may have arrived: the next delivery sends it again once, marked, with the same key; a piece sent is never sent again", async () => {
  const store = createMemoryKeyValueStorage().namespace("channel-test");
  const feed = createMemoryFeed<RunSettlement>();
  const platform = fakePlatform();
  platform.script("chat:1", "ok", "hang");
  const first = await harness({ store, feed, platform });
  feed.append(answer("chat:1", "r1", "sent|cut|later"));
  await first.wake();
  await until(() => platform.sent.length === 2, "the second piece in flight");
  await first.delivery.stop();
  expect(await store.get("piece:s-chat:1:r1#1")).toBe("sending");

  await harness({ store, feed, platform });
  await until(() => platform.sent.length === 4, "the rest");
  expect(platform.sent.map(({ key, text, possibleDuplicate }) => [key, text, possibleDuplicate])).toEqual([
    ["s-chat:1:r1#0", "sent", false],
    ["s-chat:1:r1#1", "cut", false],
    ["s-chat:1:r1#1", "cut", true],
    ["s-chat:1:r1#2", "later", false],
  ]);
});

test("a send that times out may have arrived too; one refused before it left goes again unmarked", async () => {
  const h = await harness({ policy: { sendTimeoutMs: 30 } });
  h.platform.script("chat:1", "hang");
  h.feed.append(answer("chat:1", "r1"));
  await h.wake();
  await until(() => h.platform.sent.length === 2, "the answer again after the timeout");
  expect(h.platform.sent.map((p) => p.possibleDuplicate)).toEqual([false, true]);

  h.platform.script("chat:2", new DeliveryError("transient", "502 Bad Gateway"));
  h.feed.append(answer("chat:2", "r2"));
  await h.wake();
  await until(() => h.platform.texts("chat:2").length === 1, "the refused answer");
  expect(h.platform.sent.at(-1)?.possibleDuplicate).toBe(false);
});

test("an answer delivered past a stuck one is not delivered again by a later run, nor after a restart", async () => {
  const store = createMemoryKeyValueStorage().namespace("channel-test");
  const feed = createMemoryFeed<RunSettlement>();
  const platform = fakePlatform();
  platform.script("chat:1", ...Array.from({ length: 50 }, () => new DeliveryError("transient", "down")));
  const first = await harness({ store, feed, platform, policy: { retryMs: [10] } });
  feed.append(answer("chat:1", "stuck"));
  feed.append(answer("chat:2", "past-it"));
  await first.wake();
  await until(() => platform.texts("chat:2").length === 1, "the answer past the stuck one");
  await Bun.sleep(60);
  await first.delivery.stop();

  await harness({ store, feed, platform, policy: { retryMs: [10] } });
  await Bun.sleep(60);
  expect(platform.texts("chat:2")).toEqual(["to past-it"]);
  expect(await store.get("answers-cursor")).toBeUndefined();
});

test("with outbound.queue: enqueued under the answer's key, the transports attached while it runs; an enqueue that failed is tried again", async () => {
  const enqueued: string[] = [];
  const attached: string[] = [];
  let failures = 1;
  const queue: OutboundQueue = {
    async enqueue(message) {
      enqueued.push(`${message.channel} ${message.idempotencyKey} ${message.text}`);
      if (failures-- > 0) throw new Error("disk full");
    },
    attach: (channel) => void attached.push(`attach ${channel}`),
    detach: async (channel) => void attached.push(`detach ${channel}`),
    receipts: createMemoryFeed<never>().feed,
  };
  const h = await harness({ queue });
  expect(attached).toEqual(["attach chat"]);
  const end = h.feed.append(answer("chat:1", "r1"));
  await h.wake();

  await until(async () => (await h.store.get("answers-cursor")) === end, "the cursor past the enqueued answer");
  expect(enqueued).toEqual(["chat s-chat:1:r1 to r1", "chat s-chat:1:r1 to r1"]);
  expect(h.platform.sent).toEqual([]);
  await h.delivery.stop();
  expect(attached).toEqual(["attach chat", "detach chat"]);
});

test("each gap is reported once, with the cursor it was read after", async () => {
  const h = await harness();
  const gaps = () => h.logger.lines.filter((line) => line.message.includes("pruned")).map((line) => line.fields);
  const one = h.feed.append(answer("chat:1", "r1"));
  await h.wake();
  await until(async () => (await h.store.get("answers-cursor")) === one, "r1 delivered and saved");

  h.feed.append(answer("chat:1", "r2"));
  h.feed.prune();
  await h.wake();
  await until(() => gaps().length === 1, "the first gap");
  const three = h.feed.append(answer("chat:1", "r3"));
  await h.wake();
  await until(async () => (await h.store.get("answers-cursor")) === three, "r3 delivered and saved");
  await h.wake();
  await Bun.sleep(20);
  expect(gaps()).toEqual([{ after: one }]);
  expect(h.platform.texts("chat:1")).toEqual(["to r1", "to r3"]);
});

test("when storage fails, the delivery waits and tries again", async () => {
  const real = createMemoryKeyValueStorage().namespace("channel-test");
  let failGets = 1;
  const store: KeyValueStore = {
    ...real,
    get: async (key) => {
      if (failGets-- > 0) throw new Error("database is locked");
      return real.get(key);
    },
  };
  const feed = createMemoryFeed<RunSettlement>();
  feed.append(answer("chat:1", "r1"));
  const h = await harness({ store, feed });
  await until(() => h.platform.sent.length === 1, "the answer after the retry");
  expect(h.logger.lines.map((line) => line.message)).toEqual(["channel-test: reading answers or saving the cursor failed; trying again"]);
});

test("with wakeups, every run is a wakeup: it sends at most piecesPerRun pieces and asks for the next one at once", async () => {
  const h = await harness({ wakeups: true, policy: { piecesPerRun: 2 } });
  const end = h.feed.append(answer("chat:1", "r1", "a|b|c|d|e"));
  await h.wake();
  await until(async () => (await h.store.get("answers-cursor")) === end, "the whole answer, over three runs");
  expect(h.platform.texts("chat:1")).toEqual(["a", "b", "c", "d", "e"]);
});

test("with wakeups, a run cut by its slice deadline mid-send asks for the next, which sends the piece again, marked", async () => {
  const h = await harness({ wakeups: true, sliceMs: 50 });
  h.platform.script("chat:1", "hang");
  const end = h.feed.append(answer("chat:1", "r1"));
  await h.wake();
  await until(async () => (await h.store.get("answers-cursor")) === end, "the answer, in the next run");
  expect(h.platform.sent.map((p) => [p.key, p.possibleDuplicate])).toEqual([
    ["s-chat:1:r1#0", false],
    ["s-chat:1:r1#0", true],
  ]);
});
