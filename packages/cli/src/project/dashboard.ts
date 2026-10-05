/**
 * The dashboard's files (SPEC §5): a registry's `dashboard/files/` (the kit's is
 * `registry/dashboard/files/`), written to a project's `src/dashboard/`. A project has a UI when it has
 * them; `pikit.json`'s `dashboard` records each one's hash, and `pikit-bases/` keeps each one as
 * written, as for a component's files (`bases.ts`), so `pikit upgrade` merges the registry's changes
 * with the user's edits (P6).
 *
 * What the dashboard's own toolchain makes (`node_modules/`, `dist/`) is never recorded, compared or
 * shipped.
 */

import { existsSync, readdirSync } from "node:fs";
import { hashFile, type InstalledDashboard } from "./pikit-json.ts";
import { confinedPath } from "./paths.ts";
import type { Registry } from "./registry-source.ts";

/** Where a project's dashboard lives. */
export const DASHBOARD_DIR = "src/dashboard";
/** Where a registry keeps it, from its root. */
export const DASHBOARD_SOURCE = "dashboard/files";
/** The dashboard's built files, which `admin-api` serves (its `assets` default). */
export const DASHBOARD_DIST = `${DASHBOARD_DIR}/dist`;
/** Made by its toolchain, never the dashboard's source. */
const BUILT = new Set(["node_modules", "dist"]);

/** What the registry ships: project-relative target → absolute source; `undefined` when it has no dashboard. */
export function dashboardFiles(registry: Registry): Map<string, string> | undefined {
  const root = confinedPath(registry.root, DASHBOARD_SOURCE);
  if (!existsSync(root)) return undefined;
  return new Map(listSource(root).map((file) => [`${DASHBOARD_DIR}/${file}`, confinedPath(root, file)]));
}

/** The files under `dir`, relative, but what its toolchain makes. `strict`: anything else than files and folders is refused (a registry's). */
function listSource(dir: string, strict = true, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(prefix === "" ? dir : confinedPath(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (prefix === "" && BUILT.has(entry.name)) continue;
      files.push(...listSource(dir, strict, relative));
    } else if (entry.isFile()) files.push(relative);
    else if (strict) throw new Error(`the dashboard's ${relative} is not a regular file or directory`);
  }
  return files.sort();
}

/** The record of `files` (target → source) written from `registry`. */
export function recordDashboard(registry: Registry, registryName: string, files: ReadonlyMap<string, string>, components: readonly string[]): InstalledDashboard {
  const hashes: Record<string, { hash: string }> = {};
  for (const [target, source] of files) hashes[target] = { hash: hashFile(source) };
  return { registry: registryName, ...(registry.commit !== undefined && { commit: registry.commit }), files: hashes, components: [...components] };
}

/** Files in `src/dashboard/` the record does not name, but what its toolchain makes: the user's own. */
export function unrecordedDashboardFiles(projectDir: string, dashboard: InstalledDashboard | undefined): string[] {
  const dir = confinedPath(projectDir, DASHBOARD_DIR);
  if (!existsSync(dir)) return [];
  const recorded = new Set(Object.keys(dashboard?.files ?? {}));
  return listSource(dir, false)
    .map((file) => `${DASHBOARD_DIR}/${file}`)
    .filter((file) => !recorded.has(file));
}
