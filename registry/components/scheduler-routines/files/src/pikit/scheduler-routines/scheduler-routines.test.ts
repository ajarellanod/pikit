/**
 * scheduler-routines' tests, copied with it: the sync at start, over an in-memory `scheduler` and an
 * in-memory mailbox (every key's actor is the App, as on a server); the sync call its actor answers, and
 * the Worker half's start. The routines' ticks through scheduler-sql and runtime-pi are scheduler-admit's
 * `app.test.ts` in the registry; on Cloudflare, the workerd lane's `scheduler.workerd.ts`.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, type Logger, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorMailbox } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import type { ScheduledJobState, Scheduler } from "./contract.ts";
import schedulerRoutines, { JOB_PREFIX, ROUTINES_KEY, SYNC, worker } from "./index.ts";

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
    components: [defineComponent({ name: "scheduler-test", setup: (pikit) => pikit.provide("scheduler", scheduler) }), createMemoryMailbox(), schedulerRoutines],
    config: { "scheduler-routines": { routines } },
    logger: silentLogger,
  }).create();
  await app.start();
  await app.stop();
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [defineComponent({ name: "scheduler-test", setup: (pikit) => pikit.provide("scheduler", memoryScheduler()) }), createMemoryMailbox(), schedulerRoutines], logger: silentLogger }).create();
  const half = await defineApp({ components: [createMemoryMailbox(), worker], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "scheduler-routines")).toMatchObject({ provides: [], requires: ["scheduler", "actor.inbox"], optional: [] });
  expect(half.describe().components.find((component) => component.name === "scheduler-routines-worker")).toMatchObject({ provides: [], requires: ["actor.mailbox"], optional: [] });
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

test("the sync call: only the routines' actor answers it; a routine the scheduler refuses is invalid, its storage failing is not", async () => {
  const scheduler = memoryScheduler();
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "probe-test",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      pikit.provide("scheduler", scheduler);
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [createMemoryMailbox(), probe, schedulerRoutines], config: { "scheduler-routines": { routines: [routine("a")] } }, logger: silentLogger }).create();
  await app.start();
  const sync = (key: string) => (mailbox as ActorMailbox).call(key, SYNC, {}, app.context()).then(() => "ok", (error: unknown) => (error instanceof ActorCallError ? [error.code, error.message] : String(error)));
  try {
    expect((await sync("someone-else"))[0]).toBe("invalid");
    scheduler.jobs.clear();
    expect(await sync(ROUTINES_KEY)).toBe("ok");
    expect([...scheduler.jobs.keys()]).toEqual([`${JOB_PREFIX}a`]);

    scheduler.jobs.clear();
    scheduler.schedule = async () => Promise.reject(new TypeError("the cron never matches"));
    expect(await sync(ROUTINES_KEY)).toEqual(["invalid", 'scheduler-routines: the routine "a" cannot be scheduled: the cron never matches']);
    scheduler.schedule = async () => Promise.reject(new Error("disk full"));
    expect((await sync(ROUTINES_KEY))[0]).not.toBe("invalid");
  } finally {
    await app.stop();
  }
});

test("the Worker half: a refused routine fails its start; an actor it cannot reach is logged, and it starts", async () => {
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (message) => void warnings.push(message) };
  const half = (refusal: ActorCallError) =>
    defineApp({
      components: [
        defineComponent({
          name: "mailbox-test",
          setup: (pikit) => pikit.provide("actor.mailbox", { call: async (key: string, type: string) => Promise.reject(key === ROUTINES_KEY && type === SYNC ? refusal : new Error("wrong call")) } as unknown as ActorMailbox),
        }),
        worker,
      ],
      logger,
    }).create();
  const invalid = await half(new ActorCallError("invalid", 'scheduler-routines: the routine "bad" cannot be scheduled: the cron never matches'));
  const why = await invalid.start().then(() => "started", (error: Error) => String((error.cause as Error | undefined)?.message ?? error.message));
  expect(why).toBe('scheduler-routines: the routine "bad" cannot be scheduled: the cron never matches');
  const unreachable = await half(new ActorCallError("unreachable", "the object did not answer"));
  await unreachable.start();
  await unreachable.stop();
  expect(warnings).toEqual(["scheduler-routines: the routines could not be synced; the next start asks again"]);
});
