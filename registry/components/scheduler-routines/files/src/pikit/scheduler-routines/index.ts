/**
 * scheduler-routines: prompts on a cron schedule, written in `pikit.config.ts` (reviewed and versioned
 * with the project), kept in `scheduler` as jobs of its own (`scheduler-routines:<name>`).
 *
 * At each start it makes the scheduler's jobs match its config: a routine added is scheduled, one
 * changed is scheduled again (its next tick computed anew), one taken out is cancelled. It touches no
 * other job (the agent's, from tool-schedule). A routine the scheduler refuses (a cron that never
 * matches, an unknown zone) stops the start, naming it.
 *
 * Taking it out: set `routines` to `[]` and start once (its jobs are cancelled), then remove it;
 * removed first, its jobs stay in the scheduler.
 *
 * Targets: `server`, as scheduler-sql. It imports nothing platform-specific.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import Type, { type Static } from "typebox";
import type { ScheduledJob, ScheduledJobState, Scheduler } from "./contract.ts";

/** The prefix of every job id it makes. */
export const JOB_PREFIX = "scheduler-routines:";

const Routine = Type.Object({
  /** Its identity: renaming a routine is removing one and adding another. */
  name: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 }),
  /** The conversation it runs in: an existing conversation's key, as its channel built it (`telegram:12345`). */
  key: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  /** 5 fields: minute hour day month weekday. */
  cron: Type.String({ minLength: 1 }),
  /** The IANA zone of `cron`. */
  timezone: Type.String({ minLength: 1, default: "UTC" }),
  /** A run missed while the service was down: `once` runs it late, once; `skip` drops it. */
  missed: Type.Union([Type.Literal("once"), Type.Literal("skip")], { default: "once" }),
});

const Config = Type.Object(
  { routines: Type.Array(Routine, { default: [] }) },
  { examples: [{ routines: [{ name: "morning-summary", key: "telegram:12345", prompt: "Summarize what is due today.", cron: "0 8 * * 1-5", timezone: "Europe/Madrid" }] }] },
);
export type RoutinesConfig = Static<typeof Config>;

/** The job a routine is. */
export const jobOf = (routine: RoutinesConfig["routines"][number]): ScheduledJob => ({
  id: `${JOB_PREFIX}${routine.name}`,
  key: routine.key,
  prompt: routine.prompt,
  when: { cron: routine.cron, timezone: routine.timezone },
  missed: routine.missed,
});

const same = (a: ScheduledJobState, b: ScheduledJob) =>
  JSON.stringify([a.key, a.prompt, a.when, a.missed]) === JSON.stringify([b.key, b.prompt, b.when, b.missed]);

/** Makes `scheduler`'s jobs prefixed `JOB_PREFIX` exactly `routines`. */
export async function syncRoutines(scheduler: Scheduler, routines: RoutinesConfig["routines"], ctx: AppContext): Promise<void> {
  const wanted = new Map(routines.map((routine) => [`${JOB_PREFIX}${routine.name}`, jobOf(routine)]));
  if (wanted.size !== routines.length) throw new Error("scheduler-routines: two routines have the same name");
  let after: string | undefined;
  for (;;) {
    const page = await scheduler.list({ prefix: JOB_PREFIX, limit: 100, ...(after !== undefined && { after }) }, ctx);
    for (const job of page) {
      const routine = wanted.get(job.id);
      if (routine !== undefined && same(job, routine)) wanted.delete(job.id);
      else await scheduler.cancel(job.id, ctx);
    }
    if (page.length < 100) break;
    after = page.at(-1)?.id;
  }
  for (const job of wanted.values()) {
    try {
      await scheduler.schedule(job, ctx);
    } catch (error) {
      throw new Error(`scheduler-routines: the routine "${job.id.slice(JOB_PREFIX.length)}" cannot be scheduled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export default defineComponent({
  name: "scheduler-routines",
  config: Config,
  setup(pikit, config) {
    const scheduler = pikit.use("scheduler");
    return { start: (ctx) => syncRoutines(scheduler.get(), config.routines, ctx) };
  },
});
