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

/** What `initRepository` did: made the repository and its first commit, or why not. */
export type RepositoryInit = { made: true; commit: string } | { made: false; why: string };

/** `git <args>` in `dir`, awaited (never `spawnSync`: a long child can hang Bun's). */
async function git(dir: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  try {
    const child = Bun.spawn(["git", ...args], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, out: out.trim() };
  } catch {
    return { code: -1, out: "" };
  }
}

/**
 * Makes `dir` a git repository on `main` with everything in it committed (its `.gitignore` leaves out
 * `.env`, `.pikit/` and `node_modules`): on a server, the project's main branch is where
 * self-improvement's deployer merges approved proposals. A committer is set in the repository's own
 * config when git has none. Not done, and said why, without git, or inside another repository.
 */
export async function initRepository(dir: string, message: string): Promise<RepositoryInit> {
  if ((await git(dir, ["--version"])).code !== 0) return { made: false, why: "git is not installed" };
  if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])).code === 0) return { made: false, why: "the directory is inside another git repository" };
  const steps: string[][] = [["init", "--quiet"], ["symbolic-ref", "HEAD", "refs/heads/main"]];
  for (const step of steps) if ((await git(dir, step)).code !== 0) return { made: false, why: `\`git ${step.join(" ")}\` failed` };
  if ((await git(dir, ["config", "user.email"])).out === "") {
    await git(dir, ["config", "user.name", "pikit"]);
    await git(dir, ["config", "user.email", "pikit@localhost"]);
  }
  for (const step of [["add", "--all"], ["commit", "--quiet", "--no-verify", "-m", message]]) {
    if ((await git(dir, step)).code !== 0) return { made: false, why: `\`git ${step[0]}\` failed` };
  }
  return { made: true, commit: (await git(dir, ["rev-parse", "HEAD"])).out };
}
