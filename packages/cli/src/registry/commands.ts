/**
 * `generate` and `validate` over a registry root (a directory holding `components/` and
 * `registry.json`). Both find the components by listing `components/`, so a component
 * added later needs no change here.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Target } from "@pikit/core";
import { PIKIT_ROOT as REPO } from "../paths.ts";
import { type AppName, APP_LABEL, declaredByApp, hasWorkerApp } from "../project/apps.ts";
import { DEPLOYMENT_EXPORTS } from "../project/deployment-module.ts";
import { withOffers } from "../project/offers.ts";
import { openRegistry, PRESET_SCHEMA_FILE, PresetSchema, type Registry, readPreset } from "../project/registry-source.ts";
import { starterModel, starterModelProblem } from "../project/starter-model.ts";
import { capabilityEntry, type RegistryCatalogue, registryCatalogue } from "./capabilities.ts";
import {
  checkCapabilities,
  checkDependencies,
  checkDescriptionReaders,
  checkEnvironmentUsers,
  checkDevDependencies,
  checkImports,
  checkLayout,
  checkManifest,
  checkNaming,
  checkSettingsSection,
  checkView,
} from "./checks.ts";
import { describeComponent, loadComponent, loadExport, mergeGenerated } from "./describe.ts";
import {
  BOTH_APPS,
  buildIndex,
  COMPONENT_SCHEMA_FILE,
  COMPONENT_SCHEMA_REF,
  formatIndex,
  formatManifest,
  formatSchema,
  type Generated,
  HOOKS,
  type Manifest,
  ManifestSchema,
  manifestPath,
  readManifest,
  SCHEMA_DIR,
  schemaProblems,
  TARGETS,
  withGenerated,
  writeManifest,
} from "./manifest.ts";

/** The JSON Schemas a registry carries, for editors: its path under the root → its text. */
function schemaFiles(): Map<string, string> {
  return new Map([
    [COMPONENT_SCHEMA_FILE, formatSchema(ManifestSchema)],
    [PRESET_SCHEMA_FILE, formatSchema(PresetSchema)],
  ]);
}

/** The `@pikit/core` a registry at this commit is built with; `requires.pikit` must accept it. */
export function coreVersion(): string {
  return packageVersion("core");
}

/** The `@pikit/contracts` a registry at this commit is built with; `requires.contracts` must accept it. */
export function contractsVersion(): string {
  return packageVersion("contracts");
}

/** The `@pikit/pi-adapter` a registry at this commit is built with; `requires.adapter` must accept it. */
export function adapterVersion(): string {
  return packageVersion("pi-adapter");
}

function packageVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(REPO, "packages", dir, "package.json"), "utf8")) as { version: string }).version;
}

export function componentNames(root: string): string[] {
  const dir = join(root, "components");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort();
}

function entryOf(componentDir: string, name: string): string {
  return join(componentDir, "files", "src", "pikit", name, "index.ts");
}

/** Describe on the first declared target: setup registers the same graph on every target (SPEC K1, `checkTargets`). */
function describeTarget(manifest: Manifest | undefined): Target {
  const first = manifest?.targets?.[0];
  return (TARGETS as readonly string[]).includes(first ?? "") ? (first as Target) : "server";
}

async function generatedFor(componentDir: string, name: string, manifest: Manifest | undefined, target = describeTarget(manifest)): Promise<Generated> {
  const entry = entryOf(componentDir, name);
  const component = await loadComponent(entry);
  // Not an app component (no setup): nothing to derive.
  if (component === undefined) return { provides: [], requires: [], optional: [] };
  const own = await describeComponent(component, target);
  // A component with a half for the Worker's App (C1): the manifest covers both halves, and says what
  // each declares. The default export in both Apps (`"default"`) is one component: nothing to add.
  const exported = manifest?.apps?.worker;
  if (exported === undefined || exported === BOTH_APPS) return own;
  const half = await loadExport(entry, exported);
  // Its name is its config key in `workerConfig`, which `pikit remove` takes out: never a guess.
  if (half.name !== `${name}-worker`) {
    throw new Error(`the export "${exported}" (apps.worker) is the component "${half.name}": the Worker's half of ${name} is named "${name}-worker", its config key in workerConfig`);
  }
  const worker = await describeComponent(half, target);
  const declared = ({ provides, requires, optional }: Generated) => ({ provides, requires, optional });
  return { ...mergeGenerated([own, worker]), halves: { default: declared(own), worker: declared(worker) } };
}

/**
 * `setup` never branches on the target (SPEC K1): described on each other target its manifest declares,
 * it succeeds and declares what it declares on the first (`described`), field by field.
 */
async function checkTargets(componentDir: string, name: string, manifest: Manifest, described: Generated): Promise<string[]> {
  const first = describeTarget(manifest);
  const problems: string[] = [];
  for (const target of TARGETS.filter((t) => t !== first && manifest.targets.includes(t))) {
    let other: Generated;
    try {
      other = await generatedFor(componentDir, name, manifest, target);
    } catch (error) {
      problems.push(`setup could not be described on ${target}, one of its targets (SPEC K1): ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const fields = new Set([...Object.keys(described), ...Object.keys(other)]) as Set<keyof Generated>;
    for (const field of fields) {
      const [on, off] = [JSON.stringify(described[field]) ?? "nothing", JSON.stringify(other[field]) ?? "nothing"];
      if (on !== off) {
        problems.push(
          `setup declares ${field} ${on} on ${first} but ${off} on ${target}: setup never branches on pikit.target (SPEC K1); ` +
            "what differs per target comes through a capability, or is a component per target",
        );
      }
    }
  }
  return problems;
}

/** Each of `hooks` names a file of the component that exports a function of the hook's name. */
async function checkHooks(componentDir: string, name: string, manifest: Manifest): Promise<string[]> {
  const problems: string[] = [];
  for (const hook of HOOKS) {
    const file = manifest.hooks?.[hook];
    if (file === undefined) continue;
    const path = join(componentDir, "files", "src", "pikit", name, file);
    if (!existsSync(path)) problems.push(`hooks.${hook} "${file}" is not a file of files/src/pikit/${name}/`);
    else if (/\.test(-support)?\.ts$/.test(file)) problems.push(`hooks.${hook} "${file}" is a test file`);
    else {
      try {
        const module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
        if (typeof module[hook] !== "function") problems.push(`hooks.${hook} "${file}" does not export a function ${hook}`);
      } catch (error) {
        problems.push(`hooks.${hook} could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return problems;
}

/**
 * A `deployment-*` component's `index.ts` exports the functions the CLI calls (`DEPLOYMENT_EXPORTS`):
 * each required one, and each one it exports, as a function; and nothing one letter or a case away
 * from one of them (`Status`, `restar`), which the CLI would never call.
 */
async function checkDeploymentExports(componentDir: string, name: string): Promise<string[]> {
  if (!name.startsWith("deployment-")) return [];
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(entryOf(componentDir, name)).href)) as Record<string, unknown>;
  } catch (error) {
    return [`index.ts could not be loaded: ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems: string[] = [];
  const commands = Object.keys(DEPLOYMENT_EXPORTS);
  for (const [command, need] of Object.entries(DEPLOYMENT_EXPORTS)) {
    if (module[command] === undefined) {
      if (need === "required") problems.push(`index.ts does not export ${command}(), which the CLI calls on every deployment component`);
    } else if (typeof module[command] !== "function") problems.push(`index.ts exports ${command}, but not as a function`);
  }
  for (const exported of Object.keys(module)) {
    const meant = commands.find((command) => command !== exported && oneEditApart(exported.toLowerCase(), command));
    if (meant !== undefined) problems.push(`index.ts exports ${exported}: the CLI calls ${meant}, never ${exported}`);
  }
  return problems;
}

/** At most one letter inserted, deleted or replaced turns `a` into `b`. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let start = 0;
  while (start < a.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return a.length - start - end <= 1 && b.length - start - end <= 1;
}

/** Each of `generated` is a file of the component's own directory, not a test file. */
function checkGeneratedFiles(componentDir: string, name: string, manifest: Manifest): string[] {
  return (manifest.generated ?? []).flatMap((file) => {
    if (!existsSync(join(componentDir, "files", "src", "pikit", name, file))) return [`generated "${file}" is not a file of files/src/pikit/${name}/`];
    return /\.test(-support)?\.ts$/.test(file) ? [`generated "${file}" is a test file`] : [];
  });
}

export interface Outcome {
  /** Files written (generate) or nothing (validate). */
  written: string[];
  /** `<component>: <problem>`; empty means success. */
  problems: string[];
}

/**
 * Rewrites the generated fields of every `component.json` and rebuilds `registry.json`.
 * A component without `component.json` gets a skeleton whose hand-written fields `validate` will
 * reject until someone fills them in (`targets` at least): those are decisions, not derivations.
 */
export async function generate(root: string): Promise<Outcome> {
  const written: string[] = [];
  const problems: string[] = [];
  const manifests: Manifest[] = [];
  for (const name of componentNames(root)) {
    const dir = join(root, "components", name);
    try {
      const current = readManifest(dir) ?? skeleton(dir, name);
      const next = withGenerated(current, await generatedFor(dir, name, current));
      writeManifest(dir, next);
      manifests.push(next);
      written.push(join(dir, "component.json"));
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // An index built from a partial set would silently drop the broken component.
  if (problems.length === 0) {
    writeFileSync(join(root, "registry.json"), formatIndex(buildIndex(manifests)));
    written.push(join(root, "registry.json"));
  }
  mkdirSync(join(root, SCHEMA_DIR), { recursive: true });
  for (const [file, text] of schemaFiles()) {
    writeFileSync(join(root, file), text);
    written.push(join(root, file));
  }
  return { written, problems };
}

/** Every rule, for every component, then the index. Nothing is written. */
export async function validate(root: string, options: { coreVersion?: string; contractsVersion?: string; adapterVersion?: string } = {}): Promise<Outcome> {
  const core = options.coreVersion ?? coreVersion();
  const contracts = options.contractsVersion ?? contractsVersion();
  const adapter = options.adapterVersion ?? adapterVersion();
  const problems: string[] = [];
  const manifests: Manifest[] = [];
  const regenerate = generateCommand(root);
  const names = componentNames(root);
  if (names.length === 0) problems.push(`registry: no components under ${join(root, "components")}`);
  // The kit's vocabulary, extended by what the registry's well-formed manifests declare.
  const declared = registryCatalogue(wellFormedManifests(root, names));
  problems.push(...declared.problems);
  const catalogue = declared.catalogue;

  for (const name of names) {
    const dir = join(root, "components", name);
    const report = (message: string) => problems.push(`${name}: ${message}`);
    checkNaming(name, catalogue).forEach(report);
    checkLayout(dir, name).forEach(report);

    let manifest: Manifest | undefined;
    try {
      manifest = readManifest(dir);
    } catch (error) {
      report(`component.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (manifest === undefined) {
      report(`component.json is missing: run \`${regenerate}\`, then fill in its hand-written fields`);
      continue;
    }
    manifests.push(manifest);
    checkManifest(manifest, dir, name, core, contracts, adapter).forEach(report);
    // Every rule below reads the manifest's fields: a malformed one was reported, and that is all.
    if (schemaProblems(ManifestSchema, manifest).length > 0) continue;

    const scan = checkImports(dir, name, manifest.targets);
    scan.problems.forEach(report);
    checkDependencies(manifest, scan).forEach(report);
    checkDevDependencies(manifest).forEach(report);
    checkView(dir, name, manifest).forEach(report);
    checkSettingsSection(dir, name, manifest).forEach(report);

    checkDescriptionReaders(dir, name).forEach(report);

    try {
      const described = await generatedFor(dir, name, manifest);
      const drift = checkDrift(manifest, described, regenerate);
      drift.forEach(report);
      if (drift.length === 0) {
        checkFormat(dir, manifest, regenerate).forEach(report);
        // Only on an up-to-date manifest: a drifted one would report names setup no longer uses.
        checkCapabilities(manifest, catalogue).forEach(report);
        checkEnvironmentUsers(dir, manifest).forEach(report);
      }
      (await checkTargets(dir, name, manifest, described)).forEach(report);
    } catch (error) {
      report(`setup could not be described: ${error instanceof Error ? error.message : String(error)}`);
    }
    (await checkHooks(dir, name, manifest)).forEach(report);
    (await checkDeploymentExports(dir, name)).forEach(report);
    checkGeneratedFiles(dir, name, manifest).forEach(report);
  }

  const indexPath = join(root, "registry.json");
  const expected = formatIndex(buildIndex(manifests));
  if (!existsSync(indexPath)) problems.push(`registry.json is missing: run \`${regenerate}\``);
  else if (readFileSync(indexPath, "utf8") !== expected) {
    problems.push(`registry.json does not match the components' manifests: run \`${regenerate}\``);
  } else {
    // Presets resolve through registry.json, so only once it is right.
    problems.push(...checkPresets(root, catalogue));
  }
  problems.push(...checkSchemaFiles(root));
  return { written: [], problems };
}

/** The registry's JSON Schemas are exactly what this CLI would generate. */
export function checkSchemaFiles(root: string): string[] {
  return [...schemaFiles()]
    .filter(([file, text]) => !existsSync(join(root, file)) || readFileSync(join(root, file), "utf8") !== text)
    .map(([file]) => `${file} is missing or out of date: run \`${generateCommand(root)}\``);
}

/** How this repository regenerates its own registry. */
export const KIT_GENERATE = "bun run registry generate";

/**
 * The command that regenerates the registry at `root`, for a message to say: this repository's script
 * for its own registry, `pikit registry generate <root>` (from the working directory) for any other,
 * a project's `registry/` among them.
 */
export function generateCommand(root: string): string {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  if (real(root) === real(join(REPO, "registry"))) return KIT_GENERATE;
  return `pikit registry generate ${relative(process.cwd(), resolve(root)) || "."}`;
}

/**
 * Every preset resolves: its components exist, once each; an alias extends a base and chooses what
 * that base lets it choose; and every answer to a question, and every feature, resolves too and has a
 * `title` to show.
 *
 * And composes, as `pikit new` would make it: on each target all its components run on (one at
 * least), with what they bring (`withOffers`), and each answer and each feature on each of those
 * targets it runs on (what `pikit new` offers there); and with everything it offers there at once,
 * every answer of a `multiple` question (Telegram and HTTP) and every feature. An offer needs the
 * registry's only provider, so a preset that leaned on one breaks when a second provider lands: this
 * says so before a project is written.
 */
export function checkPresets(root: string, catalogue: RegistryCatalogue = registryCatalogue(readManifests(root)).catalogue): string[] {
  const dir = join(root, "presets");
  if (!existsSync(dir)) return [];
  const registry = openRegistry(root);
  const problems = new Set<string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -".yaml".length)).sort()) {
    const report = (message: string) => problems.add(`presets/${name}.yaml: ${message}`);
    try {
      const isAlias = readPreset(root, name).extends !== undefined;
      const components = registry.preset(name);
      for (const component of components) registry.manifest(component);
      if (new Set(components).size !== components.length) report("lists a component twice");
      const targets = TARGETS.filter((target) => components.every((c) => registry.manifest(c).targets.includes(target)));
      if (targets.length === 0) {
        const not = (target: string) => components.filter((c) => !registry.manifest(c).targets.includes(target));
        report(`no target runs all its components (${TARGETS.map((t) => `not on ${t}: ${not(t).join(", ")}`).join("; ")})`);
      }
      for (const target of targets) {
        compositionProblems(registry, components, target, catalogue).forEach((p) => report(`on ${target}, ${p}`));
        // The starter agent `pikit new` writes must name a model provider the preset installs.
        const model = registry.presetModel(name) ?? starterModel(target);
        const problem = starterModelProblem(registry, components, target, model, name);
        if (problem !== undefined) report(`on ${target}, ${problem}`);
      }
      // An alias asks its base's questions: they are checked once, with the base.
      for (const slot of isAlias ? [] : registry.slots(name)) {
        for (const option of slot.options) {
          registry.preset(name, [option.name]);
          if (registry.manifest(option.name).title === undefined) {
            report(`${option.name} answers "${slot.question}" but its component.json has no title to show`);
          }
        }
      }
      for (const feature of isAlias ? [] : registry.features(name)) {
        if (registry.manifest(feature.name).title === undefined) report(`offers ${feature.name}, but its component.json has no title to show`);
        if (!targets.some((target) => registry.manifest(feature.name).targets.includes(target))) report(`offers ${feature.name}, which runs on none of its targets`);
      }
      for (const target of isAlias ? [] : targets) {
        const composes = (choices: string[]) =>
          compositionProblems(registry, registry.preset(name, choices), target, catalogue).forEach((p) => report(`with ${choices.join(" and ")}, on ${target}, ${p}`));
        const slots = registry.slots(name, [target]);
        const features = registry.features(name, [target]).map((f) => f.name);
        for (const slot of slots) {
          for (const option of slot.options.filter((o) => !slot.defaults.includes(o.name))) composes([option.name]);
        }
        for (const feature of features) composes([feature]);
        const everything = [...slots.flatMap((slot) => (slot.multiple ? slot.options.map((o) => o.name) : [])), ...features];
        if (everything.length > 1) composes(everything);
      }
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  }
  return [...problems];
}

/**
 * Why `components`, with what they bring, would not compose on `target`, per App (SPEC C1): a
 * capability one requires that nothing in its App provides (the project's own, `agent.definition`,
 * aside), and a single capability two components provide there. `pikit doctor` judges the real app;
 * this reads the manifests, before any project exists.
 */
function compositionProblems(registry: Registry, components: readonly string[], target: string, catalogue: RegistryCatalogue): string[] {
  const targets = [target];
  const providers: Record<AppName, Map<string, string[]>> = { default: new Map(), worker: new Map() };
  const required: [AppName, string, string][] = [];
  for (const name of withOffers(registry, components, targets).order) {
    for (const [app, half] of declaredByApp(registry.manifest(name), targets)) {
      for (const capability of half.provides) providers[app].set(capability, [...(providers[app].get(capability) ?? []), name]);
      for (const capability of half.requires) required.push([app, capability, name]);
    }
  }
  const where = (app: AppName) => (hasWorkerApp(targets) ? ` in ${APP_LABEL[app]}` : "");
  const problems = required
    .filter(([app, capability]) => !providers[app].has(capability) && capabilityEntry(capability, catalogue)?.providedBy !== "project")
    .map(([app, capability, name]) => `${name} requires "${capability}"${where(app)}, which nothing provides`);
  for (const app of ["default", "worker"] as const) {
    for (const [capability, names] of providers[app]) {
      if (names.length > 1 && capabilityEntry(capability, catalogue)?.mode === "single") problems.push(`"${capability}" takes one provider${where(app)}, and ${names.join(" and ")} each provide it`);
    }
  }
  return problems;
}

/** The manifests of `names` that parse and match the schema: what a registry's catalogue is read from. */
function wellFormedManifests(root: string, names: readonly string[]): Manifest[] {
  return names.flatMap((name) => {
    try {
      const manifest = readManifest(join(root, "components", name));
      return manifest !== undefined && schemaProblems(ManifestSchema, manifest).length === 0 ? [manifest] : [];
    } catch {
      return [];
    }
  });
}

/** Every component's manifest, by listing `components/`. A missing one is skipped; invalid JSON throws. */
export function readManifests(root: string): Manifest[] {
  return componentNames(root).flatMap((name) => readManifest(join(root, "components", name)) ?? []);
}

/** The generated fields are exactly what setup declares, and every tool states its replay. */
export function checkDrift(manifest: Manifest, generated: Generated, regenerate = KIT_GENERATE): string[] {
  const problems: string[] = [];
  const expected = withGenerated(manifest, generated);
  const fields: [string, unknown, unknown][] = [
    ["$schema", manifest.$schema, COMPONENT_SCHEMA_REF],
    ["provides", manifest.provides, expected.provides],
    ["requires.capabilities", manifest.requires?.capabilities, expected.requires.capabilities],
    ["optional.capabilities", manifest.optional?.capabilities, expected.optional.capabilities],
    ["replay", manifest.replay, expected.replay],
    ["modelProviders", manifest.modelProviders, expected.modelProviders],
    ["halves", manifest.halves, expected.halves],
  ];
  for (const [field, actual, derived] of fields) {
    if (JSON.stringify(actual) !== JSON.stringify(derived)) {
      problems.push(
        `${field} drifted from setup: component.json has ${JSON.stringify(actual) ?? "nothing"}, setup declares ${JSON.stringify(derived) ?? "nothing"}; run \`${regenerate}\``,
      );
    }
  }
  for (const [tool, replay] of Object.entries({ ...generated.tools, ...generated.exampleTools })) {
    if (replay !== "safe" && replay !== "unsafe") {
      problems.push(`the agent.tool "${tool}" has replay ${JSON.stringify(replay)}; every tool declares "safe" or "unsafe"`);
    }
  }
  return problems;
}

/** A stable layout keeps every diff to what changed; hand edits keep it by running `generate`. */
function checkFormat(componentDir: string, manifest: Manifest, regenerate: string): string[] {
  return readFileSync(manifestPath(componentDir), "utf8") === formatManifest(manifest)
    ? []
    : [`component.json is not in generated form (key order, formatting): run \`${regenerate}\``];
}

/** A new component's starting manifest: what can be read from its README and its imports. */
function skeleton(dir: string, name: string): Manifest {
  const targets: string[] = [];
  const { packages: imported, testPackages } = checkImports(dir, name, targets);
  const versions = knownVersions();
  const pinned = (packages: Set<string>) => Object.fromEntries([...packages].sort().map((pkg) => [pkg, versions[pkg] ?? ""]));
  return {
    name,
    version: "0.0.0",
    description: readmeSummary(dir),
    targets,
    requires: {
      pikit: coreVersion(),
      ...(imported.has("@pikit/contracts") && { contracts: contractsVersion() }),
      ...(imported.has("@pikit/pi-adapter") && { adapter: adapterVersion() }),
      capabilities: [],
    },
    optional: { capabilities: [] },
    provides: [],
    dependencies: pinned(imported),
    ...(testPackages.size > 0 && { devDependencies: pinned(testPackages) }),
    files: [{ source: "files/src", target: "src" }],
  };
}

/** The README's first paragraph after its title, on one line. */
function readmeSummary(dir: string): string {
  const path = join(dir, "README.md");
  if (!existsSync(path)) return "";
  const paragraphs = readFileSync(path, "utf8").split(/\n\s*\n/);
  const first = paragraphs.find((p) => p.trim() !== "" && !p.trimStart().startsWith("#"));
  return (first ?? "").replace(/\s+/g, " ").trim();
}

/** Versions this repository pins: the workspace packages' own, then the root package.json's. */
function knownVersions(): Record<string, string> {
  const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const versions: Record<string, string> = { ...root.dependencies, ...root.devDependencies };
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    const path = join(REPO, "packages", pkg, "package.json");
    if (!existsSync(path)) continue;
    const { name, version } = JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string };
    versions[name] = version;
  }
  return versions;
}
