/**
 * `pikit up | down | restart | logs | status`, `pikit deploy watch | install` and `pikit dev`.
 *
 * The CLI only delegates `[decision]`: `up`, `down`, `restart`, `logs` and `status` are the functions
 * of the same names that the installed `deployment-*` component exports from
 * `src/pikit/<name>/index.ts` (the protocol: `DeploymentModule`, in `project/deployment-module.ts`).
 * The CLI holds no Docker or systemd knowledge; changing how a project is deployed is editing or
 * swapping that component.
 * That component's `up` also runs the installed components' deploy hooks (`hooks.beforeDeploy` before
 * it builds, `hooks.afterDeploy` once the new version answers, as `pikit.json` records them); the CLI
 * runs only their `hooks.doctor`, through `pikit doctor`, first.
 *
 * `pikit deploy watch | install` is the deployment's optional `deploy`: on a server, the deployer that
 * deploys each merge into the main branch (deployment-docker: `git fetch`, then `pikit up`, rolling
 * back when unhealthy). It runs `pikit up` as this CLI, so the CLI tells it how to run itself.
 *
 * `pikit dev` runs the app locally: the deployment component's `dev` when it exports one
 * (`deployment-cloudflare`: `wrangler dev`), or else its process entrypoint, `src/pikit/<name>/main.ts`,
 * with Bun's `--watch` and `.env` loaded (`deployment-docker`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type DeployAction,
  DEPLOYMENT_COMMANDS,
  type DeploymentCommand,
  type DeploymentStatus,
  deploymentComponent,
  deploymentExec,
  loadDeployment,
} from "../project/deployment-module.ts";
import { apiKeyHint, checkModelCredentials, providersNamed } from "../project/model-credentials.ts";
import type { ProbeResult } from "../project/probe.ts";
import { projectEnv } from "../project/run.ts";
import { CliError, log } from "../ui.ts";
import { doctor } from "./doctor.ts";

export { DEPLOYMENT_COMMANDS, type DeploymentCommand, deploymentComponent };

/**
 * `up` and `dev` start the app: refuse before that when doctor would. `up` leaves the check of a
 * component with a `beforeDeploy` hook to that hook, which it runs right before the build. `dev` also
 * checks the model credentials on this machine (`checkLocalCredentials`); `up` checks them where the
 * app runs (`checkAppCredentials`).
 */
async function checkReady(projectDir: string, command: "up" | "dev"): Promise<void> {
  const report = await doctor(projectDir, { quiet: true, componentChecks: command === "up" ? "unless-before-deploy" : true });
  for (const problem of report.problems) log.problem(problem);
  for (const missing of report.unconfigured) log.problem(missing);
  if (report.problems.length + report.unconfigured.length > 0) throw new CliError("fix what `pikit doctor` reports first");
  if (command === "dev") await checkLocalCredentials(projectDir, report.probe);
}

/**
 * `dev` refuses to start an agent that cannot reach its model from this machine: a login in `.pikit/`
 * here, or the API key in `.env` or the shell's environment. Not a doctor check: a login made for
 * `pikit up` is kept where the app runs, never here, and doctor must not fail `up` for it. Only the
 * installed providers the agents name are checked; with none (no provider installed yet, so nothing
 * runs a model), there is nothing to check and no adapter to check it with.
 */
async function checkLocalCredentials(projectDir: string, probed: ProbeResult): Promise<void> {
  if (!probed.ok) return;
  const used = providersNamed(probed);
  const installed = Object.keys(probed.description.capabilities["model.provider"]?.keys ?? {});
  if (!installed.some((id) => used === undefined || used.has(id))) return;
  const checked = await checkModelCredentials(projectDir, undefined, used);
  const missing = Object.entries(checked.providers)
    .filter(([, ok]) => !ok)
    .map(([id]) => id);
  for (const id of missing) {
    // A login is kept by `model.credentials`: without one (on Cloudflare), or for a provider with no
    // OAuth login, the key is the only way.
    const login = checked.store === undefined || !checked.oauth.includes(id) ? "" : `run \`pikit configure --login ${id} --local\`, or `;
    log.problem(`the model provider "${id}" has no credentials on this machine, for \`pikit dev\`: ${login}${apiKeyHint(projectDir, checked, id)}`);
  }
  if (missing.length > 0) throw new CliError("the app would start without model credentials");
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
    await checkReady(projectDir, "up");
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

/**
 * `pikit deploy <action>`: the deployment's `deploy`. `watch` runs until SIGTERM or SIGINT, which
 * stop it once the deploy in progress is done.
 */
export async function deployCommand(projectDir: string, action: DeployAction, options: { intervalSeconds?: number } = {}): Promise<void> {
  const { name, module } = await loadDeployment(projectDir);
  const run = module.deploy;
  if (typeof run !== "function") {
    throw new CliError(`${name} does not export deploy() from src/pikit/${name}/index.ts: it has no deployer to run here`);
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await (run as (args: Record<string, unknown>) => Promise<unknown>)({
      cwd: projectDir,
      action,
      // This CLI, as this machine runs it: the deployer's `pikit up`, and the service's ExecStart.
      cli: [process.execPath, join(import.meta.dir, "..", "main.ts")],
      ...(options.intervalSeconds !== undefined && { intervalSeconds: options.intervalSeconds }),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

/** What `up` says it deployed, when it says (`deployment-cloudflare`: the version, answering at its URL). */
function deployedAt(result: unknown): string {
  const deployed = (result ?? {}) as { version?: unknown; url?: unknown };
  return typeof deployed.version === "string" && typeof deployed.url === "string" ? `: version ${deployed.version} answers at ${deployed.url}` : "";
}

/**
 * A deployment's status: its `lines` as they are (`DeploymentStatus`); what they say is the
 * component's, so the CLI knows nothing of containers or deployments. Any other result is printed as
 * JSON, not guessed at.
 */
export function printStatus(result: unknown): void {
  const lines = (result as Partial<DeploymentStatus> | undefined)?.lines;
  if (Array.isArray(lines)) {
    for (const line of lines) log.info(String(line));
    return;
  }
  // Not a `DeploymentStatus`: shown whole, rather than guessed at.
  log.info(JSON.stringify(result, null, 2) ?? String(result));
}

/** Runs the app here until Ctrl-C; resolves with its exit code. */
export async function dev(projectDir: string): Promise<number> {
  const name = deploymentComponent(projectDir);
  const own = existsSync(join(projectDir, "src", "pikit", name, "index.ts")) ? (await loadDeployment(projectDir)).module.dev : undefined;
  if (typeof own === "function") {
    await checkReady(projectDir, "dev");
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
  await checkReady(projectDir, "dev");

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
