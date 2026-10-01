/**
 * `pikit upgrade [<component>...]`: installed components take their registry's version, and keep
 * the user's edits (SPEC P6). Without names, every installed component whose registry has another
 * version of it (another version, other files, another manifest); `--dry-run` only says what it
 * would do.
 *
 * Each file the new version ships, against the file as installed (its hash in `pikit.json`, its base
 * in `pikit-bases/`, `bases.ts`) and the project's copy:
 * - not modified: replaced when the registry changed it;
 * - modified, and changed by the registry: a three-way merge (`merge.ts`) of the base, yours and the
 *   new one. A clean merge is written. A conflict is written with `<<<<<<< yours` … `=======` …
 *   `>>>>>>> <component>@<version>` sections, named, and the command ends with code 1;
 * - new: added, unless the path is another component's, or exists and differs (`--force` overwrites
 *   it, as `add` does);
 * - no longer shipped: deleted when not modified, else kept, named, and recorded as installed (as a
 *   reinstall does: `pikit remove` asks before deleting it);
 * - deleted by the user: not restored. It is named when the registry changed it; `pikit add --force`
 *   brings it back;
 * - `generated` (a hook rewrites it): the project's copy stays.
 *
 * Every file is then recorded, and its base kept, as the new version ships it; bases no component
 * names any more go. So a merged file shows as modified in `pikit doctor` (it is: your edits on top of
 * the new version), and a conflicted one too: whatever you resolve it to is "yours" for the next
 * upgrade, which merges from this version. Nothing is lost by running `upgrade` again: an unchanged
 * registry leaves a modified file as it is.
 *
 * The manifest's changes follow as `add` makes them: its `.env.example` block, its npm packages (new
 * ones added; those it added and no longer declares taken out when nothing else needs them; those it
 * added at the version it declared moved to the new one), its hooks and generated files, the kit
 * ranges it accepts (a version this CLI's kit does not satisfy is refused, unless `--force`, as is a
 * downgrade), the Worker's App on Cloudflare when its `apps` changed, and the providers it now needs
 * (offered, as `add` offers them; warned about when nothing provides them). What the project provides
 * is what `pikit.config.ts` composes before the upgrade, without what the upgraded components provide
 * now and with what their new versions declare (`composedProvides`, `offers.ts`).
 *
 * `add --force` stays what it was: a reinstall that overwrites the user's edits.
 *
 * Every refusal and every merge happens before the first write. The writes, the kit refresh and
 * `bun install` are undone together when one fails (`undo.ts`). `pikit doctor` runs at the end,
 * unless a file has conflicts: the app does not compose until they are resolved.
 */

import { existsSync, readFileSync } from "node:fs";
import { hasWorkerApp } from "../project/apps.ts";
import { basePath } from "../project/bases.ts";
import { setWorkerWiring } from "../project/config-file.ts";
import { exampleBlock, replaceExampleBlock } from "../project/env-file.ts";
import { mergeFile } from "../project/merge.ts";
import { mergeProvided, offeredProviders, providedByManifests } from "../project/offers.ts";
import { hashFile, type InstalledComponent, type ProjectManifest } from "../project/pikit-json.ts";
import { registryPath } from "../project/registry-location.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { Undo } from "../project/undo.ts";
import { confinedPath } from "../project/paths.ts";
import { assertNoIncompleteOperation, beginOperation, finishOperation, OPERATION_MARKER } from "../project/operation.ts";
import { pruneVendor, refreshKit } from "../project/vendor.ts";
import { CliError, confirm, isInteractive, log } from "../ui.ts";
import {
  acceptedOffers,
  alsoWrites,
  applyPlans,
  BUN_LOCK,
  checkCompatible,
  checkConflicts,
  checkKit,
  composedProvides,
  describePlan,
  type Draft,
  ownDir,
  PACKAGE_JSON,
  type Plan,
  planInstall,
  readDraft,
  recordInstall,
  warnUnprovided,
  workerWiring,
} from "./add.ts";
import { doctor } from "./doctor.ts";
import { bunInstall } from "./install.ts";

export interface UpgradeOptions {
  /**
   * Upgrade to a version this CLI's kit does not satisfy, or to an older one; replace a kit that is
   * newer or that an installed component does not accept (as `add`); overwrite a file the new
   * version adds where one exists. It never overwrites the user's edits: those are merged.
   */
  force?: boolean;
  /** Skip the confirmation, and accept every offered provider. */
  yes?: boolean;
  /** Say what it would do; write nothing. */
  dryRun?: boolean;
}

/** What an upgrade does to each file of a component. */
interface FileChanges {
  /** Not modified, changed by the registry: replaced. */
  updated: string[];
  /** Modified, changed by the registry: merged cleanly. */
  merged: string[];
  /** Modified, changed by the registry: written with conflict markers, or kept as it is when Git cannot merge it. */
  conflicted: string[];
  /** New in this version. */
  added: string[];
  /** No longer shipped, not modified: deleted. */
  removed: string[];
  /** No longer shipped, modified: kept. */
  kept: string[];
  /** Deleted by the user, changed by the registry: not restored. */
  notRestored: string[];
}

interface UpgradePlan extends Plan {
  registryName: string;
  previous: InstalledComponent;
  changes: FileChanges;
  /** Said once, as a warning: a file Git could not merge, a merge without its base. */
  notes: string[];
}

export async function upgrade(projectDir: string, names: readonly string[], options: UpgradeOptions = {}): Promise<void> {
  assertNoIncompleteOperation(projectDir);
  const force = options.force === true;
  const draft = readDraft(projectDir);
  const installed = Object.keys(draft.project.components);
  const unknown = names.filter((name) => !(name in draft.project.components));
  if (unknown.length > 0) throw new CliError(`not installed: ${unknown.join(", ")} (pikit.json has ${installed.join(", ") || "nothing"})`);

  // Every check and every merge, before anything is written.
  const registries = new Map<string, Registry>();
  const plans: UpgradePlan[] = [];
  const upToDate: string[] = [];
  for (const name of names.length > 0 ? [...new Set(names)] : installed) {
    const key = (draft.project.components[name] as InstalledComponent).registry;
    let registry: Registry;
    try {
      registry = registries.get(key) ?? registryOf(projectDir, draft.project, key);
      registries.set(key, registry);
      registry.dir(name);
    } catch (error) {
      // Named, it is an error; in a run over every component, one registry that is gone is skipped.
      if (names.length > 0) throw error;
      log.warn(`${name} is skipped: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const plan = await planUpgrade(projectDir, draft, registry, key, name, force);
    if (plan === undefined) upToDate.push(name);
    else plans.push(plan);
  }
  if (upToDate.length > 0 && names.length > 0) log.info(`up to date: ${upToDate.join(", ")}`);
  if (plans.length === 0) {
    log.ok(names.length > 0 ? "nothing to upgrade" : "every component is up to date with its registry");
    return;
  }
  checkKit(projectDir, draft.project, force);
  // What the project will provide: what it composes now, without what the upgraded components' installed
  // versions provide (and only theirs: those up to date stay as they compose), with what every new version declares.
  const composed = await composedProvides(projectDir, plans.map((plan) => plan.name));
  if (composed !== undefined) draft.provided = mergeProvided(composed, providedByManifests(plans.map((plan) => plan.manifest), draft.project.targets));
  for (const plan of plans) warnUnprovided(draft.project, plan.manifest, draft.provided);
  for (const plan of plans) describeUpgrade(plan);

  if (options.dryRun === true) {
    for (const plan of plans) {
      if (draft.provided === undefined) break;
      for (const offer of offeredProviders(plan.registry, [plan.name], installed, draft.project.targets, draft.provided)) {
        log.info(`  would offer ${offer.component}, for ${offer.for} (${offer.capability})`);
      }
    }
    log.ok("--dry-run: nothing was written");
    return;
  }
  await confirmUpgrade(plans, options);
  const all: Plan[] = [...plans];
  for (const plan of plans) {
    // Each planned provider joins `draft.provided` (`planInstall`): one two components need comes once.
    if (draft.provided === undefined) break;
    for (const offer of await acceptedOffers(plan.registry, plan.name, installed, draft.project.targets, draft.provided, options)) {
      // Two upgraded components may need the same provider: it comes once.
      if (offer.component in draft.project.components) continue;
      const offered = planInstall(projectDir, draft, plan.registry, plan.registryName, offer.component, { force, yes: options.yes === true, installedFor: offer.for });
      describePlan(offered);
      all.push(offered);
    }
  }

  const undo = new Undo(projectDir);
  beginOperation(projectDir, `pikit upgrade${names.length > 0 ? ` ${names.join(" ")}` : ""}${force ? " --force" : ""}`);
  let refreshed: string[] = [];
  try {
    undo.keep(PACKAGE_JSON);
    refreshed = refreshKit(projectDir);
    if (refreshed.length > 0) log.step(`the project's kit packages (${refreshed.join(", ")}) are refreshed to this CLI's, in vendor/`);
    const { dependenciesChanged } = applyPlans(projectDir, draft, all, undo);
    if (dependenciesChanged || refreshed.length > 0) {
      undo.keep(BUN_LOCK);
      undo.keep("bun.lockb");
      undo.installed = true;
      await bunInstall(projectDir);
    }
  } catch (error) {
    undo.restore();
    if (!undo.installed) finishOperation(projectDir);
    log.warn(`nothing was upgraded: the project's files are back as they were${undo.installed ? ` (node_modules may not be: run \`bun install\`, then delete ${OPERATION_MARKER})` : ""}`);
    throw error;
  }
  if (refreshed.length > 0) pruneVendor(projectDir);
  finishOperation(projectDir);
  for (const plan of plans) log.ok(`${plan.name} upgraded: ${plan.previous.version} → ${plan.manifest.version}`);

  const conflicted = plans.flatMap((plan) => plan.changes.conflicted.map((file) => `${file} (${plan.name}@${plan.manifest.version})`));
  if (conflicted.length > 0) {
    throw new CliError(
      `these files have conflicts between your edits and the new version:\n  ${conflicted.join("\n  ")}\n` +
        "Resolve each `<<<<<<< yours` … `>>>>>>>` section, then run `pikit doctor`. What you leave in them is yours: a later `pikit upgrade` merges it.",
    );
  }
  const report = await doctor(projectDir, { quiet: true, componentChecks: false });
  if (report.problems.length > 0) {
    for (const problem of report.problems) log.problem(problem);
    throw new CliError(`the upgrade is done, but \`pikit doctor\` found ${report.problems.length} problem(s)`);
  }
  for (const missing of report.unconfigured) log.warn(missing);
  log.ok(`\`pikit doctor\` is green${report.unconfigured.length > 0 ? " (run \`pikit configure\` for the variables above)" : ""}`);
}

function registryOf(projectDir: string, project: ProjectManifest, key: string): Registry {
  const location = project.registries[key];
  if (location === undefined) throw new CliError(`pikit.json names no registry "${key}"`);
  return openRegistry(registryPath(projectDir, location));
}

/**
 * The component's upgrade on the draft, or undefined when its registry has what is installed: the
 * same version, files and manifest. Every refusal and every merge happens here. Async only because
 * `mergeFile` is, for a Bun bug (see `merge.ts`).
 */
async function planUpgrade(projectDir: string, draft: Draft, registry: Registry, registryName: string, name: string, force: boolean): Promise<UpgradePlan | undefined> {
  const { project } = draft;
  const previous = project.components[name] as InstalledComponent;
  const manifest = registry.manifest(name);
  const files = registry.files(name);
  const { record, obsolete, kept, dropped } = recordInstall(projectDir, previous, registry, registryName, manifest, files, previous.installedFor);
  if (sameInstall(previous, record)) return undefined;

  checkCompatible(project.targets, manifest, force);
  if (Bun.semver.order(manifest.version, previous.version) < 0) {
    const what = `${name}'s registry has ${manifest.version}, older than the installed ${previous.version}`;
    if (!force) throw new CliError(`${what}; pass --force to go back to it`);
    log.warn(`${what}; --force: going back to it`);
  }
  // The files it ships that it did not install: refused where they are another component's, or differ.
  checkConflicts(projectDir, project, name, new Map([...files].filter(([target]) => !(target in previous.files))), force);

  const changes: FileChanges = { updated: [], merged: [], conflicted: [], added: [], removed: obsolete, kept, notRestored: [] };
  const writes: Plan["writes"] = new Map();
  const notes: string[] = [];
  const generated = new Set([...(previous.generated ?? []), ...(record.generated ?? [])]);
  for (const [target, source] of files) {
    const path = confinedPath(projectDir, target);
    const theirs = hashFile(source);
    const installed = previous.files[target]?.hash;
    if (installed === undefined) {
      if (!existsSync(path) || hashFile(path) !== theirs) writes.set(target, { source });
      changes.added.push(target);
    } else if (!existsSync(path)) {
      if (theirs !== installed) changes.notRestored.push(target);
    } else if (theirs !== installed && !generated.has(target)) {
      const ours = hashFile(path);
      if (ours === installed) {
        writes.set(target, { source });
        changes.updated.push(target);
      } else if (ours !== theirs) {
        const base = confinedPath(projectDir, basePath(installed));
        if (hasConflictMarkers(path)) notes.push(`${target} still has the conflict markers of an earlier upgrade: they are merged as your lines`);
        const merged = await mergeFile(path, existsSync(base) ? base : undefined, source, `${name}@${manifest.version}`);
        if ("error" in merged) {
          changes.conflicted.push(target);
          notes.push(`${target}: ${merged.error}. Yours is kept as it is; ${name} ${manifest.version}'s is ${basePath(theirs)}`);
        } else {
          writes.set(target, { content: merged.content });
          (merged.conflicts > 0 ? changes.conflicted : changes.merged).push(target);
          if (!existsSync(base)) notes.push(`${target}: its base (${basePath(installed)}) is gone, so every line that differs from the new version is a conflict`);
        }
      }
    }
  }

  // The manifest's changes, on the draft.
  if (JSON.stringify(previous.environment) !== JSON.stringify(record.environment)) {
    draft.example.after = replaceExampleBlock(draft.example.after, name, exampleBlock(name, record.environment));
  }
  if (draft.config !== undefined && hasWorkerApp(project.targets) && JSON.stringify(previous.apps) !== JSON.stringify(record.apps)) {
    draft.config.after = setWorkerWiring(draft.config.after, name, workerWiring(name, manifest, project.targets));
  }
  project.components[name] = record;
  return { name, registry, registryName, manifest, files, writes, obsolete, previous, dropped, changes, notes };
}

/** What is installed is what the registry has: the version, each file's hash, and what the manifest declares. */
function sameInstall(installed: InstalledComponent, next: InstalledComponent): boolean {
  const comparable = (c: InstalledComponent) =>
    JSON.stringify([
      c.version,
      Object.entries(c.files).sort(([a], [b]) => (a < b ? -1 : 1)),
      c.dependencies,
      c.devDependencies ?? {},
      c.environment,
      c.requires,
      c.hooks ?? {},
      c.generated ?? [],
      c.apps ?? {},
    ]);
  return comparable(installed) === comparable(next);
}

/** The plan of one component, file by file, then what its manifest changes. */
function describeUpgrade({ name, registry, manifest, previous, changes, notes, dropped, writes }: UpgradePlan): void {
  log.step(`${name} ${previous.version} → ${manifest.version} from ${registry.root}${registry.commit ? ` at ${registry.commit}` : ""}`);
  const list = (label: string, files: readonly string[]) => {
    if (files.length > 0) log.info(`  ${label}: ${files.join(", ")}`);
  };
  list("updated", changes.updated);
  list("merged with your edits", changes.merged);
  list("conflicts with your edits", changes.conflicted);
  // A registry may be anyone's: a new file outside the component's directory is marked.
  list("added", changes.added.map((file) => (file.startsWith(ownDir(name)) ? file : `! ${file}`)));
  list("deleted, no longer shipped", changes.removed);
  list("kept, no longer shipped but modified by you", changes.kept);
  list("not restored, deleted by you (`pikit add --force` restores it)", changes.notRestored);
  if (writes.size + changes.removed.length === 0) log.info("  files: no change");

  const names = (variables: InstalledComponent["environment"]) => variables.map((v) => v.name);
  const before = names(previous.environment);
  const after = (manifest.environment ?? []).map((v) => v.name);
  list("new environment variables", after.filter((v) => !before.includes(v)));
  list("environment variables it no longer reads", before.filter((v) => !after.includes(v)));
  for (const [field, label] of [["dependencies", "npm"], ["devDependencies", "npm (dev)"]] as const) {
    const was = previous[field] ?? {};
    const is = manifest[field] ?? {};
    list(`${label}, new`, Object.entries(is).filter(([pkg]) => !(pkg in was)).map(([pkg, v]) => `${pkg}@${v}`));
    list(`${label}, new versions`, Object.entries(is).filter(([pkg, v]) => pkg in was && was[pkg] !== v).map(([pkg, v]) => `${pkg}@${v}`));
    list(`${label}, taken out unless something else needs it`, dropped[field]);
  }
  for (const note of notes) log.warn(note);
}

/** `--yes`, or a "yes" at a terminal, naming the files written outside each component's directory. */
async function confirmUpgrade(plans: readonly UpgradePlan[], options: UpgradeOptions): Promise<void> {
  if (options.yes === true) return;
  if (!isInteractive()) throw new CliError("pikit upgrade asks for confirmation; pass --yes when it runs without a terminal (--dry-run shows what it does)");
  const outside = plans.map((plan) => alsoWrites(plan.name, plan.writes)).join("");
  if (!(await confirm(`Upgrade ${plans.map((plan) => plan.name).join(", ")}?${outside}`))) throw new CliError("cancelled", 1);
}

/** Whether a file still has the conflict markers `upgrade` wrote. */
function hasConflictMarkers(path: string): boolean {
  return /^<{7} yours$/m.test(readFileSync(path, "utf8"));
}
