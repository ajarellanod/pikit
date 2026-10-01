/**
 * A fixture app for `entrypoint.test.ts`, run in a child process: `bun entrypoint-fixture.ts <mode>`.
 * Its component holds a timer from `start` to `stop`, as a server holds its socket, so the process
 * stays alive until a signal stops it. `<mode>` picks how its start and stop behave:
 * - `ok`: starts and stops;
 * - `start-fails`: its start throws;
 * - `start-hangs`: its start waits until the start deadline (500 ms) cancels it;
 * - `start-waits`: its start waits until cancelled, with a long deadline, so a signal cancels it;
 * - `stop-fails`: its stop throws;
 * - `stop-hangs`: its stop never returns, with a long stop deadline, so only a second signal ends it;
 * - `rollback-hangs`: a second component, `failing`, whose start throws after `fixture` started, and
 *   `fixture`'s stop never returns while its timer runs, so the rollback hangs (K2);
 * - `rollback-hangs-late`: the same, but `failing`'s start never returns and ignores its cancellation.
 * The `rollback-*` modes run with 500 ms start and stop deadlines.
 */

import { defineApp, defineComponent } from "@pikit/core";
import { runEntrypoint } from "./entrypoint.ts";

const mode = process.argv[2] ?? "ok";
const rollback = mode.startsWith("rollback-");

/** Resolves when `signal` aborts, never otherwise. */
const aborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));

const fixture = defineComponent({
  name: "fixture",
  setup() {
    let timer: ReturnType<typeof setInterval> | undefined;
    return {
      async start(ctx) {
        if (mode === "start-fails") throw new Error("fixture: the start failed on purpose");
        if (mode === "start-hangs" || mode === "start-waits") {
          // Honours the cancellation, as every component must.
          await aborted(ctx.abortSignal);
          throw new Error("fixture: the start was cancelled");
        }
        timer = setInterval(() => {}, 60_000);
        ctx.logger.info("fixture: started");
      },
      async stop(ctx) {
        if (mode === "stop-hangs" || rollback) await new Promise(() => {});
        clearInterval(timer);
        if (mode === "stop-fails") throw new Error("fixture: the stop failed on purpose");
        ctx.logger.info("fixture: stopped");
      },
    };
  },
});

const failing = defineComponent({
  name: "failing",
  setup: () => ({
    async start() {
      if (mode === "rollback-hangs-late") await new Promise(() => {});
      throw new Error("failing: the start failed on purpose");
    },
  }),
});

await runEntrypoint(defineApp({ components: rollback ? [fixture, failing] : [fixture] }), {
  startDeadlineMs: mode === "start-hangs" || rollback ? 500 : 60_000,
  stopDeadlineMs: mode === "stop-hangs" ? 60_000 : rollback ? 500 : 2_000,
});
