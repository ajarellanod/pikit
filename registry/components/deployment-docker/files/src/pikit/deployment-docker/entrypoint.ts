/**
 * The process entrypoint of the server target (SPEC §9.1). The core never times out and never
 * restarts on its own; this file passes the deadlines, and Docker restarts the process.
 *
 * - `start(ctx)` with a deadline. If it rejects, exit 1: the container restarts (compose's
 *   `restart` policy), and a half-started app never serves.
 * - On SIGTERM (`docker stop`, `docker compose down`) or SIGINT (Ctrl-C), `stop(ctx)` with a
 *   deadline shorter than compose's `stop_grace_period`, so the process exits by itself before
 *   Docker sends SIGKILL. Exit 0 if every component stopped, 1 if one failed or was abandoned.
 * - A signal during the start cancels it (SPEC §4.6) and counts as a stop.
 * - A second signal during the stop exits at once, with 1: whoever sent it has stopped waiting.
 *
 * The app is recomposed from `pikit.config.ts`'s components and config with this deployment's
 * logger and target. How a process logs belongs to where it runs, like its deadlines: in a
 * container, JSON lines on stdout/stderr. `logger`, `clock` and `target` set in `pikit.config.ts`
 * are not visible from its definition, so they do not reach the container; pass them here.
 */

import { type App, type AppDefinition, type Clock, type Logger, BACKGROUND_CONTEXT, defineApp, withAbortSignal } from "@pikit/core";
import { createJsonLogger } from "./logger.ts";

/** Longest a start may take before it is abandoned and rolled back. */
export const START_DEADLINE_MS = 30_000;
/**
 * Longest a stop may take. Keep it below compose.yaml's `stop_grace_period` (20 s), leaving room to
 * exit: past the grace period Docker kills the process, and nothing is cleaned up.
 */
export const STOP_DEADLINE_MS = 10_000;

export interface EntrypointOptions {
  /** Default: JSON lines (`createJsonLogger()`). */
  logger?: Logger;
  /** Default: the core's system clock. */
  clock?: Clock;
  /** Default: `START_DEADLINE_MS`. */
  startDeadlineMs?: number;
  /** Default: `STOP_DEADLINE_MS`. */
  stopDeadlineMs?: number;
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

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      logger.warn("pikit: second signal, exiting now", { signal });
      process.exit(1);
    }
    stopping = true;
    logger.info("pikit: stopping", { signal, deadlineMs: stopDeadlineMs });
    running.stop(withAbortSignal(AbortSignal.timeout(stopDeadlineMs), BACKGROUND_CONTEXT)).then(
      () => {
        logger.info("pikit: stopped");
        process.exit(0);
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

  logger.info("pikit: starting", { deadlineMs: startDeadlineMs });
  try {
    await running.start(withAbortSignal(AbortSignal.timeout(startDeadlineMs), BACKGROUND_CONTEXT));
  } catch (error) {
    // A start cancelled by a signal: the shutdown above reports and exits.
    if (stopping) return;
    logger.error("pikit: the app failed to start", { error });
    return process.exit(1);
  }
  logger.info("pikit: started", { components: running.describe().components.length });
}
