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
 * - self-improvement's deployer (`deployer.ts`), compose.yaml's `deployer` service, started by the same
 *   `pikit up` when `proposals-local` is installed: it merges, checks and deploys what an operator
 *   approves, and rolls back to the previous image when unhealthy.
 *
 * Target: `server` (it uses `node:child_process` and the process's signals).
 */

export { runEntrypoint, START_DEADLINE_MS, STOP_DEADLINE_MS, type EntrypointOptions } from "./entrypoint.ts";
export { createJsonLogger, type JsonLoggerOptions, type LogLevel } from "./logger.ts";
export {
  up,
  runBeforeDeployHooks,
  profileArgs,
  SELF_IMPROVEMENT_PROFILE,
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
  createDeployer,
  runDeployer,
  discover,
  ownerCommand,
  probeHealth,
  DEFAULT_INTERVAL_MS,
  FENCED,
  type DeployerOptions,
  type DeployerState,
  type DeployerCheck,
  type DockerSetup,
  type Outcome,
} from "./deployer.ts";
