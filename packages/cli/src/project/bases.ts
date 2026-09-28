/**
 * The bases: every file a component installed, as it was installed, kept in the project (SPEC §10.3).
 *
 * M3's three-way `upgrade` needs the file as it was installed. The registry may not give it back: its
 * commit is `-dirty` when it had uncommitted changes, it may not be in Git, or its path may be gone. So
 * `add` stores each file it writes under `pikit-bases/`, named by the hash `pikit.json` records for it
 * (`sha256:<hex>` → `pikit-bases/<hex>`), and `remove` deletes those no installed component names.
 *
 * - Content-addressed: two components (or two versions) with the same file share one base.
 * - No extension: `tsc`, `bun test` and `doctor`'s source scan never read a base as the project's code.
 * - Committed with the project, so outside `.pikit/`, which is ignored (it holds credentials).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectManifest } from "./pikit-json.ts";

export const BASES_DIR = "pikit-bases";

/** The project-relative path of the base of a file with this hash (`sha256:<hex>`). */
export function basePath(hash: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(hash)?.[1];
  if (hex === undefined) throw new Error(`"${hash}" is not a sha256 hash`);
  return `${BASES_DIR}/${hex}`;
}

/** The bases in the project that no installed component names: project-relative paths. */
export function unreferencedBases(projectDir: string, project: ProjectManifest): string[] {
  const dir = join(projectDir, BASES_DIR);
  if (!existsSync(dir)) return [];
  const hashes = Object.values(project.components).flatMap((c) => Object.values(c.files).map(({ hash }) => hash));
  const named = new Set(hashes.map((hash) => `${BASES_DIR}/${hash.slice("sha256:".length)}`));
  return readdirSync(dir)
    .map((file) => `${BASES_DIR}/${file}`)
    .filter((base) => !named.has(base))
    .sort();
}
