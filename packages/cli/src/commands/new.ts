/**
 * `pikit new <dir> [--preset <name>] [--registry <path>]`: a new project.
 *
 * It writes the project's own part (`starter.ts`), vendors the kit packages into `vendor/`, adds
 * every component of the preset through the same install flow as `pikit add` (SPEC §10.5), runs
 * `bun install` once, and ends with `pikit doctor`. A preset is a list of `add` calls and nothing
 * else: no step here reads the preset's name.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { CONFIG_FILE, setConfigEntry } from "../project/config-file.ts";
import { emptyManifest, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { openRegistry } from "../project/registry-source.ts";
import { vendorKit } from "../project/vendor.ts";
import { CliError, log } from "../ui.ts";
import { installComponent } from "./add.ts";
import { doctor } from "./doctor.ts";
import { bunInstall } from "./install.ts";
import * as starter from "./starter.ts";

export interface NewOptions {
  preset?: string;
  registry?: string;
  /** Print what to run next. Default: true; the guided path (`wizard.ts`) runs it instead. */
  next?: boolean;
  /** Say what is done, not each component's files and `bun install`'s output (the guided path). */
  quiet?: boolean;
}

/** A project's directory name is its package name. */
export function validProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

export async function newProject(dir: string, options: NewOptions = {}): Promise<void> {
  const projectDir = resolve(dir);
  if (existsSync(projectDir) && readdirSync(projectDir).length > 0) throw new CliError(`${projectDir} exists and is not empty`);
  const name = basename(projectDir);
  if (!validProjectName(name)) throw new CliError(`"${name}" is not a valid package name: use lowercase letters, digits, "-", "." or "_"`);

  // Everything that can be refused is checked before the first file is written.
  const registry = openRegistry(options.registry ?? DEFAULT_REGISTRY);
  const components = options.preset === undefined ? [] : registry.preset(options.preset);
  for (const component of components) registry.manifest(component);
  const tools = components.flatMap((c) => Object.keys(registry.manifest(c).replay?.tools ?? {}));

  log.step(`creating ${projectDir}${options.preset ? ` from the preset "${options.preset}"` : ""}`);
  mkdirSync(join(projectDir, "src", "agents", starter.STARTER_AGENT), { recursive: true });
  mkdirSync(join(projectDir, "src", "extensions"), { recursive: true });
  const kit = vendorKit(projectDir);
  const write = (file: string, text: string) => writeFileSync(join(projectDir, file), text);
  write("package.json", starter.packageJson(name, kit));
  write("tsconfig.json", starter.tsconfig());
  write(".gitignore", starter.GITIGNORE);
  write("README.md", starter.readme(name, components));
  write(CONFIG_FILE, starter.CONFIG);
  write(`src/agents/${starter.STARTER_AGENT}/agent.ts`, starter.agent(tools));
  write("src/extensions/agents.ts", starter.AGENTS);
  write("src/extensions/permission-gate.ts", starter.permissionGate());
  writeProjectManifest(projectDir, emptyManifest(registry.root));

  for (const component of components) {
    const wiring = starter.STARTER_WIRING[component];
    await installComponent(projectDir, component, { yes: true, quiet: options.quiet === true, ...(wiring !== undefined && { wiring }) });
  }
  const installed = Object.keys(readProjectManifest(projectDir).components);
  let config = readFileSync(join(projectDir, CONFIG_FILE), "utf8");
  for (const [component, value] of Object.entries(starter.STARTER_CONFIG)) {
    if (installed.includes(component)) config = setConfigEntry(config, component, value);
  }
  write(CONFIG_FILE, config);

  await bunInstall(projectDir, { quiet: options.quiet === true });

  log.step("pikit doctor");
  const report = await doctor(projectDir, { quiet: true });
  for (const problem of report.problems) log.problem(problem);
  if (report.problems.length > 0) throw new CliError(`the new project has ${report.problems.length} problem(s)`);
  log.ok(`created ${name} with ${installed.length} component(s); the app composes`);
  if (options.next === false) return;
  log.info(`\nNext:\n  cd ${dir}\n  pikit configure   # ${report.unconfigured.length > 0 ? "set the variables it needs, and log in to a model provider" : "log in to a model provider"}\n  pikit dev         # or \`pikit up\` to run it in Docker`);
}
