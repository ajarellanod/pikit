/**
 * The project's `package.json`: the npm dependencies components declare (SPEC §10.2: protocols
 * and crypto are depended on, behaviour is copied). Kit packages resolve to their vendored tarballs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isKitPackage, vendorKitPackage } from "./vendor.ts";

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  [key: string]: unknown;
}

export function readPackageJson(projectDir: string): PackageJson {
  return JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as PackageJson;
}

export function writePackageJson(projectDir: string, pkg: PackageJson): void {
  writeFileSync(join(projectDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Adds the component's dependencies that the project lacks, sorted like `bun add` sorts them. A
 * package the project already depends on keeps its version, and a different one is reported: the
 * project's pin wins, and the user decides. Returns what changed and the conflicts.
 */
export function addDependencies(
  projectDir: string,
  pkg: PackageJson,
  wanted: Record<string, string>,
): { added: string[]; conflicts: string[] } {
  const dependencies = { ...pkg.dependencies };
  const added: string[] = [];
  const conflicts: string[] = [];
  for (const [name, version] of Object.entries(wanted)) {
    const specifier = isKitPackage(name) ? vendorKitPackage(projectDir, name) : version;
    const current = dependencies[name];
    if (current === undefined) {
      dependencies[name] = specifier;
      added.push(name);
    } else if (current !== specifier) {
      conflicts.push(`${name}: the project has ${current}, the component asks for ${specifier}`);
    }
  }
  pkg.dependencies = sortKeys(dependencies);
  return { added, conflicts };
}

/** Removes the named dependencies; returns those that were there. */
export function removeDependencies(pkg: PackageJson, names: Iterable<string>): string[] {
  const dependencies = { ...pkg.dependencies };
  const removed: string[] = [];
  for (const name of names) {
    if (name in dependencies) {
      delete dependencies[name];
      removed.push(name);
    }
  }
  pkg.dependencies = dependencies;
  return removed;
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
