/**
 * `pikit ui on | off`: whether the project has a UI (SPEC §5). The dashboard is a project's choice,
 * not a component: a shadcn/ui project of its own in `src/dashboard/` (the registry's
 * `dashboard/files/`), over the admin API of a component, `admin-api`.
 *
 * `on`:
 *   1. installs what it needs and the project lacks, `admin-auth-token` then `admin-api`, each as
 *      `pikit add` does (its own operation, its own doctor). On Cloudflare (`durable`) `add` puts each
 *      in both Apps: admin-api's Worker half serves the API and reaches the conversations' objects;
 *   2. writes `src/dashboard/`, keeps each file's base in `pikit-bases/` and records them in
 *      `pikit.json`'s `dashboard`, with the components step 2 installed; a failure puts back what it
 *      wrote;
 *   3. `bun install` in `src/dashboard/`. Its own packages: a failure (no network) is said, with the
 *      command to run, and leaves the project as it is.
 *   Run again, it does what is missing: a project with a dashboard and both components is left as it is.
 *
 * `off`: deletes `src/dashboard/` and the bases only it named, then removes the components `on`
 * installed for it, as `pikit remove` does (one something else needs stays, said). It refuses, unless
 * `--force`, when you modified a file of the dashboard or added your own (a view): they would be lost.
 *
 * The dashboard is upgraded with the components: `pikit upgrade` without names merges the registry's
 * changes with your edits, file by file (`upgradeDashboard`).
 */

import { copyFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basePath, unreferencedBases } from "../project/bases.ts";
import { DASHBOARD_DIR, DASHBOARD_GENERATED, dashboardFiles, dashboardRecord, recordDashboard, unrecordedDashboardFiles, viewFiles } from "../project/dashboard.ts";
import { assertNoIncompleteOperation, beginOperation, finishOperation } from "../project/operation.ts";
import { confinedPath } from "../project/paths.ts";
import { hashFile, type InstalledDashboard, modifiedFiles, PIKIT_JSON, type ProjectManifest, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { registryPath } from "../project/registry-location.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { Undo } from "../project/undo.ts";
import { CliError, confirm, isInteractive, log } from "../ui.ts";
import { add } from "./add.ts";
import { bunInstall } from "./install.ts";
import { remove } from "./remove.ts";
import { type FileChanges, mergeShipped, type UpgradeOptions } from "./upgrade.ts";

/** What the dashboard needs, providers first: the order `on` installs them in. */
export const UI_COMPONENTS = ["admin-auth-token", "admin-api"] as const;

export interface UiOptions {
  /** Skip the confirmation. */
  yes?: boolean;
  /** `on`: write over a `src/dashboard/` that is not pikit's. `off`: delete your edits and your own files too. */
  force?: boolean;
}

function defaultRegistry(projectDir: string, project: ProjectManifest): { registry: Registry; name: string } {
  const location = project.registries.default;
  if (location === undefined) throw new CliError("pikit.json has no default registry");
  return { registry: openRegistry(registryPath(projectDir, location)), name: "default" };
}

function shippedBy(registry: Registry): Map<string, string> {
  const files = dashboardFiles(registry);
  if (files === undefined) throw new CliError(`the registry ${registry.root} has no dashboard (dashboard/files/)`);
  return files;
}

/** Refuses a `src/dashboard/` that is not pikit's (no record), unless `force`. */
export function checkDashboardFree(projectDir: string, project: ProjectManifest, force: boolean): void {
  if (project.dashboard !== undefined || force) return;
  const dir = confinedPath(projectDir, DASHBOARD_DIR);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new CliError(`${DASHBOARD_DIR}/ exists and is not pikit's dashboard (pikit.json has no record of it): move it away, or pass --force to write over it`);
  }
}

/**
 * Writes the dashboard's `files` (target → source) and their bases, and records them in `project`
 * (written by the caller). What it writes is kept in `undo`.
 */
export function writeDashboard(projectDir: string, project: ProjectManifest, registry: Registry, registryName: string, files: ReadonlyMap<string, string>, components: readonly string[], undo: Undo): void {
  for (const [target, source] of files) {
    undo.keep(target);
    copyFileSync(source, undo.mkdirFor(target));
    const base = basePath(hashFile(source));
    if (existsSync(confinedPath(projectDir, base))) continue;
    undo.keep(base);
    copyFileSync(source, undo.mkdirFor(base));
  }
  project.dashboard = recordDashboard(registry, registryName, files, components);
  // The views of the components already installed (their manifest's `view`), recorded as theirs.
  const registries = new Map<string, Registry>();
  for (const [name, component] of Object.entries(project.components)) {
    const location = project.registries[component.registry];
    if (location === undefined) continue;
    const from = registries.get(component.registry) ?? (component.registry === registryName ? registry : openRegistry(registryPath(projectDir, location)));
    registries.set(component.registry, from);
    if (!from.names().includes(name)) continue;
    for (const [target, source] of viewFiles(from, name)) {
      undo.keep(target);
      copyFileSync(source, undo.mkdirFor(target));
      const hash = hashFile(source);
      component.files[target] = { hash };
      const base = basePath(hash);
      if (existsSync(confinedPath(projectDir, base))) continue;
      undo.keep(base);
      copyFileSync(source, undo.mkdirFor(base));
    }
  }
}

/**
 * `bun install` in `src/dashboard/`; a failure is said, with what to run, and is not the command's.
 * Without its `package.json` there is nothing to install (Bun would walk up to the project's).
 */
export async function installDashboardPackages(projectDir: string, quiet = false): Promise<boolean> {
  if (!existsSync(confinedPath(projectDir, `${DASHBOARD_DIR}/package.json`))) return false;
  try {
    await bunInstall(confinedPath(projectDir, DASHBOARD_DIR), { quiet: true });
    if (!quiet) log.ok(`${DASHBOARD_DIR}: its packages are installed`);
    return true;
  } catch {
    log.warn(`${DASHBOARD_DIR}: \`bun install\` failed there (no network?): run it yourself, in ${DASHBOARD_DIR}/`);
    return false;
  }
}

/** What to run next, once a project has a UI. */
export function uiNext(): string {
  return [
    "The dashboard:",
    "  pikit configure --generate PIKIT_ADMIN_TOKEN   # the operator's token, which the dashboard asks for",
    `  cd ${DASHBOARD_DIR} && bun run build             # then \`pikit dev\` serves it at /admin/ (\`pikit up\` builds it on Cloudflare)`,
    `  cd ${DASHBOARD_DIR} && bun run dev               # or hot reload on :5173, against a running app`,
  ].join("\n");
}

export async function uiOn(projectDir: string, options: UiOptions = {}): Promise<void> {
  assertNoIncompleteOperation(projectDir);
  const project = readProjectManifest(projectDir);
  const { registry, name: registryName } = defaultRegistry(projectDir, project);
  const files = project.dashboard === undefined ? shippedBy(registry) : undefined;
  if (files !== undefined) checkDashboardFree(projectDir, project, options.force === true);
  const missing = UI_COMPONENTS.filter((component) => !(component in project.components));
  if (files === undefined && missing.length === 0) {
    log.ok(`the project has a UI: ${DASHBOARD_DIR}/, with ${UI_COMPONENTS.join(" and ")}`);
    return;
  }

  if (options.yes !== true) {
    if (!isInteractive()) throw new CliError("pikit ui on asks for confirmation; pass --yes when it runs without a terminal");
    const writes = [...(files === undefined ? [] : [`${DASHBOARD_DIR}/ (a shadcn/ui project)`]), ...missing];
    if (!(await confirm(`Add a UI? It installs ${writes.join(", ")}.`, true))) throw new CliError("cancelled", 1);
  }

  if (missing.length > 0) {
    log.step(`${missing.join(", ")}, for the dashboard`);
    await add(projectDir, missing, { yes: true });
  }

  if (files !== undefined) {
    const current = readProjectManifest(projectDir);
    const undo = new Undo(projectDir);
    beginOperation(projectDir, "pikit ui on");
    try {
      writeDashboard(projectDir, current, registry, registryName, files, missing, undo);
      undo.keep(PIKIT_JSON);
      writeProjectManifest(projectDir, current);
    } catch (error) {
      undo.restore();
      finishOperation(projectDir);
      log.warn(`${DASHBOARD_DIR}/ was not written: the project's files are back as they were${missing.length > 0 ? ` (${missing.join(", ")} stay installed: \`pikit ui on\` again finishes)` : ""}`);
      throw error;
    }
    finishOperation(projectDir);
    log.ok(`${DASHBOARD_DIR}/ written: ${files.size} files, yours to change`);
    await installDashboardPackages(projectDir);
  } else if (missing.length > 0) {
    const current = readProjectManifest(projectDir);
    const dashboard = current.dashboard as InstalledDashboard;
    dashboard.components = [...new Set([...dashboard.components, ...missing])];
    writeProjectManifest(projectDir, current);
  }
  log.info(`\n${uiNext()}`);
}

export async function uiOff(projectDir: string, options: UiOptions = {}): Promise<void> {
  assertNoIncompleteOperation(projectDir);
  const project = readProjectManifest(projectDir);
  const dashboard = project.dashboard;
  if (dashboard === undefined) {
    if (existsSync(confinedPath(projectDir, DASHBOARD_DIR))) {
      throw new CliError(`${DASHBOARD_DIR}/ is not pikit's dashboard (pikit.json has no record of it): delete it yourself if you mean to`);
    }
    log.ok("the project has no UI");
    return;
  }
  const force = options.force === true;
  // The components' views go with it: they are in src/dashboard/.
  const views = (files: Record<string, { hash: string }>) => Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith(`${DASHBOARD_DIR}/`)));
  const modified = [
    ...modifiedFiles(projectDir, dashboardRecord(dashboard)),
    ...Object.values(project.components).flatMap((component) => modifiedFiles(projectDir, { files: views(component.files) })),
  ];
  const own = unrecordedDashboardFiles(projectDir, project);
  if ((modified.length > 0 || own.length > 0) && !force) {
    const lines = [...modified.map((file) => `${file} (modified)`), ...own.map((file) => `${file} (yours)`)];
    throw new CliError(`these files of the dashboard would be lost; pass --force to delete them anyway:\n  ${lines.join("\n  ")}`);
  }
  if (options.yes !== true && isInteractive() && !(await confirm(`Delete ${DASHBOARD_DIR}/ and remove ${dashboard.components.join(", ") || "nothing else"}?`, true))) {
    throw new CliError("cancelled", 1);
  }

  const undo = new Undo(projectDir);
  beginOperation(projectDir, `pikit ui off${force ? " --force" : ""}`);
  try {
    const componentViews = Object.values(project.components).flatMap((component) => Object.keys(views(component.files)));
    for (const file of [...Object.keys(dashboard.files), ...componentViews, ...own]) {
      if (existsSync(confinedPath(projectDir, file))) undo.delete(file);
    }
    for (const component of Object.values(project.components)) {
      for (const file of Object.keys(views(component.files))) delete component.files[file];
    }
    delete project.dashboard;
    undo.keep(PIKIT_JSON);
    writeProjectManifest(projectDir, project);
    for (const base of unreferencedBases(projectDir, project)) undo.delete(base);
  } catch (error) {
    undo.restore();
    finishOperation(projectDir);
    log.warn("nothing was removed: the project's files are back as they were");
    throw error;
  }
  // What is left is its toolchain's (node_modules/, dist/) and empty folders.
  rmSync(confinedPath(projectDir, DASHBOARD_DIR), { recursive: true, force: true });
  finishOperation(projectDir);
  log.ok(`${DASHBOARD_DIR}/ deleted`);

  for (const component of [...dashboard.components].reverse()) {
    if (!(component in readProjectManifest(projectDir).components)) continue;
    try {
      await remove(projectDir, component);
    } catch (error) {
      log.warn(`${component} stays installed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * `pikit upgrade` for the dashboard: the registry's `dashboard/files/` against what was written and
 * your copies, file by file, as a component's (`mergeShipped`). New files are refused where one of
 * yours differs (`--force` writes over it); files no longer shipped are deleted, unless you modified one.
 */
export async function upgradeDashboard(projectDir: string, options: UpgradeOptions = {}): Promise<void> {
  const project = readProjectManifest(projectDir);
  const previous = project.dashboard;
  if (previous === undefined) return;
  const location = project.registries[previous.registry];
  if (location === undefined) throw new CliError(`pikit.json's dashboard names no registry "${previous.registry}"`);
  const registry = openRegistry(registryPath(projectDir, location));
  const files = dashboardFiles(registry);
  if (files === undefined) {
    log.warn(`the dashboard is skipped: the registry ${registry.root} has no dashboard any more`);
    return;
  }
  const next = recordDashboard(registry, previous.registry, files, previous.components);
  const removed: string[] = [];
  const kept: string[] = [];
  const modified = new Set(modifiedFiles(projectDir, dashboardRecord(previous)));
  for (const [file, recorded] of Object.entries(previous.files)) {
    if (files.has(file) || !existsSync(confinedPath(projectDir, file))) continue;
    if (modified.has(file)) {
      next.files[file] = recorded;
      kept.push(file);
    } else removed.push(file);
  }
  const same = JSON.stringify(Object.entries(previous.files).sort()) === JSON.stringify(Object.entries(next.files).sort());
  if (same) {
    log.ok("the dashboard is up to date with its registry");
    return;
  }
  const clashing = [...files].filter(([target, source]) => {
    if (target in previous.files) return false;
    const path = confinedPath(projectDir, target);
    return existsSync(path) && hashFile(path) !== hashFile(source);
  });
  if (clashing.length > 0 && options.force !== true) {
    throw new CliError(`the dashboard's new version adds files you have, which differ; pass --force to write over them:\n  ${clashing.map(([target]) => target).join("\n  ")}`);
  }
  const label = `dashboard@${registry.commit ?? "registry"}`;
  const { writes, changes: shipped, notes } = await mergeShipped(projectDir, files, previous.files, new Set(DASHBOARD_GENERATED), label);
  const changes: FileChanges = { ...shipped, removed, kept };
  describe(changes, notes, registry);
  if (options.dryRun === true) return;
  if (options.yes !== true) {
    if (!isInteractive()) throw new CliError("pikit upgrade asks for confirmation; pass --yes when it runs without a terminal (--dry-run shows what it does)");
    if (!(await confirm("Upgrade the dashboard?"))) throw new CliError("cancelled", 1);
  }

  const undo = new Undo(projectDir);
  beginOperation(projectDir, "pikit upgrade (dashboard)");
  try {
    for (const file of removed) undo.delete(file);
    for (const [target, write] of writes) {
      undo.keep(target);
      if ("source" in write) copyFileSync(write.source, undo.mkdirFor(target));
      else writeFileSync(undo.mkdirFor(target), write.content);
    }
    for (const [target, source] of files) {
      const base = basePath(next.files[target]?.hash ?? hashFile(source));
      if (existsSync(confinedPath(projectDir, base))) continue;
      undo.keep(base);
      copyFileSync(source, undo.mkdirFor(base));
    }
    project.dashboard = next;
    undo.keep(PIKIT_JSON);
    writeProjectManifest(projectDir, project);
    for (const base of unreferencedBases(projectDir, project)) undo.delete(base);
  } catch (error) {
    undo.restore();
    finishOperation(projectDir);
    log.warn("the dashboard was not upgraded: its files are back as they were");
    throw error;
  }
  finishOperation(projectDir);
  log.ok("the dashboard is upgraded");
  if (writes.has(`${DASHBOARD_DIR}/package.json`)) await installDashboardPackages(projectDir);
  if (changes.conflicted.length > 0) {
    throw new CliError(
      `these files of the dashboard have conflicts between your edits and the new version:\n  ${changes.conflicted.join("\n  ")}\n` +
        "Resolve each `<<<<<<< yours` … `>>>>>>>` section. What you leave in them is yours: a later `pikit upgrade` merges it.",
    );
  }
}

function describe(changes: FileChanges, notes: readonly string[], registry: Registry): void {
  log.step(`the dashboard, from ${registry.root}${registry.commit ? ` at ${registry.commit}` : ""}`);
  const list = (label: string, files: readonly string[]) => {
    if (files.length > 0) log.info(`  ${label}: ${files.join(", ")}`);
  };
  list("updated", changes.updated);
  list("merged with your edits", changes.merged);
  list("conflicts with your edits", changes.conflicted);
  list("added", changes.added);
  list("deleted, no longer shipped", changes.removed);
  list("kept, no longer shipped but modified by you", changes.kept);
  list("not restored, deleted by you", changes.notRestored);
  for (const note of notes) log.warn(note);
}
