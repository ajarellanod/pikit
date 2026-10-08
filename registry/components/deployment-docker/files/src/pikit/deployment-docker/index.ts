/**
 * deployment-docker: runs a pikit project in Docker on a server.
 *
 * It is not an app component: it runs the app rather than running inside it, so it is not listed in
 * `pikit.config.ts`. It owns three things:
 * - the process entrypoint (`main.ts` → `runEntrypoint`): deadlines, signals, exit codes;
 * - the container's JSON-lines logger (`createJsonLogger`);
 * - the commands the CLI delegates to (`up`, `down`, `restart`, `logs`, `status`), each one
 *   `docker compose …` over the project's `Dockerfile` and `compose.yaml`, and `exec`, which runs a
 *   one-off command where the app runs (`pikit configure` logs in to a model provider with it);
 * - the deployer on the host (`deploy`: `pikit deploy watch | install`), which deploys each new commit
 *   of the project's main branch with `pikit up` and rolls back to the previous image when unhealthy.
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
  exec,
  parseContainers,
  spawnRunner,
  type CommandOptions,
  type ContainerState,
  type ExecOptions,
  type SharedDirectory,
  type LogsOptions,
  type Probe,
  type RunResult,
  type Runner,
  type Status,
  type StatusOptions,
} from "./commands.ts";
export {
  deploy,
  deployOnce,
  watch,
  install,
  probeHealth,
  systemdUnit,
  serviceName,
  noneIrreversible,
  DEFAULT_INTERVAL_SECONDS,
  type DeployOptions,
  type WatchOptions,
  type InstallOptions,
  type Outcome,
} from "./deploy.ts";
