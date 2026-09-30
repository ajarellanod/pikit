/**
 * `pikit.json`, the project manifest: which components are installed, from which
 * registry, at which version and commit, and the hash of every file each one wrote.
 *
 * It is the install record, so it keeps what `pikit remove` and `pikit doctor` need later without
 * the registry at hand: the npm (dev) dependencies and environment variables the component declared when
 * it was installed, the ones `add` put in package.json for it (the only ones `remove` may take out),
 * and the kit versions it accepts (`requires`), which `add` checks before it changes the project's
 * kit. Whether a file is modified is not stored: it is computed by comparing its hash,
 * so it can never go stale.
 *
 * Version 2 records registries by what resolves on any machine (`registry-location.ts`). Version 1
 * recorded the path of the CLI's checkout; it is read and converted in memory, and the next write
 * saves version 2.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentVariable, Hook } from "../registry/manifest.ts";
import { BUILTIN_REGISTRY, isCheckoutRegistry, recordedLocation } from "./registry-location.ts";

export const PIKIT_JSON = "pikit.json";

export interface InstalledComponent {
  /** A key of `registries`. */
  registry: string;
  version: string;
  /** The registry's Git commit when it was installed; `-dirty` when it had uncommitted changes. */
  commit?: string;
  /** Project-relative path → its hash as installed. */
  files: Record<string, { hash: string }>;
  /** The npm packages its manifest declared (package → version). */
  dependencies: Record<string, string>;
  /** The npm dev dependencies its manifest declared (package → version); absent when it declared none. */
  devDependencies?: Record<string, string>;
  /**
   * The packages of `dependencies` that `add` put in package.json for it: those the project did not
   * have, and those another installed component had put there (the last of them to go takes them
   * out). `remove` takes out only these, when nothing else needs them. Absent in a record made before
   * it was kept (`ownedDependencies`).
   */
  addedDependencies?: string[];
  /** The same for `devDependencies`; absent when it added none. */
  addedDevDependencies?: string[];
  /**
   * Its manifest's `requires.pikit` and `requires.contracts`: the @pikit/core and @pikit/contracts
   * versions it works with. Absent in a record made before they were recorded (`kitRanges`).
   */
  requires?: { pikit: string; contracts?: string };
  /** Its manifest's `environment`. */
  environment: EnvironmentVariable[];
  /**
   * Its manifest's `hooks`, by project path: `doctor` is the file whose `doctor` `pikit doctor` calls,
   * `beforeDeploy` and `afterDeploy` those the deployment's `up` calls before it builds and once the
   * new version answers (SPEC C8).
   */
  hooks?: Partial<Record<Hook, string>>;
  /**
   * Its manifest's `generated`, by project path: files a hook rewrites (tool-mcp's `seed.ts`), which are
   * never the user's edits. Absent when it declared none.
   */
  generated?: string[];
  /**
   * The components it was installed for, when it was offered rather than asked for (`offers.ts`):
   * it leaves with the last of them, when nothing else uses it.
   */
  installedFor?: string[];
}

export interface ProjectManifest {
  /** Schema version of `pikit.json`. */
  version: 2;
  /**
   * The kit in `vendor/`: the commit of the pikit checkout it was packed from (`vendor.ts`, `kitCommit`),
   * `-dirty` when its packages had uncommitted changes. Absent when unknown: made before version 2, or
   * by a CLI not in Git.
   */
  kit?: { commit: string };
  targets: string[];
  /** Name → location: `builtin`, a path inside the project (`./…`), or an absolute path (`registry-location.ts`). */
  registries: Record<string, string>;
  components: Record<string, InstalledComponent>;
}

/** A new project's targets unless `pikit new --target` says otherwise. */
export const NEW_PROJECT_TARGETS: readonly string[] = ["server"];

/**
 * A new project's manifest; `registry` is a recorded location (`recordedLocation`), `kit` the vendored
 * kit's commit, `targets` where it runs (`pikit new --target`).
 */
export function emptyManifest(registry: string = BUILTIN_REGISTRY, kit?: string, targets: readonly string[] = NEW_PROJECT_TARGETS): ProjectManifest {
  return { version: 2, ...(kit !== undefined && { kit: { commit: kit } }), targets: [...targets], registries: { default: registry }, components: {} };
}

export function readProjectManifest(projectDir: string): ProjectManifest {
  const path = join(projectDir, PIKIT_JSON);
  if (!existsSync(path)) {
    throw new Error(`${projectDir} is not a pikit project: there is no ${PIKIT_JSON} (create one with \`pikit new\`)`);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ProjectManifest | ProjectManifestV1;
  if (manifest.version === 1) return fromV1(projectDir, manifest);
  if (manifest.version !== 2) throw new Error(`${PIKIT_JSON} has version ${String((manifest as { version: unknown }).version)}; this CLI reads versions 1 and 2`);
  return manifest;
}

/** Version 1: registries are absolute paths, those of the machine that installed. */
type ProjectManifestV1 = Omit<ProjectManifest, "version"> & { version: 1 };

/** Version 1 in version 2's shape: a pikit checkout's registry is `builtin`, one inside the project relative. */
function fromV1(projectDir: string, manifest: ProjectManifestV1): ProjectManifest {
  const registries: Record<string, string> = {};
  for (const [name, location] of Object.entries(manifest.registries)) {
    registries[name] = isCheckoutRegistry(location) ? BUILTIN_REGISTRY : recordedLocation(projectDir, location);
  }
  return { ...manifest, version: 2, registries };
}

/** Stable text: components and files sorted, so the file's diff shows only what changed. */
export function writeProjectManifest(projectDir: string, manifest: ProjectManifest): void {
  const components: Record<string, InstalledComponent> = {};
  for (const name of Object.keys(manifest.components).sort()) {
    const c = manifest.components[name] as InstalledComponent;
    const files: Record<string, { hash: string }> = {};
    for (const file of Object.keys(c.files).sort()) files[file] = c.files[file] as { hash: string };
    components[name] = { ...c, files };
  }
  // Keys in one order, whatever order the object was built in.
  const { version, kit, targets, registries } = manifest;
  writeFileSync(join(projectDir, PIKIT_JSON), `${JSON.stringify({ version, ...(kit !== undefined && { kit }), targets, registries, components }, null, 2)}\n`);
}

export function hashOf(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function hashFile(path: string): string {
  return hashOf(readFileSync(path));
}

/**
 * Installed files whose content no longer has the hash recorded at install (the user's edits). A file
 * the component declares `generated` is its hooks', not the user's: never one of them.
 */
export function modifiedFiles(projectDir: string, component: InstalledComponent): string[] {
  const generated = new Set(component.generated ?? []);
  return Object.entries(component.files)
    .filter(([file, { hash }]) => !generated.has(file) && existsSync(join(projectDir, file)) && hashFile(join(projectDir, file)) !== hash)
    .map(([file]) => file);
}

/**
 * The @pikit/core and @pikit/contracts ranges an installed component accepts, as recorded. A record
 * made before `requires` was gives the @pikit/contracts version its manifest pinned in `dependencies`
 * (written against that one), and no core range: that one was not recorded.
 */
export function kitRanges(component: InstalledComponent): { pikit?: string; contracts?: string } {
  if (component.requires !== undefined) return component.requires;
  const contracts = component.dependencies["@pikit/contracts"];
  return contracts === undefined ? {} : { contracts };
}

/**
 * The packages `remove` may take out of package.json for an installed component: those `add` put
 * there for it. A record made before `addedDependencies` was kept gives every package it declared.
 */
export function ownedDependencies(component: InstalledComponent): { dependencies: string[]; devDependencies: string[] } {
  if (component.addedDependencies === undefined) {
    return { dependencies: Object.keys(component.dependencies), devDependencies: Object.keys(component.devDependencies ?? {}) };
  }
  return { dependencies: component.addedDependencies, devDependencies: component.addedDevDependencies ?? [] };
}

/** Installed files that are gone. */
export function missingFiles(projectDir: string, component: InstalledComponent): string[] {
  return Object.keys(component.files).filter((file) => !existsSync(join(projectDir, file)));
}
