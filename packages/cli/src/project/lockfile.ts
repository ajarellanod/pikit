/**
 * Whether `bun.lock` matches `package.json`, read without the network and without `bun install`, for
 * `pikit doctor`. A project whose lockfile does not match fails its next frozen install (a Docker
 * build), and its `node_modules` may be another set of packages than the one `package.json` names.
 *
 * `bun.lock` is JSONC (trailing commas; comments are tolerated). Its `workspaces[""]` records the root
 * package's `dependencies`, `devDependencies` and `optionalDependencies` exactly as `package.json`
 * wrote them when Bun last installed: the specifier, not the version it resolved, and not what an
 * `overrides` entry replaced it with (overrides are their own section). The check compares these
 * names/specifiers field by field and checks the separate declared overrides, never resolved versions
 * or the installed package tree. A name in several fields of `package.json` is recorded by Bun in one of them; it matches when
 * every field the lock gives it is one `package.json` gives it, with the same specifier.
 *
 * `bun.lockb`, Bun's old binary lockfile, is not parsed: doctor says it cannot check it. A project with
 * no lockfile at all is said to be unchecked, not broken: a project assembled by hand has none until
 * its first install.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { confinedPath } from "./paths.ts";

export const BUN_LOCK = "bun.lock";
export const BUN_LOCKB = "bun.lockb";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
type Field = (typeof FIELDS)[number];

/** Name → each field that names it, with its specifier. */
type Declared = Map<string, Map<Field, string>>;

export interface LockfileCheck {
  /** The lockfile is unreadable, or does not match `package.json`: `bun install`. */
  problems: string[];
  /** What could not be checked. */
  notes: string[];
}

export function checkLockfile(projectDir: string): LockfileCheck {
  let lockPath: string;
  try {
    lockPath = confinedPath(projectDir, BUN_LOCK);
    confinedPath(projectDir, BUN_LOCKB);
  } catch (error) {
    return { problems: [`lockfiles cannot be checked: ${message(error)}`], notes: [] };
  }
  if (!existsSync(lockPath)) {
    if (existsSync(join(projectDir, BUN_LOCKB))) {
      return { problems: [], notes: [`${BUN_LOCKB} is Bun's old binary lockfile: whether it matches package.json is not checked`] };
    }
    // Without node_modules, doctor already says to run `bun install`, which writes it.
    if (!existsSync(join(projectDir, "node_modules"))) return { problems: [], notes: [] };
    return { problems: [], notes: [`there is no ${BUN_LOCK}: whether node_modules matches package.json is not checked`] };
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(confinedPath(projectDir, "package.json"), "utf8"));
    if (record(pkg) === undefined) throw new Error("expected a package object");
  } catch (error) {
    return { problems: [`package.json cannot be read: ${message(error)}`], notes: [] };
  }
  let lock: unknown;
  try {
    lock = Bun.JSONC.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    return { problems: [`${BUN_LOCK} cannot be read (${message(error)}): put it back (\`git checkout ${BUN_LOCK}\`), or delete it and run \`bun install\``], notes: [] };
  }
  const root = record(record(lock)?.workspaces)?.[""];
  if (record(root) === undefined) {
    return { problems: [`${BUN_LOCK} has no root workspace (\`workspaces[""]\`): it is not a lockfile this Bun wrote; run \`bun install\``], notes: [] };
  }
  const differences = lockDifferences(declared(pkg), declared(root));
  const notes: string[] = [];
  const overrides = record(record(pkg)?.overrides) ?? {};
  const lockedOverrides = record(record(lock)?.overrides) ?? {};
  for (const name of [...new Set([...Object.keys(overrides), ...Object.keys(lockedOverrides)])].sort()) {
    const wanted = overrides[name];
    const locked = lockedOverrides[name];
    if ((wanted !== undefined && typeof wanted !== "string") || (locked !== undefined && typeof locked !== "string")) {
      notes.push(`overrides.${name}: non-string override metadata is not checked`);
    } else if (wanted !== locked) {
      differences.push(`overrides.${name}: package.json has ${JSON.stringify(wanted) ?? "nothing"}, ${BUN_LOCK} has ${JSON.stringify(locked) ?? "nothing"}`);
    }
  }
  if (differences.length === 0) return { problems: [], notes };
  return { problems: [`${BUN_LOCK} does not match package.json, so node_modules may not either: run \`bun install\`\n    ${differences.join("\n    ")}`], notes };
}

/**
 * How the root workspace of a lockfile differs from `package.json`'s dependencies: a name added,
 * removed, moved to another field, or with another specifier. Empty when they match.
 */
export function lockDifferences(pkg: Declared, lock: Declared): string[] {
  const differences: string[] = [];
  const describe = (fields: Map<Field, string>) => [...fields].map(([field, specifier]) => `${field} ${JSON.stringify(specifier)}`).join(", ");
  for (const name of [...new Set([...pkg.keys(), ...lock.keys()])].sort()) {
    const wanted = pkg.get(name);
    const locked = lock.get(name);
    if (locked === undefined) differences.push(`${name}: package.json has it (${describe(wanted as Map<Field, string>)}), ${BUN_LOCK} does not`);
    else if (wanted === undefined) differences.push(`${name}: ${BUN_LOCK} has it (${describe(locked)}), package.json does not`);
    else if ([...locked].some(([field, specifier]) => wanted.get(field) !== specifier)) {
      differences.push(`${name}: package.json has ${describe(wanted)}, ${BUN_LOCK} has ${describe(locked)}`);
    }
  }
  return differences;
}

/** The dependency fields of a `package.json`, or of a lockfile's workspace; what is not a string is not a specifier. */
export function declared(manifest: unknown): Declared {
  const result: Declared = new Map();
  for (const field of FIELDS) {
    for (const [name, specifier] of Object.entries(record(record(manifest)?.[field]) ?? {})) {
      if (typeof specifier !== "string") continue;
      const fields = result.get(name) ?? new Map<Field, string>();
      fields.set(field, specifier);
      result.set(name, fields);
    }
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
