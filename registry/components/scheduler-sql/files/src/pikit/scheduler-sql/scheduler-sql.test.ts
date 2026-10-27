/**
 * scheduler-sql: the `scheduler` suite (conformance.ts) over a SQLite file and the in-memory wakeups
 * double (which, like wakeups-timers, forgets its requests at a restart), and what the suite cannot
 * pin: what setup declares, cron ticks across a change of time, and a tick cut by the wakeup's
 * cancellation (Cloudflare's slice deadline), which the in-memory double never cuts.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppContext, defineApp, defineComponent, silentLogger, withAbortSignal } from "@pikit/core";
import type { WakeupHandler } from "@pikit/contracts";
import { createMemoryWakeups } from "@pikit/contracts/testing";
import { createManualClock } from "@pikit/core/testing";
import type { Scheduler } from "./contract.ts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { createSchedulerConformance } from "./conformance.ts";
import schedulerSql, { GRACE_MS, nextTick } from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-scheduler-sql-"));
  directories.push(dir);
  return { components: [sqliteStorage(join(dir, "pikit.db")), createMemoryWakeups(), schedulerSql] };
};

for (const c of createSchedulerConformance(fixture, { graceMs: GRACE_MS })) test(`${c.group}: ${c.name}`, () => c.run());

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: fixture().components, logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "scheduler-sql")).toMatchObject({
    provides: ["scheduler"],
    requires: ["storage.sql", "wakeups"],
    optional: [],
  });
});

test("a cron tick keeps its local time across a change of time: 08:00 in Madrid is 07:00 UTC in winter, 06:00 UTC in summer", () => {
  const daily = { cron: "0 8 * * *", timezone: "Europe/Madrid" };
  expect(new Date(nextTick(daily, Date.UTC(2026, 2, 28, 12)) as number).toISOString()).toBe("2026-03-29T06:00:00.000Z");
  expect(new Date(nextTick(daily, Date.UTC(2026, 2, 27, 12)) as number).toISOString()).toBe("2026-03-28T07:00:00.000Z");
  // Strictly after: a tick at its own time is followed by the next one.
  expect(nextTick(daily, Date.UTC(2026, 2, 29, 6))).toBe(Date.UTC(2026, 2, 30, 6));
});

test("a tick cut by the wakeup's cancellation is no failure: the run resolves, asks again at once, and the tick comes again", async () => {
  let run: WakeupHandler | undefined;
  const asked: number[] = [];
  const delivered: number[] = [];
  let scheduler: Scheduler | undefined;
  const wakeups = defineComponent({
    name: "wakeups-test",
    setup: (pikit) => pikit.provide("wakeups", { handle: (_name, handler) => void (run = handler), at: async (_name, time) => void asked.push(time), cancel: async () => {} }),
  });
  const consumer = defineComponent({
    name: "consumer-test",
    setup(pikit) {
      const handle = pikit.use("scheduler");
      return {
        start() {
          scheduler = handle.get();
          // The first delivery waits for its context's cancellation, and rejects with it, as a cut RPC does.
          scheduler.handle(async (tick, ctx) => {
            delivered.push(tick.tick);
            if (delivered.length === 1) await new Promise((_, reject) => ctx.abortSignal?.addEventListener("abort", () => reject(ctx.abortSignal?.reason), { once: true }));
          });
        },
      };
    },
  });
  const clock = createManualClock(Date.UTC(2030, 0, 1));
  const app = await defineApp({ components: [sqliteStorage(), wakeups, schedulerSql, consumer], clock, logger: silentLogger }).create();
  await app.start();
  try {
    await (scheduler as Scheduler).schedule({ id: "a", key: "chat:1", prompt: "now", when: { at: clock.now() }, missed: "once" }, app.context());
    const slice = new AbortController();
    const cut = (run as WakeupHandler)(app.context().derive((context) => withAbortSignal(slice.signal, context)) as AppContext);
    await new Promise((resolve) => setTimeout(resolve, 10));
    slice.abort(new Error("the slice's deadline"));
    await cut; // resolves: rejecting would be a failure, retried after the wakeup's backoff
    expect(asked.at(-1)).toBe(clock.now());
    await (run as WakeupHandler)(app.context());
    expect(delivered).toEqual([clock.now(), clock.now()]);
    expect(await (scheduler as Scheduler).get("a", app.context())).toBeUndefined();
  } finally {
    await app.stop();
  }
});
