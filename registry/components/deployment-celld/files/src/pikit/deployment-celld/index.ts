/**
 * deployment-celld: runs a pikit project of the `durable` target on your own machines, a fleet of
 * celld nodes sharing a bucket (self-hosted Durable Objects, `denoland/celld`; features/deployment-celld.md).
 *
 * It is not an app component: it runs the project's Apps rather than running inside them, so it is not
 * listed in `pikit.config.ts`. It owns:
 * - the entrypoint `wrangler.jsonc` deploys (`worker.ts` → `entrypoint.ts` → `host.ts`): the Worker
 *   runs `export const worker`, each `Conversation` Durable Object runs the default export, and both
 *   find the platform in `WORKERS_HOST` (C1, C4, C5), as on Cloudflare;
 * - `wrangler.jsonc`, at the project's root, from which each deploy derives the config celld reads
 *   (`celld-config.mjs`);
 * - the commands the CLI delegates to (`up`, `down`, `logs`, `status`, `dev`), and `pikit doctor`'s
 *   check (`doctor`); `deploy.mjs` deploys from CI by the same rules (`rollout.mjs`);
 * - the nodes' templates (`nodes/`: systemd, Caddy, nftables, ECS) and a GitHub Actions workflow
 *   (`ci/deploy.yml`), which nothing runs: README, "Running a fleet".
 *
 * This file exports only what runs on the machine and what is neutral: `entrypoint.ts` imports
 * `cloudflare:workers` and loads only in celld.
 *
 * Target: `durable`.
 */

export {
  clientAddress,
  createObjectHost,
  createWorkerHost,
  createWorkerServer,
  type WorkerServer,
  GUARD_FIRST_MS,
  GUARD_MAX_MS,
  HEALTH_OBJECT,
  OBJECT_BINDING,
  ROLLBACK_DEADLINE_MS,
  START_DEADLINE_MS,
  START_FAILURES_KEY,
  VERSION_VAR,
  type AlarmInfo,
  type HostOptions,
  type ObjectHost,
  type ObjectNamespace,
  type ObjectState,
  type ObjectStorage,
  type WorkerHost,
} from "./host.ts";
export {
  type AfterDeployIO,
  type BeforeDeployIO,
  type CommandOptions,
  compareVersions,
  type DeployHook,
  type Deployed,
  DEFAULT_UNIT,
  DEV_VARS,
  deployHooks,
  dev,
  doctor,
  type DoctorIO,
  down,
  type FleetCheck,
  logs,
  type LogsOptions,
  machineEnv,
  MIN_CELLD_VERSION,
  type Probe,
  type RunResult,
  type Runner,
  spawnRunner,
  sshNodes,
  status,
  type Status,
  type StatusOptions,
  up,
  type UpOptions,
  url,
} from "./commands.ts";
