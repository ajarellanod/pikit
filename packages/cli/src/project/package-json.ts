/**
 * The project's `package.json`: the npm dependencies components declare (protocols and
 * crypto are depended on, behaviour is copied), and the dev dependencies they declare (a tool
 * they run, like deployment-cloudflare's `wrangler`). Kit packages resolve to their vendored tarballs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { confinedPath } from "./paths.ts";
import { isKitPackage, vendorKitPackage } from "./vendor.ts";

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  [key: string]: unknown;
}

/** Where a component's npm packages go: its manifest's `dependencies` or `devDependencies`. */
export type DependencyField = "dependencies" | "devDependencies";

export function readPackageJson(projectDir: string): PackageJson {
  return JSON.parse(readFileSync(confinedPath(projectDir, "package.json"), "utf8")) as PackageJson;
}

export function writePackageJson(projectDir: string, pkg: PackageJson): void {
  writeFileSync(confinedPath(projectDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Where a component's npm packages go in the project's `package.json`: its `dependencies` in
 * `dependencies`, its `devDependencies` (what only its tests import, the tools it runs) in
 * `devDependencies`, except a kit package its tests import, which goes with the kit in `dependencies`
 * (where `refreshKit` repoints every kit package).
 */
export function projectDependencies(manifest: { dependencies: Record<string, string>; devDependencies?: Record<string, string> | undefined }): Record<DependencyField, Record<string, string>> {
  const dev = Object.entries(manifest.devDependencies ?? {});
  return {
    dependencies: { ...manifest.dependencies, ...Object.fromEntries(dev.filter(([name]) => isKitPackage(name))) },
    devDependencies: Object.fromEntries(dev.filter(([name]) => !isKitPackage(name))),
  };
}

/**
 * Adds the component's dependencies (or dev dependencies) that the project lacks, sorted like `bun
 * add` sorts them. A package the project already depends on keeps its version, and a different one
 * is reported: the project's pin wins, and the user decides. A dev dependency the project has as a
 * dependency is there already: it is installed either way. Returns what changed and the conflicts.
 */
export function addDependencies(
  projectDir: string,
  pkg: PackageJson,
  wanted: Record<string, string>,
  field: DependencyField = "dependencies",
): { added: string[]; conflicts: string[] } {
  const record = { ...pkg[field] };
  const added: string[] = [];
  const conflicts: string[] = [];
  for (const [name, version] of Object.entries(wanted)) {
    const specifier = isKitPackage(name) ? vendorKitPackage(projectDir, name) : version;
    const current = record[name] ?? (field === "devDependencies" ? pkg.dependencies?.[name] : undefined);
    if (current === undefined) {
      record[name] = specifier;
      added.push(name);
    } else if (current !== specifier) {
      conflicts.push(`${name}: the project has ${current}, the component asks for ${specifier}`);
    }
  }
  if (added.length > 0) pkg[field] = sortKeys(record);
  return { added, conflicts };
}

/**
 * An upgrade's new versions (`pikit upgrade`): each of `owned` (what `add` put in package.json for the
 * component) that the project still has at the version the component declared (`before`) moves to
 * the one it declares now (`wanted`). A version the project chose stays; kit packages are the kit's
 * (`refreshKit`). Returns the packages moved.
 */
export function updateDependencies(
  pkg: PackageJson,
  before: Record<string, string>,
  wanted: Record<string, string>,
  owned: readonly string[],
  field: DependencyField = "dependencies",
): string[] {
  const record = pkg[field];
  if (record === undefined) return [];
  const moved = Object.entries(wanted).filter(
    ([name, version]) => owned.includes(name) && !isKitPackage(name) && before[name] !== undefined && record[name] === before[name] && version !== before[name],
  );
  for (const [name, version] of moved) record[name] = version;
  return moved.map(([name]) => name);
}

/** Removes the named dependencies (or dev dependencies); returns those that were there. */
export function removeDependencies(pkg: PackageJson, names: Iterable<string>, field: DependencyField = "dependencies"): string[] {
  const record = { ...pkg[field] };
  const removed: string[] = [];
  for (const name of names) {
    if (name in record) {
      delete record[name];
      removed.push(name);
    }
  }
  if (removed.length > 0) pkg[field] = record;
  return removed;
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
