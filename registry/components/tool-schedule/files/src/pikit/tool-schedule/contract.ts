/**
 * `scheduler`: prompts that run at a time, or on a cron schedule, in a conversation that exists.
 * Declared by scheduler-sql; every component that uses it carries an identical copy of this file
 * (a component never imports another's files; `tsc` refuses two copies that differ).
 *
 * The scheduler keeps jobs and delivers their ticks to the one handler registered with `handle`
 * (the component that admits them into their conversations). It never runs an agent itself, so a
 * tool may use it (the runtime uses every tool: a tool cannot use `agent.runtime`).
 *
 * What a provider guarantees, checked by `createSchedulerConformance` (conformance.ts):
 * - **Never early.** A tick is delivered at or after its time, on the App's clock; maybe late.
 * - **At least once, with its identity.** A tick is done only when the handler resolves. One cut short
 *   or rejected is delivered again, later, with the same `tick`: the handler is idempotent by
 *   `(job.id, tick)`. One job's ticks are delivered in order, one at a time.
 * - **Missed ticks, by the job's policy.** A tick is missed when it is delivered more than the
 *   provider's grace after its time (a stop, a crash), or when the job's following tick is already due.
 *   `skip` drops missed ticks; `once` delivers the earliest of them, once. Either way the job goes on at
 *   its first tick after now.
 * - **An `at` job ends with its tick:** once handled (or skipped), `get` and `list` no longer return it,
 *   and scheduling its id again changes nothing for as long as the provider keeps ended ids.
 * - **Idempotent by id.** `schedule` with an id already scheduled returns the stored job unchanged.
 * - **Cancel is effective:** once `cancel` resolves, no tick of the job starts; one already being
 *   handled finishes.
 * - **Durable.** Jobs survive a restart (a new App over the same storage), and ticks that came due
 *   while nothing ran are delivered after it, by the policy above.
 * - **The handler may come late.** Ticks that come due before `handle` wait for it.
 */

import type { AppContext } from "@pikit/core";

/** When a job runs: once at `at` (epoch milliseconds), or at each match of a 5-field `cron` in `timezone` (IANA). */
export type ScheduleWhen = { at: number } | { cron: string; timezone: string };

/** One job. A type, not an interface: it is JSON. */
export type ScheduledJob = {
  /**
   * Its identity and idempotency key, chosen by whoever schedules it and prefixed with that
   * component's name (`tool-schedule:<conversation>:<call>`), so two components never share one.
   */
  id: string;
  /** The key of the conversation it runs in, as that conversation's channel built it. */
  key: string;
  /** The message the agent gets at each tick. */
  prompt: string;
  when: ScheduleWhen;
  /** What a missed tick does: `skip` drops it, `once` delivers the earliest missed tick, once. */
  missed: "skip" | "once";
};

/** A job as the scheduler keeps it, with the time of its next tick (epoch milliseconds). */
export type ScheduledJobState = ScheduledJob & { next: number };

/** One tick of a job. `tick`, its scheduled time in epoch milliseconds, is its identity within the job. */
export type SchedulerTick = { job: ScheduledJob; tick: number };

/** Handles one tick: resolve when it is done, reject to have it delivered again later. */
export type SchedulerTickHandler = (tick: SchedulerTick, ctx: AppContext) => Promise<void>;

/** Which jobs `list` returns: ordered by id, after `after`, at most `limit`. */
export type SchedulerQuery = {
  /** Only the jobs of this conversation key. */
  key?: string;
  /** Only the jobs whose id starts with this. */
  prefix?: string;
  /** The last id of the previous page. */
  after?: string;
  /** 1 to 100. */
  limit: number;
};

export interface Scheduler {
  /**
   * Keeps `job` and returns it with its first tick. An id already scheduled returns the stored job,
   * unchanged whatever `job` says; the id of an `at` job that already ended returns `undefined` and
   * schedules nothing. Rejects, keeping nothing, a job that is not valid (an empty id, key or prompt,
   * one over the provider's limits, a cron that is not 5 fields or never matches, an unknown zone).
   */
  schedule(job: ScheduledJob, ctx: AppContext): Promise<ScheduledJobState | undefined>;
  /** The job `id`, or `undefined` when there is none (never scheduled, cancelled, or an ended `at`). */
  get(id: string, ctx: AppContext): Promise<ScheduledJobState | undefined>;
  /** The jobs `query` selects, ordered by id. */
  list(query: SchedulerQuery, ctx: AppContext): Promise<ScheduledJobState[]>;
  /** Removes the job `id`: none of its ticks starts after this resolves. An unknown id changes nothing. */
  cancel(id: string, ctx: AppContext): Promise<void>;
  /**
   * Registers the one handler of every tick, until the App stops. Call it in `start`. Throws when a
   * handler is registered already.
   */
  handle(handler: SchedulerTickHandler): void;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    scheduler: Scheduler;
  }
}
