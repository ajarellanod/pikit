/**
 * `pikit add <component>`: the install flow of SPEC §10.5.
 *
 *   1. resolve the registry (a local path in M1) and the component's version and commit
 *   2. read the component's package
 *   3. check its targets and `requires.pikit`; warn for each required capability nothing provides
 *   4. show what it writes: files, npm dependencies, environment, capabilities, source
 *   5. confirm (`--yes` in a script)
 *   6. write its files; refuse to overwrite a file that differs without `--force`
 *   7. add its npm dependencies; `bun install`
 *   8. list it in `pikit.config.ts` (a component with no default export, a `deployment-*`, is not)
 *   9. append its variables to `.env.example`
 *  10. record the registry, version, commit and file hashes in `pikit.json`
 *  11. `pikit doctor`
 *
 * Every refusal (steps 1–5, for the component and the providers it brings) comes before the first
 * write. A step that fails after it puts back what was written: `package.json`, `bun.lock`,
 * `pikit.json`, `pikit.config.ts`, `.env.example`, the copied files and the new tarballs.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripComments } from "../registry/imports.ts";
import { coreVersion } from "../registry/commands.ts";
import type { Manifest } from "../registry/manifest.ts";
import { addComponent, CONFIG_FILE, type ComponentEntry } from "../project/config-file.ts";
import { appendExampleBlock, ENV_EXAMPLE, exampleBlock } from "../project/env-file.ts";
import { addDependencies, readPackageJson, writePackageJson } from "../project/package-json.ts";
import { hashFile, PIKIT_JSON, type ProjectManifest, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { type Offer, offeredProviders } from "../project/offers.ts";
import { pruneVendor, refreshKit, VENDOR_DIR } from "../project/vendor.ts";
import { capabilityEntry } from "../registry/capabilities.ts";
import { CliError, confirm, isInteractive, log } from "../ui.ts";
import { doctor } from "./doctor.ts";
import { bunInstall } from "./install.ts";

const PACKAGE_JSON = "package.json";
const BUN_LOCK = "bun.lock";

export interface AddOptions {
  /** A registry path other than the project's default one. */
  registry?: string;
  /** Overwrite files that differ, and reinstall an installed component. */
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
  const registryName = registryKey(draft.project, options.registry);
  const registry = openRegistry(draft.project.registries[registryName] as string);
  const installed = Object.keys(draft.project.components);
  const plans = [planInstall(projectDir, draft, registry, registryName, name, options)];
  if (options.quiet !== true) describePlan(plans[0] as Plan);
  await confirmPlan(plans[0] as Plan, options);
  for (const offer of await acceptedOffers(registry, name, installed, options)) {
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
  const report = await doctor(projectDir, { quiet: true });
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
async function acceptedOffers(registry: Registry, name: string, installed: readonly string[], options: AddOptions): Promise<Offer[]> {
  const accepted: Offer[] = [];
  const declined = new Set<string>();
  for (const offer of offeredProviders(registry, [name], installed).reverse()) {
    if (declined.has(offer.for)) {
      declined.add(offer.component);
      continue;
    }
    const what = (capabilityEntry(offer.capability)?.summary ?? offer.capability).replace(/\.$/, "");
    const question =
      offer.why === "recommended"
        ? `${offer.for} can use ${offer.capability} (${what}). Install ${offer.component}?`
        : `${offer.for} requires ${offer.capability}. Install ${offer.component}?`;
    if (options.yes === true || (isInteractive() && (await confirm(question, true)))) {
      log.step(`${offer.component}, for ${offer.for} (${offer.capability})`);
      accepted.push(offer);
    } else declined.add(offer.component);
  }
  // Providers before what uses them.
  return accepted.reverse();
}

/** Steps 1–6 and 8–10: everything but `bun install` and `doctor`, which `pikit new` runs once for all. */
export async function installComponent(
  projectDir: string,
  name: string,
  options: AddOptions = {},
): Promise<{ dependenciesChanged: boolean }> {
  const draft = readDraft(projectDir);
  const registryName = registryKey(draft.project, options.registry);
  const registry = openRegistry(draft.project.registries[registryName] as string);
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

/** One component's install, checked: what it writes, from where. */
interface Plan {
  name: string;
  registry: Registry;
  manifest: Manifest;
  /** Project-relative target → absolute source. */
  files: Map<string, string>;
}

/**
 * The project files an install edits, as they will be once it is done. Each plan is checked against
 * the draft and edits it in memory; nothing reaches the disk before every plan passed and was confirmed.
 */
interface Draft {
  project: ProjectManifest;
  /** `pikit.config.ts`, as read and as it will be; undefined when the project has none. */
  config: { before: string; after: string } | undefined;
  /** `.env.example`, as read ("" when absent) and as it will be. */
  example: { before: string; after: string };
}

function readDraft(projectDir: string): Draft {
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
function planInstall(
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
    throw new CliError(`${name} is already installed; \`pikit upgrade\` arrives in M3 (or pass --force to reinstall it)`);
  }
  checkCompatible(project.targets, manifest);
  warnUnprovided(project, registry, manifest);

  const files = registry.files(name);
  checkConflicts(projectDir, project, name, files, options.force === true);

  // An app component has a default export (SPEC §10.2); a `deployment-*` does not, and is not listed.
  const entry = files.get(`src/pikit/${name}/index.ts`);
  if (entry !== undefined && hasDefaultExport(entry)) {
    if (draft.config === undefined) throw new CliError(`${CONFIG_FILE} is missing: ${name} is listed in it`);
    // A `ShapeError` refuses the install here, before a file is copied.
    if (!draft.config.after.includes(`"./src/pikit/${name}/index.ts"`)) draft.config.after = addComponent(draft.config.after, { name, ...options.wiring });
  }

  if (!draft.example.after.split("\n").includes(`# ${name}`)) {
    draft.example.after = appendExampleBlock(draft.example.after, exampleBlock(name, manifest.environment ?? []));
  }

  // The copy has the source's bytes, so its hash is the source's.
  const hashes: Record<string, { hash: string }> = {};
  for (const [target, source] of files) hashes[target] = { hash: hashFile(source) };
  const installedFor = options.installedFor === undefined ? undefined : [...new Set([...(project.components[name]?.installedFor ?? []), options.installedFor])];
  project.components[name] = {
    ...(installedFor !== undefined && { installedFor }),
    registry: registryName,
    version: manifest.version,
    ...(registry.commit !== undefined && { commit: registry.commit }),
    files: hashes,
    dependencies: manifest.dependencies,
    environment: manifest.environment ?? [],
  };
  return { name, registry, manifest, files };
}

/** Step 5: `--yes`, or a "yes" at a terminal. */
async function confirmPlan(plan: Plan, options: AddOptions): Promise<void> {
  if (options.yes === true) return;
  if (!isInteractive()) throw new CliError("pikit add asks for confirmation; pass --yes when it runs without a terminal");
  if (!(await confirm(`Install ${plan.name}?`))) throw new CliError("cancelled", 1);
}

/** Steps 6–10 for the confirmed plans: files, npm dependencies, then the draft's three files. */
function applyPlans(projectDir: string, draft: Draft, plans: readonly Plan[], undo: Undo): { dependenciesChanged: boolean } {
  for (const plan of plans) {
    for (const [target, source] of plan.files) {
      undo.keep(target);
      copyFileSync(source, undo.mkdirFor(target));
    }
  }

  undo.keep(PACKAGE_JSON);
  const pkg = readPackageJson(projectDir);
  let dependenciesChanged = false;
  for (const plan of plans) {
    const { added, conflicts } = addDependencies(projectDir, pkg, plan.manifest.dependencies);
    for (const conflict of conflicts) log.warn(`dependency kept as the project has it: ${conflict}`);
    dependenciesChanged ||= added.length > 0;
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
  return { dependenciesChanged };
}

/**
 * What an install changed, to put back when a later step fails: each file's content before its first
 * change (or its absence), the directories it created, and the tarballs it added to `vendor/`.
 */
class Undo {
  private readonly saved = new Map<string, Buffer | undefined>();
  private readonly createdDirs: string[] = [];
  private readonly vendorBefore: string[] | undefined;
  /** `bun install` ran: `node_modules` is not put back. */
  installed = false;

  constructor(private readonly projectDir: string) {
    const vendor = join(projectDir, VENDOR_DIR);
    this.vendorBefore = existsSync(vendor) ? readdirSync(vendor) : undefined;
  }

  /** Remembers a project-relative file as it is now, the first time it is about to change. */
  keep(file: string): void {
    const path = join(this.projectDir, file);
    if (!this.saved.has(path)) this.saved.set(path, existsSync(path) ? readFileSync(path) : undefined);
  }

  /** Creates the directory of a project-relative file, remembering the outermost one it created; returns the file's path. */
  mkdirFor(file: string): string {
    const path = join(this.projectDir, file);
    let outermost: string | undefined;
    for (let dir = dirname(path); !existsSync(dir); dir = dirname(dir)) outermost = dir;
    mkdirSync(dirname(path), { recursive: true });
    if (outermost !== undefined) this.createdDirs.push(outermost);
    return path;
  }

  restore(): void {
    for (const [path, content] of this.saved) {
      if (content === undefined) rmSync(path, { force: true });
      else writeFileSync(path, content);
    }
    for (const dir of this.createdDirs.reverse()) rmSync(dir, { recursive: true, force: true });
    const vendor = join(this.projectDir, VENDOR_DIR);
    if (this.vendorBefore === undefined) rmSync(vendor, { recursive: true, force: true });
    else if (existsSync(vendor)) {
      for (const file of readdirSync(vendor)) if (!this.vendorBefore.includes(file)) rmSync(join(vendor, file), { force: true });
    }
  }
}

/** The key of `registries` for this path, added when the project does not know it yet. */
function registryKey(project: ProjectManifest, path: string | undefined): string {
  if (path === undefined) {
    if (project.registries.default === undefined) throw new CliError("pikit.json has no default registry; pass --registry <path>");
    return "default";
  }
  const root = openRegistry(path).root;
  const known = Object.entries(project.registries).find(([, location]) => location === root);
  if (known) return known[0];
  let key = "local";
  for (let n = 2; key in project.registries; n++) key = `local-${n}`;
  project.registries[key] = root;
  return key;
}

/** Refuses a component that does not run on `targets` or does not accept this CLI's core. */
export function checkCompatible(targets: readonly string[], manifest: Manifest): void {
  const unsupported = targets.filter((t) => !manifest.targets.includes(t));
  if (unsupported.length > 0) {
    throw new CliError(`${manifest.name} runs on ${manifest.targets.join(", ")}, not on this project's ${unsupported.join(", ")} target`);
  }
  const core = coreVersion();
  if (!Bun.semver.satisfies(core, manifest.requires.pikit)) {
    throw new CliError(`${manifest.name} requires @pikit/core ${manifest.requires.pikit}; this CLI vendors ${core}`);
  }
}

/** Information, not failure: the provider may come next, or from the project's own components. */
function warnUnprovided(project: ProjectManifest, registry: Registry, manifest: Manifest): void {
  const provided = new Set(manifest.provides);
  for (const installed of Object.keys(project.components)) {
    try {
      for (const capability of registry.manifest(installed).provides) provided.add(capability);
    } catch {
      // Installed from another registry: `pikit doctor` checks the real app anyway.
    }
  }
  for (const capability of manifest.requires.capabilities) {
    if (!provided.has(capability)) log.warn(`${manifest.name} requires "${capability}", which no installed component provides yet`);
  }
}

function checkConflicts(projectDir: string, project: ProjectManifest, name: string, files: Map<string, string>, force: boolean): void {
  const conflicts: string[] = [];
  for (const [target, source] of files) {
    const owner = Object.entries(project.components).find(([other, c]) => other !== name && target in c.files)?.[0];
    if (owner !== undefined) throw new CliError(`${name} would write ${target}, which ${owner} installed (SPEC §10.2)`);
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

function describePlan({ registry, manifest, files }: Plan): void {
  log.step(`${manifest.name} ${manifest.version} from ${registry.root}${registry.commit ? ` at ${registry.commit}` : ""}`);
  log.info(`  files: ${files.size} (${[...new Set([...files.keys()].map((f) => (f.startsWith("src/") ? `src/pikit/${manifest.name}/` : f)))].join(", ")})`);
  const deps = Object.entries(manifest.dependencies);
  if (deps.length > 0) log.info(`  npm: ${deps.map(([p, v]) => `${p}@${v}`).join(", ")}`);
  const env = manifest.environment ?? [];
  if (env.length > 0) log.info(`  environment: ${env.map((v) => `${v.name}${v.required ? "" : " (optional)"}`).join(", ")}`);
  if (manifest.provides.length > 0) log.info(`  provides: ${manifest.provides.join(", ")}`);
  if (manifest.requires.capabilities.length > 0) log.info(`  requires: ${manifest.requires.capabilities.join(", ")}`);
}

/** Whether a component's entry point (its source in the registry) has a default export. */
function hasDefaultExport(entry: string): boolean {
  return /(^|\n)\s*export\s+default\b/.test(stripComments(readFileSync(entry, "utf8")));
}
