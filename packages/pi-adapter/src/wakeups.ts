/**
 * Wake-ups for a pi-durable `Harness` on a host that lives only during an event and may be evicted
 * between events (a Cloudflare Durable Object): when its pending work next needs the process
 * (`nextWakeAt`), and one bounded slice of driving it (`driveSlice`). Host-agnostic: the host turns
 * `nextWakeAt` into its own timer (an object's alarm, pikit's `wakeups`).
 *
 * pi-durable (1.4.0) sleeps durably: a model retry's backoff, a deferred response's poll and a
 * compaction's retry end their phase asleep until a time, which survives an eviction, and
 * `harness.inspect()` reports each such task `sleeping` with its `until`. A Harness opened with
 * `onWake` keeps no timer for them (one would keep the object alive): the host wakes the process and
 * calls `resume()`, which `driveSlice` does. `Harness.wake()` says the same from memory, but counts the
 * recovery pass a fresh open runs as work, which no commit may end; this reads the inspection.
 *
 * What `nextWakeAt` reads: `harness.inspect()`, the live tasks, and nothing else.
 *
 * - A `running` task is due now: it needs the process until it commits.
 * - A `pending` task is due now: the scheduler reserves it at once (after `resume()`). A sleeping task
 *   past its time, or an abort-marked one, is pending.
 * - A `sleeping` task is due at its `until`.
 * - `waiting`, `completing` and `blocked` tasks are never due by themselves: what they wait for is a
 *   live task counted on its own, and a blocked task (no definition can take it) waits for a code
 *   change, not a time. Unsettled submissions are not read: a queued one waits for a live task of its
 *   conversation, a placed one has one.
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withoutAbortSignal } from "@earendil-works/chord/context";
import type { Harness, HarnessInspection } from "@earendil-works/pi-durable";


export interface WakeOptions {
  /** The clock the Harness was opened with (`HarnessOptions.now`). Default: `Date.now`. */
  now?: (() => number) | undefined;
}

/**
 * The earliest time, on `now`'s clock, at which the Harness's pending work needs the process:
 * `now()` when a task is running or pending, else the earliest sleeping task's time, else
 * `undefined` (nothing to wake for). A time at or before `now()` means at once. Writes nothing.
 */
export async function nextWakeAt(harness: Harness, context: Context, options: WakeOptions = {}): Promise<number | undefined> {
  return nextWakeAtOf(await harness.inspect(context), options);
}

/** `nextWakeAt` over an inspection already read. */
export function nextWakeAtOf(inspection: Pick<HarnessInspection, "tasks">, options: WakeOptions = {}): number | undefined {
  const now = options.now ?? Date.now;
  let earliest: number | undefined;
  for (const { state } of inspection.tasks) {
    // Due now is the earliest anything can be.
    if (state.kind === "running" || state.kind === "pending") return now();
    if (state.kind === "sleeping" && (earliest === undefined || state.until < earliest)) earliest = state.until;
  }
  return earliest;
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
 * One slice of driving the Harness inside a host event: `resume()` (which also wakes the sleeping
 * tasks now due), then let the scheduler run until nothing is due, or until what is due comes after
 * the slice (a retry backoff longer than what is left), or the slice ends. Returns when the host must
 * come back. Leaves the Harness open and scheduling. Rejects when the Harness closes during the slice.
 */
export async function driveSlice(harness: Harness, options: DriveSliceOptions): Promise<SliceResult> {
  const now = options.now ?? Date.now;
  const { until } = options;
  const signals = [options.context?.abortSignal, options.signal].filter((s) => s !== undefined);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const context = withoutAbortSignal(options.context ?? BACKGROUND_CONTEXT);
  let changed: (() => void) | undefined;
  // A task's transitions are stored commits: wait for those. Its invocation ends after its last one,
  // without a commit of its own (a phase that ends asleep): what runs now is looked at again shortly.
  const observation = harness.observeCommits({
    advance: (publication) => {
      if (publication.changes.some((change) => change.type === "task")) changed?.();
    },
    end: () => changed?.(),
  });
  try {
    for (;;) {
      // Armed before the read, so that a change right after it is not missed.
      const change = new Promise<void>((resolve) => (changed = resolve));
      harness.resume();
      const next = await nextWakeAt(harness, context, options);
      if (next === undefined) return { idle: true };
      const current = now();
      const left = until === undefined ? Number.POSITIVE_INFINITY : until - current;
      if (left <= 0 || signal?.aborted === true || next > (until ?? current)) return { idle: false, nextWakeAt: next };
      // Due within the slice: wait for a task to change, its time to come, or the slice to end.
      await settled(change, next > current ? Math.min(left, next - current) : Math.min(left, RECHECK_MS), signal);
    }
  } finally {
    changed = undefined;
    observation.detach();
  }
}

const MAX_TIMER_DELAY = 2 ** 31 - 1;
/** How long a slice waits for a commit while work runs before it looks again (`driveSlice`). */
const RECHECK_MS = 50;

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
