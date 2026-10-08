/**
 * The installed `deployment-*` component, as the CLI sees it: the functions its
 * `src/pikit/<name>/index.ts` exports. The CLI holds no Docker knowledge; it calls these.
 *
 * The protocol between them is declared here, once (`DeploymentModule`, `DEPLOYMENT_EXPORTS`): the
 * CLI calls it, and `registry validate` checks every `deployment-*` component's entry against it.
 * A component is a deployment by its name's prefix, as every kind is.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectManifest } from "./pikit-json.ts";
import { CliError } from "../ui.ts";

/**
 * What a deployment's `status` returns for `pikit status` to print as it is, one line each. What the
 * lines say (containers, deployments, probes) is the component's; it may return more fields beside
 * them, which the CLI does not read.
 */
export interface DeploymentStatus {
  lines: string[];
}

/**
 * The functions a `deployment-*` component's `index.ts` exports for the CLI, each called with the
 * project's directory as `cwd`. An optional one may be absent: the CLI says so (`restart`), or does
 * without it (`dev` runs `main.ts`; without `exec`, the app runs on this machine).
 */
export interface DeploymentModule {
  /** `pikit up`: deploys; may resolve with `{ version, url }`, which the CLI prints. */
  up(args: { cwd: string }): Promise<unknown>;
  down(args: { cwd: string }): Promise<unknown>;
  restart?(args: { cwd: string }): Promise<unknown>;
  logs(args: { cwd: string; follow?: boolean; tail?: number }): Promise<unknown>;
  /** A `DeploymentStatus`. */
  status(args: { cwd: string }): Promise<unknown>;
  /** `pikit dev`: runs the app here until Ctrl-C; resolves with its exit code. */
  dev?(args: { cwd: string }): Promise<number>;
  /** `AppExec`, where the app runs. */
  exec?(args: { cwd: string } & Parameters<AppExec>[0]): Promise<number>;
}

/** Every export of `DeploymentModule`, and whether each is required; tsc keeps the two in step. */
export const DEPLOYMENT_EXPORTS = {
  up: "required",
  down: "required",
  restart: "optional",
  logs: "required",
  status: "required",
  dev: "optional",
  exec: "optional",
} as const satisfies { [K in keyof DeploymentModule]-?: {} extends Pick<DeploymentModule, K> ? "optional" : "required" };

/** The commands `pikit <command>` delegates to the export of the same name. */
export const DEPLOYMENT_COMMANDS = ["up", "down", "restart", "logs", "status"] as const satisfies readonly (keyof DeploymentModule)[];
export type DeploymentCommand = (typeof DEPLOYMENT_COMMANDS)[number];

/** The installed `deployment-*` component: exactly one. */
export function deploymentComponent(projectDir: string): string {
  const project = readProjectManifest(projectDir);
  const names = Object.keys(project.components).filter((name) => name.startsWith("deployment-"));
  if (names.length === 0) {
    const example = project.targets.includes("durable") ? "deployment-cloudflare" : "deployment-docker";
    throw new CliError(`no deployment-* component is installed; add one, e.g. \`pikit add ${example}\``);
  }
  if (names.length > 1) throw new CliError(`several deployment components are installed (${names.join(", ")}); remove all but one`);
  return names[0] as string;
}

/** The deployment component's exports, loaded from the project. */
export async function loadDeployment(projectDir: string): Promise<{ name: string; module: Record<string, unknown> }> {
  const name = deploymentComponent(projectDir);
  const entry = join(projectDir, "src", "pikit", name, "index.ts");
  if (!existsSync(entry)) throw new CliError(`${name} is installed but src/pikit/${name}/index.ts is missing`);
  return { name, module: (await import(pathToFileURL(entry).href)) as Record<string, unknown> };
}

/**
 * Runs a command where the app runs (`pikit up`'s app, not this machine) and resolves with its exit
 * code. `share` lists this machine's directories the command needs, at the same path there.
 */
export type AppExec = (options: { command: string[]; share: { path: string; writable?: boolean }[]; interactive: boolean }) => Promise<number>;

/**
 * The deployment's `exec`, bound to the project; `undefined` when no deployment component is
 * installed, or when it does not export one (it runs the app on this machine, as `pikit dev` does).
 */
export async function deploymentExec(projectDir: string): Promise<AppExec | undefined> {
  const installed = Object.keys(readProjectManifest(projectDir).components).filter((name) => name.startsWith("deployment-"));
  if (installed.length !== 1) return undefined;
  const { module } = await loadDeployment(projectDir);
  const exec = module.exec;
  if (typeof exec !== "function") return undefined;
  return (options) => (exec as (args: Record<string, unknown>) => Promise<number>)({ cwd: projectDir, ...options });
}
