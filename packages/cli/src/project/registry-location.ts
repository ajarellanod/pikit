/**
 * Where `pikit.json`'s registries are (SPEC §10.3). A project is committed and cloned elsewhere, so a
 * registry is recorded by what works on any machine, and resolved here, at run time:
 *
 * - `"builtin"`: the registry of the pikit checkout the running CLI comes from (`DEFAULT_REGISTRY`);
 * - `"./<path>"`: a registry inside the project, relative to it;
 * - an absolute path: a registry elsewhere on this machine. It works only here: `add` says so.
 *
 * Git and HTTP registries come with M3's `upgrade` (SPEC §10.3).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * A `pikit.json` version 1 location (always an absolute path, SPEC §10.3) that names the registry of a
 * pikit checkout, which version 2 records as `builtin`. Version 1 recorded the checkout the CLI ran
 * from, so the path is often of another machine: it is the running CLI's registry, the `registry/` of
 * any pikit checkout that still exists (its `packages/cli` is `@pikit/cli`), or, gone or not, the
 * installer's checkout (`…/.pikit/pikit/registry`).
 */
export function isCheckoutRegistry(location: string): boolean {
  if (!isAbsolute(location)) return false;
  const path = resolve(location);
  if (samePath(path, DEFAULT_REGISTRY)) return true;
  if (path.split("\\").join("/").endsWith("/.pikit/pikit/registry")) return true;
  if (basename(path) !== "registry" || !existsSync(join(path, "registry.json"))) return false;
  const cli = join(dirname(path), "packages", "cli", "package.json");
  try {
    return (JSON.parse(readFileSync(cli, "utf8")) as { name?: unknown }).name === "@pikit/cli";
  } catch {
    return false;
  }
}

/** The same directory, through symlinks (macOS's `/var` is `/private/var`). */
function samePath(a: string, b: string): boolean {
  return real(a) === real(b);
}

function real(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}
