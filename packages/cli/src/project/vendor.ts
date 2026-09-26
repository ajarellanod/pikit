/**
 * The kit packages in a project, until they are published (SPEC §10.5, "M1: vendored kit").
 *
 * `@pikit/core`, `@pikit/pi-adapter` and `@pikit/pi-extension-shim` are not on npm yet. The CLI
 * packs them from its own checkout into the project's `vendor/` (`bun pm pack`), and the project
 * depends on the tarballs with `file:vendor/<tarball>`. Everything then resolves inside the project
 * directory, so `bun install --frozen-lockfile` works in a Docker build too.
 *
 * A packed package names its kit dependencies by version (`@pikit/core: 0.0.0`), which npm does
 * not have, so `overrides` points every kit package at its tarball. That also keeps exactly one
 * copy of `@pikit/core` in `node_modules`: two copies would mean two sets of capability contracts.
 *
 * The version stays `0.0.0` until the kit is published, so a tarball's name also carries a hash of
 * the package's files (`pikit-core-0.0.0-<hash>.tgz`). A project whose tarballs are another kit's
 * gets this CLI's when a component is added (`refreshKit`): the component and the core it needs come
 * from the same checkout. The core only grows within a major (SPEC §12a), so the components already
 * installed keep working.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACKAGES_DIR } from "../paths.ts";
import { readPackageJson, writePackageJson } from "./package-json.ts";

export const VENDOR_DIR = "vendor";

/** Kit package → its directory under `packages/`. */
export const KIT_PACKAGES: Record<string, string> = {
  "@pikit/core": "core",
  "@pikit/pi-adapter": "pi-adapter",
  "@pikit/pi-extension-shim": "pi-extension-shim",
};

/**
 * Pi extensions import `@earendil-works/pi-coding-agent`; a project installs the shim under that
 * name (SPEC §6.2b), so the 19 MB coding agent is never a dependency.
 */
export const EXTENSION_ALIAS = "@earendil-works/pi-coding-agent";

export function isKitPackage(name: string): boolean {
  return name in KIT_PACKAGES;
}

/** `pikit-core-0.0.0`: the name `bun pm pack` gives a kit package's tarball, without `.tgz`. */
function packedName(name: string): string {
  const dir = KIT_PACKAGES[name];
  if (dir === undefined) throw new Error(`${name} is not a kit package`);
  const { version } = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8")) as { version: string };
  return `${name.slice(1).replace("/", "-")}-${version}`;
}

const hashes = new Map<string, string>();

/** A short hash of the kit package's files as this checkout has them (tests and node_modules aside). */
export function kitHash(name: string): string {
  const cached = hashes.get(name);
  if (cached !== undefined) return cached;
  const root = join(PACKAGES_DIR, KIT_PACKAGES[name] as string);
  const hasher = new Bun.CryptoHasher("sha256");
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === "node_modules" || entry.endsWith(".test.ts")) continue;
      const path = join(dir, entry);
      const relative = `${prefix}${entry}`;
      if (statSync(path).isDirectory()) walk(path, `${relative}/`);
      else hasher.update(`${relative}\0`).update(readFileSync(path)).update("\0");
    }
  };
  walk(root, "");
  const hash = hasher.digest("hex").slice(0, 10);
  hashes.set(name, hash);
  return hash;
}

/** `file:vendor/pikit-core-0.0.0-<hash>.tgz`: this checkout's tarball of the kit package. */
export function kitSpecifier(name: string): string {
  return `file:${VENDOR_DIR}/${packedName(name)}-${kitHash(name)}.tgz`;
}

/**
 * Packs the kit package into the project's `vendor/` unless its tarball is already there. An
 * existing tarball is kept: repacking changes its bytes, and `bun.lock` records their integrity.
 */
export function vendorKitPackage(projectDir: string, name: string): string {
  const specifier = kitSpecifier(name);
  const tarball = join(projectDir, specifier.slice("file:".length));
  if (existsSync(tarball)) return specifier;
  mkdirSync(join(projectDir, VENDOR_DIR), { recursive: true });
  const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", join(projectDir, VENDOR_DIR), "--quiet"], {
    cwd: join(PACKAGES_DIR, KIT_PACKAGES[name] as string),
    stdout: "pipe",
    stderr: "pipe",
  });
  const plain = join(projectDir, VENDOR_DIR, `${packedName(name)}.tgz`);
  if (packed.exitCode !== 0 || !existsSync(plain)) {
    throw new Error(`could not pack ${name} into ${VENDOR_DIR}/: ${packed.stderr.toString().trim() || `expected ${plain}`}`);
  }
  renameSync(plain, tarball);
  return specifier;
}

/**
 * Points the project at this checkout's kit when it has another one (older, or from another
 * checkout): new tarballs in `vendor/`, `dependencies` and `overrides` rewritten, the tarballs no
 * longer named deleted. Returns the packages refreshed; `bun install` must run after.
 */
export function refreshKit(projectDir: string): string[] {
  const pkg = readPackageJson(projectDir);
  const refreshed: string[] = [];
  const rewrite = (record: Record<string, string> | undefined): void => {
    if (record === undefined) return;
    for (const [dependency, specifier] of Object.entries(record)) {
      // The Pi extension alias points at the shim's tarball too.
      const kit = Object.keys(KIT_PACKAGES).find((name) => name === dependency || specifier.includes(`/${packedName(name)}`));
      if (kit === undefined || !specifier.startsWith(`file:${VENDOR_DIR}/`)) continue;
      const current = vendorKitPackage(projectDir, kit);
      if (specifier === current) continue;
      record[dependency] = current;
      if (!refreshed.includes(kit)) refreshed.push(kit);
    }
  };
  rewrite(pkg.dependencies);
  rewrite(pkg.overrides);
  if (refreshed.length === 0) return [];
  writePackageJson(projectDir, pkg);
  const named = new Set([...Object.values(pkg.dependencies ?? {}), ...Object.values(pkg.overrides ?? {})].map((s) => s.slice("file:".length)));
  for (const file of readdirSync(join(projectDir, VENDOR_DIR))) {
    if (file.endsWith(".tgz") && !named.has(`${VENDOR_DIR}/${file}`)) rmSync(join(projectDir, VENDOR_DIR, file));
  }
  return refreshed;
}

/** Every kit package vendored, and the `overrides` that point each one at its tarball. */
export function vendorKit(projectDir: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const name of Object.keys(KIT_PACKAGES)) overrides[name] = vendorKitPackage(projectDir, name);
  return overrides;
}
