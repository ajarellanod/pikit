/**
 * `pikit up | down | restart | logs | status` and `pikit dev` (SPEC §9.1, §11).
 *
 * The CLI only delegates `[decision]`: `up`, `down`, `restart`, `logs` and `status` are the functions
 * of the same names that the installed `deployment-*` component exports from
 * `src/pikit/<name>/index.ts`. The CLI holds no Docker or systemd knowledge; changing how a project
 * is deployed is editing or swapping that component.
 *
 * `pikit dev` runs the same process locally, with Bun's `--watch`: the deployment component's
 * entrypoint, `src/pikit/<name>/main.ts`, with `.env` loaded.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectManifest } from "../project/pikit-json.ts";
import { projectEnv } from "../project/run.ts";
import { CliError, log } from "../ui.ts";
import { doctor } from "./doctor.ts";

export const DEPLOYMENT_COMMANDS = ["up", "down", "restart", "logs", "status"] as const;
export type DeploymentCommand = (typeof DEPLOYMENT_COMMANDS)[number];

/** The installed `deployment-*` component: exactly one. */
export function deploymentComponent(projectDir: string): string {
  const names = Object.keys(readProjectManifest(projectDir).components).filter((name) => name.startsWith("deployment-"));
  if (names.length === 0) throw new CliError("no deployment-* component is installed; add one, e.g. `pikit add deployment-docker`");
  if (names.length > 1) throw new CliError(`several deployment components are installed (${names.join(", ")}); remove all but one`);
  return names[0] as string;
}

/** `up` and `dev` start the app: refuse before that when doctor would. */
async function checkReady(projectDir: string): Promise<void> {
  const report = await doctor(projectDir, { quiet: true });
  for (const problem of report.problems) log.problem(problem);
  for (const missing of report.unconfigured) log.problem(missing);
  if (report.problems.length + report.unconfigured.length > 0) throw new CliError("fix what `pikit doctor` reports first");
}

export interface DeploymentOptions {
  follow?: boolean;
  tail?: number;
}

export async function deployment(projectDir: string, command: DeploymentCommand, options: DeploymentOptions = {}): Promise<void> {
  const name = deploymentComponent(projectDir);
  const entry = join(projectDir, "src", "pikit", name, "index.ts");
  if (!existsSync(entry)) throw new CliError(`${name} is installed but src/pikit/${name}/index.ts is missing`);
  if (command === "up") await checkReady(projectDir);

  const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const run = module[command];
  if (typeof run !== "function") throw new CliError(`${name} does not export ${command}() from src/pikit/${name}/index.ts`);

  const args: Record<string, unknown> = { cwd: projectDir };
  if (command === "logs") {
    if (options.follow === true) args.follow = true;
    if (options.tail !== undefined) args.tail = options.tail;
  }
  const result: unknown = await run(args);
  if (command === "status") printStatus(result);
  else if (command !== "logs") log.ok(`${command}: done`);
}

function printStatus(result: unknown): void {
  const status = result as { containers?: { name: string; state: string; health: string; status: string }[]; health?: unknown; ready?: unknown };
  for (const c of status.containers ?? []) log.info(`${c.name}: ${c.state}${c.health ? ` (${c.health})` : ""} · ${c.status}`);
  if ((status.containers ?? []).length === 0) log.info("no containers");
  log.info(`GET /health: ${String(status.health)}\nGET /ready:  ${String(status.ready)}`);
}

/** Runs the deployment's entrypoint with `bun --watch` until Ctrl-C; resolves with its exit code. */
export async function dev(projectDir: string): Promise<number> {
  const name = deploymentComponent(projectDir);
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
