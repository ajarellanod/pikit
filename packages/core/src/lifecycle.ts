/**
 * Start and stop (SPEC §4.6): `start()` runs each component's `start` in dependency order and
 * rolls back on failure; `stop()` runs each `stop` in reverse, even after a failure.
 *
 * Deadlines belong to whoever runs the harness (systemd, a Durable Object constructor), so
 * `start(ctx)` and `stop(ctx)` take a context instead of timeout options. Its cancellation
 * reaches every hook as `ctx.abortSignal`, and the harness stops waiting for a hook that
 * outlives it. `runtime.*` listeners share that deadline. JavaScript cannot kill a promise, so
 * an abandoned hook keeps running and must release what it acquired when it sees the abort.
 * The harness logs abandoned work.
 *
 * A harness is single-use: once `stop()` is called or `start()` fails, it never starts again.
 * Restarting is `create()` again, which is what every target does anyway (a fresh process, a
 * fresh Durable Object). So abandoned work never shares a closure with a new run.
 */

import { type Context, withAbortSignal, withCancel } from "./context.ts";
import type { Logger } from "./contracts/logger.ts";
import type { ComponentLifecycle, HarnessContext } from "./harness.ts";

declare module "./events.ts" {
  interface HarnessEvents {
    "runtime.starting": Record<string, never>;
    "runtime.ready": Record<string, never>;
    "runtime.stopping": Record<string, never>;
    "runtime.stopped": Record<string, never>;
  }
}

type RuntimeEvent = "runtime.starting" | "runtime.ready" | "runtime.stopping" | "runtime.stopped";

const SINGLE_USE = "harness has stopped and is single-use; create() a new one to start again";

/** A component that returned hooks from setup. */
export interface LifecycleEntry {
  name: string;
  hooks: ComponentLifecycle;
}

export interface LifecycleOptions {
  /** In start order. */
  components: readonly LifecycleEntry[];
  /** Builds the harness context each hook and `runtime.*` listener receives. */
  context(inner: Context): HarnessContext;
  logger: Logger;
}

/** The harness's `start`/`stop`; see `Harness` for their contract. */
export interface Lifecycle {
  start(parent: Context): Promise<void>;
  stop(parent: Context): Promise<void>;
}

export function createLifecycle({ components, context, logger }: LifecycleOptions): Lifecycle {
  const lifecycleStep = (label: string, work: () => unknown, signal: AbortSignal | undefined) =>
    bounded(work, signal, () => logger.warn("abandoned at its deadline; it keeps running", { step: label }));
  /** `runtime.*` listeners share the lifecycle deadline. Events cannot fail the harness. */
  const announce = async (ctx: HarnessContext, name: RuntimeEvent): Promise<void> => {
    await lifecycleStep(`${name} listeners`, () => ctx.emit(name, {}), ctx.abortSignal).catch(() => {});
  };

  /**
   * Stops `list` in reverse order under `ctx`. Every stop runs even if an earlier one threw;
   * one still running when `ctx.abortSignal` fires is abandoned and reported.
   */
  const shutdown = async (list: readonly LifecycleEntry[], ctx: HarnessContext): Promise<Error[]> => {
    await announce(ctx, "runtime.stopping");
    const errors: Error[] = [];
    for (const { name, hooks } of [...list].reverse()) {
      try {
        await lifecycleStep(`${name}.stop`, () => hooks.stop?.(ctx), ctx.abortSignal);
      } catch (error) {
        errors.push(new Error(`component "${name}" failed to stop`, { cause: error }));
      }
    }
    await announce(ctx, "runtime.stopped");
    return errors;
  };

  /** One in-flight `start()`: `stop()` cancels it and bounds its rollback with its own deadline. */
  interface Boot {
    done: Promise<void>;
    cancel(reason: unknown): void;
    boundRollback(signal: AbortSignal | undefined): void;
  }

  const boot = (parent: Context): Boot => {
    const { context: bootContext, cancel } = withCancel(parent);
    // The rollback does not inherit the start's cancellation, which is usually why it runs;
    // only a stop() that interrupts the start bounds it.
    const rollback = new AbortController();
    const done = (async () => {
      const ctx = context(bootContext);
      await announce(ctx, "runtime.starting");
      const up: LifecycleEntry[] = [];
      for (const entry of components) {
        try {
          ctx.abortSignal?.throwIfAborted();
          await lifecycleStep(`${entry.name}.start`, () => entry.hooks.start?.(ctx), ctx.abortSignal);
        } catch (error) {
          // Every runtime.starting is closed by runtime.stopped, even when start fails.
          const rollbackCtx = context(withAbortSignal(rollback.signal, withoutCancel(parent)));
          for (const stopError of await shutdown(up, rollbackCtx)) {
            logger.error("rollback after failed start", { error: stopError });
          }
          throw new Error(`component "${entry.name}" failed to start`, { cause: error });
        }
        up.push(entry);
      }
      running = up;
      await announce(ctx, "runtime.ready");
    })();
    return { done, cancel, boundRollback: (signal) => follow(signal, rollback) };
  };

  /** `stopped` is terminal: set by the first `stop()` or by a failed `start()`. */
  let state: "new" | "started" | "stopped" = "new";
  /** The components a successful boot brought up; `stop()` takes them. */
  let running: readonly LifecycleEntry[] | undefined;
  let starting: Boot | undefined;
  let stopping: Promise<void> | undefined;

  return {
    async start(parent) {
      if (state === "stopped") throw new Error(SINGLE_USE);
      if (state === "started") throw new Error("harness already started");
      state = "started";
      starting = boot(parent);
      try {
        await starting.done;
      } catch (error) {
        state = "stopped";
        throw error;
      } finally {
        starting = undefined;
      }
    },

    stop(parent) {
      // Concurrent calls share the first call's shutdown; once it has finished, stop() is a no-op.
      stopping ??= (async () => {
        state = "stopped";
        if (starting) {
          // A SIGTERM during boot: cancel it and let it roll back within this stop's deadline.
          // Its error belongs to the caller of start().
          starting.boundRollback(parent.abortSignal);
          starting.cancel(new Error("harness is stopping"));
          await starting.done.catch(() => {});
        }
        if (running === undefined) return;
        const list = running;
        running = undefined;
        const errors = await shutdown(list, context(parent));
        if (errors.length) throw new AggregateError(errors, "harness stopped with errors");
      })().finally(() => {
        stopping = Promise.resolve();
      });
      return stopping;
    },
  };
}

/**
 * Awaits `work()` unless `signal` aborts first; then calls `onAbandon` and rejects with the
 * abort reason. `work` is always called. An abandoned promise keeps
 * running, and its outcome is consumed here so it cannot surface as an unhandled rejection.
 */
function bounded(
  work: () => unknown,
  signal: AbortSignal | undefined,
  onAbandon: () => void,
): Promise<void> {
  const pending = Promise.resolve().then(work);
  if (signal === undefined) return pending.then(() => {});
  return new Promise<void>((resolve, reject) => {
    // Whichever happens first wins: the work settling, or the abort.
    let decided = false;
    const decide = (outcome: () => void) => {
      if (decided) return;
      decided = true;
      signal.removeEventListener("abort", abandon);
      outcome();
    };
    const abandon = () =>
      decide(() => {
        onAbandon();
        reject(signal.reason);
      });
    pending.then(
      () => decide(resolve),
      (error: unknown) => decide(() => reject(error)),
    );
    if (signal.aborted) {
      // Past the deadline a step still runs and gets one turn of the event loop, so quick cleanup
      // after a slow step is not reported as abandoned.
      setTimeout(abandon, 0);
    } else {
      // Removed by `decide`, so a long-lived signal does not collect one listener per step.
      signal.addEventListener("abort", abandon, { once: true });
    }
  });
}

/** Abort `target` when `signal` aborts (now, if it already has). */
function follow(signal: AbortSignal | undefined, target: AbortController): void {
  if (signal === undefined) return;
  if (signal.aborted) target.abort(signal.reason);
  else signal.addEventListener("abort", () => target.abort(signal.reason), { once: true });
}

/** `parent`'s values without its cancellation (for work that must outlive it, like a rollback). */
function withoutCancel(parent: Context): Context {
  return {
    abortSignal: undefined,
    value: (key) => parent.value(key),
    toString: () => `${parent}.WithoutCancel`,
  };
}
