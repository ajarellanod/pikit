/**
 * Start and stop (SPEC §4.6): `start()` runs each component's `start` in dependency order and
 * rolls back on failure; `stop()` runs each `stop` in reverse, even after a failure.
 *
 * Deadlines belong to whoever runs the harness (systemd, a Durable Object constructor), so
 * `start(ctx)` and `stop(ctx)` take a context instead of timeout options. Its cancellation
 * reaches every hook as `ctx.abortSignal`, and the harness stops waiting for a hook that
 * outlives it. `runtime.*` listeners share that deadline. JavaScript cannot kill a promise, so
 * an abandoned hook keeps running and must release what it acquired when it sees the abort.
 * The harness logs abandoned work, and refuses to start again until it has settled.
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

/**
 * Log messages for abandoned lifecycle work (`fields.step` names it). Not public API, but
 * `@pikit/core/testing` observes them to tell when abandoned work has settled.
 */
export const ABANDONED_MESSAGE = "abandoned at its deadline; it keeps running";
export const SETTLED_MESSAGE = "abandoned step settled";

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
  /**
   * Work abandoned at a deadline that has not settled yet, by label. It keeps running and
   * shares its component's closure, so `start()` refuses to run beside it: a late `stop` could
   * otherwise release what the new run acquired.
   */
  const abandoned = new Map<Promise<unknown>, string>();
  const lifecycleStep = (label: string, work: () => unknown, signal: AbortSignal | undefined) =>
    bounded(work, signal, (pending) => {
      logger.warn(ABANDONED_MESSAGE, { step: label });
      abandoned.set(pending, label);
      const settled = () => {
        abandoned.delete(pending);
        logger.info(SETTLED_MESSAGE, { step: label });
      };
      pending.then(settled, settled);
    });
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
          started = false;
          throw new Error(`component "${entry.name}" failed to start`, { cause: error });
        }
        up.push(entry);
      }
      running = up;
      await announce(ctx, "runtime.ready");
    })();
    return { done, cancel, boundRollback: (signal) => follow(signal, rollback) };
  };

  let started = false;
  let running: readonly LifecycleEntry[] = [];
  let starting: Boot | undefined;
  let stopping: Promise<void> | undefined;

  return {
    async start(parent) {
      if (stopping) throw new Error("harness is stopping");
      if (started) throw new Error("harness already started");
      if (abandoned.size) {
        throw new Error(`harness cannot start: abandoned work still running (${[...abandoned.values()].join(", ")})`);
      }
      started = true;
      starting = boot(parent);
      try {
        await starting.done;
      } finally {
        starting = undefined;
      }
    },

    stop(parent) {
      stopping ??= (async () => {
        if (starting) {
          // A SIGTERM during boot: cancel it and let it roll back within this stop's deadline.
          // Its error belongs to the caller of start().
          starting.boundRollback(parent.abortSignal);
          starting.cancel(new Error("harness is stopping"));
          await starting.done.catch(() => {});
        }
        if (!started) return;
        started = false;
        const errors = await shutdown(running, context(parent));
        running = [];
        if (errors.length) throw new AggregateError(errors, "harness stopped with errors");
      })().finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}

/**
 * Awaits `work()` unless `signal` aborts first; then calls `onAbandon` with the still-pending
 * work and rejects with the abort reason. `work` is always called. An abandoned promise keeps
 * running, and its outcome is consumed here so it cannot surface as an unhandled rejection.
 */
function bounded(
  work: () => unknown,
  signal: AbortSignal | undefined,
  onAbandon: (pending: Promise<unknown>) => void,
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
        onAbandon(pending);
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
