/** Declarative file operations stay below their root, even through existing filesystem ancestors. */
import { lstatSync, realpathSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";

/** Portable project/component-relative path: normalize both separators, never a drive or root. */
export function isInside(file: string): boolean {
  if (file === "" || file.includes("\0") || /^[a-z]:/i.test(file) || win32.isAbsolute(file)) return false;
  const path = posix.normalize(file.replaceAll("\\", "/"));
  return path !== "." && !posix.isAbsolute(path) && !path.split("/").includes("..");
}

/**
 * Roots may themselves be symlinked (e.g. macOS /tmp). Below the root, reject symlinks rather
 * than follow aliases: even an internal alias could overwrite a protected project record.
 * Missing descendants are fine for new files. This is not a sandbox for trusted setup code,
 * nor protection against another process replacing an ancestor between the check and the write.
 */
export function confinedPath(root: string, file: string): string {
  if (!isInside(file)) throw new Error(`the path "${file}" leaves ${root}`);
  const base = realpathSync(root);
  const relative = posix.normalize(file.replaceAll("\\", "/"));
  let path = base;
  for (const part of relative.split("/")) {
    path = join(path, part);
    let linked: boolean;
    try {
      linked = lstatSync(path).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (linked) throw new Error(`the path "${file}" contains a symlink (${path}); declarative file operations do not follow symlinks below ${root}`);
  }
  return resolve(base, relative);
}
