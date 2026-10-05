/**
 * `pikit.json`, the project manifest: which components are installed, from which
 * registry, at which version and commit, and the hash of every file each one wrote.
 *
 * It is the install record, so it keeps what `pikit remove` and `pikit doctor` need later without
 * the registry at hand: the npm (dev) dependencies and environment variables the component declared when
 * it was installed, the ones `add` put in package.json for it (the only ones `remove` may take out),
 * and the kit versions it accepts (`requires`), which `add` checks before it changes the project's
 * kit. Whether a file is modified is not stored: it is computed by comparing its hash,
 * so it can never go stale. Registries are recorded by what resolves on any machine
 * (`registry-location.ts`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { confinedPath } from "./paths.ts";
import { type EnvironmentVariable, type Hook } from "../registry/manifest.ts";
import { BUILTIN_REGISTRY } from "./registry-location.ts";

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
   * out). `remove` takes out only these, when nothing else needs them (`ownedDependencies`).
   */
  addedDependencies: string[];
  /** The same for `devDependencies`; absent when it added none. */
  addedDevDependencies?: string[];
  /**
   * Its manifest's `requires.pikit`, `requires.contracts` and `requires.adapter`: the @pikit/core,
   * @pikit/contracts and @pikit/pi-adapter versions it works with; `contracts` and `adapter` absent
   * when it does not depend on them.
   */
  requires: { pikit: string; contracts?: string; adapter?: string };
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
   * Its manifest's `apps`: where it went in a project on Cloudflare (SPEC C1). `pikit upgrade` changes
   * the Worker's App only when a new version says otherwise. Absent when it declared none.
   */
  apps?: { worker: string };
  /**
   * The components it was installed for, when it was offered rather than asked for (`offers.ts`):
   * it leaves with the last of them, when nothing else uses it.
   */
  installedFor?: string[];
}

/**
 * The dashboard (SPEC §5), when the project has a UI (`pikit new --ui`, `pikit ui on`): the files the
 * registry's `dashboard/files/` wrote in `src/dashboard/`, recorded and kept as bases like a component's,
 * so `pikit upgrade` merges the registry's changes with the user's edits (P6).
 */
export interface InstalledDashboard {
  /** A key of `registries`. */
  registry: string;
  /** The registry's Git commit when it was written; `-dirty` when it had uncommitted changes. */
  commit?: string;
  /** Project-relative path → its hash as written. */
  files: Record<string, { hash: string }>;
  /** The components `pikit ui on` installed for it (`admin-api`, …): `pikit ui off` removes them. */
  components: string[];
}

export interface ProjectManifest {
  /** Schema version of `pikit.json`. */
  version: 1;
  /**
   * The kit in `vendor/`: the commit of the pikit checkout it was packed from (`vendor.ts`, `kitCommit`),
   * `-dirty` when its packages had uncommitted changes. Absent when unknown: made by a CLI not in Git.
   */
  kit?: { commit: string };
  targets: string[];
  /** Name → location: `builtin`, a path inside the project (`./…`), or an absolute path (`registry-location.ts`). */
  registries: Record<string, string>;
  components: Record<string, InstalledComponent>;
  /** The dashboard's files; absent in a project without a UI. */
  dashboard?: InstalledDashboard;
}

/** A new project's targets unless `pikit new --target` says otherwise. */
export const NEW_PROJECT_TARGETS: readonly string[] = ["server"];

/**
 * A new project's manifest; `registry` is a recorded location (`recordedLocation`), `kit` the vendored
 * kit's commit, `targets` where it runs (`pikit new --target`).
 */
export function emptyManifest(registry: string = BUILTIN_REGISTRY, kit?: string, targets: readonly string[] = NEW_PROJECT_TARGETS): ProjectManifest {
  return { version: 1, ...(kit !== undefined && { kit: { commit: kit } }), targets: [...targets], registries: { default: registry }, components: {} };
}

export function readProjectManifest(projectDir: string): ProjectManifest {
  const path = confinedPath(projectDir, PIKIT_JSON);
  if (!existsSync(path)) {
    throw new Error(`${projectDir} is not a pikit project: there is no ${PIKIT_JSON} (create one with \`pikit new\`)`);
  }
  const read = JSON.parse(readFileSync(path, "utf8")) as ProjectManifest;
  if (read.version !== 1) throw new Error(`${PIKIT_JSON} has version ${String((read as { version: unknown }).version)}; this CLI reads version 1`);
  return read;
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
  const dashboard = manifest.dashboard === undefined ? undefined : { ...manifest.dashboard, files: sortedFiles(manifest.dashboard.files) };
  const text = JSON.stringify({ version, ...(kit !== undefined && { kit }), targets, registries, components, ...(dashboard !== undefined && { dashboard }) }, null, 2);
  writeFileSync(confinedPath(projectDir, PIKIT_JSON), `${text}\n`);
}

function sortedFiles(files: Record<string, { hash: string }>): Record<string, { hash: string }> {
  return Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file] as { hash: string }]));
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
export function modifiedFiles(projectDir: string, component: Pick<InstalledComponent, "files" | "generated">): string[] {
  const generated = new Set(component.generated ?? []);
  return Object.entries(component.files)
    .filter(([file, { hash }]) => {
      const path = confinedPath(projectDir, file);
      return !generated.has(file) && existsSync(path) && hashFile(path) !== hash;
    })
    .map(([file]) => file);
}

/** The packages `remove` may take out of package.json for an installed component: those `add` put there for it. */
export function ownedDependencies(component: InstalledComponent): { dependencies: string[]; devDependencies: string[] } {
  return { dependencies: component.addedDependencies, devDependencies: component.addedDevDependencies ?? [] };
}

/** Installed files that are gone. */
export function missingFiles(projectDir: string, component: InstalledComponent): string[] {
  return Object.keys(component.files).filter((file) => !existsSync(confinedPath(projectDir, file)));
}
