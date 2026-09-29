/**
 * wakeups-timers' tests. They are copied with the component and keep running in your project: the
 * `wakeups` conformance suite (with and without a slice deadline), the lifecycle suite, its logs, its
 * config, and a restart that forgets every request.
 */

import { expect, test } from "bun:test";
import { type AppContext, type Clock, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import type { Wakeups } from "@pikit/contracts";
import { createLifecycleConformance, createManualClock } from "@pikit/core/testing";
import { createWakeupsConformance } from "@pikit/contracts/testing";
import wakeupsTimers, { BACKOFF_MS } from "./index.ts";

// The wakeups contract, held to the backoff this component declares.
for (const c of createWakeupsConformance(() => ({ components: [wakeupsTimers] }), { backoffMs: BACKOFF_MS })) {
  test(`wakeups-timers ${c.group}: ${c.name}`, () => c.run());
}

// The same, with a slice deadline configured.
for (const c of createWakeupsConformance(() => ({ components: [wakeupsTimers], config: { "wakeups-timers": { sliceMs: 30_000 } } }), {
  backoffMs: BACKOFF_MS,
  sliceMs: 30_000,
})) {
  test(`wakeups-timers with sliceMs ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline, and a fresh app starts again.
for (const c of createLifecycleConformance(() => ({ component: wakeupsTimers }))) {
  test(`wakeups-timers ${c.group}: ${c.name}`, () => c.run());
}

/** An app of wakeups-timers and one component that registers "test.wake" to run `handler`, and asks. */
async function open(clock: Clock, handler: (ctx: AppContext) => Promise<void>, logger: Logger = silentLogger, config?: Record<string, unknown>) {
  let wakeups: Wakeups | undefined;
  const owner = defineComponent({
    name: "test-owner",
    setup(pikit) {
      const handle = pikit.use("wakeups");
      return {
        start() {
          wakeups = handle.get();
          wakeups.handle("test.wake", handler);
        },
      };
    },
  });
  const app = await defineApp({ components: [wakeupsTimers, owner], logger, clock, ...(config !== undefined && { config }) }).create();
  await app.start();
  if (wakeups === undefined) throw new Error("wakeups was not resolved");
  return { wakeups, app };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [wakeupsTimers], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "wakeups-timers")).toMatchObject({
    provides: ["wakeups"],
    requires: [],
    optional: [],
  });
});

test("the backoff is 1 s, 5 s, 30 s, then every 60 s", () => {
  expect([...BACKOFF_MS]).toEqual([1_000, 5_000, 30_000, 60_000]);
});

test("a failure is logged with the handler's name, its count and when it runs again", async () => {
  const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = { ...silentLogger, warn: (message, fields) => void warnings.push({ message, ...(fields !== undefined && { fields }) }) };
  const clock = createManualClock();
  const { wakeups, app } = await open(clock, async () => {
    throw new Error("the database is busy");
  }, logger);
  try {
    await wakeups.at("test.wake", clock.now(), app.context());
    await clock.advance(0);
    expect(warnings).toEqual([
      {
        message: 'wakeups-timers: the wakeup handler "test.wake" failed; it runs again later',
        fields: { name: "test.wake", failures: 1, retryInMs: 1_000, error: "the database is busy" },
      },
    ]);
  } finally {
    await app.stop();
  }
});

test("registering a name twice says a name has one owner", async () => {
  const clock = createManualClock();
  const { wakeups, app } = await open(clock, async () => {});
  try {
    expect(() => wakeups.handle("test.wake", async () => {})).toThrow(
      '"test.wake" already has a handler; a name has one owner, so give each handler its own (prefixed with your component\'s name)',
    );
  } finally {
    await app.stop();
  }
});

test("nothing is persisted: a new app over the same clock forgets the last one's requests", async () => {
  const clock = createManualClock();
  let runs = 0;
  const first = await open(clock, async () => void runs++);
  await first.wakeups.at("test.wake", clock.now() + 1_000, first.app.context());
  await first.app.stop();
  const second = await open(clock, async () => void runs++);
  try {
    await clock.advance(60 * 60 * 1_000);
    expect(runs).toBe(0);
  } finally {
    await second.app.stop();
  }
});

test("sliceMs is a positive whole number of milliseconds", () => {
  expect(() => defineApp({ components: [wakeupsTimers], config: { "wakeups-timers": { sliceMs: 0 } } })).toThrow("invalid config");
});

test("no timer outlives a stop by more than a second, even with a long slice: the loop keeps the deadlines", async () => {
  const manual = createManualClock();
  const sleeps: number[] = [];
  const clock: Clock = { now: () => manual.now(), sleep: (ms) => (sleeps.push(ms), manual.sleep(ms)) };
  let cut = false;
  const waitForCut = (ctx: AppContext) =>
    new Promise<void>((resolve) =>
      ctx.abortSignal?.addEventListener("abort", () => {
        cut = true;
        resolve();
      }),
    );
  const { wakeups, app } = await open(
    clock,
    waitForCut,
    silentLogger,
    { "wakeups-timers": { sliceMs: 60 * 60 * 1_000 } },
  );
  try {
    await wakeups.at("test.wake", manual.now() + 5_000, app.context());
    await manual.advance(5_000);
    await manual.advance(60 * 60 * 1_000);
    expect(cut).toBe(true);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(1_000);
  } finally {
    await app.stop();
  }
});
