/**
 * deployment-docker: runs a pikit project in Docker on a server (SPEC §9.1, §11).
 *
 * It is not an app component: it runs the app rather than running inside it, so it is not listed in
 * `pikit.config.ts`. It owns three things:
 * - the process entrypoint (`main.ts` → `runEntrypoint`): deadlines, signals, exit codes;
 * - the container's JSON-lines logger (`createJsonLogger`);
 * - the commands the CLI delegates to (`up`, `down`, `restart`, `logs`, `status`), each one
 *   `docker compose …` over the project's `Dockerfile` and `compose.yaml`.
 *
 * Target: `server` (it uses `node:child_process` and the process's signals).
 */

export { runEntrypoint, START_DEADLINE_MS, STOP_DEADLINE_MS, type EntrypointOptions } from "./entrypoint.ts";
export { createJsonLogger, type JsonLoggerOptions, type LogLevel } from "./logger.ts";
export {
  up,
  down,
  restart,
  logs,
  status,
  parseContainers,
  spawnRunner,
  type CommandOptions,
  type ContainerState,
  type LogsOptions,
  type Probe,
  type RunResult,
  type Runner,
  type Status,
  type StatusOptions,
} from "./commands.ts";
