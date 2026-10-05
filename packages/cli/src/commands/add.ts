/**
 * `pikit add <component>`: the install flow.
 *
 *   1. resolve the registry (`builtin`, or a local path) and the component's version and commit
 *   2. read the component's package
 *   3. check its targets, `requires.pikit`, `requires.contracts` and `requires.adapter` (a range it
 *      must state is refused when missing, even with `--force`), and that this CLI's kit is not older
 *      than the project's nor outside what an installed component accepts (`checkKit`); warn for each
 *      required capability nothing provides, by what `pikit.config.ts` composes now (`offers.ts`)
 *   4. show what it writes: files (each one outside `src/pikit/<name>/` by its path), npm dependencies
 *      and dev dependencies, environment, capabilities, source
 *   5. confirm, naming the files outside `src/pikit/<name>/` (`--yes` in a script)
 *   6. write its files, and its README as `src/pikit/<name>/README.md` (`registry.files`); refuse to
 *      overwrite a file that differs without `--force`. A reinstall
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
 *  11. `pikit doctor`, its notes printed (a provider nothing uses)
 *
 * Every refusal (steps 1–5, for the component and the providers it brings) comes before the first
 * write. A step that fails after it puts back what was written: `package.json`, `bun.lock`,
 * `pikit.json`, `pikit.config.ts`, `.env.example`, the copied files, the bases and the new tarballs.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../registry/imports.ts";
import { kitRangeProblems } from "../registry/checks.ts";
import { adapterVersion, contractsVersion, coreVersion } from "../registry/commands.ts";
import { BOTH_APPS, HOOKS, type Manifest } from "../registry/manifest.ts";
import { APP_LABEL, declaredByApp, hasWorkerApp, workerHalfName } from "../project/apps.ts";
import { BASES_DIR, basePath, unreferencedBases } from "../project/bases.ts";
import { addComponent, CONFIG_FILE, type ComponentEntry, identifierFor } from "../project/config-file.ts";
import { ENV_EXAMPLE, exampleBlock, replaceExampleBlock } from "../project/env-file.ts";
import {
  addDependencies,
  type DependencyField,
  projectDependencies,
  readPackageJson,
  removeDependencies,
  updateDependencies,
  writePackageJson,
} from "../project/package-json.ts";
import {
  hashFile,
  type InstalledComponent,
  modifiedFiles,
  ownedDependencies,
  PIKIT_JSON,
  type ProjectManifest,
  readProjectManifest,
  writeProjectManifest,
} from "../project/pikit-json.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { isPortable, recordedLocation, registryPath } from "../project/registry-location.ts";
import {
  mergeProvided,
  type Offer,
  offeredProviders,
  type ProvidedCapabilities,
  providedByApp,
  providedByManifests,
  unchosenProviders,
} from "../project/offers.ts";
import { probe } from "../project/run.ts";
import { Undo } from "../project/undo.ts";
import { confinedPath } from "../project/paths.ts";
import { assertNoIncompleteOperation, beginOperation, finishOperation, OPERATION_MARKER } from "../project/operation.ts";
import { kitCommit, kitOrder, pruneVendor, refreshKit, staleKit, VENDOR_DIR } from "../project/vendor.ts";
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
  assertNoIncompleteOperation(projectDir);
  // Steps 1–5 for the component and the providers it brings, before anything is written: a refusal
  // (installed, incompatible, a conflict, a config shape, a "no") leaves the project as it was.
  const draft = readDraft(projectDir);
  checkKit(projectDir, draft.project, options.force === true);
  const registryName = registryKey(projectDir, draft.project, options.registry);
  const location = draft.project.registries[registryName] as string;
  const registry = openRegistry(registryPath(projectDir, location));
  if (!isPortable(location)) log.warn(notPortable(location));
  const installed = Object.keys(draft.project.components);
  // What the project provides now, but for the component a reinstall replaces.
  draft.provided = await composedProvides(projectDir, name in draft.project.components ? [name] : []);
  const plans = [planInstall(projectDir, draft, registry, registryName, name, options)];
  if (options.quiet !== true) describePlan(plans[0] as Plan);
  await confirmPlan(plans[0] as Plan, options);
  const offers = draft.provided === undefined ? [] : await acceptedOffers(registry, name, installed, draft.project.targets, draft.provided, options);
  for (const offer of offers) {
    const offered = planInstall(projectDir, draft, registry, registryName, offer.component, { ...options, installedFor: offer.for });
    if (options.quiet !== true) describePlan(offered);
    plans.push(offered);
  }

  // Steps 6–10 and `bun install`, as one transaction.
  await applyInstall(projectDir, `pikit add ${name}${options.force === true ? " --force" : ""}`, draft, plans, "nothing was added");
  const report = await doctor(projectDir, { quiet: true, componentChecks: false });
  for (const note of report.notes) log.info(`  ${note}`);
  if (report.problems.length > 0) {
    for (const problem of report.problems) log.problem(problem);
    throw new CliError(`${name} is installed, but \`pikit doctor\` found ${report.problems.length} problem(s)`);
  }
  for (const missing of report.unconfigured) log.warn(missing);
  log.ok(`${name} installed; \`pikit doctor\` is green${report.unconfigured.length > 0 ? " (run \`pikit configure\` for the variables above)" : ""}`);
}

/**
 * The writes of `add` and `upgrade`, as one transaction: the operation marker (`operation.ts`), the
 * kit refreshed to this CLI's (the components come from its registry, so the core they need is its
 * kit, `vendor.ts`), the confirmed `plans` and the draft (`applyPlans`), then `bun install` when a
 * dependency or the kit changed. When a step fails, `undo` puts back what was written, so the project
 * is never left half-changed (a package.json that bun.lock does not match fails the next frozen
 * install), `notDone` is said, and the error is thrown again. The marker stays only when `bun install`
 * ran: node_modules is not put back. Returns the kit packages refreshed.
 */
export async function applyInstall(projectDir: string, command: string, draft: Draft, plans: readonly Plan[], notDone: string): Promise<string[]> {
  const undo = new Undo(projectDir);
  beginOperation(projectDir, command);
  let refreshed: string[] = [];
  try {
    undo.keep(PACKAGE_JSON);
    refreshed = refreshKit(projectDir);
    if (refreshed.length > 0) log.step(`the project's kit packages (${refreshed.join(", ")}) are refreshed to this CLI's, in vendor/`);
    const { dependenciesChanged } = applyPlans(projectDir, draft, plans, undo);
    if (dependenciesChanged || refreshed.length > 0) {
      undo.keep(BUN_LOCK);
      undo.keep("bun.lockb");
      undo.installed = true;
      await bunInstall(projectDir);
    }
  } catch (error) {
    undo.restore();
    if (!undo.installed) finishOperation(projectDir);
    log.warn(`${notDone}: the project's files are back as they were${undo.installed ? ` (node_modules may not be: run \`bun install\`, then delete ${OPERATION_MARKER})` : ""}`);
    throw error;
  }
  // Only now: until the install rewrote bun.lock, it named the old tarballs.
  if (refreshed.length > 0) pruneVendor(projectDir);
  finishOperation(projectDir);
  return refreshed;
}

/**
 * What the project's Apps provide now, as `pikit.config.ts` composes them (`providedByApp`): its own
 * components and their config included, `excluding` those about to be replaced. Undefined, and said,
 * when it does not compose: then nothing is offered, and the providers are the user's to add.
 */
export async function composedProvides(projectDir: string, excluding: readonly string[]): Promise<ProvidedCapabilities | undefined> {
  let error: string;
  try {
    const result = await probe(projectDir);
    const provided = providedByApp(result, excluding);
    if (provided !== undefined) return provided;
    error = result.ok ? "" : result.error;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  log.warn(
    `pikit.config.ts does not compose (${error}), so what the project provides is unknown: no provider is offered. ` +
      "Fix the composition, or add the providers it needs with `pikit add <name>`",
  );
  return undefined;
}

/**
 * The providers `name` brings (`offers.ts`), given what the project provides (`composedProvides`),
 * each asked about (Enter is yes), or all of them with `--yes`. A declined provider takes what only
 * it needed with it.
 */
export async function acceptedOffers(
  registry: Registry,
  name: string,
  installed: readonly string[],
  targets: readonly string[],
  provided: ProvidedCapabilities,
  options: AddOptions,
): Promise<Offer[]> {
  warnUnchosen(registry, [name], installed, targets, provided);
  const accepted: Offer[] = [];
  const declined = new Set<string>();
  for (const offer of offeredProviders(registry, [name], installed, targets, provided).reverse()) {
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
export function warnUnchosen(
  registry: Registry,
  names: readonly string[],
  installed: readonly string[],
  targets: readonly string[],
  provided?: ProvidedCapabilities,
): void {
  for (const { capability, for: name, providers, app, why } of unchosenProviders(registry, names, installed, targets, provided)) {
    const what = (capabilityEntry(capability)?.summary ?? capability).replace(/\.$/, "");
    const who = app === "worker" ? `${name}'s Worker half` : name;
    log.warn(
      why === "recommended"
        ? `${who} can use ${capability} (${what}), but ${providers.join(" and ")} each provide it, so none is installed: choose one with \`pikit add <name>\``
        : `${who} requires ${capability}, which ${providers.join(" and ")} each provide, so none is installed: install one with \`pikit add <name>\` before the app composes`,
    );
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
  /**
   * What the project will provide, per App: what it composes now (`composedProvides`), with what each
   * planned component declares. Undefined when unknown (it does not compose; `pikit new`, whose final
   * doctor checks it): nothing is warned about, nor offered.
   */
  provided?: ProvidedCapabilities | undefined;
}

export function readDraft(projectDir: string): Draft {
  // Fixed records/directories are guarded before any component can write or an install can run.
  for (const file of [PACKAGE_JSON, BUN_LOCK, "bun.lockb", BASES_DIR, VENDOR_DIR]) confinedPath(projectDir, file);
  const configPath = confinedPath(projectDir, CONFIG_FILE);
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  const examplePath = confinedPath(projectDir, ENV_EXAMPLE);
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
  warnUnprovided(project, manifest, draft.provided);
  if (draft.provided !== undefined) draft.provided = mergeProvided(draft.provided, providedByManifests([manifest], project.targets));

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
  for (const [target, source] of files) {
    const hash = hashFile(source);
    confinedPath(projectDir, basePath(hash));
    hashes[target] = { hash };
  }
  const obsolete: string[] = [];
  const kept: string[] = [];
  if (previous !== undefined) {
    const modified = new Set(modifiedFiles(projectDir, previous));
    for (const [file, recorded] of Object.entries(previous.files)) {
      if (files.has(file) || !existsSync(confinedPath(projectDir, file))) continue;
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
    requires: {
      pikit: manifest.requires.pikit,
      ...(manifest.requires.contracts !== undefined && { contracts: manifest.requires.contracts }),
      ...(manifest.requires.adapter !== undefined && { adapter: manifest.requires.adapter }),
    },
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
 * Refused too, unless `--force`, when an installed component does not accept this CLI's core,
 * contracts or adapter (`requires` in pikit.json): the contracts stay 0.x on their own schedule (SPEC
 * K8), and nothing else would check the components already vendored against them. The draft records
 * the kit the project will have. `action` is what replaces it, in the messages.
 */
export function checkKit(projectDir: string, project: ProjectManifest, force: boolean, action = "adding a component"): void {
  const Action = `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
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
        `${what}. ${Action} replaces the project's kit with this CLI's, and the components installed with the newer kit may need what only it has.\n` +
          "Update pikit (run the installer again, or `git pull` in its checkout), or pass --force to replace the kit anyway (then check with `pikit doctor`).",
      );
    }
    log.warn(`${what}; --force: replacing it with this older kit`);
  } else if (order.verdict === "unknown") {
    log.warn(`the project's kit is replaced with this CLI's (${cli ?? "not in Git"}), which may be older: ${order.why}`);
  }
  const refused = incompatibleInstalled(project);
  if (refused.length > 0) {
    const what = `${action} replaces the project's kit with this CLI's (@pikit/core ${coreVersion()}, @pikit/contracts ${contractsVersion()}, @pikit/pi-adapter ${adapterVersion()}), which these installed components do not accept:\n  ${refused.join("\n  ")}`;
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
      if (existsSync(confinedPath(projectDir, base))) continue;
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
      const owned = ownedDependencies(record)[field];
      const moved = updateDependencies(pkg, plan.previous?.[field] ?? {}, record[field] ?? {}, owned, field);
      dependenciesChanged ||= removed.length > 0 || moved.length > 0;
    }
    const wanted = projectDependencies(plan.manifest);
    const { added, conflicts } = addDependencies(projectDir, pkg, wanted.dependencies);
    for (const conflict of conflicts) log.warn(`dependency kept as the project has it: ${conflict}`);
    const dev = addDependencies(projectDir, pkg, wanted.devDependencies, "devDependencies");
    for (const conflict of dev.conflicts) log.warn(`dev dependency kept as the project has it: ${conflict}`);
    dependenciesChanged ||= added.length > 0 || dev.added.length > 0;
    // Only what it added is its to take out on `remove`: a package the project had is the project's.
    const others = Object.entries(draft.project.components).flatMap(([name, c]) => (name === plan.name ? [] : [ownedDependencies(c)]));
    record.addedDependencies = owned(record.addedDependencies, added, plan.manifest.dependencies, others.flatMap((o) => o.dependencies));
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

/** This CLI's kit: the versions it vendors. */
function kitVersions(): { "@pikit/core": string; "@pikit/contracts": string; "@pikit/pi-adapter": string } {
  return { "@pikit/core": coreVersion(), "@pikit/contracts": contractsVersion(), "@pikit/pi-adapter": adapterVersion() };
}

/** Each installed component that does not accept this CLI's core, contracts or adapter, with what it accepts. */
function incompatibleInstalled(project: ProjectManifest): string[] {
  const kit = kitVersions();
  return Object.entries(project.components).flatMap(([name, installed]) => {
    const { pikit, contracts, adapter } = installed.requires;
    return (
      [
        ["@pikit/core", pikit],
        ["@pikit/contracts", contracts],
        ["@pikit/pi-adapter", adapter],
      ] as const
    )
      .filter(([pkg, range]) => range !== undefined && !Bun.semver.satisfies(kit[pkg], range))
      .map(([pkg, range]) => `${name} requires ${pkg} ${range}`);
  });
}

/**
 * Refuses a component that does not run on `targets`, that does not say which contracts or adapter it
 * accepts while it depends on them (`kitRangeProblems`), or that does not accept this CLI's core,
 * contracts or adapter. `force` (`pikit upgrade --force`) turns only the last into a warning: a range
 * that is not stated could not be checked later either.
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
  const { missing, refused } = kitRangeProblems(manifest, kitVersions());
  if (missing.length > 0) {
    throw new CliError(`${manifest.name}'s component.json: ${missing.join("; ")}. Its registry must say so; --force does not skip it`);
  }
  for (const { pkg, range, version } of refused) refuse(`${manifest.name} requires ${pkg} ${range}; this CLI vendors ${version}`);
}

/**
 * Information, not failure: the provider may come next. Per App on Cloudflare: what the Worker's half
 * requires must be provided in the Worker's App. `provided` is what the project will provide
 * (`Draft.provided`); unknown, nothing is said (`pikit doctor` checks the real app).
 */
export function warnUnprovided(project: ProjectManifest, manifest: Manifest, provided: ProvidedCapabilities | undefined): void {
  if (provided === undefined) return;
  const own = providedByManifests([manifest], project.targets);
  const apps = declaredByApp(manifest, project.targets);
  for (const [app, half] of apps) {
    for (const capability of half.requires) {
      if (provided[app].has(capability) || own[app].has(capability)) continue;
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
    const path = confinedPath(projectDir, target);
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
