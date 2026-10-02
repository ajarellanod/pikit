/**
 * The kit packages in a project, until they are published.
 *
 * `@pikit/core`, `@pikit/contracts` and `@pikit/pi-adapter` are not on npm yet. The CLI
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
 * from the same checkout. That is not assumed safe for the components already installed: P7 promises
 * only the core's 1.x, and the contracts stay 0.x on their own schedule (SPEC K8). So each installed
 * component records the core, contracts and adapter ranges it accepts (`requires` in `pikit.json`), and `add`
 * refuses, before any write and unless `--force`, a kit outside them (`checkKit` in `add.ts`).
 *
 * A hash says two kits differ, not which is newer. Meanwhile the kit's identity is the commit of the
 * checkout it was packed from (`kitCommit`), recorded in `pikit.json` as `kit.commit`: `add` refuses to
 * replace a project's kit with an older one (`compareKits`), so an older CLI never downgrades it silently.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGES_DIR, PIKIT_ROOT } from "../paths.ts";
import { gitCommit, isAncestor } from "./git.ts";
import { type PackageJson, readPackageJson, writePackageJson } from "./package-json.ts";
import { confinedPath } from "./paths.ts";

export const VENDOR_DIR = "vendor";

/** Kit package → its directory under `packages/`. */
export const KIT_PACKAGES: Record<string, string> = {
  "@pikit/core": "core",
  "@pikit/contracts": "contracts",
  "@pikit/pi-adapter": "pi-adapter",
};

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
  const tarball = confinedPath(projectDir, specifier.slice("file:".length));
  if (existsSync(tarball)) return specifier;
  mkdirSync(confinedPath(projectDir, VENDOR_DIR), { recursive: true });
  // Packed elsewhere: `bun pm pack` names the tarball without the hash, which may be an older kit's
  // tarball still in vendor/ (and still named in bun.lock until the next install).
  const staging = mkdtempSync(join(tmpdir(), "pikit-pack-"));
  try {
    const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", staging, "--quiet"], {
      cwd: join(PACKAGES_DIR, KIT_PACKAGES[name] as string),
      stdout: "pipe",
      stderr: "pipe",
    });
    const plain = join(staging, `${packedName(name)}.tgz`);
    if (packed.exitCode !== 0 || !existsSync(plain)) {
      throw new Error(`could not pack ${name} into ${VENDOR_DIR}/: ${packed.stderr.toString().trim() || `expected ${plain}`}`);
    }
    copyFileSync(plain, tarball);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return specifier;
}

/**
 * Points the project at this checkout's kit when it has another one (older, or from another
 * checkout): new tarballs in `vendor/`, `dependencies` and `overrides` rewritten, and an override
 * added for a kit package the project's kit did not have. Returns the
 * packages refreshed; `bun install` must run after, then `pruneVendor`: `bun.lock` still names the old
 * tarballs until the install rewrites it. `add` checks first that this is no downgrade (`compareKits`).
 */
export function refreshKit(projectDir: string): string[] {
  const pkg = readPackageJson(projectDir);
  const { stale } = pointAtKit(pkg, (kit) => vendorKitPackage(projectDir, kit));
  if (stale.length === 0) return [];
  writePackageJson(projectDir, pkg);
  return stale;
}

/**
 * What `refreshKit` would do, writing nothing: the kit packages it would refresh, and whether the
 * project has a vendored kit at all.
 */
export function staleKit(projectDir: string): { vendored: boolean; stale: string[] } {
  return pointAtKit(readPackageJson(projectDir), kitSpecifier);
}

/** Points `pkg`'s kit packages at `specifier(kit)`, in memory. */
function pointAtKit(pkg: PackageJson, specifier: (kit: string) => string): { vendored: boolean; stale: string[] } {
  const stale: string[] = [];
  let vendored = false;
  const rewrite = (record: Record<string, string> | undefined): void => {
    if (record === undefined) return;
    for (const [dependency, current] of Object.entries(record)) {
      const kit = Object.keys(KIT_PACKAGES).find((name) => name === dependency || current.includes(`/${packedName(name)}`));
      if (kit === undefined || !current.startsWith(`file:${VENDOR_DIR}/`)) continue;
      vendored = true;
      const wanted = specifier(kit);
      if (current === wanted) continue;
      record[dependency] = wanted;
      if (!stale.includes(kit)) stale.push(kit);
    }
  };
  rewrite(pkg.dependencies);
  rewrite(pkg.overrides);
  // A kit package the project's kit did not have yet (one split out of another, as @pikit/contracts
  // was out of @pikit/core): the other kit packages name it by version, so it needs its override too.
  if (pkg.overrides !== undefined) {
    for (const kit of Object.keys(KIT_PACKAGES)) {
      if (kit in pkg.overrides) continue;
      pkg.overrides[kit] = specifier(kit);
      if (!stale.includes(kit)) stale.push(kit);
    }
  }
  return { vendored, stale };
}

let commit: { value: string | undefined } | undefined;

/**
 * The kit's identity until it is published: the commit of this CLI's checkout, `-dirty` when a kit
 * package has uncommitted changes. Undefined when the checkout is not in Git.
 */
export function kitCommit(): string | undefined {
  commit ??= { value: gitCommit(PIKIT_ROOT, Object.values(KIT_PACKAGES).map((dir) => `packages/${dir}`)) };
  return commit.value;
}

/** Whether replacing a project's kit with another is an upgrade, a downgrade, or cannot be told. */
export type KitOrder = { verdict: "upgrade" } | { verdict: "downgrade" } | { verdict: "unknown"; why: string };

/**
 * How the kit at commit `next` (this CLI's) compares with the project's, at commit `current`, in the
 * repository `repo` (this CLI's checkout). An upgrade when `current` is `next` or comes before it; a
 * downgrade when it does not (`next` is older, or on another branch). `-dirty` is set aside, except
 * when both name one commit and the project's had uncommitted changes, which Git cannot order.
 */
export function compareKits(repo: string, current: string | undefined, next: string | undefined): KitOrder {
  if (current === undefined) return { verdict: "unknown", why: "pikit.json does not record the project's kit (the CLI that made it was not in Git)" };
  if (next === undefined) return { verdict: "unknown", why: `this CLI's checkout (${repo}) is not in Git` };
  const [from, to] = [current.replace(/-dirty$/, ""), next.replace(/-dirty$/, "")];
  if (from === to && current.endsWith("-dirty")) return { verdict: "unknown", why: `the project's kit was packed from uncommitted changes to ${from}` };
  const ancestor = isAncestor(repo, from, to);
  if (ancestor === undefined) return { verdict: "unknown", why: `this CLI's checkout does not have the project's kit commit ${current}, which may be newer` };
  return { verdict: ancestor ? "upgrade" : "downgrade" };
}

/** `compareKits` for this CLI's kit. */
export function kitOrder(current: string | undefined): KitOrder {
  return compareKits(PIKIT_ROOT, current, kitCommit());
}

/** Deletes the tarballs in `vendor/` that `package.json` no longer names (after a refresh and its install). */
export function pruneVendor(projectDir: string): string[] {
  const pkg = readPackageJson(projectDir);
  const named = new Set([...Object.values(pkg.dependencies ?? {}), ...Object.values(pkg.overrides ?? {})].map((s) => s.slice("file:".length)));
  const dir = confinedPath(projectDir, VENDOR_DIR);
  if (!existsSync(dir)) return [];
  const pruned = readdirSync(dir).filter((file) => file.endsWith(".tgz") && !named.has(`${VENDOR_DIR}/${file}`));
  for (const file of pruned) rmSync(confinedPath(projectDir, `${VENDOR_DIR}/${file}`));
  return pruned;
}

/** Every kit package vendored, and the `overrides` that point each one at its tarball. */
export function vendorKit(projectDir: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const name of Object.keys(KIT_PACKAGES)) overrides[name] = vendorKitPackage(projectDir, name);
  return overrides;
}
