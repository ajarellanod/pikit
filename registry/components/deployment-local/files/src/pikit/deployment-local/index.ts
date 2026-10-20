/**
 * deployment-local: runs a pikit project as a service of this machine, without Docker: a systemd user
 * unit on Linux, a launchd user agent on macOS.
 *
 * It is not an app component: it runs the app rather than running inside it, so it is not listed in
 * `pikit.config.ts`. It owns:
 * - the process entrypoint (`main.ts` → `local` → `runEntrypoint`): deadlines, signals, exit codes,
 *   and the `/health` watchdog that restarts the app when `health` says it is down;
 * - its JSON-lines logger, into `.pikit/logs/app.log`, rotated (`createJsonLogger`, `createRotatingFile`);
 * - the unit and the plist (`pikit.service`, `pikit.plist`) and the supervisor's commands
 *   (`supervisor.ts`);
 * - the commands the CLI delegates to (`up`, `down`, `restart`, `logs`, `status`, `dev`, `exec`) and
 *   `pikit doctor`'s check (`doctor`).
 *
 * Target: `server` (it uses `node:child_process` and the process's signals).
 */

export { runEntrypoint, START_DEADLINE_MS, STOP_DEADLINE_MS, type EntrypointOptions, type WatchdogOptions } from "./entrypoint.ts";
export { createJsonLogger, createRotatingFile, type JsonLoggerOptions, type LogLevel, type RotatingFileOptions } from "./logger.ts";
export { local, type LocalOptions } from "./local.ts";
export {
  createSupervisor,
  parseLaunchctlPrint,
  parseSystemdShow,
  render,
  serviceFile,
  serviceNames,
  supervisorKind,
  type ServiceNames,
  type ServiceSettings,
  type Supervisor,
  type SupervisorKind,
} from "./supervisor.ts";
export {
  up,
  down,
  restart,
  logs,
  status,
  exec,
  dev,
  doctor,
  runBeforeDeployHooks,
  runAfterDeployHooks,
  spawnRunner,
  UP_TIMEOUT_MS,
  type AfterDeployIO,
  type BeforeDeployIO,
  type CommandOptions,
  type DoctorIO,
  type ExecOptions,
  type LogsOptions,
  type Probe,
  type RunResult,
  type Runner,
  type ServiceState,
  type SharedDirectory,
  type Status,
  type UpOptions,
} from "./commands.ts";
