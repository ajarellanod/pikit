/**
 * `pikit up | down | restart | logs | status` and `pikit dev`.
 *
 * The CLI only delegates `[decision]`: `up`, `down`, `restart`, `logs` and `status` are the functions
 * of the same names that the installed `deployment-*` component exports from
 * `src/pikit/<name>/index.ts`. The CLI holds no Docker or systemd knowledge; changing how a project
 * is deployed is editing or swapping that component.
 * That component's `up` also runs the installed components' deploy hooks (`hooks.beforeDeploy` before
 * it builds, `hooks.afterDeploy` once the new version answers, as `pikit.json` records them); the CLI
 * runs only their `hooks.doctor`, through `pikit doctor`, first.
 *
 * `pikit dev` runs the app locally: the deployment component's `dev` when it exports one
 * (`deployment-cloudflare`: `wrangler dev`), or else its process entrypoint, `src/pikit/<name>/main.ts`,
 * with Bun's `--watch` and `.env` loaded (`deployment-docker`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { deploymentComponent, deploymentExec, loadDeployment } from "../project/deployment-module.ts";
import { checkModelCredentials } from "../project/model-credentials.ts";
import { projectEnv } from "../project/run.ts";
import { CliError, log } from "../ui.ts";
import { doctor } from "./doctor.ts";

export { deploymentComponent };

export const DEPLOYMENT_COMMANDS = ["up", "down", "restart", "logs", "status"] as const;
export type DeploymentCommand = (typeof DEPLOYMENT_COMMANDS)[number];

/** `up` and `dev` start the app: refuse before that when doctor would. */
async function checkReady(projectDir: string): Promise<void> {
  const report = await doctor(projectDir, { quiet: true });
  for (const problem of report.problems) log.problem(problem);
  for (const missing of report.unconfigured) log.problem(missing);
  if (report.problems.length + report.unconfigured.length > 0) throw new CliError("fix what `pikit doctor` reports first");
}

/**
 * `up` refuses to start an agent that cannot reach its model: it checks the credentials where the app
 * runs (the deployment's volume and `.env`), not on this machine, which only `pikit dev` uses.
 */
async function checkAppCredentials(projectDir: string): Promise<void> {
  const exec = await deploymentExec(projectDir);
  if (exec === undefined) return;
  log.step("checking the model credentials where the app runs (the first time, its image is built)");
  const missing = Object.entries((await checkModelCredentials(projectDir, exec)).providers)
    .filter(([, ok]) => !ok)
    .map(([id]) => id);
  for (const id of missing) {
    log.problem(`the model provider "${id}" has no credentials where the app runs: run \`pikit configure\` (log in for \`pikit up\`, or put its API key in .env)`);
  }
  if (missing.length > 0) throw new CliError("the app would start without model credentials");
}

export interface DeploymentOptions {
  follow?: boolean;
  tail?: number;
}

export async function deployment(projectDir: string, command: DeploymentCommand, options: DeploymentOptions = {}): Promise<void> {
  const { name, module } = await loadDeployment(projectDir);
  if (command === "up") {
    await checkReady(projectDir);
    await checkAppCredentials(projectDir);
  }

  const run = module[command];
  if (typeof run !== "function") throw new CliError(`${name} does not export ${command}() from src/pikit/${name}/index.ts`);

  const args: Record<string, unknown> = { cwd: projectDir };
  if (command === "logs") {
    if (options.follow === true) args.follow = true;
    if (options.tail !== undefined) args.tail = options.tail;
  }
  const result: unknown = await run(args);
  if (command === "status") printStatus(result);
  else if (command !== "logs") log.ok(`${command}: done${deployedAt(result)}`);
}

/** What `up` says it deployed, when it says (`deployment-cloudflare`: the version, answering at its URL). */
function deployedAt(result: unknown): string {
  const deployed = (result ?? {}) as { version?: unknown; url?: unknown };
  return typeof deployed.version === "string" && typeof deployed.url === "string" ? `: version ${deployed.version} answers at ${deployed.url}` : "";
}

/** A deployment's status: containers (Docker) or deployments (Cloudflare), then its probes. */
function printStatus(result: unknown): void {
  const status = result as {
    containers?: { name: string; state: string; health: string; status: string }[];
    deployments?: { id: string; created: string; message?: string; versions: { id: string; percentage: number }[] }[];
    url?: string;
    health?: unknown;
    ready?: unknown;
    version?: unknown;
  };
  if (status.deployments !== undefined) {
    for (const d of status.deployments) {
      const versions = d.versions.map((v) => `${v.id} (${v.percentage}%)`).join(", ");
      log.info(`${d.created}  ${versions}${d.message ? ` · ${d.message}` : ""}`);
    }
    if (status.deployments.length === 0) log.info("no deployments");
    const at = status.url === undefined ? " (no URL yet: `pikit up` records it)" : ` at ${status.url}`;
    log.info(`GET /health${at}: ${String(status.health)}${typeof status.version === "string" ? ` from version ${status.version}` : ""}`);
    return;
  }
  for (const c of status.containers ?? []) log.info(`${c.name}: ${c.state}${c.health ? ` (${c.health})` : ""} · ${c.status}`);
  if ((status.containers ?? []).length === 0) log.info("no containers");
  log.info(`GET /health: ${String(status.health)}\nGET /ready:  ${String(status.ready)}`);
}

/** Runs the app here until Ctrl-C; resolves with its exit code. */
export async function dev(projectDir: string): Promise<number> {
  const name = deploymentComponent(projectDir);
  const own = existsSync(join(projectDir, "src", "pikit", name, "index.ts")) ? (await loadDeployment(projectDir)).module.dev : undefined;
  if (typeof own === "function") {
    await checkReady(projectDir);
    // The command shares this terminal: Ctrl-C reaches it directly, and it owns its shutdown. The CLI
    // stays until it has exited.
    const wait = () => {};
    process.on("SIGINT", wait);
    try {
      return await (own as (args: Record<string, unknown>) => Promise<number>)({ cwd: projectDir });
    } finally {
      process.off("SIGINT", wait);
    }
  }
  const main = join("src", "pikit", name, "main.ts");
  if (!existsSync(join(projectDir, main))) throw new CliError(`${name} has no ${main}, the process entrypoint \`pikit dev\` runs`);
  await checkReady(projectDir);

  log.step(`bun --watch ${main}`);
  const child = Bun.spawn([process.execPath, "--watch", main], {
    cwd: projectDir,
    env: projectEnv(projectDir),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // The entrypoint owns the shutdown (its stop deadline); the CLI passes the signal on and waits.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  return await child.exited;
}
