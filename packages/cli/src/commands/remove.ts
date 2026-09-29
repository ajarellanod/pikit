/**
 * `pikit remove <component>`: the install flow in reverse (SPEC §10.5), so that removing leaves the
 * project as it was before `add` (S3).
 *
 * It refuses when another component requires (`use`) a capability this one is the only provider
 * of; losing the provider of an optional capability is allowed and `doctor` reports it. Without
 * `--force`, it also refuses to take a key an agent names (a tool, an extension, a model's provider):
 * the app would compose and the runtime refuse to start. The answer
 * comes from the app itself (`describe()`), not from manifests, so project components count too.
 * It never deletes a file the user modified without `--force`. The bases of its files (`bases.ts`) go
 * with it, unless another component installed the same content.
 *
 * What was installed *for* it (an offered provider, SPEC §10.5) goes with it when nothing else uses
 * it, so `add` then `remove` leaves no trace even when `add` brought a provider along. When another
 * component uses it now, it stays, installed for that one.
 *
 * On Cloudflare it undoes both Apps (SPEC C1): its entries leave every `components` list, its config
 * keys leave `config` and `workerConfig` (its Worker half's is `<name>-worker`), and what depends on
 * it is looked for in each App.
 */

import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageName, scanImports } from "../registry/imports.ts";
import { BASES_DIR, unreferencedBases } from "../project/bases.ts";
import { workerHalfName } from "../project/apps.ts";
import { CONFIG_FILE, removeComponent, removeConfigEntry, WORKER_CONFIG } from "../project/config-file.ts";
import type { AppDescription } from "../project/probe.ts";
import { ENV_EXAMPLE, removeExampleBlock } from "../project/env-file.ts";
import { readPackageJson, removeDependencies, writePackageJson } from "../project/package-json.ts";
import { type ProjectManifest, modifiedFiles, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { brokenReferences } from "../project/references.ts";
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

  await checkNoDependents(projectDir, project, name, options.force === true);

  const modified = modifiedFiles(projectDir, installed);
  if (modified.length > 0 && options.force !== true) {
    throw new CliError(`you modified these files of ${name}; pass --force to delete them anyway:\n  ${modified.join("\n  ")}`);
  }

  // pikit.config.ts first: if its shape is not recognised, nothing has been deleted yet.
  const configPath = join(projectDir, CONFIG_FILE);
  const config = readFileSync(configPath, "utf8");
  let nextConfig = removeConfigEntry(removeComponent(config, name), name);
  // The Worker's App's keys: its own (in both Apps) and its Worker half's, unless that is another component.
  for (const key of [name, workerHalfName(name)].filter((key) => key === name || !(key in project.components))) {
    nextConfig = removeConfigEntry(nextConfig, key, WORKER_CONFIG);
  }
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
  for (const base of unreferencedBases(projectDir, project)) rmSync(join(projectDir, base));
  removeEmptyParents(projectDir, BASES_DIR);

  const pkg = readPackageJson(projectDir);
  const removed = removeDependencies(pkg, unneededDependencies(projectDir, project, installed.dependencies));
  if (removed.length > 0) {
    writePackageJson(projectDir, pkg);
    await bunInstall(projectDir);
  }

  log.ok(`${name} removed${removed.length > 0 ? ` (and the npm packages only it used: ${removed.join(", ")})` : ""}`);
  const report = await doctor(projectDir, { quiet: true, componentChecks: false });
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
  const apps = result.ok ? appsOf(result) : [];
  // In each App: what uses what the component provides there, by installed component.
  const usersOf = (component: string): string[] => {
    const users = apps.flatMap(({ components }) => {
      const provides = new Set(components.filter((c) => installedName(project, c.name) === component).flatMap((c) => c.provides));
      return components
        .filter((c) => installedName(project, c.name) !== component && [...c.requires, ...c.optional].some((cap) => provides.has(cap)))
        .map((c) => installedName(project, c.name));
    });
    return [...new Set(users)];
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

/**
 * Refuses when a remaining component requires a capability only this component provides, and,
 * unless forced, when an agent names a key only it provides.
 */
async function checkNoDependents(projectDir: string, project: ProjectManifest, name: string, force: boolean): Promise<void> {
  const result = await probe(projectDir);
  if (!result.ok) {
    if (force) return;
    throw new CliError(`the app does not compose now, so what depends on ${name} is unknown: ${result.error}\nFix it (\`pikit doctor\`) or pass --force`);
  }
  const own = (component: string) => installedName(project, component) === name;
  const blockers: string[] = [];
  for (const { where, components, capabilities, config } of appsOf(result)) {
    for (const [capability, { providers }] of Object.entries(capabilities)) {
      if (!providers.some(own) || providers.some((p) => !own(p))) continue;
      for (const c of components) if (!own(c.name) && c.requires.includes(capability)) blockers.push(`${c.name} requires ${capability}${where}`);
    }
    const selection = (config.capabilities ?? {}) as Record<string, string>;
    for (const [capability, chosen] of Object.entries(selection)) {
      if (own(chosen)) blockers.push(`config.capabilities selects ${chosen} for ${capability}${where}`);
    }
  }
  if (blockers.length > 0) {
    throw new CliError(`${name} cannot be removed; it is the only provider of what the app needs:\n  ${blockers.join("\n  ")}\nInstall another provider first.`);
  }
  const references = brokenReferences(result, name);
  if (references.length > 0 && !force) {
    throw new CliError(`${name} cannot be removed; agents name what only it provides, and the app would not start:\n  ${references.join("\n  ")}\nChange those agents first, or pass --force.`);
  }
}

/** Each App the probe described, with how a blocker names it: the Worker's is named. */
function appsOf(result: Extract<Awaited<ReturnType<typeof probe>>, { ok: true }>): (AppDescription & { where: string })[] {
  return [{ ...result.description, where: "" }, ...(result.worker === undefined ? [] : [{ ...result.worker, where: " in the Worker's App" }])];
}

/** The installed component a name in an App belongs to: itself, or the one whose Worker half it is. */
function installedName(project: ProjectManifest, component: string): string {
  if (component in project.components) return component;
  const base = component.endsWith("-worker") ? component.slice(0, -"-worker".length) : undefined;
  return base !== undefined && base in project.components && workerHalfName(base) === component ? base : component;
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
