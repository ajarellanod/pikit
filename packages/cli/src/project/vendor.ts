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
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGES_DIR } from "../paths.ts";

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

/** `file:vendor/pikit-core-0.0.0.tgz`: the tarball `bun pm pack` names from the package's version. */
export function kitSpecifier(name: string): string {
  const dir = KIT_PACKAGES[name];
  if (dir === undefined) throw new Error(`${name} is not a kit package`);
  const { version } = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8")) as { version: string };
  return `file:${VENDOR_DIR}/${name.slice(1).replace("/", "-")}-${version}.tgz`;
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
  if (packed.exitCode !== 0 || !existsSync(tarball)) {
    throw new Error(`could not pack ${name} into ${VENDOR_DIR}/: ${packed.stderr.toString().trim() || `expected ${tarball}`}`);
  }
  return specifier;
}

/** Every kit package vendored, and the `overrides` that point each one at its tarball. */
export function vendorKit(projectDir: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const name of Object.keys(KIT_PACKAGES)) overrides[name] = vendorKitPackage(projectDir, name);
  return overrides;
}
