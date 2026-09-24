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
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripComments } from "../registry/imports.ts";
import { coreVersion } from "../registry/commands.ts";
import type { Manifest } from "../registry/manifest.ts";
import { addComponent, CONFIG_FILE, type ComponentEntry } from "../project/config-file.ts";
import { appendExampleBlock, ENV_EXAMPLE, exampleBlock } from "../project/env-file.ts";
import { addDependencies, readPackageJson, writePackageJson } from "../project/package-json.ts";
import { hashFile, type ProjectManifest, readProjectManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { CliError, confirm, isInteractive, log } from "../ui.ts";
import { doctor } from "./doctor.ts";
import { bunInstall } from "./install.ts";

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
}

export async function add(projectDir: string, name: string, options: AddOptions = {}): Promise<void> {
  const { dependenciesChanged } = await installComponent(projectDir, name, options);
  if (dependenciesChanged) await bunInstall(projectDir);
  const report = await doctor(projectDir, { quiet: true });
  if (report.problems.length > 0) {
    for (const problem of report.problems) log.problem(problem);
    throw new CliError(`${name} is installed, but \`pikit doctor\` found ${report.problems.length} problem(s)`);
  }
  for (const missing of report.unconfigured) log.warn(missing);
  log.ok(`${name} installed; \`pikit doctor\` is green${report.unconfigured.length > 0 ? " (run `pikit configure` for the variables above)" : ""}`);
}

/** Steps 1–6 and 8–10: everything but `bun install` and `doctor`, which `pikit new` runs once for all. */
export async function installComponent(
  projectDir: string,
  name: string,
  options: AddOptions = {},
): Promise<{ dependenciesChanged: boolean }> {
  const project = readProjectManifest(projectDir);
  const registryName = registryKey(project, options.registry);
  const registry = openRegistry(project.registries[registryName] as string);
  const manifest = registry.manifest(name);

  if (name in project.components && options.force !== true) {
    throw new CliError(`${name} is already installed; \`pikit upgrade\` arrives in M3 (or pass --force to reinstall it)`);
  }
  checkCompatible(project, manifest);
  warnUnprovided(project, registry, manifest);

  const files = registry.files(name);
  checkConflicts(projectDir, project, name, files, options.force === true);

  describePlan(registry, manifest, files);
  if (options.yes !== true) {
    if (!isInteractive()) throw new CliError("pikit add asks for confirmation; pass --yes when it runs without a terminal");
    if (!(await confirm(`Install ${name}?`))) throw new CliError("cancelled", 1);
  }

  const hashes: Record<string, { hash: string }> = {};
  for (const [target, source] of files) {
    const path = join(projectDir, target);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(source, path);
    hashes[target] = { hash: hashFile(path) };
  }

  const pkg = readPackageJson(projectDir);
  const { added, conflicts } = addDependencies(projectDir, pkg, manifest.dependencies);
  for (const conflict of conflicts) log.warn(`dependency kept as the project has it: ${conflict}`);
  if (added.length > 0) writePackageJson(projectDir, pkg);

  if (hasDefaultExport(projectDir, name)) {
    const configPath = join(projectDir, CONFIG_FILE);
    const text = readFileSync(configPath, "utf8");
    if (!text.includes(`"./src/pikit/${name}/index.ts"`)) {
      writeFileSync(configPath, addComponent(text, { name, ...options.wiring }));
    }
  }

  const examplePath = join(projectDir, ENV_EXAMPLE);
  const example = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
  if (!example.split("\n").includes(`# ${name}`)) {
    const next = appendExampleBlock(example, exampleBlock(name, manifest.environment ?? []));
    if (next !== example) writeFileSync(examplePath, next);
  }

  project.components[name] = {
    registry: registryName,
    version: manifest.version,
    ...(registry.commit !== undefined && { commit: registry.commit }),
    files: hashes,
    dependencies: manifest.dependencies,
    environment: manifest.environment ?? [],
  };
  writeProjectManifest(projectDir, project);
  return { dependenciesChanged: added.length > 0 };
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

function checkCompatible(project: ProjectManifest, manifest: Manifest): void {
  const unsupported = project.targets.filter((t) => !manifest.targets.includes(t));
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

function describePlan(registry: Registry, manifest: Manifest, files: Map<string, string>): void {
  log.step(`${manifest.name} ${manifest.version} from ${registry.root}${registry.commit ? ` at ${registry.commit}` : ""}`);
  log.info(`  files: ${files.size} (${[...new Set([...files.keys()].map((f) => (f.startsWith("src/") ? `src/pikit/${manifest.name}/` : f)))].join(", ")})`);
  const deps = Object.entries(manifest.dependencies);
  if (deps.length > 0) log.info(`  npm: ${deps.map(([p, v]) => `${p}@${v}`).join(", ")}`);
  const env = manifest.environment ?? [];
  if (env.length > 0) log.info(`  environment: ${env.map((v) => `${v.name}${v.required ? "" : " (optional)"}`).join(", ")}`);
  if (manifest.provides.length > 0) log.info(`  provides: ${manifest.provides.join(", ")}`);
  if (manifest.requires.capabilities.length > 0) log.info(`  requires: ${manifest.requires.capabilities.join(", ")}`);
}

/** An app component has a default export (SPEC §10.2); a `deployment-*` does not, and is not listed. */
function hasDefaultExport(projectDir: string, name: string): boolean {
  const entry = join(projectDir, "src", "pikit", name, "index.ts");
  return existsSync(entry) && /(^|\n)\s*export\s+default\b/.test(stripComments(readFileSync(entry, "utf8")));
}
