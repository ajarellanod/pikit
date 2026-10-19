/**
 * `scheduler` conformance: what every provider of contract.ts must do, wherever it keeps its jobs.
 * Runner-independent, as the kit's suites are:
 *
 *   for (const c of createSchedulerConformance(() => myFixture(), { graceMs: GRACE_MS }))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite owns the clock (`createManualClock`) and the tick handler: one component of its own that
 * uses `scheduler` and registers the handler in its `start`, as the component that admits ticks does.
 * A restart is a second App over the fixture's components, whose storage outlives the first.
 */

import { type App, type AppContext, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type ConformanceCase, createManualClock, type ManualClock } from "@pikit/core/testing";
import type { ScheduledJob, Scheduler, SchedulerTick } from "./contract.ts";

export interface SchedulerFixture {
  /** The components providing `scheduler` and what it uses (storage, wakeups), over storage that outlives one App. */
  components: ComponentDefinition[];
  dispose?(): Promise<void>;
}

export interface SchedulerConformanceOptions {
  /** A tick delivered later than this after its time is missed. */
  graceMs: number;
}

const GROUP = "scheduler";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 2030-01-01T00:00:00Z: a Tuesday, on the hour. */
const START = Date.UTC(2030, 0, 1);

function expect(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const rejects = async (work: Promise<unknown>, what: string): Promise<void> => {
  const failed = await work.then(
    () => false,
    () => true,
  );
  if (!failed) throw new Error(`${GROUP}: expected ${what} to be refused`);
};

/** Lets what a wakeup started (a run, its SQL, the handler) finish. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
};

const job = (id: string, when: ScheduledJob["when"], over: Partial<ScheduledJob> = {}): ScheduledJob => ({ id, key: "chat:1", prompt: `run ${id}`, when, missed: "once", ...over });

/** What the suite's handler does with a tick: `ok`, reject it, or hold it until released. */
type Script = (tick: SchedulerTick, ctx: AppContext) => Promise<void>;

interface Booted {
  app: App;
  scheduler: Scheduler;
  ctx: AppContext;
}

export function createSchedulerConformance(factory: () => SchedulerFixture | Promise<SchedulerFixture>, options: SchedulerConformanceOptions): ConformanceCase[] {
  /** One case: a fresh fixture, a clock, every tick handled (`ticks`, as `id@tick`), and Apps that restart. */
  const scenario = (name: string, body: (s: { clock: ManualClock; ticks: string[]; boot(script?: Script): Promise<Booted>; stop(): Promise<void> }) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    async run() {
      const fixture = await factory();
      const clock = createManualClock(START);
      const ticks: string[] = [];
      let current: App | undefined;
      const stop = async () => {
        const app = current;
        current = undefined;
        await app?.stop();
      };
      const boot = async (script: Script = async () => {}): Promise<Booted> => {
        await stop();
        let reached: { scheduler: Scheduler; ctx: AppContext } | undefined;
        const consumer = defineComponent({
          name: "scheduler-conformance",
          setup(pikit) {
            const scheduler = pikit.use("scheduler");
            return {
              start(ctx) {
                scheduler.get().handle(async (tick, tickCtx) => {
                  await script(tick, tickCtx);
                  ticks.push(`${tick.job.id}@${tick.tick - START}`);
                });
                reached = { scheduler: scheduler.get(), ctx };
              },
            };
          },
        });
        const app = await defineApp({ components: [...fixture.components, consumer], logger: silentLogger, clock }).create();
        await app.start();
        current = app;
        await settle();
        if (reached === undefined) throw new Error(`${GROUP}: the suite's component did not start`);
        return { app, scheduler: reached.scheduler, ctx: app.context() };
      };
      try {
        await body({ clock, ticks, boot, stop });
      } finally {
        await stop();
        await fixture.dispose?.();
      }
    },
  });

  return [
    scenario("an at job ticks at its time, never before, then ends", async ({ clock, ticks, boot }) => {
      const { scheduler, ctx } = await boot();
      const scheduled = await scheduler.schedule(job("a", { at: START + HOUR }), ctx);
      expect(scheduled?.next, START + HOUR, "the job's first tick");
      // A job just before it wakes the provider while a's time has not come.
      await scheduler.schedule(job("early", { at: START + HOUR - 30_000 }), ctx);
      await clock.advance(HOUR - 1);
      await settle();
      expect(ticks, [`early@${HOUR - 30_000}`], "the ticks a millisecond before a's time");
      await clock.advance(1);
      await settle();
      expect(ticks, [`early@${HOUR - 30_000}`, `a@${HOUR}`], "the ticks at a's time");
      expect(await scheduler.get("a", ctx), undefined, "the ended job");
      expect(await scheduler.list({ limit: 10 }, ctx), [], "the jobs after it ended");
      expect(await scheduler.schedule(job("a", { at: START + 2 * HOUR }), ctx), undefined, "scheduling an ended job's id again");
      await clock.advance(2 * HOUR);
      await settle();
      expect(ticks, [`early@${HOUR - 30_000}`, `a@${HOUR}`], "the ticks after its id was scheduled again");
    }),

    scenario("a cron job ticks at each match, in its zone", async ({ clock, ticks, boot }) => {
      const { scheduler, ctx } = await boot();
      // 08:00 in New York is 13:00 UTC in January.
      await scheduler.schedule(job("daily", { cron: "0 8 * * *", timezone: "America/New_York" }), ctx);
      expect((await scheduler.get("daily", ctx))?.next, START + 13 * HOUR, "the first tick");
      await clock.advance(13 * HOUR);
      await settle();
      await clock.advance(24 * HOUR);
      await settle();
      expect(ticks, [`daily@${13 * HOUR}`, `daily@${37 * HOUR}`], "the ticks of two days");
      expect((await scheduler.get("daily", ctx))?.next, START + 61 * HOUR, "the next tick");
    }),

    scenario("scheduling an id again keeps the stored job: one job, one tick", async ({ clock, ticks, boot }) => {
      const { scheduler, ctx } = await boot();
      await scheduler.schedule(job("a", { at: START + HOUR }), ctx);
      const again = await scheduler.schedule(job("a", { at: START + 2 * HOUR }, { prompt: "another" }), ctx);
      expect([again?.prompt, again?.next], ["run a", START + HOUR], "what the second schedule returns");
      expect((await scheduler.list({ limit: 10 }, ctx)).length, 1, "the jobs");
      await clock.advance(3 * HOUR);
      await settle();
      expect(ticks, [`a@${HOUR}`], "the ticks");
    }),

    scenario("a rejected tick is delivered again, with the same identity, then the job moves on", async ({ clock, ticks, boot }) => {
      let deliveries = 0;
      const { scheduler, ctx } = await boot(async () => {
        deliveries += 1;
        if (deliveries === 1) throw new Error("the first delivery fails");
      });
      await scheduler.schedule(job("hourly", { cron: "0 * * * *", timezone: "UTC" }), ctx);
      await clock.advance(HOUR);
      await settle();
      for (let waited = 0; ticks.length === 0 && waited < options.graceMs / 2; waited += 1_000) {
        await clock.advance(1_000);
        await settle();
      }
      expect([deliveries, ticks], [2, [`hourly@${HOUR}`]], "the deliveries of the first tick");
      expect((await scheduler.get("hourly", ctx))?.next, START + 2 * HOUR, "the next tick");
    }),

    scenario("a tick cut by a restart is delivered again after it, with the same identity", async ({ clock, ticks, boot }) => {
      const cut: string[] = [];
      const first = await boot(
        (tick, tickCtx) =>
          new Promise<void>((_, reject) => {
            cut.push(`${tick.job.id}@${tick.tick - START}`);
            tickCtx.abortSignal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
          }),
      );
      await first.scheduler.schedule(job("a", { at: START + HOUR }), first.ctx);
      await clock.advance(HOUR);
      await settle();
      expect(cut, [`a@${HOUR}`], "the tick the first App was handling");
      await boot();
      expect(ticks, [`a@${HOUR}`], "the tick after the restart");
    }),

    scenario("cancel: no tick of the job starts once it resolves; a tick in progress finishes", async ({ clock, ticks, boot }) => {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let holding = () => {};
      const started = new Promise<void>((resolve) => (holding = resolve));
      const { scheduler, ctx } = await boot(async (tick) => {
        if (tick.job.id === "minutely" && tick.tick === START + MINUTE) {
          holding();
          await held;
        }
      });
      await scheduler.schedule(job("later", { at: START + HOUR }), ctx);
      await scheduler.cancel("later", ctx);
      await scheduler.cancel("never-scheduled", ctx);
      expect(await scheduler.get("later", ctx), undefined, "a cancelled job");
      await scheduler.schedule(job("minutely", { cron: "* * * * *", timezone: "UTC" }), ctx);
      await clock.advance(MINUTE);
      await started;
      const cancelled = scheduler.cancel("minutely", ctx);
      release();
      await cancelled;
      await clock.advance(2 * HOUR);
      await settle();
      expect(ticks, [`minutely@${MINUTE}`], "the ticks");
      expect(await scheduler.list({ limit: 10 }, ctx), [], "the jobs");
    }),

    scenario("jobs survive a restart; ticks missed meanwhile are delivered once (missed: once)", async ({ clock, ticks, boot, stop }) => {
      const first = await boot();
      await first.scheduler.schedule(job("hourly", { cron: "0 * * * *", timezone: "UTC" }), first.ctx);
      await stop();
      await clock.advance(3 * HOUR + 30 * MINUTE);
      const { scheduler, ctx } = await boot();
      expect(ticks, [`hourly@${HOUR}`], "the ticks after the restart: the earliest missed one");
      expect((await scheduler.get("hourly", ctx))?.next, START + 4 * HOUR, "the next tick");
      await clock.advance(30 * MINUTE);
      await settle();
      expect(ticks, [`hourly@${HOUR}`, `hourly@${4 * HOUR}`], "the ticks after the next one");
    }),

    scenario("missed: skip drops the ticks missed while stopped, and goes on", async ({ clock, ticks, boot, stop }) => {
      const first = await boot();
      await first.scheduler.schedule(job("hourly", { cron: "0 * * * *", timezone: "UTC" }, { missed: "skip" }), first.ctx);
      await first.scheduler.schedule(job("late", { at: START + HOUR }, { missed: "skip" }), first.ctx);
      await stop();
      await clock.advance(3 * HOUR + 30 * MINUTE);
      const { scheduler, ctx } = await boot();
      expect(ticks, [], "the ticks after the restart");
      expect(await scheduler.get("late", ctx), undefined, "an at job whose tick was skipped");
      await clock.advance(30 * MINUTE);
      await settle();
      expect(ticks, [`hourly@${4 * HOUR}`], "the ticks after the next one");
    }),

    scenario("a tick delivered within the grace after a stop is not missed: delivered even with skip", async ({ clock, ticks, boot, stop }) => {
      const first = await boot();
      await first.scheduler.schedule(job("soon", { at: START + HOUR }, { missed: "skip" }), first.ctx);
      await stop();
      await clock.advance(HOUR + Math.floor(options.graceMs / 2));
      await boot();
      expect(ticks, [`soon@${HOUR}`], "the ticks after a stop shorter than the grace");
    }),

    scenario("list selects by key and by prefix, ordered by id, a page at a time; never another key's jobs", async ({ boot }) => {
      const { scheduler, ctx } = await boot();
      const at = { at: START + HOUR };
      await scheduler.schedule(job("b:1", at, { key: "chat:1" }), ctx);
      await scheduler.schedule(job("a:2", at, { key: "chat:2" }), ctx);
      await scheduler.schedule(job("a:1", at, { key: "chat:1" }), ctx);
      const ids = async (query: Parameters<Scheduler["list"]>[0]) => (await scheduler.list(query, ctx)).map((j) => j.id);
      expect(await ids({ limit: 10 }), ["a:1", "a:2", "b:1"], "every job");
      expect(await ids({ key: "chat:1", limit: 10 }), ["a:1", "b:1"], "chat:1's jobs");
      expect(await ids({ prefix: "a:", limit: 10 }), ["a:1", "a:2"], "the jobs prefixed a:");
      expect(await ids({ key: "chat:1", prefix: "a:", limit: 10 }), ["a:1"], "chat:1's jobs prefixed a:");
      expect(await ids({ key: "chat:3", limit: 10 }), [], "a key with no jobs");
      expect(await ids({ limit: 1, after: "a:1" }), ["a:2"], "the page after a:1");
      await rejects(scheduler.list({ limit: 0 }, ctx), "a limit of 0");
    }),

    scenario("an invalid job is refused, and nothing is kept", async ({ boot }) => {
      const { scheduler, ctx } = await boot();
      const daily = { cron: "0 8 * * *", timezone: "UTC" };
      const invalid: [string, ScheduledJob][] = [
        ["an empty id", job("", daily)],
        ["an empty key", job("x", daily, { key: "" })],
        ["an empty prompt", job("x", daily, { prompt: " " })],
        ["a minute of 61", job("x", { cron: "61 * * * *", timezone: "UTC" })],
        ["6 fields", job("x", { cron: "0 0 8 * * *", timezone: "UTC" })],
        ["an unknown zone", job("x", { cron: "0 8 * * *", timezone: "Mars/Olympus" })],
        ["a cron that never matches", job("x", { cron: "0 0 30 2 *", timezone: "UTC" })],
        ["a time that is no integer", job("x", { at: START + 0.5 })],
        ["an unknown missed policy", job("x", daily, { missed: "twice" as "once" })],
      ];
      for (const [what, candidate] of invalid) await rejects(scheduler.schedule(candidate, ctx), what);
      expect(await scheduler.list({ limit: 10 }, ctx), [], "the jobs");
    }),

    scenario("one tick handler per App", async ({ boot }) => {
      const { scheduler } = await boot();
      let threw = false;
      try {
        scheduler.handle(async () => {});
      } catch {
        threw = true;
      }
      if (!threw) throw new Error(`${GROUP}: expected a second handler to be refused`);
    }),
  ];
}
