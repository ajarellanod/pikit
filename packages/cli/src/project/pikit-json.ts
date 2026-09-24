/**
 * `pikit.json`, the project manifest (SPEC §10.3): which components are installed, from which
 * registry, at which version and commit, and the hash of every file each one wrote.
 *
 * It is the install record, so it keeps what `pikit remove` and `pikit doctor` need later without
 * the registry at hand: the npm dependencies and environment variables the component declared when
 * it was installed. Whether a file is modified is not stored: it is computed by comparing its hash,
 * so it can never go stale.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentVariable } from "../registry/manifest.ts";

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
  /** Its manifest's `environment`. */
  environment: EnvironmentVariable[];
}

export interface ProjectManifest {
  /** Schema version of `pikit.json` (SPEC §12a). */
  version: 1;
  targets: string[];
  /** Name → location. M1 reads local paths only. */
  registries: Record<string, string>;
  components: Record<string, InstalledComponent>;
}

export function emptyManifest(registry: string): ProjectManifest {
  return { version: 1, targets: ["server"], registries: { default: registry }, components: {} };
}

export function readProjectManifest(projectDir: string): ProjectManifest {
  const path = join(projectDir, PIKIT_JSON);
  if (!existsSync(path)) {
    throw new Error(`${projectDir} is not a pikit project: there is no ${PIKIT_JSON} (create one with \`pikit new\`)`);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ProjectManifest;
  if (manifest.version !== 1) throw new Error(`${PIKIT_JSON} has version ${String(manifest.version)}; this CLI reads version 1`);
  return manifest;
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
  writeFileSync(join(projectDir, PIKIT_JSON), `${JSON.stringify({ ...manifest, components }, null, 2)}\n`);
}

export function hashOf(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function hashFile(path: string): string {
  return hashOf(readFileSync(path));
}

/** Installed files whose content no longer has the hash recorded at install (the user's edits). */
export function modifiedFiles(projectDir: string, component: InstalledComponent): string[] {
  return Object.entries(component.files)
    .filter(([file, { hash }]) => existsSync(join(projectDir, file)) && hashFile(join(projectDir, file)) !== hash)
    .map(([file]) => file);
}

/** Installed files that are gone. */
export function missingFiles(projectDir: string, component: InstalledComponent): string[] {
  return Object.keys(component.files).filter((file) => !existsSync(join(projectDir, file)));
}
