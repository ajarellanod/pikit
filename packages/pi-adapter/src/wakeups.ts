/**
 * Wake-ups for a pi-durable `Harness` on a host that lives only during an event and may be evicted
 * between events (a Cloudflare Durable Object): when its pending work next needs the process
 * (`nextWakeAt`), and one bounded slice of driving it (`driveSlice`). Host-agnostic: the host turns
 * `nextWakeAt` into its own timer (an object's alarm, pikit's `wakeups`).
 *
 * Why: pi-durable 1.0 waits with in-process timers (the scheduler's `runtime.sleep`, a `setTimeout`)
 * and reports no next due time. An object evicted while a task sleeps keeps the task durably, but
 * nothing wakes the object to run it. See docs/upstream/pi-durable-next-wake.md. Upstream:
 * earendil-works/pi#10325; when it ships, `checkpointedDue` here and `timed` in runtime.ts go
 * (docs/upstream/README.md, proposal 1, "To delete when it ships").
 *
 * What `nextWakeAt` reads: `harness.inspect()`, the live tasks with their records, and nothing else.
 *
 * - A `ready` or `running` task is due now: the scheduler reserves a ready one at once (after
 *   `resume()`), and a running one (a model stream, a tool) needs the process until it commits.
 * - Except the built-in waits, which keep their due time in the task's checkpoint, the very value the
 *   phase sleeps on, so the time survives an eviction:
 *   - `pi.generation` at phase `retry` (model error backoff): `until`;
 *   - `pi.generation` at phase `poll` (a deferred response): `pollAt`;
 *   - `pi.compaction` at phase `retry` (summary model error backoff): `until`.
 *   `pi.live` mirrors these (`generation.retry.at`, `generation.deferred.pollAt`,
 *   `compactions[].retry.at`) for presentation; it is not read here, because the checkpoint is what
 *   the phase actually waits for, and a stale presentation value could only wake the host early.
 * - An abort-marked ready or running task is due now (its abort handler runs at once).
 * - `waiting`, `completing` and `blocked` tasks are never due by themselves: what they wait for is a
 *   live task counted on its own, and a blocked task (no definition can take it) waits for a code
 *   change, not a time. Unsettled submissions are not read: a queued one waits for a live task of its
 *   conversation, a placed one has one.
 *
 * What it cannot see: a custom task's `runtime.sleep(until)` that is not checkpointed. While its
 * invocation runs it is `running` (due now: the host keeps driving, in slices, until the deadline);
 * after an eviction it is `ready` again (due now: its phase runs again and sleeps again). Correct, but
 * the host spends a slice per wake-up on it. A custom task that checkpoints its due time can report it
 * through `dueAt`.
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withoutAbortSignal } from "@earendil-works/chord/context";
import type { Harness, HarnessInspection, TaskInspection } from "@earendil-works/pi-durable";

/** A live task's record, as `harness.inspect()` lists it. */
export type LiveTaskRecord = TaskInspection["record"];

export interface WakeOptions {
  /** The clock the Harness was opened with (`HarnessOptions.now`). Default: `Date.now`. */
  now?: (() => number) | undefined;
  /**
   * The due time of a ready or running task the built-in rules do not know: a custom task that keeps
   * the time it sleeps until in its checkpoint. `undefined`: the built-in rules (due now, unless it is
   * one of the built-in waits). Not called for an abort-marked task, which is due now.
   */
  dueAt?: ((record: LiveTaskRecord) => number | undefined) | undefined;
}

/**
 * The earliest time, on `now`'s clock, at which the Harness's pending work needs the process:
 * `now()` when a task is ready or running, else the earliest checkpointed due time, else
 * `undefined` (nothing to wake for). A time at or before `now()` means at once. Writes nothing.
 */
export async function nextWakeAt(harness: Harness, context: Context, options: WakeOptions = {}): Promise<number | undefined> {
  return nextWakeAtOf(await harness.inspect(context), options);
}

/** `nextWakeAt` over an inspection already read. */
export function nextWakeAtOf(inspection: Pick<HarnessInspection, "tasks">, options: WakeOptions = {}): number | undefined {
  const now = options.now ?? Date.now;
  let earliest: number | undefined;
  for (const { record, state } of inspection.tasks) {
    if (state.kind !== "ready" && state.kind !== "running") continue;
    const due = record.abortRequested === true ? undefined : (options.dueAt?.(record) ?? checkpointedDue(record));
    // Due now is the earliest anything can be.
    if (due === undefined) return now();
    if (earliest === undefined || due < earliest) earliest = due;
  }
  return earliest;
}

/** The time a built-in task's current phase sleeps until, from its checkpoint. */
function checkpointedDue(record: LiveTaskRecord): number | undefined {
  if (!("checkpoint" in record.state)) return undefined;
  const checkpoint = record.state.checkpoint;
  if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined;
  const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  if (record.kind === "pi.generation") {
    if (checkpoint.phase === "retry") return time(checkpoint.until);
    if (checkpoint.phase === "poll") return time(checkpoint.pollAt);
  }
  if (record.kind === "pi.compaction" && checkpoint.phase === "retry") return time(checkpoint.until);
  return undefined;
}

export interface DriveSliceOptions extends WakeOptions {
  /**
   * Cancelling it ends the slice (the host's slice deadline, a stop). The Harness calls of the slice
   * run with its values but without its cancellation, so the slice can still report what is left.
   * Default: Chord's background context.
   */
  context?: Context | undefined;
  /** Aborting it ends the slice too: a host's own cancellation (pikit's `AppContext.abortSignal`) needs no Chord context. */
  signal?: AbortSignal | undefined;
  /**
   * The end of the slice, on `now`'s clock: work due by then (a short backoff) is waited for in the
   * slice. Absent: the slice waits for nothing that is due later, and otherwise runs until idle or
   * until it is cancelled.
   */
  until?: number | undefined;
}

export interface SliceResult {
  /** No live task is due at any time: nothing to wake the host for. */
  idle: boolean;
  /** Absent when idle: when to drive the next slice; at or before now means at once (work was still running). */
  nextWakeAt?: number;
}

/**
 * One slice of driving the Harness inside a host event: `resume()`, then let the scheduler run until
 * nothing is due, or until what is due comes after the slice (a retry backoff longer than what is
 * left), or the slice ends. Returns when the host must come back. Leaves the Harness open and
 * scheduling: if the host lives on, an in-process timer may run a wait before the host's wake-up does,
 * and the wake-up then finds less to do. But on workerd a pending timer also keeps the object from
 * being evicted: a host that wants to go between wake-ups closes the Harness after a slice whose
 * `nextWakeAt` is later than now, and reopens it at its next event. Rejects when the Harness closes
 * during the slice.
 */
export async function driveSlice(harness: Harness, options: DriveSliceOptions): Promise<SliceResult> {
  const now = options.now ?? Date.now;
  const { until } = options;
  const signals = [options.context?.abortSignal, options.signal].filter((s) => s !== undefined);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const context = withoutAbortSignal(options.context ?? BACKGROUND_CONTEXT);
  let changed: (() => void) | undefined;
  // Every task transition is a commit: wait for those, not for a poll.
  const unsubscribe = harness.subscribeCommits((publication) => {
    if (publication.changes.some((change) => change.type === "task")) changed?.();
  });
  try {
    harness.resume();
    for (;;) {
      // Armed before the read, so that a change right after it is not missed.
      const change = new Promise<void>((resolve) => (changed = resolve));
      const next = await nextWakeAt(harness, context, options);
      if (next === undefined) return { idle: true };
      const current = now();
      const left = until === undefined ? Number.POSITIVE_INFINITY : until - current;
      if (left <= 0 || signal?.aborted === true || next > (until ?? current)) return { idle: false, nextWakeAt: next };
      // Due within the slice: wait for a task to change, its time to come, or the slice to end.
      await settled(change, next > current ? Math.min(left, next - current) : left, signal);
    }
  } finally {
    changed = undefined;
    unsubscribe();
  }
}

const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** Resolves when `promise` resolves, after `ms` (never, when infinite), or when `signal` aborts. */
function settled(promise: Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    // A longer delay than `setTimeout` takes would fire at once; waking early only reads again.
    const timer = Number.isFinite(ms) ? setTimeout(done, Math.min(ms, MAX_TIMER_DELAY)) : undefined;
    signal?.addEventListener("abort", done, { once: true });
    void promise.then(done);
  });
}
