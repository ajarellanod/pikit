/**
 * platform-cloudflare on real Durable Objects.
 *
 * - The `wakeups` suite, with the slice deadline and a restart over the same storage, on a real
 *   object's SQLite. The suite owns a manual clock and a real alarm fires on the real one, so there
 *   the alarm is `simulatedObject`'s, on the app's clock (the component's test support).
 * - The `actor.mailbox` and `actor.inbox` suite from the Worker's App, over the real `CONVERSATION`
 *   binding: each key is a real object (`ConversationDouble`, with deployment-cloudflare's interface),
 *   reached by RPC, whose actor also sends to another and wakes itself by the object's real alarm.
 * - Then the real alarm: `at` and `cancel` set it, `runDurableObjectAlarm` fires it through the
 *   object's `alarm()`, and it survives an eviction; the slice, the backoff, a request waiting for its
 *   handler; and an object's own mailbox.
 *
 * The clock of the real-alarm tests runs a day ahead when a test says so: a request asked for a day
 * later sets a real alarm the runtime will not fire by itself, and the test fires it when it is due.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type AppContext, type Clock, defineComponent, systemClock } from "@pikit/core";
import { type ActorMailbox, type JsonValue, type WakeupHandler, type Wakeups, WORKERS_HOST } from "@pikit/contracts";
import { createMailboxConformance, createWakeupsConformance, withWorkersHost } from "@pikit/contracts/testing";
import { afterEach, expect, it, vi } from "vitest";
import platformCloudflare, { BACKOFF_MS, WAKEUPS_TABLE } from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import { simulatedObject } from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/object.test-support.ts";
import { type ConversationDouble, composeObjects, stopObjects } from "../src/worker.ts";
import { inObject, objectHost, workerEnv } from "./host.ts";

const SLICE_MS = 90_000;
const DAY = 24 * 60 * 60 * 1_000;

for (const c of createWakeupsConformance(
  () => {
    const object = simulatedObject((objectHost().object?.storage as DurableObjectStorage).sql);
    return {
      components: [...withWorkersHost(object.host, [platformCloudflare]), object.component],
      config: { "platform-cloudflare": { sliceMs: SLICE_MS } },
    };
  },
  { backoffMs: BACKOFF_MS, sliceMs: SLICE_MS, durable: true },
)) {
  it(`platform-cloudflare ${c.group}: ${c.name}`, () => inObject(c));
}

// Where the actors run, platform-cloudflare also provides wakeups: the suite's actor wakes itself by the real alarm.
for (const c of createMailboxConformance(
  (inbox) => {
    composeObjects({ components: [platformCloudflare, inbox] });
    return { components: withWorkersHost({ env: workerEnv }, [platformCloudflare]), dispose: stopObjects };
  },
  { wakeups: true },
)) {
  it(`platform-cloudflare ${c.group}: ${c.name}`, () => c.run());
}

afterEach(() => stopObjects());

/** A clock `ahead` ms ahead of the real one. */
function aheadClock(): Clock & { ahead: number } {
  const clock = { ahead: 0, now: () => Date.now() + clock.ahead, sleep: systemClock.sleep };
  return clock;
}

/** What the objects' owner of wakeups registers; `wakeups` is the last object App's. */
const owner = (handlers: Record<string, WakeupHandler>) => {
  const seen: { wakeups?: Wakeups } = {};
  const component = defineComponent({
    name: "test-owner",
    setup(pikit) {
      const handle = pikit.use("wakeups");
      return {
        start() {
          seen.wakeups = handle.get();
          for (const [name, handler] of Object.entries(handlers)) seen.wakeups.handle(name, handler);
        },
      };
    },
  });
  return { component, seen };
};

/** Runs `work` inside the object `stub` with its App open. */
const inside = <R>(stub: DurableObjectStub<ConversationDouble>, work: (ctx: AppContext, storage: DurableObjectStorage) => Promise<R>): Promise<R> =>
  runInDurableObject(stub, async (instance: ConversationDouble, state) => {
    const { app } = await instance.open();
    return work(app.context(), state.storage);
  });

const rowsOf = (storage: DurableObjectStorage) => storage.sql.exec(`SELECT name, time, failures FROM ${WAKEUPS_TABLE} ORDER BY name`).toArray();

const newObject = () => env.CONVERSATION.get(env.CONVERSATION.newUniqueId());

it("at and cancel set the object's real alarm to the earliest handled request; the alarm runs what is due, and the row goes", async () => {
  const clock = aheadClock();
  const runs: string[] = [];
  const { component, seen } = owner({ a: async () => void runs.push("a"), b: async () => void runs.push("b") });
  composeObjects({ components: [platformCloudflare, component], clock });
  const stub = newObject();
  const time = clock.now() + DAY;
  await inside(stub, async (ctx, storage) => {
    const wakeups = seen.wakeups as Wakeups;
    await wakeups.at("a", time, ctx);
    expect(await storage.getAlarm()).toBe(Math.ceil(time));
    await wakeups.at("b", time - 1_000, ctx);
    expect(await storage.getAlarm()).toBe(Math.ceil(time - 1_000));
    await wakeups.cancel("b", ctx);
    expect(await storage.getAlarm()).toBe(Math.ceil(time));
  });
  // Early, the alarm runs nothing and is set again.
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(runs).toEqual([]);
  clock.ahead = DAY;
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(runs).toEqual(["a"]);
  await inside(stub, async (_ctx, storage) => {
    expect(await storage.getAlarm()).toBeNull();
    expect(rowsOf(storage)).toEqual([]);
  });
});

it("a request survives the object's eviction and a lost alarm: the next App sets the alarm again from the rows, and runs it", async () => {
  const clock = aheadClock();
  const runs: string[] = [];
  const { component, seen } = owner({ a: async () => void runs.push("a") });
  composeObjects({ components: [platformCloudflare, component], clock });
  const stub = newObject();
  const time = clock.now() + DAY;
  await inside(stub, async (ctx, storage) => {
    await seen.wakeups?.at("a", time, ctx);
    await storage.deleteAlarm(); // as a reset might lose it
  });
  await evictDurableObject(stub);
  // A new instance, a new App: its start sets the alarm again.
  await inside(stub, async (_ctx, storage) => expect(await storage.getAlarm()).toBe(Math.ceil(time)));
  await evictDurableObject(stub);
  clock.ahead = DAY;
  // The alarm constructs the object again, whose App runs the request.
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(runs).toEqual(["a"]);
});

it("a request whose name has no handler stays in the table and sets no alarm; once the handler registers, the alarm runs it", async () => {
  const clock = aheadClock();
  const { component, seen } = owner({});
  composeObjects({ components: [platformCloudflare, component], clock });
  const stub = newObject();
  const time = clock.now() + DAY;
  const runs: string[] = [];
  await inside(stub, async (ctx, storage) => {
    await seen.wakeups?.at("late", time, ctx);
    expect(await storage.getAlarm()).toBeNull();
    expect(rowsOf(storage)).toEqual([{ name: "late", time, failures: 0 }]);
    seen.wakeups?.handle("late", async () => void runs.push("late"));
    await vi.waitFor(async () => expect(await storage.getAlarm()).toBe(Math.ceil(time)));
  });
  clock.ahead = DAY;
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(runs).toEqual(["late"]);
});

it("a handler that fails gets a backoff row and the real alarm moves to its retry", async () => {
  const clock = aheadClock();
  const { component, seen } = owner({
    flaky: async () => {
      throw new Error("the model provider is busy");
    },
  });
  composeObjects({ components: [platformCloudflare, component], clock });
  const stub = newObject();
  await inside(stub, (ctx) => seen.wakeups?.at("flaky", clock.now() + DAY, ctx) as Promise<void>);
  clock.ahead = DAY;
  const before = clock.now();
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await inside(stub, async (_ctx, storage) => {
    const [row] = rowsOf(storage) as { name: string; time: number; failures: number }[];
    expect(row?.failures).toBe(1);
    expect(row?.time).toBeGreaterThanOrEqual(before + BACKOFF_MS[0]);
    // The failure's time plus the first wait: now, read after it, may be the same millisecond.
    expect(row?.time).toBeLessThanOrEqual(clock.now() + BACKOFF_MS[0]);
    expect(await storage.getAlarm()).toBe(Math.ceil(row?.time as number));
  });
});

it("the slice deadline cancels the running handler's context in a real alarm; it asks again and the next alarm continues", async () => {
  const sliceMs = 200;
  const runs: { cutAfterMs?: number; reason?: string }[] = [];
  let wakeups: Wakeups | undefined;
  const { component, seen } = owner({
    long: async (ctx) => {
      if (runs.push({}) > 1) return;
      const began = Date.now();
      await new Promise<void>((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
      runs[0] = { cutAfterMs: Date.now() - began, reason: String(ctx.abortSignal?.reason) };
      await wakeups?.at("long", ctx.clock.now(), ctx);
    },
  });
  composeObjects({ components: [platformCloudflare, component], config: { "platform-cloudflare": { sliceMs } } });
  const stub = newObject();
  await inside(stub, async (ctx) => {
    wakeups = seen.wakeups;
    await wakeups?.at("long", ctx.clock.now() - 1, ctx);
  });
  // Due at once: the runtime may fire it first; one alarm runs at a time either way.
  await runDurableObjectAlarm(stub);
  // The second alarm, due at once, is fired by the runtime or here.
  await vi.waitFor(async () => {
    await runDurableObjectAlarm(stub);
    expect(runs.length).toBe(2);
  });
  expect(runs[0]?.cutAfterMs).toBeGreaterThanOrEqual(sliceMs - 5);
  expect(runs[0]?.reason).toContain(`slice deadline (${sliceMs} ms)`);
});

it("in an object, actor.mailbox delivers to its own key locally and to any other key by RPC to that key's object", async () => {
  const received: { key: string; message: JsonValue; object: string | undefined }[] = [];
  const inbox = defineComponent({
    name: "test-inbox",
    setup(pikit) {
      const handle = pikit.use("actor.inbox");
      return {
        start: () =>
          handle.get().handle("test.message", async (key, message, ctx) => {
            received.push({ key, message, object: ctx.value(WORKERS_HOST)?.object?.id });
          }),
      };
    },
  });
  let mailbox: ActorMailbox | undefined;
  const sender = defineComponent({
    name: "test-sender",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  composeObjects({ components: [platformCloudflare, inbox, sender] });
  const [a, b] = ["conv-a", "conv-b"].map((name) => env.CONVERSATION.idFromName(name));
  await runInDurableObject(env.CONVERSATION.get(a as DurableObjectId), async (instance: ConversationDouble) => {
    const { app } = await instance.open();
    await mailbox?.send("conv-a", "test.message", "to myself", app.context());
    await mailbox?.send("conv-b", "test.message", { to: ["another"] }, app.context());
  });
  expect(received).toEqual([
    { key: "conv-a", message: "to myself", object: a?.toString() },
    { key: "conv-b", message: { to: ["another"] }, object: b?.toString() },
  ]);
});
