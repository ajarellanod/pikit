/**
 * Runs the sample: `bun samples/http/main.ts`. A stand-in for `pikit up` and the entrypoint a
 * `deployment-*` component will own, following SPEC §9.1:
 * - start with a deadline; if it fails, exit non-zero;
 * - on SIGTERM or SIGINT, stop with a deadline; exit 0 if it stopped cleanly, non-zero otherwise;
 * - a second signal during the stop exits at once.
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from "@pikit/core";
import definition, { config } from "./pikit.config.ts";

const START_DEADLINE_MS = 30_000;
const STOP_DEADLINE_MS = 10_000;

const app = await definition.create();
try {
  await app.start(withAbortSignal(AbortSignal.timeout(START_DEADLINE_MS), BACKGROUND_CONTEXT));
} catch (error) {
  console.error("pikit: the app failed to start", error);
  process.exit(1);
}
console.info(`pikit: ready on http://localhost:${config["server-bun"].port}`);

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) process.exit(1);
  stopping = true;
  try {
    await app.stop(withAbortSignal(AbortSignal.timeout(STOP_DEADLINE_MS), BACKGROUND_CONTEXT));
    process.exit(0);
  } catch (error) {
    console.error("pikit: the app did not stop cleanly", error);
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
