/**
 * The project's `package.json`: the npm dependencies components declare (SPEC §10.2: protocols
 * and crypto are depended on, behaviour is copied), and the dev dependencies they declare (a tool
 * they run, like deployment-cloudflare's `wrangler`). Kit packages resolve to their vendored tarballs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  return JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as PackageJson;
}

export function writePackageJson(projectDir: string, pkg: PackageJson): void {
  writeFileSync(join(projectDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
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
