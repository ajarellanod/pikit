/**
 * platform-cloudflare on real Durable Objects.
 *
 * - The `wakeups` suite, with the slice deadline and a restart over the same storage, on a real
 *   object's SQLite. The suite owns a manual clock and a real alarm fires on the real one, so there
 *   the alarm is `simulatedObject`'s, on the app's clock (the component's test support).
 * - The `actor.mailbox` and `actor.inbox` suite from the Worker's App, by RPC to deployment-cloudflare's
 *   real `Conversation` class (`PlatformConversation`, `src/platform.ts`): each key is a real object,
 *   whose actor also sends to another and wakes itself by the object's real alarm.
 * - Then, on that class, the real alarm: `at` and `cancel` set it, `runDurableObjectAlarm` fires it
 *   through the class's `alarm()`, and it survives an eviction; the slice (a handler that waits it out
 *   holds up none of the others), the backoff, a request waiting for its handler; and an object's own
 *   mailbox. The suite's calls (`call`, answered by `answer`) cross the class's `call` RPC; one more
 *   test reads an object's state by a call after its eviction.
 *
 * When a test says so, `Date` (the apps' system clock: the tests and the objects share one isolate)
 * runs a day ahead: a request asked for a day later sets a real alarm the runtime does not fire by
 * itself, and the test fires it once it is due.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorMailbox, type JsonValue, type WakeupHandler, type Wakeups } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { createMailboxConformance, createWakeupsConformance, withWorkersHost } from "@pikit/contracts/testing";
import { afterEach, expect, it, vi } from "vitest";
import platformCloudflare, { BACKOFF_MS, WAKEUPS_TABLE } from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import { simulatedObject } from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/object.test-support.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

const SLICE_MS = 90_000;
const DAY = 24 * 60 * 60 * 1_000;
/** platform-cloudflare's config in the Worker's App: the objects are `PlatformConversation`s. */
const WORKER_CONFIG = { "platform-cloudflare": { binding: PLATFORM_BINDING } };

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
    composeObjects([platformCloudflare, inbox]);
    return { components: withWorkersHost({ env: workerEnv }, [platformCloudflare]), config: WORKER_CONFIG, dispose: resetObjects };
  },
  { wakeups: true },
)) {
  it(`platform-cloudflare ${c.group}: ${c.name}`, () => c.run());
}

afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

/** From now on `Date`, the apps' clock, runs `ms` ahead of the real one. */
const ahead = (ms: number) => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms, shouldAdvanceTime: true });

/** What the objects' owner of wakeups registers; `wakeups` and `ctx` are the last object App's. */
const owner = (handlers: Record<string, WakeupHandler>) => {
  const seen: { wakeups?: Wakeups; ctx?: AppContext } = {};
  const component = defineComponent({
    name: "test-owner",
    setup(pikit) {
      const handle = pikit.use("wakeups");
      return {
        start(ctx) {
          seen.ctx = ctx;
          seen.wakeups = handle.get();
          for (const [name, handler] of Object.entries(handlers)) seen.wakeups.handle(name, handler);
        },
      };
    },
  });
  return { component, seen };
};

/** What a test calls on the class: its `health` RPC starts the object's App. */
type Started = { health(): Promise<{ ok: true }> };

/** Runs `work` inside the object `stub` once its App started, with the owner's start context. */
const inside = <R>(stub: DurableObjectStub, seen: { ctx?: AppContext }, work: (ctx: AppContext, storage: DurableObjectStorage) => Promise<R>): Promise<R> =>
  runInDurableObject(stub, async (instance: DurableObject, state) => {
    await (instance as unknown as Started).health();
    return work(seen.ctx as AppContext, state.storage);
  });

const rowsOf = (storage: DurableObjectStorage) => storage.sql.exec(`SELECT name, time, failures FROM ${WAKEUPS_TABLE} ORDER BY name`).toArray();

const newObject = () => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.newUniqueId());

it("at and cancel set the object's real alarm to the earliest handled request; the alarm runs what is due, and the row goes", async () => {
  const runs: string[] = [];
  const { component, seen } = owner({ a: async () => void runs.push("a"), b: async () => void runs.push("b") });
  composeObjects([platformCloudflare, component]);
  const stub = newObject();
  const time = Date.now() + DAY;
  await inside(stub, seen, async (ctx, storage) => {
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
  ahead(DAY);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(runs).toEqual(["a"]);
  await inside(stub, seen, async (_ctx, storage) => {
    expect(await storage.getAlarm()).toBeNull();
    expect(rowsOf(storage)).toEqual([]);
  });
});

it("a request survives the object's eviction and a lost alarm: the next App sets the alarm again from the rows, and runs it", async () => {
  const runs: string[] = [];
  const { component, seen } = owner({ a: async () => void runs.push("a") });
  composeObjects([platformCloudflare, component]);
  const stub = newObject();
  const time = Date.now() + DAY;
  await inside(stub, seen, async (ctx, storage) => {
    await seen.wakeups?.at("a", time, ctx);
    await storage.deleteAlarm(); // as a reset might lose it
  });
  await evictDurableObject(stub);
  // A new instance, a new App: its start sets the alarm again.
  await inside(stub, seen, async (_ctx, storage) => expect(await storage.getAlarm()).toBe(Math.ceil(time)));
  await evictDurableObject(stub);
  ahead(DAY);
  // The alarm constructs the object again, whose App runs the request.
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(runs).toEqual(["a"]);
});

it("a request whose name has no handler stays in the table and sets no alarm; once the handler registers, the alarm runs it", async () => {
  const { component, seen } = owner({});
  composeObjects([platformCloudflare, component]);
  const stub = newObject();
  const time = Date.now() + DAY;
  const runs: string[] = [];
  await inside(stub, seen, async (ctx, storage) => {
    await seen.wakeups?.at("late", time, ctx);
    expect(await storage.getAlarm()).toBeNull();
    expect(rowsOf(storage)).toEqual([{ name: "late", time, failures: 0 }]);
    seen.wakeups?.handle("late", async () => void runs.push("late"));
    await vi.waitFor(async () => expect(await storage.getAlarm()).toBe(Math.ceil(time)));
  });
  ahead(DAY);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(runs).toEqual(["late"]);
});

it("a handler that fails gets a backoff row and the real alarm moves to its retry", async () => {
  const { component, seen } = owner({
    flaky: async () => {
      throw new Error("the model provider is busy");
    },
  });
  composeObjects([platformCloudflare, component]);
  const stub = newObject();
  await inside(stub, seen, (ctx) => seen.wakeups?.at("flaky", Date.now() + DAY, ctx) as Promise<void>);
  ahead(DAY);
  const before = Date.now();
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await inside(stub, seen, async (_ctx, storage) => {
    const [row] = rowsOf(storage) as { name: string; time: number; failures: number }[];
    expect(row?.failures).toBe(1);
    expect(row?.time).toBeGreaterThanOrEqual(before + BACKOFF_MS[0]);
    // The failure's time plus the first wait: now, read after it, may be the same millisecond.
    expect(row?.time).toBeLessThanOrEqual(Date.now() + BACKOFF_MS[0]);
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
  composeObjects([platformCloudflare, component], { "platform-cloudflare": { sliceMs } });
  const stub = newObject();
  await inside(stub, seen, async (ctx) => {
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

it("in a real alarm, a handler that waits the whole slice does not hold up one that asks again every 100 ms: it runs throughout", async () => {
  // runtime-pi.drive waits in its wakeup while the model thinks; a channel renews "typing…" meanwhile.
  const sliceMs = 1_000;
  const ticks: number[] = [];
  let cutAt: number | undefined;
  let wakeups: Wakeups | undefined;
  const { component, seen } = owner({
    long: async (ctx) => {
      if (cutAt !== undefined) return;
      await new Promise<void>((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
      cutAt = Date.now();
    },
    tick: async (ctx) => {
      ticks.push(Date.now());
      if (cutAt === undefined) await wakeups?.at("tick", ctx.clock.now() + 100, ctx);
    },
  });
  composeObjects([platformCloudflare, component], { "platform-cloudflare": { sliceMs } });
  const stub = newObject();
  await inside(stub, seen, async (ctx) => {
    wakeups = seen.wakeups;
    await wakeups?.at("long", ctx.clock.now() - 1, ctx);
    await wakeups?.at("tick", ctx.clock.now() - 1, ctx);
  });
  // Due at once: the runtime may fire it first; one alarm runs at a time either way.
  await runDurableObjectAlarm(stub);
  await vi.waitFor(() => expect(cutAt).toBeDefined(), { timeout: 5_000 });
  const during = ticks.filter((at) => at < (cutAt as number));
  expect(during.length).toBeGreaterThanOrEqual(5);
});

it("a call reads what an object keeps, from the Worker's App, after the object was evicted; a refusal keeps its code across the RPC", async () => {
  // An actor that counts its messages in its own SQL and answers how many it holds: what a dashboard asks.
  const counter = defineComponent({
    name: "test-counter",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      return {
        start(ctx) {
          const storage = ctx.value(WORKERS_HOST)?.object?.storage as DurableObjectStorage;
          storage.sql.exec("CREATE TABLE IF NOT EXISTS test_counter (n INTEGER NOT NULL)");
          inbox.get().handle("test.count", async () => void storage.sql.exec("INSERT INTO test_counter (n) VALUES (1)"));
          inbox.get().answer("test.how-many", async (key) => {
            if (key === "nobody") throw new ActorCallError("not_found", "no such conversation");
            return { key, count: storage.sql.exec("SELECT COUNT(*) AS n FROM test_counter").one().n as number };
          });
        },
      };
    },
  });
  composeObjects([platformCloudflare, counter]);
  let mailbox: ActorMailbox | undefined;
  const caller = defineComponent({
    name: "test-caller",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [...withWorkersHost({ env: workerEnv }, [platformCloudflare]), caller], config: WORKER_CONFIG, logger: silentLogger }).create();
  await app.start();
  try {
    const send = mailbox as ActorMailbox;
    await send.send("conv-counted", "test.count", null, app.context());
    await send.send("conv-counted", "test.count", null, app.context());
    // The object goes (no alarm runs in it): its next App starts on the call, over the same SQL.
    await evictDurableObject(env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName("conv-counted")));
    expect(await send.call("conv-counted", "test.how-many", null, app.context())).toEqual({ key: "conv-counted", count: 2 });

    const refused = await send.call("nobody", "test.how-many", null, app.context()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect([(refused as ActorCallError).code, (refused as ActorCallError).message]).toEqual(["not_found", "no such conversation"]);
  } finally {
    await app.stop();
  }
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
  const seen: { mailbox?: ActorMailbox; ctx?: AppContext } = {};
  const sender = defineComponent({
    name: "test-sender",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return {
        start(ctx) {
          seen.ctx = ctx;
          seen.mailbox = handle.get();
        },
      };
    },
  });
  composeObjects([platformCloudflare, inbox, sender]);
  const [a, b] = ["conv-a", "conv-b"].map((name) => env.PLATFORM_CONVERSATION.idFromName(name));
  await inside(env.PLATFORM_CONVERSATION.get(a as DurableObjectId), seen, async (ctx) => {
    const mailbox = seen.mailbox as ActorMailbox;
    await mailbox.send("conv-a", "test.message", "to myself", ctx);
    await mailbox.send("conv-b", "test.message", { to: ["another"] }, ctx);
  });
  expect(received).toEqual([
    { key: "conv-a", message: "to myself", object: a?.toString() },
    { key: "conv-b", message: { to: ["another"] }, object: b?.toString() },
  ]);
});
