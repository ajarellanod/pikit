/**
 * The process entrypoint of the server target (SPEC K2), as a service of this machine. The core never
 * times out and never restarts on its own; this file passes the deadlines, and the supervisor (systemd
 * or launchd) restarts the process. It is deployment-docker's entrypoint, plus the watchdog.
 *
 * - `start(ctx)` with a deadline. If it rejects, exit 1: the supervisor starts the process again, and a
 *   half-started app never serves.
 * - At the start deadline, and after a failed start, `stop(ctx)` with the stop deadline bounds the
 *   rollback of whatever had started, and the process exits 1 once it settles. A rollback that hangs
 *   (a socket that never drains) would otherwise keep a process alive that never serves and that the
 *   supervisor never restarts.
 * - On SIGTERM (`systemctl --user stop`, `launchctl bootout`) or SIGINT (Ctrl-C), `stop(ctx)` with a
 *   deadline shorter than the supervisor's (`TimeoutStopSec`, `ExitTimeOut`: 20 s), so the process
 *   exits by itself before it is killed. Exit 0 if every component stopped, 1 if one failed or was
 *   abandoned.
 * - A signal during the start cancels it and counts as a stop.
 * - A second signal during the stop exits at once, with 1: whoever sent it has stopped waiting.
 * - **The watchdog** (`watchdog`, only under the supervisor): once started, it fetches `/health` every
 *   `intervalMs`; on a 503 (`health` says the app is down, past its grace: health-registry), it stops
 *   the app as a signal would and exits 1, and the supervisor starts it again. A refused connection or
 *   a timeout (still starting, or stuck) restarts nothing. This is what deployment-docker's healthcheck
 *   does with Docker.
 *
 * The app is recomposed from `pikit.config.ts`'s components and config with this deployment's
 * logger and target. How a process logs belongs to where it runs, like its deadlines. `logger`,
 * `clock` and `target` set in `pikit.config.ts` are not visible from its definition, so they do not
 * reach the service; pass them here.
 */

import {
  type App,
  type AppDefinition,
  BACKGROUND_CONTEXT,
  type Clock,
  defineApp,
  type Logger,
  withAbortSignal,
} from "@pikit/core";
import { createJsonLogger } from "./logger.ts";

/** Longest a start may take before it is abandoned and rolled back. */
export const START_DEADLINE_MS = 30_000;
/**
 * Longest a stop may take. Keep it below the supervisor's stop budget (`TimeoutStopSec` in
 * pikit.service, `ExitTimeOut` in pikit.plist: 20 s), leaving room to exit: past it the supervisor
 * kills the process, and nothing is cleaned up.
 */
export const STOP_DEADLINE_MS = 10_000;

export interface WatchdogOptions {
  /** The app's `/health`, as this machine reaches it (`http://127.0.0.1:3000/health`). */
  url: string | URL;
  /** Between two probes. Default: 10 s, as deployment-docker's healthcheck. */
  intervalMs?: number;
  /**
   * 503s in a row that stop the app. Default: 1, as deployment-docker's healthcheck: health-registry
   * already says `down` only past its grace, so a blip restarts nothing.
   */
  failures?: number;
  /** How long a probe waits. Default: 5 s. */
  timeoutMs?: number;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

export interface EntrypointOptions {
  /** Default: JSON lines (`createJsonLogger()`). */
  logger?: Logger;
  /** Default: the core's system clock. */
  clock?: Clock;
  /** Default: `START_DEADLINE_MS`. */
  startDeadlineMs?: number;
  /** Default: `STOP_DEADLINE_MS`. */
  stopDeadlineMs?: number;
  /** Restart on `/health`'s 503s. Default: none (`pikit dev`). */
  watchdog?: WatchdogOptions;
}

/** Runs the app until a signal stops it; the process exits from here. Never resolves after a stop. */
export async function runEntrypoint(definition: AppDefinition, options: EntrypointOptions = {}): Promise<void> {
  const logger = options.logger ?? createJsonLogger();
  const startDeadlineMs = options.startDeadlineMs ?? START_DEADLINE_MS;
  const stopDeadlineMs = options.stopDeadlineMs ?? STOP_DEADLINE_MS;

  let running: App;
  try {
    running = await defineApp({
      components: [...definition.components],
      config: definition.config,
      target: "server",
      logger,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }).create();
  } catch (error) {
    // A composition error (missing provider, bad config) is fixed in the project, not by a restart;
    // it still exits non-zero so the supervisor shows it.
    logger.error("pikit: the app could not be composed", { error });
    return process.exit(1);
  }

  // A stop within the stop deadline. Its timer, like the start's, is a `setTimeout`, not
  // `AbortSignal.timeout`: Bun's does not keep the process alive, and a deadline must fire even when
  // a hanging stop has released everything else (the process would drain and skip the other stops).
  const stopWithin = async (what: string): Promise<void> => {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error(`deployment-local: ${what} did not finish within ${stopDeadlineMs} ms`)),
      stopDeadlineMs,
    );
    try {
      await running.stop(withAbortSignal(deadline.signal, BACKGROUND_CONTEXT));
    } finally {
      clearTimeout(timer);
    }
  };

  let stopping = false;
  let watching: ReturnType<typeof setTimeout> | undefined;
  /** Stops the app; exits `cleanExit` if every component stopped, 1 otherwise. */
  const shutdown = (signal: string, cleanExit = 0): void => {
    if (stopping) {
      logger.warn("pikit: second signal, exiting now", { signal });
      process.exit(1);
    }
    stopping = true;
    clearTimeout(watching);
    logger.info("pikit: stopping", { signal, deadlineMs: stopDeadlineMs });
    stopWithin("the stop").then(
      () => {
        logger.info("pikit: stopped");
        process.exit(cleanExit);
      },
      (error: unknown) => {
        logger.error("pikit: the app did not stop cleanly", { error });
        process.exit(1);
      },
    );
  };
  // Registered before the start, so a signal during a slow start cancels it instead of killing it.
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // The rollback of a failed or overdue start (K2): the kernel bounds it only by a stop's deadline.
  let rollingBack: Promise<never> | undefined;
  const rollBack = (): Promise<never> =>
    (rollingBack ??= (async () => {
      try {
        await stopWithin("the rollback");
      } catch (error) {
        logger.error("pikit: the failed start did not roll back cleanly", { error });
      }
      return process.exit(1);
    })());

  logger.info("pikit: starting", { deadlineMs: startDeadlineMs });
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error(`deployment-local: the app did not start within ${startDeadlineMs} ms`));
    // A signal's stop already bounds the rollback.
    if (!stopping) void rollBack();
  }, startDeadlineMs);
  try {
    await running.start(withAbortSignal(deadline.signal, BACKGROUND_CONTEXT));
  } catch (error) {
    // A start cancelled by a signal: the shutdown above reports and exits. A start the deadline had
    // already rolled back failed on its own, even if a signal came during its rollback.
    if (stopping && rollingBack === undefined) return;
    logger.error("pikit: the app failed to start", { error });
    return await rollBack();
  } finally {
    clearTimeout(timer);
  }
  logger.info("pikit: started", { components: running.describe().components.length });

  const watchdog = options.watchdog;
  if (watchdog === undefined || stopping) return;
  const intervalMs = watchdog.intervalMs ?? 10_000;
  const failures = watchdog.failures ?? 1;
  const timeoutMs = watchdog.timeoutMs ?? 5_000;
  const fetcher = watchdog.fetch ?? fetch;
  let unhealthy = 0;
  const probe = async (): Promise<void> => {
    // Only a 503 counts: `health` said down. Another answer resets the count; a refused connection or a
    // timeout neither counts nor resets it, and restarts nothing, as deployment-docker's healthcheck.
    const status = await fetcher(watchdog.url, { signal: AbortSignal.timeout(timeoutMs) }).then(
      (response) => response.status,
      () => undefined,
    );
    if (stopping) return;
    unhealthy = status === 503 ? unhealthy + 1 : status === undefined ? unhealthy : 0;
    if (unhealthy >= failures) {
      logger.error("pikit: /health answered 503, restarting", { times: unhealthy, url: String(watchdog.url) });
      shutdown("watchdog", 1);
      return;
    }
    schedule();
  };
  // One probe at a time; the timer never keeps a process alive whose app let go of everything.
  const schedule = (): void => {
    watching = setTimeout(() => void probe(), intervalMs);
    watching.unref?.();
  };
  schedule();
}
