/**
 * scheduler-routines' tests, copied with it: the sync at start, over an in-memory `scheduler`. The
 * routines' ticks through scheduler-sql and runtime-pi are scheduler-admit's `app.test.ts` in the registry.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ScheduledJobState, Scheduler } from "./contract.ts";
import schedulerRoutines, { JOB_PREFIX } from "./index.ts";

/** `scheduler` in memory, refusing a cron of "never" as a provider refuses one that never matches. */
function memoryScheduler(): Scheduler & { jobs: Map<string, ScheduledJobState>; cancelled: string[] } {
  const jobs = new Map<string, ScheduledJobState>();
  const cancelled: string[] = [];
  return {
    jobs,
    cancelled,
    async schedule(job) {
      if ("cron" in job.when && job.when.cron === "never") throw new TypeError("the cron never matches");
      const stored = jobs.get(job.id) ?? { ...job, next: 0 };
      jobs.set(job.id, stored);
      return stored;
    },
    get: async (id) => jobs.get(id),
    list: async (query) =>
      [...jobs.values()]
        .filter((job) => (query.prefix === undefined || job.id.startsWith(query.prefix)) && (query.after === undefined || job.id > query.after))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, query.limit),
    async cancel(id) {
      cancelled.push(id);
      jobs.delete(id);
    },
    handle() {},
  };
}

const routine = (name: string, over: Record<string, unknown> = {}) => ({ name, key: "chat:1", prompt: `do ${name}`, cron: "0 8 * * *", ...over });

async function start(scheduler: Scheduler, routines: unknown[]) {
  const app = await defineApp({
    components: [defineComponent({ name: "scheduler-test", setup: (pikit) => pikit.provide("scheduler", scheduler) }), schedulerRoutines],
    config: { "scheduler-routines": { routines } },
    logger: silentLogger,
  }).create();
  await app.start();
  await app.stop();
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [defineComponent({ name: "scheduler-test", setup: (pikit) => pikit.provide("scheduler", memoryScheduler()) }), schedulerRoutines], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "scheduler-routines")).toMatchObject({ provides: [], requires: ["scheduler"], optional: [] });
});

test("each start makes its jobs the config's: added, changed, removed; another component's jobs untouched", async () => {
  const scheduler = memoryScheduler();
  await scheduler.schedule({ id: "tool-schedule:c:1", key: "chat:1", prompt: "the agent's", when: { at: 1 }, missed: "once" }, undefined as never);
  await start(scheduler, [routine("a"), routine("b", { timezone: "Europe/Madrid", missed: "skip" })]);
  expect(scheduler.jobs.get(`${JOB_PREFIX}b`)).toEqual({ id: `${JOB_PREFIX}b`, key: "chat:1", prompt: "do b", when: { cron: "0 8 * * *", timezone: "Europe/Madrid" }, missed: "skip", next: 0 });

  // Unchanged: left as it is (its next tick too). Changed: scheduled again. Taken out: cancelled.
  await start(scheduler, [routine("a"), routine("b", { prompt: "do b better", timezone: "Europe/Madrid", missed: "skip" }), routine("c")]);
  expect(scheduler.cancelled).toEqual([`${JOB_PREFIX}b`]);
  expect(scheduler.jobs.get(`${JOB_PREFIX}b`)?.prompt).toBe("do b better");
  await start(scheduler, [routine("c")]);
  expect([...scheduler.jobs.keys()].sort()).toEqual([`${JOB_PREFIX}c`, "tool-schedule:c:1"]);
});

test("a routine the scheduler refuses stops the start, naming it; two routines of one name too", async () => {
  /** Why the start failed: the component's error, which the App's wraps. */
  const why = (routines: unknown[]) => start(memoryScheduler(), routines).then(
    () => "started",
    (error: Error) => String((error.cause as Error | undefined)?.message ?? error.message),
  );
  expect(await why([routine("bad", { cron: "never" })])).toBe('scheduler-routines: the routine "bad" cannot be scheduled: the cron never matches');
  expect(await why([routine("a"), routine("a")])).toBe("scheduler-routines: two routines have the same name");
  expect(await why([routine("Not A Name")])).not.toBe("started");
});
