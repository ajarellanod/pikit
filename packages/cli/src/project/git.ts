/**
 * What the CLI asks Git: the commit a directory is at, and whether one commit comes before another.
 * Both answer "unknown" (undefined) rather than fail: a registry or a checkout need not be in Git.
 */

/** HEAD of the repository `dir` is in, `-dirty` when `paths` (relative to `dir`) have uncommitted changes. */
export function gitCommit(dir: string, paths: readonly string[] = ["."]): string | undefined {
  const head = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (head.exitCode !== 0) return undefined;
  const status = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--", ...paths], { stdout: "pipe", stderr: "ignore" });
  const dirty = status.stdout.toString().trim() !== "";
  return `${head.stdout.toString().trim()}${dirty ? "-dirty" : ""}`;
}

/**
 * Whether `ancestor` is `descendant` or comes before it, in the repository `dir` is in. Undefined when
 * that repository does not have one of them (a commit it never fetched) or is not a repository.
 */
export function isAncestor(dir: string, ancestor: string, descendant: string): boolean | undefined {
  const known = (commit: string) =>
    /^[0-9a-f]{7,64}$/.test(commit) && Bun.spawnSync(["git", "-C", dir, "cat-file", "-e", `${commit}^{commit}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (!known(ancestor) || !known(descendant)) return undefined;
  const check = Bun.spawnSync(["git", "-C", dir, "merge-base", "--is-ancestor", ancestor, descendant], { stdout: "ignore", stderr: "ignore" });
  return check.exitCode === 0 ? true : check.exitCode === 1 ? false : undefined;
}
