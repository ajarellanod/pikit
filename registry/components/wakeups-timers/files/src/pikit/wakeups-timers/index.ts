/**
 * wakeups-timers: `wakeups` on a server, as in-process timers on the app's clock (SPEC §4.1, C3).
 *
 * - **One loop, one table of requests** (name → time) in memory. The loop runs every handler whose
 *   time has come, then sleeps until the next one is due, a second at most, or until `at` or `cancel`
 *   changes something. That is the shape of the Cloudflare provider too: rows multiplexed over one
 *   alarm, the earliest time setting it.
 * - **At least once, never early, one run per name at a time.** A request is taken when its run
 *   begins; one made during the run (the handler asking again) stands after it.
 * - **Backoff.** A handler that rejects runs again after 1 s, 5 s, 30 s, then every 60 s until it
 *   resolves: the first waits ride out a blip (a database busy for a moment), the cap keeps a broken
 *   handler from spinning, and it never gives up, because nothing else would wake that work again.
 *   Every failure is logged with its count. A request made during the failed run stands if it is
 *   sooner; a `cancel` during it drops the retry.
 * - **An optional slice deadline** (`sliceMs`): a running handler's context is cancelled that long
 *   after its run began, as Cloudflare's provider does to keep each alarm short. Without it, a
 *   handler's context is cancelled only when the app stops. Set it to exercise your handlers' slices
 *   on a server.
 * - **Nothing is persisted.** A restart forgets every request, like a crash would (K6): each
 *   component asks again in its `start` for what its own durable state still needs.
 *
 * `stop` ends the loop, cancels the running handlers' contexts and waits for them, within its
 * deadline; no handler runs after it.
 *
 * Targets: `server`. It imports nothing platform-specific, but a Durable Object keeps running only
 * while an event is in progress, so timers there would not fire: Cloudflare has its own provider.
 */

import { type AppContext, defineComponent, withAbortSignal } from "@pikit/core";
import type { WakeupHandler, Wakeups } from "@pikit/contracts";
import Type from "typebox";

const SECOND = 1_000;
/** The waits after a handler's 1st, 2nd, 3rd and 4th consecutive failure; the last repeats. */
export const BACKOFF_MS = [SECOND, 5 * SECOND, 30 * SECOND, 60 * SECOND] as const;
/** The loop never sleeps longer than this, so a clock that jumps (a machine that slept) is noticed. */
const LONGEST_SLEEP_MS = SECOND;

const Config = Type.Object({
  /** Cancel a running handler's context this long after its run began, in ms. Absent: never. */
  sliceMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** A handler's run in progress. */
interface Run {
  /** `at` or `cancel` was called for its name while it ran: that decides what a failure does. */
  touched: boolean;
  /** Settles when the run ended and its outcome was recorded. Never rejects. */
  done: Promise<void>;
}

export default defineComponent({
  name: "wakeups-timers",
  config: Config,
  setup(pikit, config) {
    const handlers = pikit.useKeyed("wakeup");
    const { clock, logger } = pikit;
    /** The pending request of each name: when it is due, in epoch ms. */
    const requests = new Map<string, number>();
    /** Each name's consecutive failures, until it resolves once. */
    const failures = new Map<string, number>();
    const runs = new Map<string, Run>();
    let running: { stop: AbortController; loop: Promise<void> } | undefined;

    let wake = () => {};
    let woken = new Promise<void>((resolve) => (wake = resolve));
    /** Something changed: the loop looks again now instead of finishing its sleep. */
    const kick = () => {
      wake();
      woken = new Promise<void>((resolve) => (wake = resolve));
    };

    /** A run's outcome: a failure waits its backoff, unless the run itself asked again sooner. */
    const ended = (name: string, run: Run, error: unknown) => {
      if (error === undefined) {
        failures.delete(name);
        return;
      }
      const count = (failures.get(name) ?? 0) + 1;
      failures.set(name, count);
      const wait = BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1] as number;
      const retry = clock.now() + wait;
      const asked = requests.get(name);
      if (!run.touched) requests.set(name, retry);
      else if (asked !== undefined) requests.set(name, Math.min(asked, retry));
      // else: cancelled during the run, so no retry either.
      if (running === undefined) return; // cancelled by the stop: not worth a warning
      const next = requests.get(name);
      logger.warn(`wakeups-timers: the wakeup handler "${name}" failed; ${next === undefined ? "it was cancelled, so it does not run again" : "it runs again later"}`, {
        name,
        failures: count,
        ...(next !== undefined && { retryInMs: next - clock.now() }),
        error: error instanceof Error ? error.message : String(error),
      });
    };

    /** Takes `name`'s request and runs its handler, with a context of its own. */
    const begin = (name: string, base: AppContext) => {
      requests.delete(name);
      const run: Run = { touched: false, done: Promise.resolve() };
      runs.set(name, run);
      let ctx = base;
      if (config.sliceMs !== undefined) {
        const slice = new AbortController();
        const ms = config.sliceMs;
        void clock.sleep(ms).then(() => slice.abort(new Error(`wakeups-timers: "${name}" reached its slice deadline (${ms} ms); ask again for what remains`)));
        ctx = base.derive((inner) => withAbortSignal(slice.signal, inner));
      }
      // `at` only records names that have a handler, and handlers are fixed at setup.
      const handler = handlers.get(name) as WakeupHandler;
      run.done = Promise.resolve()
        .then(() => handler(ctx))
        .then(
          () => ended(name, run, undefined),
          (error: unknown) => ended(name, run, error ?? new Error("rejected with nothing")),
        )
        .finally(() => {
          runs.delete(name);
          kick();
        });
    };

    /** Runs what is due, then sleeps until the next request is due or something changes. */
    const loop = async (base: AppContext, signal: AbortSignal) => {
      while (!signal.aborted) {
        const changed = woken;
        const now = clock.now();
        let next = now + LONGEST_SLEEP_MS;
        for (const [name, time] of requests) {
          if (runs.has(name)) continue; // due or not, it waits for its run to end, which kicks
          if (time <= now) begin(name, base);
          else next = Math.min(next, time);
        }
        await Promise.race([changed, clock.sleep(next - now)]);
      }
    };

    const wakeups: Wakeups = {
      async at(name, time) {
        if (handlers.get(name) === undefined) {
          const known = handlers.keys();
          throw new Error(
            `wakeups-timers: no "wakeup" handler is named "${name}" (named: ${known.length > 0 ? known.join(", ") : "none"}); ` +
              `provide one with pikit.provideKeyed("wakeup", "${name}", handler), or check the name`,
          );
        }
        if (!Number.isFinite(time)) throw new TypeError(`wakeups-timers: the time for "${name}" must be a finite number of epoch milliseconds, got ${time}`);
        requests.set(name, time);
        const run = runs.get(name);
        if (run !== undefined) run.touched = true;
        kick();
      },
      async cancel(name) {
        requests.delete(name);
        const run = runs.get(name);
        if (run !== undefined) run.touched = true;
        kick();
      },
    };
    pikit.provide("wakeups", wakeups);

    return {
      start(ctx) {
        const stop = new AbortController();
        const signal = stop.signal;
        // The start context's values, with the app's stop as the only cancellation: start's own
        // deadline must not cut a handler that runs an hour later.
        const base = ctx.derive((inner) => ({ abortSignal: signal, value: (key) => inner.value(key), toString: () => `${inner}.Wakeup` }));
        running = { stop, loop: loop(base, signal) };
      },
      async stop(ctx) {
        const stopping = running;
        running = undefined;
        if (stopping === undefined) return;
        stopping.stop.abort(new Error("wakeups-timers: the app is stopping"));
        kick();
        await stopping.loop;
        // Running handlers saw their context cancelled; wait for them within the stop's deadline.
        await Promise.race([Promise.all([...runs.values()].map((run) => run.done)), aborted(ctx.abortSignal)]);
      },
    };
  },
});

/** Resolves when `signal` aborts; never, without one. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}
