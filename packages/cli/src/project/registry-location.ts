/**
 * Where `pikit.json`'s registries are. A project is committed and cloned elsewhere, so a
 * registry is recorded by what works on any machine, and resolved here, at run time:
 *
 * - `"builtin"`: the registry of the pikit checkout the running CLI comes from (`DEFAULT_REGISTRY`);
 * - `"./<path>"`: a registry inside the project, relative to it;
 * - an absolute path: a registry elsewhere on this machine. It works only here: `add` says so.
 *
 * Git and HTTP registries are a feature (`features/open-registries.md`).
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";

export const BUILTIN_REGISTRY = "builtin";

/** The absolute path of a recorded location, on this machine. */
export function registryPath(projectDir: string, location: string): string {
  return location === BUILTIN_REGISTRY ? DEFAULT_REGISTRY : resolve(projectDir, location);
}

/** How the project records the registry at `root`: `builtin`, relative when inside the project, else as given. */
export function recordedLocation(projectDir: string, root: string): string {
  if (samePath(root, DEFAULT_REGISTRY)) return BUILTIN_REGISTRY;
  // As given, then through symlinks: a path that is gone has no real path.
  for (const [project, registry] of [[resolve(projectDir), resolve(root)], [real(projectDir), real(root)]] as const) {
    const inside = relative(project, registry).split("\\").join("/");
    if (inside !== "" && inside.split("/")[0] !== ".." && !isAbsolute(inside)) return `./${inside}`;
  }
  return root;
}

/** A location that resolves on another machine: `builtin`, or a path inside the project. */
export function isPortable(location: string): boolean {
  return location === BUILTIN_REGISTRY || !isAbsolute(location);
}

/** The same directory, through symlinks (macOS's `/var` is `/private/var`). */
function samePath(a: string, b: string): boolean {
  return real(a) === real(b);
}

function real(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}
