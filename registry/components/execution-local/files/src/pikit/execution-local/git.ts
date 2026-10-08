/**
 * `git` for the agent's commands: isomorphic-git over this machine's files, run by the server, never
 * by the shell. It covers what an agent needs to change a repository and propose the change: `clone`,
 * `status`, `diff`, `add`, `commit`, `log`, `push`, and `pr` (a pull request, through GitHub's API).
 * The shell reaches it through a small `git` program on its `PATH` (`shim.ts`).
 *
 * The same command as execution-do's (Cloudflare), copied here over Node's `fs` (components share
 * contracts, never files). The fences are code, not a prompt:
 * - **Push only to allowed repositories, only to branches under the prefix** (`pikit/self/` by
 *   default), never to `main`. A pull request is opened from such a branch, for a person to review.
 * - **The token never reaches the shell.** It is read through `secrets` when a command needs it, and
 *   sent only to github.com: in the headers of git's requests, in `onAuth`, and to GitHub's API for
 *   `pr`. A push goes to the URL this code builds from the origin, never to a URL `.git/config` names
 *   some other way. No token means public clones only.
 * - **A failed clone leaves nothing** behind, and a 429 or 5xx from GitHub is retried twice.
 *
 * Unlike on Cloudflare, `.git` is not fenced: the shell runs as the server's user and may change any
 * file there. It changes nothing of the above: the remote is checked at each push.
 *
 * GitHub over HTTPS only (`https://github.com/<owner>/<repository>`). Clones are shallow (depth 1,
 * one branch).
 */

import * as fs from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

export interface GitOptions {
  /** The GitHub token, read at each command that needs it; `undefined` without one. */
  token(): Promise<string | undefined>;
  /** `owner/name`: the only repositories a push or a pull request may go to. */
  pushRepositories: readonly string[];
  /** What every pushed branch starts with. */
  branchPrefix: string;
  /** Who commits. */
  author?: { name: string; email: string };
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const AUTHOR = { name: "pikit agent", email: "agent@pikit.invalid" };
const USAGE = "usage: git clone <https://github.com/owner/repo> [dir] | status | diff [path] | add | commit -m <message> | log [-n N] | push origin <branch> | pr <branch> <title> [-b <body>]\n";
const decoder = new TextDecoder();

/** `owner` and `name` of a GitHub repository URL; `undefined` for anything else. */
export function githubRepository(url: string): { owner: string; name: string } | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] !== undefined && match[2] !== undefined ? { owner: match[1], name: match[2] } : undefined;
}

/** Whether `branch` starts with `prefix` and is a plain, safe branch name after it. */
export function branchAllowed(branch: string, prefix: string): boolean {
  if (!branch.startsWith(prefix)) return false;
  const rest = branch.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(rest) && !rest.includes("..") && !rest.includes("//") && !rest.endsWith("/") && !rest.endsWith(".lock");
}

/** The `git` command: `run(args, cwd)` answers as a process would, with output and an exit code. */
export function createGit(options: GitOptions) {
  const author = options.author ?? AUTHOR;
  const allowed = (repository: { owner: string; name: string }) =>
    options.pushRepositories.some((entry) => entry.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase());
  const ok = (stdout: string): CommandResult => ({ stdout: stdout === "" || stdout.endsWith("\n") ? stdout : `${stdout}\n`, stderr: "", exitCode: 0 });
  const fail = (message: string, exitCode = 1): CommandResult => ({ stdout: "", stderr: `${message}\n`, exitCode });
  /** Every request to github.com carries the token, when there is one (the key isomorphic-git's `onAuth` sets too). */
  const headersFor = (token: string | undefined) => (token === undefined ? {} : { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` });

  /** A real clone has its remote-tracking branch and a commit; a directory without them is half made. */
  const isClone = async (dir: string) => {
    try {
      return (await git.listBranches({ fs, dir, remote: "origin" })).length > 0 && (await git.log({ fs, dir, depth: 1 })).length > 0;
    } catch {
      return false;
    }
  };

  const originOf = async (dir: string) => {
    const url = (await git.getConfig({ fs, dir, path: "remote.origin.url" })) as string | undefined;
    const repository = url === undefined ? undefined : githubRepository(url);
    if (repository === undefined) throw new Error("this repository's origin is not a GitHub repository");
    return repository;
  };

  // statusMatrix rows: [file, HEAD (0 absent, 1 present), workdir (0 absent, 1 as HEAD, 2 changed), stage].
  const changes = async (dir: string) =>
    (await git.statusMatrix({ fs, dir }))
      .filter(([, head, work]) => !(head === 1 && work === 1) && !(head === 0 && work === 0))
      .map(([file, head, work]) => ({ file, kind: head === 0 ? ("new" as const) : work === 0 ? ("deleted" as const) : ("modified" as const) }));

  const repositoryAt = async (cwd: string) => {
    try {
      return await git.findRoot({ fs, filepath: cwd });
    } catch {
      return undefined;
    }
  };

  /** Runs `attempt`, again after a 429 or a 5xx from GitHub (twice, after 4 s then 8 s). */
  const retrying = async <T>(attempt: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> => {
    for (let round = 1; ; round++) {
      try {
        return await attempt();
      } catch (error) {
        await cleanup();
        const message = error instanceof Error ? error.message : String(error);
        if (round >= 3 || !/\b(429|5\d\d)\b/.test(message)) throw error;
        await new Promise((done) => setTimeout(done, round * 4_000));
      }
    }
  };

  async function clone(args: string[], cwd: string): Promise<CommandResult> {
    const [url, target] = args.filter((arg) => !arg.startsWith("-"));
    if (url === undefined) return fail(USAGE, 129);
    const repository = githubRepository(url);
    if (repository === undefined) return fail(`fatal: only GitHub repositories over HTTPS can be cloned here (https://github.com/<owner>/<repository>), not '${url}'`, 128);
    const dir = resolve(cwd, target ?? repository.name);
    const existing = await lstat(dir).catch(() => undefined);
    if (existing !== undefined && (!existing.isDirectory() || (await readdir(dir)).length > 0)) {
      return fail(`fatal: destination path '${target ?? repository.name}' already exists and is not an empty directory`, 128);
    }
    const token = await options.token();
    const onAuth = token !== undefined && allowed(repository) ? () => ({ username: "x-access-token", password: token }) : undefined;
    try {
      await retrying(
        () => git.clone({ fs, http, dir, url, depth: 1, singleBranch: true, headers: headersFor(token), ...(onAuth !== undefined && { onAuth }) }),
        // Never leave a half clone behind.
        () => rm(dir, { recursive: true, force: true }),
      );
    } catch (error) {
      return fail(`fatal: could not clone ${url}: ${error instanceof Error ? error.message : String(error)}`, 128);
    }
    const branch = await git.currentBranch({ fs, dir });
    const count = (await git.listFiles({ fs, dir })).length;
    const push = token !== undefined && allowed(repository) ? `you may push branches ${options.branchPrefix}… to it` : "read-only: pushing to it is not allowed here";
    return ok(`Cloned ${url} into ${dir} (branch ${branch}, ${count} files, latest commit only); ${push}.`);
  }

  async function status(dir: string): Promise<CommandResult> {
    const branch = await git.currentBranch({ fs, dir });
    const changed = await changes(dir);
    const marks = { new: "??", modified: " M", deleted: " D" };
    const lines = changed.map((change) => `${marks[change.kind]} ${change.file}`);
    return ok(`On branch ${branch}\n${lines.length === 0 ? "nothing to commit, working tree clean" : lines.join("\n")}`);
  }

  async function diff(dir: string, paths: string[]): Promise<CommandResult> {
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const patches: string[] = [];
    for (const change of await changes(dir)) {
      if (paths.length > 0 && !paths.some((path) => change.file === path || change.file.startsWith(`${path.replace(/\/$/, "")}/`))) continue;
      const before = change.kind === "new" ? new Uint8Array() : (await git.readBlob({ fs, dir, oid: head, filepath: change.file })).blob;
      const after = change.kind === "deleted" ? new Uint8Array() : new Uint8Array(await readFile(join(dir, change.file)));
      if (before.includes(0) || after.includes(0)) {
        patches.push(`Binary files a/${change.file} and b/${change.file} differ\n`);
        continue;
      }
      patches.push(createTwoFilesPatch(`a/${change.file}`, `b/${change.file}`, decoder.decode(before), decoder.decode(after), "", "", { context: 3 }));
    }
    return ok(patches.join(""));
  }

  async function commit(dir: string, args: string[]): Promise<CommandResult> {
    const messages: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-m" || arg === "-am" || arg === "--message") messages.push(args[++i] ?? "");
      else if (arg.startsWith("--message=")) messages.push(arg.slice("--message=".length));
    }
    if (messages.length === 0 || messages.every((message) => message.trim() === "")) return fail("error: git commit here needs a message: git commit -m <message>");
    const changed = await changes(dir);
    if (changed.length === 0) return ok("nothing to commit, working tree clean");
    // Every change is committed, as `git add -A && git commit` would.
    for (const change of changed) {
      if (change.kind === "deleted") await git.remove({ fs, dir, filepath: change.file });
      else await git.add({ fs, dir, filepath: change.file });
    }
    const oid = await git.commit({ fs, dir, message: messages.join("\n\n"), author });
    const branch = await git.currentBranch({ fs, dir });
    return ok(`[${branch} ${oid.slice(0, 7)}] ${messages[0]}\n ${changed.length} file(s) changed: ${changed.map((change) => change.file).join(", ")}`);
  }

  async function log(dir: string, args: string[]): Promise<CommandResult> {
    let count = 10;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-n") count = Number(args[++i]);
      else if (/^-\d+$/.test(arg)) count = Number(arg.slice(1));
      else if (arg.startsWith("--max-count=")) count = Number(arg.slice("--max-count=".length));
    }
    const entries = await git.log({ fs, dir, depth: Math.min(Math.max(Number.isFinite(count) ? count : 10, 1), 100) });
    return ok(entries.map((entry) => `${entry.oid.slice(0, 7)} ${entry.commit.message.split("\n")[0]} (${entry.commit.author.name})`).join("\n"));
  }

  async function push(dir: string, args: string[]): Promise<CommandResult> {
    const branch = args.filter((arg) => !arg.startsWith("-") && arg !== "origin")[0];
    if (branch === undefined) return fail(`usage: git push origin ${options.branchPrefix}<topic>`);
    if (!branchAllowed(branch, options.branchPrefix)) {
      return fail(`fatal: pushing is allowed only to new branches ${options.branchPrefix}<topic> (letters, digits, . _ / -), not '${branch}'`);
    }
    if (!(await isClone(dir))) return fail(`fatal: ${dir} is not a complete clone: clone it again`);
    const origin = await originOf(dir);
    if (!allowed(origin)) return fail(`fatal: pushing to ${origin.owner}/${origin.name} is not allowed here`);
    const token = await options.token();
    if (token === undefined) return fail("fatal: there is no GitHub token here, so nothing can be pushed");
    await git.branch({ fs, dir, ref: branch, force: true });
    const result = await git.push({
      fs,
      http,
      dir,
      // Built here from the checked origin: never a URL `.git/config` could redirect.
      url: `https://github.com/${origin.owner}/${origin.name}.git`,
      ref: branch,
      remoteRef: branch,
      // The agent's own branches: it may rewrite them.
      force: true,
      headers: headersFor(token),
      onAuth: () => ({ username: "x-access-token", password: token }),
    });
    if (!result.ok) return fail(`fatal: the push was rejected: ${result.error ?? JSON.stringify(result.refs)}`);
    return ok(`To https://github.com/${origin.owner}/${origin.name}\n * ${branch} -> ${branch}\nCompare: https://github.com/${origin.owner}/${origin.name}/compare/${branch}?expand=1`);
  }

  async function pullRequest(dir: string, args: string[]): Promise<CommandResult> {
    let body = "";
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-b" || args[i] === "--body") body = args[++i] ?? "";
      else positional.push(args[i] ?? "");
    }
    const [branch, ...title] = positional;
    if (branch === undefined || title.length === 0) return fail(`usage: git pr ${options.branchPrefix}<topic> <title> [-b <body>]`);
    if (!branchAllowed(branch, options.branchPrefix)) return fail(`fatal: pull requests are opened only from branches ${options.branchPrefix}<topic>`);
    const origin = await originOf(dir);
    if (!allowed(origin)) return fail(`fatal: opening pull requests on ${origin.owner}/${origin.name} is not allowed here`);
    const token = await options.token();
    if (token === undefined) return fail("fatal: there is no GitHub token here, so no pull request can be opened");
    const api = `https://api.github.com/repos/${origin.owner}/${origin.name}`;
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "pikit-execution-local" };
    const repository = (await (await fetch(api, { headers })).json()) as { default_branch?: string };
    const response = await fetch(`${api}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: title.join(" "), body, head: branch, base: repository.default_branch ?? "main" }),
    });
    const answer = (await response.json()) as { html_url?: string; message?: string };
    if (!response.ok) return fail(`fatal: GitHub answered ${response.status}: ${answer.message ?? ""}`);
    return ok(`Pull request opened: ${answer.html_url}`);
  }

  return {
    /** Runs `git <args>` in `cwd` (absolute). */
    async run(args: string[], cwd: string): Promise<CommandResult> {
      const [command, ...rest] = args;
      try {
        if (command === undefined || command === "help" || command === "--help") return ok(USAGE);
        if (command === "clone") return await clone(rest, cwd);
        if (!["status", "diff", "add", "commit", "log", "push", "pr"].includes(command)) {
          return fail(`git: '${command}' is not supported here.\n${USAGE}`);
        }
        const dir = await repositoryAt(cwd);
        if (dir === undefined) return fail("fatal: not a git repository (or any of the parent directories): .git", 128);
        switch (command) {
          case "status":
            return await status(dir);
          case "diff":
            return await diff(dir, rest.filter((arg) => !arg.startsWith("-")));
          case "add":
            // `commit` takes every change: nothing to stage by hand.
            return ok("");
          case "commit":
            return await commit(dir, rest);
          case "log":
            return await log(dir, rest);
          case "push":
            return await push(dir, rest);
          default:
            return await pullRequest(dir, rest);
        }
      } catch (error) {
        return fail(`git ${command}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export type Git = ReturnType<typeof createGit>;
