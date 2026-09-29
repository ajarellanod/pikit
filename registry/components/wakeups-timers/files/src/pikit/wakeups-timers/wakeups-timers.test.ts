/**
 * wakeups-timers' tests. They are copied with the component and keep running in your project: the
 * `wakeups` conformance suite (with and without a slice deadline), the lifecycle suite, its logs, its
 * config, and a restart that forgets every request.
 */

import { expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import type { Wakeups } from "@pikit/contracts";
import { createLifecycleConformance, createManualClock, type ManualClock } from "@pikit/core/testing";
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

/**
 * An app of wakeups-timers and one handler, "test.wake", that runs `handle`; its `wakeups` comes from a
 * second component, as a component that both handles and asks would be a dependency cycle.
 */
async function open(clock: ManualClock, handle: (ctx: AppContext) => Promise<void>, logger: Logger = silentLogger) {
  let wakeups: Wakeups | undefined;
  const handler = defineComponent({ name: "test-handler", setup: (pikit) => pikit.provideKeyed("wakeup", "test.wake", handle) });
  const asker = defineComponent({
    name: "test-asker",
    setup(pikit) {
      const handle = pikit.use("wakeups");
      return { start: () => void (wakeups = handle.get()) };
    },
  });
  const app = await defineApp({ components: [handler, wakeupsTimers, asker], logger, clock }).create();
  await app.start();
  if (wakeups === undefined) throw new Error("wakeups was not resolved");
  return { wakeups, app };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [wakeupsTimers], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "wakeups-timers")).toMatchObject({
    provides: ["wakeups"],
    requires: [],
    optional: ["wakeup"],
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

test("asking for a name nobody handles says which names exist and how to provide one", async () => {
  const clock = createManualClock();
  const { wakeups, app } = await open(clock, async () => {});
  try {
    await expect(wakeups.at("test.wak", clock.now(), app.context())).rejects.toThrow(
      'no "wakeup" handler is named "test.wak" (named: test.wake); provide one with pikit.provideKeyed("wakeup", "test.wak", handler), or check the name',
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
