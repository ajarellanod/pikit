/**
 * scheduler-sql: `scheduler` (contract.ts) over `storage.sql` and `wakeups`. Jobs are rows of its
 * table, each with the time of its next tick; one wakeup, at the earliest of them, delivers what is
 * due to the handler registered with `handle`, then moves each job on. Cron expressions (5 fields, in
 * an IANA zone) are croner's.
 *
 * - **Durable**: a job is a committed row; at start it asks `wakeups` again for the earliest tick
 *   (wakeups-timers keeps no request across a restart, K6).
 * - **At least once**: a job moves on only after the handler resolved for its tick, so a crash in
 *   between delivers the same tick again. A rejected tick is retried with the wakeup's backoff; the
 *   other jobs due in the same run are delivered meanwhile.
 * - **Missed ticks**: later than `GRACE_MS`, or with the following tick already due: `skip` or `once`.
 * - **Cancel** waits for a tick in progress (one lock per App: delivering and cancelling never
 *   interleave), so once it resolves no tick of the job starts.
 *
 * Targets: `server`. On Cloudflare each conversation is a Durable Object with its own `storage.sql`
 * and alarm: see the README.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { Cron } from "croner";
import type { ScheduledJob, ScheduledJobState, Scheduler, SchedulerQuery, SchedulerTickHandler, ScheduleWhen } from "./contract.ts";

export const TABLE = "scheduler_sql_jobs";
/** Its one wakeup. */
export const WAKEUP = "scheduler-sql";
/** A tick delivered later than this after its time is missed (the job's `missed` decides). */
export const GRACE_MS = 5 * 60_000;
/** How long an ended `at` job's id stays taken, so a repeated `schedule` of it schedules nothing. */
export const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000;
/** What a job may hold. */
export const LIMITS = { id: 200, key: 500, prompt: 20_000, list: 100 } as const;
/** Ticks one wakeup run delivers at most; then it asks for the next run at once. */
const BATCH = 50;

/** The first tick of `when` strictly after `after` (epoch ms), or `undefined` when there is none. Throws on a bad cron or zone. */
export function nextTick(when: ScheduleWhen, after: number): number | undefined {
  if ("at" in when) return when.at > after ? when.at : undefined;
  const next = new Cron(when.cron, { timezone: when.timezone, mode: "5-part" }).nextRun(new Date(after));
  return next === null ? undefined : next.getTime();
}

/** Why `job` cannot be scheduled, or `undefined`. */
export function jobProblem(job: ScheduledJob, now: number): string | undefined {
  const text = (value: unknown, limit: number) => typeof value === "string" && value.trim() !== "" && value.length <= limit;
  if (!text(job.id, LIMITS.id)) return `the id must be a non-empty string of at most ${LIMITS.id} characters`;
  if (!text(job.key, LIMITS.key)) return `the key must be a non-empty string of at most ${LIMITS.key} characters`;
  if (!text(job.prompt, LIMITS.prompt)) return `the prompt must be a non-empty string of at most ${LIMITS.prompt} characters`;
  if (job.missed !== "skip" && job.missed !== "once") return 'missed must be "skip" or "once"';
  const when = job.when as Partial<{ at: unknown; cron: unknown; timezone: unknown }> | undefined;
  if (when === undefined || typeof when !== "object") return "when must be { at } or { cron, timezone }";
  if ("at" in when) {
    if (Object.keys(when).length !== 1 || !Number.isSafeInteger(when.at)) return "when.at must be epoch milliseconds (an integer)";
    return undefined;
  }
  if (Object.keys(when).length !== 2 || typeof when.cron !== "string" || typeof when.timezone !== "string") return "when must be { at } or { cron, timezone }";
  try {
    if (nextTick({ cron: when.cron, timezone: when.timezone }, now) === undefined) return `the cron "${when.cron}" never matches`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

type Row = { id: string; job: string; next_at: number | null };
const stateOf = (row: Row): ScheduledJobState => ({ ...(JSON.parse(row.job) as ScheduledJob), next: Number(row.next_at) });

export default defineComponent({
  name: "scheduler-sql",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    const wakeups = pikit.use("wakeups");
    let handler: SchedulerTickHandler | undefined;
    // ponytail: one lock per App, as a server runs one App per database; several processes would need a lease per row.
    let lock: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
      const result = lock.then(work);
      lock = result.catch(() => {});
      return result;
    };

    /** Asks for the wakeup at the earliest tick, if there is one. */
    const arm = async (ctx: AppContext): Promise<void> => {
      const [row] = await sql.get().query<{ next: number | null }>(`SELECT MIN(next_at) AS next FROM ${TABLE} WHERE next_at IS NOT NULL`);
      if (row?.next !== null && row?.next !== undefined) await wakeups.get().at(WAKEUP, Number(row.next), ctx);
    };

    /** Delivers the job `id`'s due tick, if it still has one, and moves the job on. */
    const fire = (id: string, ctx: AppContext) =>
      exclusive(async () => {
        const db = sql.get();
        const now = ctx.clock.now();
        const [row] = await db.query<Row>(`SELECT id, job, next_at FROM ${TABLE} WHERE id = ?`, [id]);
        if (row === undefined || row.next_at === null) return; // cancelled meanwhile
        const job = JSON.parse(row.job) as ScheduledJob;
        const tick = Number(row.next_at);
        const following = "cron" in job.when ? nextTick(job.when, tick) : undefined;
        const missed = now - tick > GRACE_MS || (following !== undefined && following <= now);
        if (handler === undefined) throw new Error("scheduler-sql: no tick handler (the App is stopping)");
        if (!missed || job.missed === "once") await handler({ job, tick }, ctx);
        else ctx.logger.warn("scheduler-sql: a missed tick is skipped", { job: job.id, tick, now });
        const next = "cron" in job.when ? nextTick(job.when, now) : undefined;
        if (next === undefined) await db.run(`UPDATE ${TABLE} SET next_at = NULL, ended_at = ? WHERE id = ?`, [now, id]);
        else await db.run(`UPDATE ${TABLE} SET next_at = ? WHERE id = ?`, [next, id]);
      });

    /** The wakeup: every due tick, up to `BATCH`, each job on its own. */
    const run = async (ctx: AppContext): Promise<void> => {
      const db = sql.get();
      const now = ctx.clock.now();
      await db.run(`DELETE FROM ${TABLE} WHERE next_at IS NULL AND ended_at < ?`, [now - KEEP_ENDED_MS]);
      const due = await db.query<{ id: string }>(`SELECT id FROM ${TABLE} WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at, id LIMIT ?`, [now, BATCH]);
      const failed: string[] = [];
      for (const { id } of due) {
        if (ctx.abortSignal?.aborted) break;
        try {
          await fire(id, ctx);
        } catch (error) {
          failed.push(id);
          ctx.logger.warn("scheduler-sql: a tick failed; it is delivered again", { job: id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      // A failure is the wakeup's to retry, with its backoff; the jobs delivered meanwhile moved on.
      if (failed.length > 0) throw new Error(`scheduler-sql: the ticks of ${failed.join(", ")} failed`);
      if (due.length === BATCH || ctx.abortSignal?.aborted) await wakeups.get().at(WAKEUP, now, ctx);
      else await arm(ctx);
    };

    const scheduler: Scheduler = {
      async schedule(job, ctx) {
        const now = ctx.clock.now();
        const problem = jobProblem(job, now);
        if (problem !== undefined) throw new TypeError(`scheduler-sql: ${problem}`);
        const stored: ScheduledJob = { id: job.id, key: job.key, prompt: job.prompt, when: job.when, missed: job.missed };
        const first = "at" in job.when ? job.when.at : (nextTick(job.when, now) as number);
        const result = await sql.get().transaction(async (tx) => {
          const [row] = await tx.query<Row>(`SELECT id, job, next_at FROM ${TABLE} WHERE id = ?`, [job.id]);
          if (row !== undefined) return row.next_at === null ? undefined : stateOf(row);
          await tx.run(`INSERT INTO ${TABLE} (id, conversation_key, job, next_at) VALUES (?, ?, ?, ?)`, [job.id, job.key, JSON.stringify(stored), first]);
          return { ...stored, next: first };
        });
        await arm(ctx);
        return result;
      },
      async get(id) {
        const [row] = await sql.get().query<Row>(`SELECT id, job, next_at FROM ${TABLE} WHERE id = ? AND next_at IS NOT NULL`, [id]);
        return row === undefined ? undefined : stateOf(row);
      },
      async list(query: SchedulerQuery) {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > LIMITS.list) throw new TypeError(`scheduler-sql: list's limit is 1 to ${LIMITS.list}`);
        const where = ["next_at IS NOT NULL"];
        const params: (string | number)[] = [];
        const add = (condition: string, ...values: (string | number)[]) => {
          where.push(condition);
          params.push(...values);
        };
        if (query.key !== undefined) add("conversation_key = ?", query.key);
        if (query.prefix !== undefined) add("substr(id, 1, ?) = ?", query.prefix.length, query.prefix);
        if (query.after !== undefined) add("id > ?", query.after);
        const rows = await sql.get().query<Row>(`SELECT id, job, next_at FROM ${TABLE} WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`, [...params, query.limit]);
        return rows.map(stateOf);
      },
      cancel: (id) => exclusive(async () => void (await sql.get().run(`DELETE FROM ${TABLE} WHERE id = ?`, [id]))),
      handle(next) {
        if (handler !== undefined) throw new Error("scheduler-sql: a tick handler is registered already (one per App)");
        handler = next;
        // Registered only now: ticks due before wait for it, as the wakeup's request waits for its handler.
        wakeups.get().handle(WAKEUP, run);
      },
    };
    pikit.provide("scheduler", scheduler);

    return {
      async start(ctx) {
        const db = sql.get();
        await db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, job TEXT NOT NULL, next_at BIGINT, ended_at BIGINT)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_next ON ${TABLE} (next_at)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${TABLE}_key ON ${TABLE} (conversation_key, id)`);
        await arm(ctx);
      },
      stop() {
        handler = undefined;
      },
    };
  },
});
