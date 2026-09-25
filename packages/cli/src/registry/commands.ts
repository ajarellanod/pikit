/**
 * `generate` and `validate` over a registry root (a directory holding `components/` and
 * `registry.json`, SPEC §10.4). Both find the components by listing `components/`, so a component
 * added later needs no change here.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "@pikit/core";
import { PIKIT_ROOT as REPO } from "../paths.ts";
import { openRegistry, PRESET_SCHEMA_FILE, PresetSchema, readPreset } from "../project/registry-source.ts";
import { checkCapabilities, checkDependencies, checkImports, checkLayout, checkManifest, checkNaming } from "./checks.ts";
import { describeSetup, loadComponent } from "./describe.ts";
import {
  buildIndex,
  COMPONENT_SCHEMA_FILE,
  COMPONENT_SCHEMA_REF,
  formatIndex,
  formatManifest,
  formatSchema,
  type Generated,
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
  return (JSON.parse(readFileSync(join(REPO, "packages", "core", "package.json"), "utf8")) as { version: string }).version;
}

export function componentNames(root: string): string[] {
  const dir = join(root, "components");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort();
}

function entryOf(componentDir: string, name: string): string {
  return join(componentDir, "files", "src", "pikit", name, "index.ts");
}

/** Describe on the first declared target: setup registers the same graph on every target. */
function describeTarget(manifest: Manifest | undefined): Target {
  const first = manifest?.targets?.[0];
  return (TARGETS as readonly string[]).includes(first ?? "") ? (first as Target) : "server";
}

async function generatedFor(componentDir: string, name: string, manifest: Manifest | undefined): Promise<Generated> {
  const component = await loadComponent(entryOf(componentDir, name));
  // Not an app component (no setup): nothing to derive.
  if (component === undefined) return { provides: [], requires: [], optional: [] };
  return describeSetup(component, describeTarget(manifest));
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
export async function validate(root: string, options: { coreVersion?: string } = {}): Promise<Outcome> {
  const core = options.coreVersion ?? coreVersion();
  const problems: string[] = [];
  const manifests: Manifest[] = [];
  const names = componentNames(root);
  if (names.length === 0) problems.push(`registry: no components under ${join(root, "components")}`);

  for (const name of names) {
    const dir = join(root, "components", name);
    const report = (message: string) => problems.push(`${name}: ${message}`);
    checkNaming(name).forEach(report);
    checkLayout(dir, name).forEach(report);

    let manifest: Manifest | undefined;
    try {
      manifest = readManifest(dir);
    } catch (error) {
      report(`component.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (manifest === undefined) {
      report("component.json is missing: run `bun run registry generate`, then fill in its hand-written fields");
      continue;
    }
    manifests.push(manifest);
    checkManifest(manifest, dir, name, core).forEach(report);
    // Every rule below reads the manifest's fields: a malformed one was reported, and that is all.
    if (schemaProblems(ManifestSchema, manifest).length > 0) continue;

    const scan = checkImports(dir, name, manifest.targets);
    scan.problems.forEach(report);
    checkDependencies(manifest.dependencies, scan.packages).forEach(report);

    try {
      const drift = checkDrift(manifest, await generatedFor(dir, name, manifest));
      drift.forEach(report);
      if (drift.length === 0) {
        checkFormat(dir, manifest).forEach(report);
        // Only on an up-to-date manifest: a drifted one would report names setup no longer uses.
        checkCapabilities(manifest).forEach(report);
      }
    } catch (error) {
      report(`setup could not be described: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const indexPath = join(root, "registry.json");
  const expected = formatIndex(buildIndex(manifests));
  if (!existsSync(indexPath)) problems.push("registry.json is missing: run `bun run registry generate`");
  else if (readFileSync(indexPath, "utf8") !== expected) {
    problems.push("registry.json does not match the components' manifests: run `bun run registry generate`");
  } else {
    // Presets resolve through registry.json, so only once it is right.
    problems.push(...checkPresets(root));
  }
  problems.push(...checkSchemaFiles(root));
  return { written: [], problems };
}

/** The registry's JSON Schemas are exactly what this CLI would generate. */
export function checkSchemaFiles(root: string): string[] {
  return [...schemaFiles()]
    .filter(([file, text]) => !existsSync(join(root, file)) || readFileSync(join(root, file), "utf8") !== text)
    .map(([file]) => `${file} is missing or out of date: run \`bun run registry generate\``);
}

/**
 * Every preset resolves: its components exist, once each; an alias extends a base and chooses what
 * that base lets it choose; and every answer to a question resolves too and has a `title` to show.
 */
export function checkPresets(root: string): string[] {
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
      // An alias asks its base's questions: they are checked once, with the base.
      for (const slot of isAlias ? [] : registry.slots(name)) {
        for (const option of slot.options) {
          registry.preset(name, [option.name]);
          if (registry.manifest(option.name).title === undefined) {
            report(`${option.name} answers "${slot.question}" but its component.json has no title to show`);
          }
        }
      }
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  }
  return [...problems];
}

/** Every component's manifest, by listing `components/`. A missing one is skipped; invalid JSON throws. */
export function readManifests(root: string): Manifest[] {
  return componentNames(root).flatMap((name) => readManifest(join(root, "components", name)) ?? []);
}

/** S14: the generated fields are exactly what setup declares. S10: every tool states its replay. */
export function checkDrift(manifest: Manifest, generated: Generated): string[] {
  const problems: string[] = [];
  const expected = withGenerated(manifest, generated);
  const fields: [string, unknown, unknown][] = [
    ["$schema", manifest.$schema, COMPONENT_SCHEMA_REF],
    ["provides", manifest.provides, expected.provides],
    ["requires.capabilities", manifest.requires?.capabilities, expected.requires.capabilities],
    ["optional.capabilities", manifest.optional?.capabilities, expected.optional.capabilities],
    ["replay", manifest.replay, expected.replay],
  ];
  for (const [field, actual, derived] of fields) {
    if (JSON.stringify(actual) !== JSON.stringify(derived)) {
      problems.push(
        `${field} drifted from setup: component.json has ${JSON.stringify(actual) ?? "nothing"}, setup declares ${JSON.stringify(derived) ?? "nothing"}; run \`bun run registry generate\` (S14)`,
      );
    }
  }
  for (const [tool, replay] of Object.entries(generated.tools ?? {})) {
    if (replay !== "safe" && replay !== "never") {
      problems.push(`the agent.tool "${tool}" has replay ${JSON.stringify(replay)}; every tool declares "safe" or "never" (S10)`);
    }
  }
  return problems;
}

/** A stable layout keeps every diff to what changed; hand edits keep it by running `generate`. */
function checkFormat(componentDir: string, manifest: Manifest): string[] {
  return readFileSync(manifestPath(componentDir), "utf8") === formatManifest(manifest)
    ? []
    : ["component.json is not in generated form (key order, formatting): run `bun run registry generate`"];
}

/** A new component's starting manifest: what can be read from its README and its imports. */
function skeleton(dir: string, name: string): Manifest {
  const targets: string[] = [];
  const imported = checkImports(dir, name, targets).packages;
  const versions = knownVersions();
  return {
    name,
    version: "0.0.0",
    description: readmeSummary(dir),
    targets,
    requires: { pikit: coreVersion(), capabilities: [] },
    optional: { capabilities: [] },
    provides: [],
    dependencies: Object.fromEntries([...imported].sort().map((pkg) => [pkg, versions[pkg] ?? ""])),
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
