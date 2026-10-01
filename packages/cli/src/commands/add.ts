/**
 * `pikit add <component>`: the install flow.
 *
 *   1. resolve the registry (`builtin`, or a local path) and the component's version and commit
 *   2. read the component's package
 *   3. check its targets, `requires.pikit` and `requires.contracts`, and that this CLI's kit is not
 *      older than the project's nor outside what an installed component accepts (`checkKit`); warn for
 *      each required capability nothing provides
 *   4. show what it writes: files (each one outside `src/pikit/<name>/` by its path), npm dependencies
 *      and dev dependencies, environment, capabilities, source
 *   5. confirm, naming the files outside `src/pikit/<name>/` (`--yes` in a script)
 *   6. write its files; refuse to overwrite a file that differs without `--force`. A reinstall
 *      (`--force`) overwrites the user's edits (`pikit upgrade` merges them instead), and deletes the
 *      files the installed version wrote that this one no longer ships, unless the user modified one:
 *      that one is kept, named, and stays recorded as the component's, so `pikit remove` asks for
 *      `--force` before deleting it
 *   7. add its npm dependencies and dev dependencies (`component.json`'s `devDependencies`), and on a
 *      reinstall take out those it added that it no longer declares, when nothing else needs them;
 *      `bun install`
 *   8. list it in `pikit.config.ts` (a component with no default export, a `deployment-*`, is not);
 *      on Cloudflare, also in the Worker's App when its `component.json`'s `apps.worker` says so (C1)
 *   9. append its variables to `.env.example` (a reinstall replaces its block)
 *  10. record the registry, version, commit, kit ranges, file hashes, hooks and the npm packages it added
 *      in `pikit.json`, and keep each file
 *      as installed, its base, in `pikit-bases/` (`bases.ts`)
 *  11. `pikit doctor`
 *
 * Every refusal (steps 1–5, for the component and the providers it brings) comes before the first
 * write. A step that fails after it puts back what was written: `package.json`, `bun.lock`,
 * `pikit.json`, `pikit.config.ts`, `.env.example`, the copied files, the bases and the new tarballs.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../registry/imports.ts";
import { contractsVersion, coreVersion } from "../registry/commands.ts";
import { BOTH_APPS, HOOKS, type Manifest } from "../registry/manifest.ts";
import { type AppName, APP_LABEL, declaredByApp, hasWorkerApp, workerHalfName } from "../project/apps.ts";
import { basePath, unreferencedBases } from "../project/bases.ts";
import { addComponent, CONFIG_FILE, type ComponentEntry, identifierFor } from "../project/config-file.ts";
import { ENV_EXAMPLE, exampleBlock, replaceExampleBlock } from "../project/env-file.ts";
import { addDependencies, type DependencyField, readPackageJson, removeDependencies, updateDependencies, writePackageJson } from "../project/package-json.ts";
import {
  hashFile,
  type InstalledComponent,
  kitRanges,
  modifiedFiles,
  ownedDependencies,
  PIKIT_JSON,
  type ProjectManifest,
  readProjectManifest,
  writeProjectManifest,
} from "../project/pikit-json.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { isPortable, recordedLocation, registryPath } from "../project/registry-location.ts";
import { type Offer, offeredProviders, unchosenProviders } from "../project/offers.ts";
import { Undo } from "../project/undo.ts";
import { kitCommit, kitOrder, pruneVendor, refreshKit, staleKit } from "../project/vendor.ts";
import { capabilityEntry } from "../registry/capabilities.ts";
import { CliError, confirm, isInteractive, log } from "../ui.ts";
import { doctor } from "./doctor.ts";
import { bunInstall } from "./install.ts";
import { unneededDependencies } from "./remove.ts";

export const PACKAGE_JSON = "package.json";
export const BUN_LOCK = "bun.lock";
const FIELDS: readonly DependencyField[] = ["dependencies", "devDependencies"];

export interface AddOptions {
  /** A registry path other than the project's default one. */
  registry?: string;
  /**
   * Overwrite files that differ, reinstall an installed component, and replace a kit that is newer or
   * that an installed component does not accept with this CLI's. It never deletes a file the user
   * modified that a reinstalled version no longer ships.
   */
  force?: boolean;
  /** Skip the confirmation (step 5). */
  yes?: boolean;
  /**
   * How `pikit.config.ts` imports and lists it, when not by its default export under its
   * camelCase name. `pikit new` uses it to load Pi's permission gate into `runtime-pi`.
   */
  wiring?: Omit<ComponentEntry, "name">;
  /** Do not describe what is installed (files, npm, capabilities): `pikit new`'s guided path. */
  quiet?: boolean;
  /** It is installed as an offer for this component (`offers.ts`), not asked for. */
  installedFor?: string;
}

export async function add(projectDir: string, name: string, options: AddOptions = {}): Promise<void> {
  // Steps 1–5 for the component and the providers it brings, before anything is written: a refusal
  // (installed, incompatible, a conflict, a config shape, a "no") leaves the project as it was.
  const draft = readDraft(projectDir);
  checkKit(projectDir, draft.project, options.force === true);
  const registryName = registryKey(projectDir, draft.project, options.registry);
  const location = draft.project.registries[registryName] as string;
  const registry = openRegistry(registryPath(projectDir, location));
  if (!isPortable(location)) log.warn(notPortable(location));
  const installed = Object.keys(draft.project.components);
  const plans = [planInstall(projectDir, draft, registry, registryName, name, options)];
  if (options.quiet !== true) describePlan(plans[0] as Plan);
  await confirmPlan(plans[0] as Plan, options);
  for (const offer of await acceptedOffers(registry, name, installed, draft.project.targets, options)) {
    const offered = planInstall(projectDir, draft, registry, registryName, offer.component, { ...options, installedFor: offer.for });
    if (options.quiet !== true) describePlan(offered);
    plans.push(offered);
  }

  // Steps 6–10 and `bun install`. What they write is put back if one fails, so the project is never
  // left half-added: a package.json that bun.lock does not match fails the next frozen install.
  const undo = new Undo(projectDir);
  let refreshed: string[] = [];
  try {
    // The component comes from this CLI's registry: the core it needs is this CLI's kit (vendor.ts).
    undo.keep(PACKAGE_JSON);
    refreshed = refreshKit(projectDir);
    if (refreshed.length > 0) log.step(`the project's kit packages (${refreshed.join(", ")}) are refreshed to this CLI's, in vendor/`);
    const { dependenciesChanged } = applyPlans(projectDir, draft, plans, undo);
    if (dependenciesChanged || refreshed.length > 0) {
      undo.keep(BUN_LOCK);
      undo.installed = true;
      await bunInstall(projectDir);
    }
  } catch (error) {
    undo.restore();
    log.warn(`nothing was added: the project's files are back as they were${undo.installed ? " (node_modules may not be: run `bun install`)" : ""}`);
    throw error;
  }
  // Only now: until the install rewrote bun.lock, it named the old tarballs.
  if (refreshed.length > 0) pruneVendor(projectDir);
  const report = await doctor(projectDir, { quiet: true, componentChecks: false });
  if (report.problems.length > 0) {
    for (const problem of report.problems) log.problem(problem);
    throw new CliError(`${name} is installed, but \`pikit doctor\` found ${report.problems.length} problem(s)`);
  }
  for (const missing of report.unconfigured) log.warn(missing);
  log.ok(`${name} installed; \`pikit doctor\` is green${report.unconfigured.length > 0 ? " (run \`pikit configure\` for the variables above)" : ""}`);
}

/**
 * The providers `name` brings (`offers.ts`), each asked about (Enter is yes), or all of them with
 * `--yes`. A declined provider takes what only it needed with it.
 */
export async function acceptedOffers(registry: Registry, name: string, installed: readonly string[], targets: readonly string[], options: AddOptions): Promise<Offer[]> {
  warnUnchosen(registry, [name], installed, targets);
  const accepted: Offer[] = [];
  const declined = new Set<string>();
  for (const offer of offeredProviders(registry, [name], installed, targets).reverse()) {
    if (declined.has(offer.for)) {
      declined.add(offer.component);
      continue;
    }
    const what = (capabilityEntry(offer.capability)?.summary ?? offer.capability).replace(/\.$/, "");
    const who = offer.app === "worker" ? `${offer.for}'s Worker half` : offer.for;
    const question =
      (offer.why === "recommended"
        ? `${who} can use ${offer.capability} (${what}). Install ${offer.component}?`
        : `${who} requires ${offer.capability}. Install ${offer.component}?`) + alsoWrites(offer.component, registry.files(offer.component));
    if (options.yes === true || (isInteractive() && (await confirm(question, true)))) {
      log.step(`${offer.component}, for ${offer.for} (${offer.capability})`);
      accepted.push(offer);
    } else declined.add(offer.component);
  }
  // Providers before what uses them.
  return accepted.reverse();
}

/**
 * Says which optional capabilities `names` could use but get no provider for, because the registry has
 * several (`unchosenProviders`): the project composes without them, so nothing else would say so.
 */
export function warnUnchosen(registry: Registry, names: readonly string[], installed: readonly string[], targets: readonly string[]): void {
  for (const { capability, for: name, providers, app } of unchosenProviders(registry, names, installed, targets)) {
    const what = (capabilityEntry(capability)?.summary ?? capability).replace(/\.$/, "");
    const who = app === "worker" ? `${name}'s Worker half` : name;
    log.warn(`${who} can use ${capability} (${what}), but ${providers.join(" and ")} each provide it, so none is installed: choose one with \`pikit add <name>\``);
  }
}

/** Steps 1–6 and 8–10: everything but `bun install` and `doctor`, which `pikit new` runs once for all. */
export async function installComponent(
  projectDir: string,
  name: string,
  options: AddOptions = {},
): Promise<{ dependenciesChanged: boolean }> {
  const draft = readDraft(projectDir);
  const registryName = registryKey(projectDir, draft.project, options.registry);
  const registry = openRegistry(registryPath(projectDir, draft.project.registries[registryName] as string));
  const plan = planInstall(projectDir, draft, registry, registryName, name, options);
  if (options.quiet !== true) describePlan(plan);
  await confirmPlan(plan, options);
  const undo = new Undo(projectDir);
  try {
    return applyPlans(projectDir, draft, [plan], undo);
  } catch (error) {
    undo.restore();
    throw error;
  }
}

/** One component's install (or upgrade), checked: what it writes, from where. */
export interface Plan {
  name: string;
  registry: Registry;
  manifest: Manifest;
  /** Every file it ships, project-relative target → absolute source: each one's base (`bases.ts`) is kept. */
  files: Map<string, string>;
  /** What is written, by target: a shipped file (its source), or a merge's text (`pikit upgrade`). */
  writes: Map<string, { source: string } | { content: Uint8Array }>;
  /** A reinstall: what the installed version wrote, this one no longer ships, and nobody modified; deleted. */
  obsolete: string[];
  /** A reinstall: the record it replaces. */
  previous: InstalledComponent | undefined;
  /** A reinstall: the packages `add` put in package.json for it that it no longer declares, by field. */
  dropped: Record<DependencyField, string[]>;
}

/**
 * The project files an install edits, as they will be once it is done. Each plan is checked against
 * the draft and edits it in memory; nothing reaches the disk before every plan passed and was confirmed.
 */
export interface Draft {
  project: ProjectManifest;
  /** `pikit.config.ts`, as read and as it will be; undefined when the project has none. */
  config: { before: string; after: string } | undefined;
  /** `.env.example`, as read ("" when absent) and as it will be. */
  example: { before: string; after: string };
}

export function readDraft(projectDir: string): Draft {
  const configPath = join(projectDir, CONFIG_FILE);
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  const examplePath = join(projectDir, ENV_EXAMPLE);
  const example = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
  return {
    project: readProjectManifest(projectDir),
    config: config === undefined ? undefined : { before: config, after: config },
    example: { before: example, after: example },
  };
}

/** Steps 1–4 and the text of steps 8–10, on the draft: every refusal happens here, before any write. */
export function planInstall(
  projectDir: string,
  draft: Draft,
  registry: Registry,
  registryName: string,
  name: string,
  options: AddOptions,
): Plan {
  const { project } = draft;
  const manifest = registry.manifest(name);
  if (name in project.components && options.force !== true) {
    throw new CliError(
      `${name} is already installed: \`pikit upgrade ${name}\` takes its registry's version and keeps your edits (\`--force\` reinstalls it, overwriting them)`,
    );
  }
  checkCompatible(project.targets, manifest);
  warnUnprovided(project, registry, manifest);

  const files = registry.files(name);
  checkConflicts(projectDir, project, name, files, options.force === true);

  // An app component has a default export; a `deployment-*` does not, and is not listed.
  const entry = files.get(`src/pikit/${name}/index.ts`);
  if (entry !== undefined && hasDefaultExport(entry)) {
    if (draft.config === undefined) throw new CliError(`${CONFIG_FILE} is missing: ${name} is listed in it`);
    // A `ShapeError` refuses the install here, before a file is copied.
    if (!draft.config.after.includes(`"./src/pikit/${name}/index.ts"`)) {
      draft.config.after = addComponent(draft.config.after, { name, ...workerWiring(name, manifest, project.targets), ...options.wiring });
    }
  }

  // A reinstall replaces its block: the variables are this version's.
  draft.example.after = replaceExampleBlock(draft.example.after, name, exampleBlock(name, manifest.environment ?? []));

  const previous = project.components[name];
  const installedFor = options.installedFor === undefined ? undefined : [...new Set([...(previous?.installedFor ?? []), options.installedFor])];
  const { record, obsolete, kept, dropped } = recordInstall(projectDir, previous, registry, registryName, manifest, files, installedFor);
  for (const file of kept) {
    log.warn(`${name} ${manifest.version} no longer ships ${file}, which you modified: it is kept (delete it yourself if nothing uses it)`);
  }
  project.components[name] = record;
  const writes = new Map([...files].map(([target, source]) => [target, { source }]));
  return { name, registry, manifest, files, writes, obsolete, previous, dropped };
}

/**
 * The `pikit.json` record of `manifest`'s install from `registry`: each file it ships by the hash of
 * its source (its copy's, and its base's), and what it declares. On a reinstall or an upgrade
 * (`previous`), the files the installed version wrote that this one no longer ships are `obsolete`
 * (deleted), unless the user modified one: that one is `kept`, recorded as installed, so `pikit
 * remove` still asks first. The packages `add` put in package.json for it stay its own while it
 * declares them; the others are `dropped` (`applyPlans` takes them out when nothing else needs them).
 */
export function recordInstall(
  projectDir: string,
  previous: InstalledComponent | undefined,
  registry: Registry,
  registryName: string,
  manifest: Manifest,
  files: Map<string, string>,
  installedFor: string[] | undefined,
): { record: InstalledComponent; obsolete: string[]; kept: string[]; dropped: Record<DependencyField, string[]> } {
  const { name } = manifest;
  const hashes: Record<string, { hash: string }> = {};
  for (const [target, source] of files) hashes[target] = { hash: hashFile(source) };
  const obsolete: string[] = [];
  const kept: string[] = [];
  if (previous !== undefined) {
    const modified = new Set(modifiedFiles(projectDir, previous));
    for (const [file, recorded] of Object.entries(previous.files)) {
      if (files.has(file) || !existsSync(join(projectDir, file))) continue;
      if (!modified.has(file)) obsolete.push(file);
      else {
        hashes[file] = recorded;
        kept.push(file);
      }
    }
  }
  const ownedBefore = previous === undefined ? { dependencies: [], devDependencies: [] } : ownedDependencies(previous);
  const declared = { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies ?? {} };
  const stays = (field: DependencyField) => ownedBefore[field].filter((pkg) => pkg in declared[field]);
  const dropped = { dependencies: ownedBefore.dependencies.filter((pkg) => !(pkg in declared.dependencies)), devDependencies: ownedBefore.devDependencies.filter((pkg) => !(pkg in declared.devDependencies)) };
  const record: InstalledComponent = {
    ...(installedFor !== undefined && { installedFor }),
    registry: registryName,
    version: manifest.version,
    ...(registry.commit !== undefined && { commit: registry.commit }),
    // The kit it accepts: a later add checks it before it changes the project's kit (`checkKit`).
    requires: { pikit: manifest.requires.pikit, ...(manifest.requires.contracts !== undefined && { contracts: manifest.requires.contracts }) },
    files: hashes,
    dependencies: manifest.dependencies,
    ...(manifest.devDependencies !== undefined && { devDependencies: manifest.devDependencies }),
    // What `add` put in package.json for it: a reinstall keeps those it still declares (`applyPlans` adds this version's).
    addedDependencies: stays("dependencies"),
    ...(stays("devDependencies").length > 0 && { addedDevDependencies: stays("devDependencies") }),
    environment: manifest.environment ?? [],
    // What `pikit doctor` and the deployment's `up` run for it, by its project path.
    ...(manifest.hooks !== undefined && { hooks: projectHooks(name, manifest.hooks) }),
    // Files a hook rewrites: never reported as the user's edits.
    ...(manifest.generated !== undefined && { generated: manifest.generated.map((file) => `${ownDir(name)}${file}`) }),
    // Where it goes on Cloudflare: `pikit upgrade` rewires the Worker's App only when this changes.
    ...(manifest.apps !== undefined && { apps: manifest.apps }),
  };
  return { record, obsolete, kept, dropped };
}

/**
 * How a component goes in the Worker's App too, on Cloudflare (SPEC C1), as `component.json`'s
 * `apps.worker` says: its default export as it is (`"default"`), or its named Worker half, imported
 * under its component's name (`channel-telegram-webhook-worker` → `channelTelegramWebhookWorker`),
 * which is its config key in `workerConfig`. On a server, or without `apps`, only the default App.
 */
export function workerWiring(name: string, manifest: Manifest, targets: readonly string[]): Omit<ComponentEntry, "name"> {
  const exported = manifest.apps?.worker;
  if (exported === undefined || !hasWorkerApp(targets)) return {};
  const identifier = identifierFor(name);
  if (exported === BOTH_APPS) return { worker: identifier };
  const half = identifierFor(workerHalfName(name));
  return { importClause: `${identifier}, { ${exported === half ? half : `${exported} as ${half}`} }`, worker: half };
}

/**
 * The kit `add` will point the project at is this CLI's (`refreshKit`, in the apply phase). Refused,
 * before any write, when that replaces a newer kit: the components installed with it may need what
 * it has. `--force` replaces it anyway. When the order cannot be told, it is said, and it goes ahead.
 * Refused too, unless `--force`, when an installed component does not accept this CLI's core or
 * contracts (`requires` in pikit.json, `kitRanges`): the contracts stay 0.x on their own schedule (SPEC
 * K8), and nothing else would check the components already vendored against them. The draft records
 * the kit the project will have.
 */
export function checkKit(projectDir: string, project: ProjectManifest, force: boolean): void {
  const { vendored, stale } = staleKit(projectDir);
  const cli = kitCommit();
  if (stale.length === 0) {
    // Already this CLI's packages, byte for byte: a project that does not say which kit it has now does.
    if (vendored && project.kit === undefined && cli !== undefined) project.kit = { commit: cli };
    return;
  }
  const current = project.kit?.commit;
  const order = kitOrder(current);
  if (order.verdict === "downgrade") {
    const what = `this project's kit (vendor/) comes from pikit ${current}, which this CLI's checkout (${cli}) does not include: this CLI is older, or on another branch`;
    if (!force) {
      throw new CliError(
        `${what}. Adding a component replaces the project's kit with this CLI's, and the components installed with the newer kit may need what only it has.\n` +
          "Update pikit (run the installer again, or `git pull` in its checkout), or pass --force to replace the kit anyway (then check with `pikit doctor`).",
      );
    }
    log.warn(`${what}; --force: replacing it with this older kit`);
  } else if (order.verdict === "unknown") {
    log.warn(`the project's kit is replaced with this CLI's (${cli ?? "not in Git"}), which may be older: ${order.why}`);
  }
  const refused = incompatibleInstalled(project);
  if (refused.length > 0) {
    const what = `adding a component replaces the project's kit with this CLI's (@pikit/core ${coreVersion()}, @pikit/contracts ${contractsVersion()}), which these installed components do not accept:\n  ${refused.join("\n  ")}`;
    if (!force) {
      throw new CliError(
        `${what}\nUse a pikit whose kit they accept, or pass --force to replace the kit anyway (then check them with \`pikit doctor\` and a type-check).`,
      );
    }
    log.warn(`${what}\n--force: replacing it anyway`);
  }
  if (cli === undefined) delete project.kit;
  else project.kit = { commit: cli };
}

/** Step 5: `--yes`, or a "yes" at a terminal. */
async function confirmPlan(plan: Plan, options: AddOptions): Promise<void> {
  if (options.yes === true) return;
  if (!isInteractive()) throw new CliError("pikit add asks for confirmation; pass --yes when it runs without a terminal");
  if (!(await confirm(`Install ${plan.name}?${alsoWrites(plan.name, plan.files)}`))) throw new CliError("cancelled", 1);
}

/** Where a component's own files go; the plan names every file it writes anywhere else. */
/** A manifest's `hooks` (files of the component's own directory) by project path, in the order they run. */
function projectHooks(name: string, hooks: NonNullable<Manifest["hooks"]>): NonNullable<InstalledComponent["hooks"]> {
  return Object.fromEntries(HOOKS.flatMap((hook) => (hooks[hook] === undefined ? [] : [[hook, `${ownDir(name)}${hooks[hook]}`]])));
}

export function ownDir(name: string): string {
  return `src/pikit/${name}/`;
}

/** The targets outside the component's own directory, sorted (so grouped by directory). */
function outside(name: string, files: Map<string, unknown>): string[] {
  return [...files.keys()].filter((target) => !target.startsWith(ownDir(name))).sort();
}

/** What a confirmation adds when the component writes outside its directory: the files, by name. */
export function alsoWrites(name: string, files: Map<string, unknown>): string {
  const others = outside(name, files);
  return others.length === 0 ? "" : ` It also writes, outside ${ownDir(name)}: ${others.join(", ")}`;
}

/** Steps 6–10 for the confirmed plans: files and their bases, npm (dev) dependencies, then the draft's three files. */
export function applyPlans(projectDir: string, draft: Draft, plans: readonly Plan[], undo: Undo): { dependenciesChanged: boolean } {
  for (const plan of plans) {
    for (const file of plan.obsolete) undo.delete(file);
    for (const [target, write] of plan.writes) {
      undo.keep(target);
      if ("source" in write) copyFileSync(write.source, undo.mkdirFor(target));
      else writeFileSync(undo.mkdirFor(target), write.content);
    }
    const recorded = draft.project.components[plan.name]?.files ?? {};
    for (const [target, source] of plan.files) {
      // The base is named by the hash pikit.json records: the source's.
      const base = basePath(recorded[target]?.hash ?? hashFile(source));
      if (existsSync(join(projectDir, base))) continue;
      undo.keep(base);
      copyFileSync(source, undo.mkdirFor(base));
    }
  }

  undo.keep(PACKAGE_JSON);
  const pkg = readPackageJson(projectDir);
  let dependenciesChanged = false;
  for (const plan of plans) {
    const record = draft.project.components[plan.name] as InstalledComponent;
    // A reinstall or an upgrade: what it added and no longer declares goes, when nothing else needs
    // it; what it added moves to the version it declares now, unless the project chose another.
    for (const field of FIELDS) {
      const unneeded = plan.dropped[field].length === 0 ? [] : unneededDependencies(projectDir, draft.project, plan.dropped[field]);
      const removed = removeDependencies(pkg, unneeded, field);
      const owned = (field === "dependencies" ? record.addedDependencies : record.addedDevDependencies) ?? [];
      const moved = updateDependencies(pkg, plan.previous?.[field] ?? {}, record[field] ?? {}, owned, field);
      dependenciesChanged ||= removed.length > 0 || moved.length > 0;
    }
    const { added, conflicts } = addDependencies(projectDir, pkg, plan.manifest.dependencies);
    for (const conflict of conflicts) log.warn(`dependency kept as the project has it: ${conflict}`);
    const dev = addDependencies(projectDir, pkg, plan.manifest.devDependencies ?? {}, "devDependencies");
    for (const conflict of dev.conflicts) log.warn(`dev dependency kept as the project has it: ${conflict}`);
    dependenciesChanged ||= added.length > 0 || dev.added.length > 0;
    // Only what it added is its to take out on `remove`: a package the project had is the project's.
    const others = Object.entries(draft.project.components).flatMap(([name, c]) => (name === plan.name ? [] : [ownedDependencies(c)]));
    record.addedDependencies = owned(record.addedDependencies ?? [], added, plan.manifest.dependencies, others.flatMap((o) => o.dependencies));
    const addedDev = owned(record.addedDevDependencies ?? [], dev.added, plan.manifest.devDependencies ?? {}, others.flatMap((o) => o.devDependencies));
    if (addedDev.length > 0) record.addedDevDependencies = addedDev;
  }
  if (dependenciesChanged) writePackageJson(projectDir, pkg);

  if (draft.config !== undefined && draft.config.after !== draft.config.before) {
    undo.keep(CONFIG_FILE);
    writeFileSync(join(projectDir, CONFIG_FILE), draft.config.after);
  }
  if (draft.example.after !== draft.example.before) {
    undo.keep(ENV_EXAMPLE);
    writeFileSync(join(projectDir, ENV_EXAMPLE), draft.example.after);
  }
  undo.keep(PIKIT_JSON);
  writeProjectManifest(projectDir, draft.project);
  // A reinstall (--force) replaces the component's hashes: the bases of the old ones may be nobody's now.
  for (const base of unreferencedBases(projectDir, draft.project)) {
    undo.keep(base);
    rmSync(join(projectDir, base));
  }
  return { dependenciesChanged };
}

/**
 * The packages of one field a component owns after an add: what it owned, what the add put in
 * package.json, and what it declares that another installed component put there (shared: the last of
 * them to be removed takes it out).
 */
function owned(before: readonly string[], added: readonly string[], declared: Record<string, string>, ownedByOthers: readonly string[]): string[] {
  const shared = Object.keys(declared).filter((pkg) => ownedByOthers.includes(pkg));
  return [...new Set([...before, ...added, ...shared])].sort();
}

/** The key of `registries` for this path, added (as `recordedLocation` records it) when the project does not know it yet. */
function registryKey(projectDir: string, project: ProjectManifest, path: string | undefined): string {
  if (path === undefined) {
    if (project.registries.default === undefined) throw new CliError("pikit.json has no default registry; pass --registry <path>");
    return "default";
  }
  const root = openRegistry(path).root;
  const location = recordedLocation(projectDir, root);
  const known = Object.entries(project.registries).find(([, recorded]) => recorded === location || registryPath(projectDir, recorded) === root);
  if (known) return known[0];
  let key = "local";
  for (let n = 2; key in project.registries; n++) key = `local-${n}`;
  project.registries[key] = location;
  return key;
}

/** Said whenever a component comes from a registry recorded by a path of this machine. */
export function notPortable(location: string): string {
  return `the registry ${location} is a path on this machine: where this project is cloned, \`pikit add\` from it fails (put the registry inside the project to keep it portable)`;
}

/** Each installed component that does not accept this CLI's core or contracts, with what it accepts. */
function incompatibleInstalled(project: ProjectManifest): string[] {
  const kit = { "@pikit/core": coreVersion(), "@pikit/contracts": contractsVersion() };
  return Object.entries(project.components).flatMap(([name, installed]) => {
    const { pikit, contracts } = kitRanges(installed);
    return (
      [
        ["@pikit/core", pikit],
        ["@pikit/contracts", contracts],
      ] as const
    )
      .filter(([pkg, range]) => range !== undefined && !Bun.semver.satisfies(kit[pkg], range))
      .map(([pkg, range]) => `${name} requires ${pkg} ${range}`);
  });
}

/**
 * Refuses a component that does not run on `targets` or does not accept this CLI's core and
 * contracts. `force` (`pikit upgrade --force`) turns the second into a warning.
 */
export function checkCompatible(targets: readonly string[], manifest: Manifest, force = false): void {
  const unsupported = targets.filter((t) => !manifest.targets.includes(t));
  if (unsupported.length > 0) {
    throw new CliError(`${manifest.name} runs on ${manifest.targets.join(", ")}, not on this project's ${unsupported.join(", ")} target`);
  }
  const refuse = (what: string) => {
    if (!force) throw new CliError(what);
    log.warn(`${what}; --force: going ahead`);
  };
  const core = coreVersion();
  if (!Bun.semver.satisfies(core, manifest.requires.pikit)) {
    refuse(`${manifest.name} requires @pikit/core ${manifest.requires.pikit}; this CLI vendors ${core}`);
  }
  const contracts = contractsVersion();
  if (manifest.requires.contracts !== undefined && !Bun.semver.satisfies(contracts, manifest.requires.contracts)) {
    refuse(`${manifest.name} requires @pikit/contracts ${manifest.requires.contracts}; this CLI vendors ${contracts}`);
  }
}

/**
 * Information, not failure: the provider may come next, or from the project's own components. Per App
 * on Cloudflare: what the Worker's half requires must be provided in the Worker's App.
 */
export function warnUnprovided(project: ProjectManifest, registry: Registry, manifest: Manifest): void {
  const provided: Record<AppName, Set<string>> = { default: new Set(), worker: new Set() };
  const provide = (m: Manifest) => {
    for (const [app, half] of declaredByApp(m, project.targets)) for (const capability of half.provides) provided[app].add(capability);
  };
  provide(manifest);
  for (const installed of Object.keys(project.components)) {
    try {
      provide(registry.manifest(installed));
    } catch {
      // Installed from another registry: `pikit doctor` checks the real app anyway.
    }
  }
  const apps = declaredByApp(manifest, project.targets);
  for (const [app, half] of apps) {
    for (const capability of half.requires) {
      if (provided[app].has(capability)) continue;
      log.warn(
        apps.length === 1
          ? `${manifest.name} requires "${capability}", which no installed component provides yet`
          : `${manifest.name} requires "${capability}" in ${APP_LABEL[app]}, which no installed component provides there yet`,
      );
    }
  }
}

export function checkConflicts(projectDir: string, project: ProjectManifest, name: string, files: Map<string, string>, force: boolean): void {
  const conflicts: string[] = [];
  for (const [target, source] of files) {
    const owner = Object.entries(project.components).find(([other, c]) => other !== name && target in c.files)?.[0];
    if (owner !== undefined) throw new CliError(`${name} would write ${target}, which ${owner} installed`);
    const path = join(projectDir, target);
    if (!existsSync(path) || hashFile(path) === hashFile(source)) continue;
    // A reinstall may overwrite what it installed itself, when nobody changed it since.
    const recorded = project.components[name]?.files[target]?.hash;
    if (recorded !== undefined && recorded === hashFile(path)) continue;
    conflicts.push(target);
  }
  if (conflicts.length > 0 && !force) {
    throw new CliError(`these files exist and differ from ${name}'s (pass --force to overwrite them):\n  ${conflicts.join("\n  ")}`);
  }
}

export function describePlan({ registry, manifest, files, obsolete }: Plan): void {
  log.step(`${manifest.name} ${manifest.version} from ${registry.root}${registry.commit ? ` at ${registry.commit}` : ""}`);
  if (registry.commit?.endsWith("-dirty")) {
    log.warn(`the registry has uncommitted changes: its commit does not name these files (pikit-bases/ keeps them as installed, for \`pikit upgrade\`)`);
  }
  // A registry may be anyone's: a file outside the component's directory is shown by its path, marked.
  const others = outside(manifest.name, files);
  log.info(`  files: ${files.size - others.length} in ${ownDir(manifest.name)}`);
  if (others.length > 0) {
    log.info(`  files outside ${ownDir(manifest.name)}: ${others.length}`);
    for (const target of others) log.info(`    ! ${target}`);
  }
  if (obsolete.length > 0) log.info(`  deletes, no longer shipped: ${obsolete.join(", ")}`);
  const deps = Object.entries(manifest.dependencies);
  if (deps.length > 0) log.info(`  npm: ${deps.map(([p, v]) => `${p}@${v}`).join(", ")}`);
  const devDeps = Object.entries(manifest.devDependencies ?? {});
  if (devDeps.length > 0) log.info(`  npm (dev): ${devDeps.map(([p, v]) => `${p}@${v}`).join(", ")}`);
  const env = manifest.environment ?? [];
  if (env.length > 0) log.info(`  environment: ${env.map((v) => `${v.name}${v.required ? "" : " (optional)"}`).join(", ")}`);
  if (manifest.provides.length > 0) log.info(`  provides: ${manifest.provides.join(", ")}`);
  if (manifest.requires.capabilities.length > 0) log.info(`  requires: ${manifest.requires.capabilities.join(", ")}`);
}

/** Whether a component's entry point (its source in the registry) has a default export. */
function hasDefaultExport(entry: string): boolean {
  return /(^|\n)\s*export\s+default\b/.test(stripComments(readFileSync(entry, "utf8")));
}
