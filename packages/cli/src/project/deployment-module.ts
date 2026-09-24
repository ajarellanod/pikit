/**
 * The installed `deployment-*` component, as the CLI sees it: the functions its
 * `src/pikit/<name>/index.ts` exports (SPEC §11). The CLI holds no Docker knowledge; it calls these.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectManifest } from "./pikit-json.ts";
import { CliError } from "../ui.ts";

/** The installed `deployment-*` component: exactly one. */
export function deploymentComponent(projectDir: string): string {
  const names = Object.keys(readProjectManifest(projectDir).components).filter((name) => name.startsWith("deployment-"));
  if (names.length === 0) throw new CliError("no deployment-* component is installed; add one, e.g. `pikit add deployment-docker`");
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
