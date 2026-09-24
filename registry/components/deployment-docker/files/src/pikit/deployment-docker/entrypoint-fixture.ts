/**
 * A fixture app for `entrypoint.test.ts`, run in a child process: `bun entrypoint-fixture.ts <mode>`.
 * Its component holds a timer from `start` to `stop`, as a server holds its socket, so the process
 * stays alive until a signal stops it. `<mode>` picks how its start and stop behave:
 * - `ok`: starts and stops;
 * - `start-fails`: its start throws;
 * - `start-hangs`: its start waits until the start deadline (500 ms) cancels it;
 * - `start-waits`: its start waits until cancelled, with a long deadline, so a signal cancels it;
 * - `stop-fails`: its stop throws;
 * - `stop-hangs`: its stop never returns, with a long stop deadline, so only a second signal ends it.
 */

import { defineApp, defineComponent } from "@pikit/core";
import { runEntrypoint } from "./entrypoint.ts";

const mode = process.argv[2] ?? "ok";

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
          // Honours the cancellation, as every component must (SPEC §4.6).
          await aborted(ctx.abortSignal);
          throw new Error("fixture: the start was cancelled");
        }
        timer = setInterval(() => {}, 60_000);
        ctx.logger.info("fixture: started");
      },
      async stop(ctx) {
        if (mode === "stop-hangs") await new Promise(() => {});
        clearInterval(timer);
        if (mode === "stop-fails") throw new Error("fixture: the stop failed on purpose");
        ctx.logger.info("fixture: stopped");
      },
    };
  },
});

await runEntrypoint(defineApp({ components: [fixture] }), {
  startDeadlineMs: mode === "start-hangs" ? 500 : 60_000,
  stopDeadlineMs: mode === "stop-hangs" ? 60_000 : 2_000,
});
