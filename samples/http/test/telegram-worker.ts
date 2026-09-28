/**
 * A process that is killed mid-run: `bun telegram-worker.ts <dataDir> <apiBase>`, for `answers.test.ts`.
 *
 * It runs the Telegram composition of `telegram.ts`. Its `hold` tool prints `held` and never returns,
 * so the test kills it (SIGKILL: no stop, no cleanup) once Telegram has the message acknowledged.
 */

import { telegramApp } from "./telegram.ts";

const [dataDir, apiBase] = process.argv.slice(2);
if (dataDir === undefined || apiBase === undefined) throw new Error("usage: telegram-worker.ts <dataDir> <apiBase>");

const app = await telegramApp({
  dataDir,
  apiBase,
  hold: () => {
    process.stdout.write("held\n");
    return new Promise<string>(() => {});
  },
}).create();
await app.start();
