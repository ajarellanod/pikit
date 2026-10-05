/**
 * `pikit remove <component>`: the install flow in reverse, so that removing leaves the
 * project as it was before `add` (SPEC P3).
 *
 * It refuses when another component requires (`use`) a capability this one is the only provider
 * of; losing the provider of an optional capability is allowed and `doctor` reports it. Without
 * `--force`, it also refuses to take a key an agent names (a tool, a model's provider):
 * the app would compose and the runtime refuse to start; and to leave the app answering nobody, a
 * channel without a router or `http.route`s without a server (`serving.ts`). The answer
 * comes from the app itself (`describe()`), not from manifests, so project components count too.
 * It never deletes a file the user modified without `--force`. The bases of its files (`bases.ts`) go
 * with it, unless another component installed the same content.
 *
 * What was installed *for* it (an offered provider, `offers.ts`) goes with it when nothing else uses
 * it, so `add` then `remove` leaves no trace even when `add` brought a provider along. When another
 * component uses it now (in either App, or an agent names a key it provides), it stays, installed for
 * that one, or on its own. That cleanup is never forced: `--force` is for the component named. A
 * provider whose files you modified, or that cannot be removed for another reason, stays, said, and is
 * then on its own (no longer installed for anything). When the app does not compose, what uses a
 * provider is unknown: every one stays, on its own.
 *
 * Every refusal comes before the first write. A step that fails after it (a `bun install`) puts back
 * what was written (`undo.ts`): the config, the files, `.env.example`, `pikit.json`, the bases,
 * `package.json` and `bun.lock`. The marker of an unfinished operation (`operation.ts`) is there from
 * the first write until the component and what goes with it are all gone; it stays when a step fails
 * after `bun install` ran (node_modules is not put back) or after the component itself was removed.
 * `pikit doctor` runs once, at the end, after what was installed for it went too: it reports (its
 * notes too), and never keeps that cleanup from running.
 *
 * On Cloudflare it undoes both Apps (SPEC C1): its entries leave every `components` list, its config
 * keys leave `config` and `workerConfig` (its Worker half's is `<name>-worker`), and what depends on
 * it is looked for in each App.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { packageName, scanImports } from "../registry/imports.ts";
import { BASES_DIR, unreferencedBases } from "../project/bases.ts";
import { confinedPath } from "../project/paths.ts";
import { workerHalfName } from "../project/apps.ts";
import { CONFIG_FILE, removeComponent, removeConfigEntry, WORKER_CONFIG } from "../project/config-file.ts";
import type { AppDescription } from "../project/probe.ts";
import { ENV_EXAMPLE, removeExampleBlock } from "../project/env-file.ts";
import { readPackageJson, removeDependencies, writePackageJson } from "../project/package-json.ts";
import { PIKIT_JSON, type ProjectManifest, modifiedFiles, ownedDependencies, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { assertNoIncompleteOperation, beginOperation, finishOperation, OPERATION_MARKER } from "../project/operation.ts";
import { brokenReferences } from "../project/references.ts";
import { probe } from "../project/run.ts";
import { servingGaps } from "../project/serving.ts";
import { Undo } from "../project/undo.ts";
import { CliError, log } from "../ui.ts";
import { doctor, projectSources } from "./doctor.ts";
import { bunInstall } from "./install.ts";

export interface RemoveOptions {
  /**
   * Delete the component's modified files, and remove it even when the app does not compose. Never
   * what was installed for it: that goes only when it can without.
   */
  force?: boolean;
}

const PACKAGE_JSON = "package.json";
const BUN_LOCK = "bun.lock";

export async function remove(projectDir: string, name: string, options: RemoveOptions = {}): Promise<void> {
  assertNoIncompleteOperation(projectDir);
  const force = options.force === true;
  await removeOne(projectDir, name, force, () => beginOperation(projectDir, `pikit remove ${name}${force ? " --force" : ""}`));
  try {
    await removeLeftovers(projectDir, name);
  } catch (error) {
    log.warn(`${name} was removed, but not all that was installed for it: check the project, then delete ${OPERATION_MARKER} and run \`pikit doctor\``);
    throw error;
  }
  // Before doctor: what it reports is the project's state, not an unfinished removal.
  finishOperation(projectDir);
  const report = await doctor(projectDir, { quiet: true, componentChecks: false });
  for (const note of report.notes) log.info(`  ${note}`);
  for (const problem of report.problems) log.problem(problem);
  if (report.problems.length > 0) throw new CliError(`\`pikit doctor\` found ${report.problems.length} problem(s) after removing ${name}`);
}

/**
 * What was installed only for `name`, now that it is gone, each with what was installed only for that
 * one. Never forced: one that refuses (its files modified, something depends on it) stays, said.
 */
async function removeLeftovers(projectDir: string, name: string): Promise<void> {
  for (const leftover of await installedOnlyFor(projectDir, name)) {
    log.step(`${leftover} was installed for ${name}, and nothing uses it now`);
    try {
      await removeOne(projectDir, leftover, false);
    } catch (error) {
      // A refusal, before its first write: it stays, on its own (`installedOnlyFor` took `name` out of its `installedFor`).
      if (!(error instanceof Refused)) throw error;
      log.warn(`${leftover} stays installed, on its own: ${error.message}`);
      continue;
    }
    await removeLeftovers(projectDir, leftover);
  }
}

/** A removal refused before its first write. */
class Refused extends CliError {}

/**
 * Removes one component. With `begin` it is the component named on the command line: `begin` runs
 * right before its first write (the operation's marker). Without, it goes with another, already removed.
 */
async function removeOne(projectDir: string, name: string, force: boolean, begin?: () => void): Promise<void> {
  const project = readProjectManifest(projectDir);
  const installed = project.components[name];
  if (installed === undefined) throw new CliError(`${name} is not installed (pikit.json has ${Object.keys(project.components).join(", ") || "nothing"})`);

  await checkNoDependents(projectDir, project, name, force);

  const modified = modifiedFiles(projectDir, installed);
  if (modified.length > 0 && !force) {
    throw new Refused(`you modified these files of ${name}; pass --force to delete them anyway:\n  ${modified.join("\n  ")}`);
  }

  // pikit.config.ts first: if its shape is not recognised, nothing has been deleted yet.
  const configPath = confinedPath(projectDir, CONFIG_FILE);
  for (const file of [PACKAGE_JSON, BUN_LOCK, "bun.lockb", BASES_DIR, ENV_EXAMPLE]) confinedPath(projectDir, file);
  const config = readFileSync(configPath, "utf8");
  let nextConfig: string;
  try {
    nextConfig = removeConfigEntry(removeComponent(config, name), name);
    // The Worker's App's keys: its own (in both Apps) and its Worker half's, unless that is another component.
    for (const key of [name, workerHalfName(name)].filter((key) => key === name || !(key in project.components))) {
      nextConfig = removeConfigEntry(nextConfig, key, WORKER_CONFIG);
    }
  } catch (error) {
    // Text only, nothing written yet: a shape the edit does not recognise is a refusal.
    throw new Refused(error instanceof Error ? error.message : String(error));
  }
  const undo = new Undo(projectDir);
  begin?.();
  let removed: string[] = [];
  try {
    if (nextConfig !== config) {
      undo.keep(CONFIG_FILE);
      writeFileSync(configPath, nextConfig);
    }

    for (const file of Object.keys(installed.files)) undo.delete(file);

    const examplePath = confinedPath(projectDir, ENV_EXAMPLE);
    if (existsSync(examplePath)) {
      const example = readFileSync(examplePath, "utf8");
      const next = removeExampleBlock(example, name);
      if (next === "") undo.delete(ENV_EXAMPLE);
      else if (next !== example) {
        undo.keep(ENV_EXAMPLE);
        writeFileSync(examplePath, next);
      }
    }

    delete project.components[name];
    undo.keep(PIKIT_JSON);
    writeProjectManifest(projectDir, project);
    for (const base of unreferencedBases(projectDir, project)) undo.delete(base);

    // Only what `add` put in package.json for it: a package the project had before stays.
    const owned = ownedDependencies(installed);
    const pkg = readPackageJson(projectDir);
    removed = [
      ...removeDependencies(pkg, unneededDependencies(projectDir, project, owned.dependencies)),
      ...removeDependencies(pkg, unneededDependencies(projectDir, project, owned.devDependencies), "devDependencies"),
    ];
    if (removed.length > 0) {
      undo.keep(PACKAGE_JSON);
      writePackageJson(projectDir, pkg);
      undo.keep(BUN_LOCK);
      undo.keep("bun.lockb");
      undo.installed = true;
      await bunInstall(projectDir);
    }
  } catch (error) {
    undo.restore();
    // Nothing of this command is left once the named component's files are back and node_modules was not touched.
    const finished = begin !== undefined && !undo.installed;
    if (finished) finishOperation(projectDir);
    const modules = undo.installed ? " (node_modules may not be: run `bun install`)" : "";
    if (begin === undefined) log.warn(`${name} was not removed: its files are back as they were${modules}`);
    else log.warn(`nothing was removed: the project's files are back as they were${modules}${finished ? "" : `; check the project, then delete ${OPERATION_MARKER}`}`);
    throw error;
  }

  log.ok(`${name} removed${removed.length > 0 ? ` (and the npm packages only it used: ${removed.join(", ")})` : ""}`);
}

/**
 * The components installed for `name` (after it is gone) that nothing uses: the ones to remove. Each
 * candidate's `installedFor` loses `name`: another that something still requires stays, installed for
 * its users now. A component that only uses it if present does not keep it: it was brought for `name`,
 * and the project goes back to what it was before `name` came (P3). One an agent names a key of, or any when the app does not compose (what uses it is
 * unknown), stays on its own. A returned one is on its own too, in case its removal is refused.
 */
async function installedOnlyFor(projectDir: string, name: string): Promise<string[]> {
  const project = readProjectManifest(projectDir);
  const candidates = Object.entries(project.components).filter(([, c]) => c.installedFor?.includes(name));
  if (candidates.length === 0) return [];
  const result = await probe(projectDir);
  const apps = result.ok ? appsOf(result) : [];
  // In each App: what requires what the component provides there, by installed component.
  const usersOf = (component: string): string[] => {
    const users = apps.flatMap(({ components }) => {
      const provides = new Set(components.filter((c) => installedName(project, c.name) === component).flatMap((c) => c.provides));
      return components
        .filter((c) => installedName(project, c.name) !== component && c.requires.some((cap) => provides.has(cap)))
        .map((c) => installedName(project, c.name));
    });
    return [...new Set(users)];
  };
  const leftovers: string[] = [];
  for (const [component, installed] of candidates) {
    const others = (installed.installedFor ?? []).filter((n) => n !== name);
    const users = result.ok ? usersOf(component) : [];
    const owners = [...new Set([...others, ...users])];
    if (owners.length > 0) installed.installedFor = owners;
    else delete installed.installedFor;
    if (owners.length > 0) continue;
    if (!result.ok) {
      log.warn(`${component} was installed for ${name}; the app does not compose, so whether anything uses it is unknown: it stays installed, on its own (\`pikit remove ${component}\` if you do not need it)`);
    } else if (brokenReferences(result, component).length > 0) {
      log.warn(`${component} was installed for ${name}; agents name what it provides: it stays installed, on its own`);
    } else leftovers.push(component);
  }
  writeProjectManifest(projectDir, project);
  return leftovers;
}

/**
 * Refuses when a remaining component requires a capability only this component provides, and,
 * unless forced, when an agent names a key only it provides, or when the app would answer nobody
 * where it did (`serving.ts`): a gap the project has already is `doctor`'s to report, not this removal's.
 */
async function checkNoDependents(projectDir: string, project: ProjectManifest, name: string, force: boolean): Promise<void> {
  const result = await probe(projectDir);
  if (!result.ok) {
    if (force) return;
    throw new Refused(`the app does not compose now, so what depends on ${name} is unknown: ${result.error}\nFix it (\`pikit doctor\`) or pass --force`);
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
    throw new Refused(`${name} cannot be removed; it is the only provider of what the app needs:\n  ${blockers.join("\n  ")}\nInstall another provider first.`);
  }
  const references = brokenReferences(result, name);
  if (references.length > 0 && !force) {
    throw new Refused(`${name} cannot be removed; agents name what only it provides, and the app would not start:\n  ${references.join("\n  ")}\nChange those agents first, or pass --force.`);
  }
  const before = servingGaps(result);
  const gaps = servingGaps(result, own).filter((gap) => !before.some((had) => had.kind === gap.kind && had.where === gap.where));
  if (gaps.length > 0 && !force) {
    throw new Refused(`${name} cannot be removed; the app would answer nobody:\n  ${gaps.map((gap) => gap.message).join("\n  ")}\nDo so first, or pass --force.`);
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
 * Of the npm packages `add` put in package.json for the component (`candidates`: dependencies or dev
 * dependencies, `ownedDependencies`), those nothing else needs: no remaining component declares it,
 * as either, no source file of the project imports it, and it is not the kit.
 */
export function unneededDependencies(projectDir: string, project: ProjectManifest, candidates: readonly string[]): string[] {
  if (candidates.length === 0) return [];
  const needed = new Set(Object.values(project.components).flatMap((c) => [...Object.keys(c.dependencies), ...Object.keys(c.devDependencies ?? {})]));
  try {
    for (const file of projectSources(projectDir)) {
      for (const specifier of scanImports(readFileSync(confinedPath(projectDir, file), "utf8"))) needed.add(packageName(specifier));
    }
  } catch (error) {
    log.warn(`package usage could not be checked: ${error instanceof Error ? error.message : String(error)}; keeping ${candidates.join(", ")}`);
    return [];
  }
  return candidates.filter((pkg) => !needed.has(pkg) && pkg !== "@pikit/core");
}
