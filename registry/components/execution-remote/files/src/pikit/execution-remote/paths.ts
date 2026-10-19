/**
 * Paths in a sandbox, POSIX, computed here as Node's `path.posix` and pi-durable's `NodeExecutionEnv`
 * do, so a relative path, `~`, `~/x` and `file://` URLs mean what they mean on the host without a
 * request: every path the protocol carries is absolute.
 */

function segments(path: string, allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out.at(-1) !== "..") out.pop();
      else if (allowAboveRoot) out.push("..");
      continue;
    }
    out.push(part);
  }
  return out;
}

/** `path.posix.normalize`. */
export function normalize(path: string): string {
  if (path === "") return ".";
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/");
  const joined = segments(path, !absolute).join("/");
  if (joined === "") return absolute ? "/" : trailing ? "./" : ".";
  return `${absolute ? "/" : ""}${joined}${trailing ? "/" : ""}`;
}

/** `path.posix.join`: relative parts stay relative. */
export function join(parts: readonly string[]): string {
  const joined = parts.filter((part) => part !== "").join("/");
  return joined === "" ? "." : normalize(joined);
}

/** `path` resolved against `cwd` (absolute) as `NodeExecutionEnv` does: `~` is `home`, a `file://` URL its path. Always absolute, no trailing `/`. */
export function resolvePath(cwd: string, home: string, path: string): string {
  let target = path;
  if (target === "~") target = home;
  else if (target.startsWith("~/")) target = `${home}/${target.slice(2)}`;
  else if (target.startsWith("file://")) {
    try {
      target = decodeURIComponent(new URL(target).pathname);
    } catch {
      // A malformed URL stays an ordinary path, as on the host.
    }
  }
  return `/${segments(target.startsWith("/") ? target : `${cwd}/${target}`, false).join("/")}`;
}
