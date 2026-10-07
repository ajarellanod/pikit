/**
 * outbound-durable in deployment-cloudflare's real `Conversation` class (`PlatformConversation`), over
 * storage-do and platform-cloudflare's `wakeups`: its retries are the object's alarm, so a piece whose
 * send failed, or was cut by the slice's deadline, is sent again after the object was evicted, with
 * no new message.
 *
 * `Date` (the apps' clock) runs a day ahead, so the alarms the outbox asks for never fire on their own:
 * the test fires each one, and evicts the object between two (AGENTS.md, the workerd lesson).
 */

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { defineComponent } from "@pikit/core";
import { type ChannelTransport, DeliveryError, type OutboundPiece, type OutboundQueue } from "@pikit/contracts";
import { afterEach, expect, it, vi } from "vitest";
import outboundDurable from "../../../registry/components/outbound-durable/files/src/pikit/outbound-durable/index.ts";
import { BACKOFF_MS } from "../../../registry/components/outbound-durable/files/src/pikit/outbound-durable/queue.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects } from "../src/platform.ts";
import { resetObjects } from "./host.ts";

const DAY = 24 * 60 * 60 * 1_000;

afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

/**
 * A channel's object half: attaches `transport` at start, as `startAnswerDelivery` does. The queue is
 * the last instance's (the tests and the objects share one isolate).
 */
function channel(transport: ChannelTransport) {
  const seen: { queue?: OutboundQueue } = {};
  const component = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const queue = pikit.use("outbound.queue");
      return {
        start() {
          seen.queue = queue.get();
          seen.queue.attach("chat", transport);
        },
      };
    },
  });
  return { component, seen };
}

/** What a test calls on the class: its `health` RPC starts the object's App. */
type Started = { health(): Promise<{ ok: true }> };

/** Starts a new object's App and enqueues one answer there. */
async function enqueueInNewObject(seen: { queue?: OutboundQueue }): Promise<DurableObjectStub> {
  const stub = env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.newUniqueId());
  await runInDurableObject(stub, async (instance: DurableObject) => {
    await (instance as unknown as Started).health();
    await seen.queue?.enqueue({ idempotencyKey: "c1:r1", channel: "chat", conversationKey: "chat:1", text: "the answer" });
  });
  return stub;
}

const pieces = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_instance, state) => state.storage.sql.exec("SELECT key, state, attempts, possible_duplicate FROM outbound_pieces").toArray());

const alarmOf = (stub: DurableObjectStub) => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

it("a send that failed is retried by the object's alarm, after the object was evicted, with no new message", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const sends: OutboundPiece[] = [];
  const { component, seen } = channel({
    idempotent: false,
    split: (text) => [text],
    async send(piece) {
      sends.push(piece);
      if (sends.length === 1) throw new DeliveryError("transient", "503 from the platform");
      return { platformMessageId: `p${sends.length}` };
    },
  });
  composeObjects([storageDo, platformCloudflare, outboundDurable, component]);
  const stub = await enqueueInNewObject(seen);

  // The first alarm sends, and the platform fails: the retry is the object's next alarm.
  const before = Date.now();
  await runDurableObjectAlarm(stub);
  expect(sends.map((p) => p.key)).toEqual(["c1:r1#0"]);
  const retryAt = await alarmOf(stub);
  expect(retryAt).toBeGreaterThanOrEqual(before + BACKOFF_MS[0]);
  expect(retryAt).toBeLessThanOrEqual(Date.now() + BACKOFF_MS[0] + 1);

  // Between two alarms: the instance goes; the piece and the request stay in its storage.
  await evictDurableObject(stub);
  vi.setSystemTime(Date.now() + BACKOFF_MS[0]);
  // The alarm constructs the object again; its App starts and the outbox's handler sends.
  await runDurableObjectAlarm(stub);

  expect(sends.map((p) => [p.key, p.text, p.possibleDuplicate])).toEqual([
    ["c1:r1#0", "the answer", false],
    ["c1:r1#0", "the answer", false],
  ]);
  expect(await pieces(stub)).toEqual([{ key: "c1:r1#0", state: "delivered", attempts: 2, possible_duplicate: 0 }]);
  // Nothing left to wake for.
  expect(await alarmOf(stub)).toBeNull();
});

it("a send cut by the slice's deadline is sent again by the next alarm, after an eviction, as a possible duplicate", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const sends: OutboundPiece[] = [];
  const { component, seen } = channel({
    idempotent: false,
    split: (text) => [text],
    send(piece, signal) {
      sends.push(piece);
      if (sends.length > 1) return Promise.resolve({ platformMessageId: "p2" });
      // The platform never answers: only the slice's deadline ends the send.
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  composeObjects([storageDo, platformCloudflare, outboundDurable, component], { "platform-cloudflare": { sliceMs: 200 } });
  const stub = await enqueueInNewObject(seen);

  await runDurableObjectAlarm(stub);
  expect(sends).toHaveLength(1);
  expect(await pieces(stub)).toEqual([{ key: "c1:r1#0", state: "pending", attempts: 1, possible_duplicate: 1 }]);
  // It asked for the next run at once: a day ahead of the real clock, so the runtime leaves it to the test.
  expect(await alarmOf(stub)).not.toBeNull();

  await evictDurableObject(stub);
  await runDurableObjectAlarm(stub);

  expect(sends.map((p) => [p.key, p.possibleDuplicate])).toEqual([
    ["c1:r1#0", false],
    ["c1:r1#0", true],
  ]);
  expect(await pieces(stub)).toEqual([{ key: "c1:r1#0", state: "delivered", attempts: 2, possible_duplicate: 1 }]);
});
