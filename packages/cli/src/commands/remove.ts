/**
 * `pikit remove <component>`: the install flow in reverse (SPEC §10.5), so that removing leaves the
 * project as it was before `add` (S3).
 *
 * It refuses when another component requires (`use`) a capability this one is the only provider
 * of; losing the provider of an optional capability is allowed and `doctor` reports it. The answer
 * comes from the app itself (`describe()`), not from manifests, so project components count too.
 * It never deletes a file the user modified without `--force`.
 *
 * What was installed *for* it (an offered provider, SPEC §10.5) goes with it when nothing else uses
 * it, so `add` then `remove` leaves no trace even when `add` brought a provider along. When another
 * component uses it now, it stays, installed for that one.
 */

import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageName, scanImports } from "../registry/imports.ts";
import { CONFIG_FILE, removeComponent, removeConfigEntry } from "../project/config-file.ts";
import { ENV_EXAMPLE, removeExampleBlock } from "../project/env-file.ts";
import { readPackageJson, removeDependencies, writePackageJson } from "../project/package-json.ts";
import { type ProjectManifest, modifiedFiles, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { probe } from "../project/run.ts";
import { EXTENSION_ALIAS } from "../project/vendor.ts";
import { CliError, log } from "../ui.ts";
import { doctor, projectSources } from "./doctor.ts";
import { bunInstall } from "./install.ts";

export interface RemoveOptions {
  /** Delete modified files, and remove even when the app does not compose. */
  force?: boolean;
}

export async function remove(projectDir: string, name: string, options: RemoveOptions = {}): Promise<void> {
  const project = readProjectManifest(projectDir);
  const installed = project.components[name];
  if (installed === undefined) throw new CliError(`${name} is not installed (pikit.json has ${Object.keys(project.components).join(", ") || "nothing"})`);

  await checkNoDependents(projectDir, name, options.force === true);

  const modified = modifiedFiles(projectDir, installed);
  if (modified.length > 0 && options.force !== true) {
    throw new CliError(`you modified these files of ${name}; pass --force to delete them anyway:\n  ${modified.join("\n  ")}`);
  }

  // pikit.config.ts first: if its shape is not recognised, nothing has been deleted yet.
  const configPath = join(projectDir, CONFIG_FILE);
  const config = readFileSync(configPath, "utf8");
  const nextConfig = removeConfigEntry(removeComponent(config, name), name);
  if (nextConfig !== config) writeFileSync(configPath, nextConfig);

  for (const file of Object.keys(installed.files)) {
    rmSync(join(projectDir, file), { force: true });
    removeEmptyParents(projectDir, dirname(file));
  }

  const examplePath = join(projectDir, ENV_EXAMPLE);
  if (existsSync(examplePath)) {
    const example = readFileSync(examplePath, "utf8");
    const next = removeExampleBlock(example, name);
    if (next === "") rmSync(examplePath);
    else if (next !== example) writeFileSync(examplePath, next);
  }

  delete project.components[name];
  writeProjectManifest(projectDir, project);

  const pkg = readPackageJson(projectDir);
  const removed = removeDependencies(pkg, unneededDependencies(projectDir, project, installed.dependencies));
  if (removed.length > 0) {
    writePackageJson(projectDir, pkg);
    await bunInstall(projectDir);
  }

  log.ok(`${name} removed${removed.length > 0 ? ` (and the npm packages only it used: ${removed.join(", ")})` : ""}`);
  const report = await doctor(projectDir, { quiet: true });
  for (const problem of report.problems) log.problem(problem);
  if (report.problems.length > 0) throw new CliError(`\`pikit doctor\` found ${report.problems.length} problem(s) after removing ${name}`);

  for (const leftover of await installedOnlyFor(projectDir, name)) {
    log.step(`${leftover} was installed for ${name}, and nothing uses it now`);
    await remove(projectDir, leftover, options);
  }
}

/**
 * The components installed for `name` (after it is gone) that nothing uses: the ones to remove.
 * Another installed for `name` that something still uses stays, installed for its users now.
 */
async function installedOnlyFor(projectDir: string, name: string): Promise<string[]> {
  const project = readProjectManifest(projectDir);
  const candidates = Object.entries(project.components).filter(([, c]) => c.installedFor?.includes(name));
  if (candidates.length === 0) return [];
  const result = await probe(projectDir);
  const components = result.ok ? result.description.components : [];
  const usersOf = (component: string): string[] => {
    const provides = new Set(components.find((c) => c.name === component)?.provides ?? []);
    return components.filter((c) => c.name !== component && [...c.requires, ...c.optional].some((cap) => provides.has(cap))).map((c) => c.name);
  };
  const leftovers: string[] = [];
  for (const [component, installed] of candidates) {
    const others = (installed.installedFor ?? []).filter((n) => n !== name);
    const users = result.ok ? usersOf(component) : others;
    if (others.length === 0 && users.length === 0) leftovers.push(component);
    else installed.installedFor = [...new Set([...others, ...users])];
  }
  writeProjectManifest(projectDir, project);
  return leftovers;
}

/** Refuses when a remaining component requires a capability only this component provides. */
async function checkNoDependents(projectDir: string, name: string, force: boolean): Promise<void> {
  const result = await probe(projectDir);
  if (!result.ok) {
    if (force) return;
    throw new CliError(`the app does not compose now, so what depends on ${name} is unknown: ${result.error}\nFix it (\`pikit doctor\`) or pass --force`);
  }
  const { components, capabilities, config } = result.description;
  const blockers: string[] = [];
  for (const [capability, { providers }] of Object.entries(capabilities)) {
    if (!providers.includes(name) || providers.some((p) => p !== name)) continue;
    for (const c of components) if (c.name !== name && c.requires.includes(capability)) blockers.push(`${c.name} requires ${capability}`);
  }
  const selection = (config.capabilities ?? {}) as Record<string, string>;
  for (const [capability, chosen] of Object.entries(selection)) {
    if (chosen === name) blockers.push(`config.capabilities selects ${name} for ${capability}`);
  }
  if (blockers.length > 0) {
    throw new CliError(`${name} cannot be removed; it is the only provider of what the app needs:\n  ${blockers.join("\n  ")}\nInstall another provider first.`);
  }
}

/**
 * The component's npm packages that nothing else needs: no remaining component declares it, no
 * source file of the project imports it, and it is not the kit.
 */
function unneededDependencies(projectDir: string, project: ProjectManifest, declared: Record<string, string>): string[] {
  const needed = new Set(Object.values(project.components).flatMap((c) => Object.keys(c.dependencies)));
  for (const file of projectSources(projectDir)) {
    for (const specifier of scanImports(readFileSync(join(projectDir, file), "utf8"))) needed.add(packageName(specifier));
  }
  return Object.keys(declared).filter((pkg) => !needed.has(pkg) && pkg !== "@pikit/core" && pkg !== EXTENSION_ALIAS);
}

function removeEmptyParents(projectDir: string, dir: string): void {
  let current = dir;
  while (current !== "." && current !== "" && current !== "src") {
    const path = join(projectDir, current);
    if (!existsSync(path) || readdirSync(path).length > 0) return;
    rmdirSync(path);
    current = dirname(current);
  }
}
