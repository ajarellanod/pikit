/**
 * The workspace's git, as the steward proposes a change on every target (SPEC §6, extension-pikit-self):
 * `git clone <remote> project`, `cd project && git checkout -b pikit/self/<topic>`, the change,
 * `git add`, `git commit -m`, `git push origin pikit/self/<topic>`. Run through the shell of an
 * `execution` environment against a remote it can push to, it checks that `git` there behaves as real
 * git for that subset, so pikit-self's instructions hold whichever `execution` provider is installed:
 *
 * - `clone` gives the remote's `main`; `checkout -b` makes a branch at HEAD and switches to it;
 * - `status` and `diff` show the changes; `add` stages only what it is given (`diff --staged`);
 * - `commit -m` commits only what is staged (an edit not added stays unstaged); `log` shows it;
 * - `push origin <branch>` puts the branch on the remote, at that commit;
 * - a command outside the subset fails with a non-zero exit, naming it (there is no `git pr`).
 *
 * Only the subset is checked, and only its meaning, not its output's layout: real git (execution-local)
 * supports more, execution-do's git exactly this. With `credential`, one more case (every durable
 * provider's rule, SPEC §4.1): the remote's credential, used by clone and push, appears nowhere the
 * agent can read: the variables (`env`, `printenv`), the flow's outputs, any file of the workspace
 * (`.git/config` included).
 *
 *   for (const c of createWorkspaceGitConformance((files) => myFixture(files)))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ConformanceCase } from "@pikit/core/testing";

/** An environment and a remote, built for one case. */
export interface WorkspaceGitFixture {
  /** Files and shell (`execution.shell`); its `cwd` is an empty directory. */
  env: ExecutionEnv;
  /** What `git clone` is given (`proposals.remote()`'s path or URL); its `main` holds the suite's files (and maybe more). */
  remote: string;
  /** The commit `branch` points to on the remote; `undefined` when it has no such branch. */
  head(branch: string): Promise<string | undefined>;
  /** Release what the fixture holds. */
  dispose?(): Promise<void>;
}

export interface WorkspaceGitConformanceOptions {
  /**
   * The credential the remote needs, which the agent must never read (a durable target: `github`'s
   * token). Given, a case checks that it appears nowhere the agent can read.
   */
  credential?: string;
}

const GROUP = "workspace git";
const ctx = BACKGROUND_CONTEXT;
const BRANCH = "pikit/self/conformance";
/** What the remote's `main` holds. */
export const WORKSPACE_GIT_FILES: Readonly<Record<string, string>> = {
  "README.md": "# The project\n",
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 2;\n",
};

interface Run {
  exitCode: number;
  output: string;
}

/** A fixture's shell, recording every output. */
class Workspace {
  readonly outputs: string[] = [];
  constructor(readonly fixture: WorkspaceGitFixture) {}

  async run(command: string, cwd?: string): Promise<Run> {
    let output = "";
    const result = await this.fixture.env.exec(command, { ...(cwd !== undefined && { cwd }), onOutput: (text) => void (output += text) }, ctx);
    if (!result.ok) throw new Error(`${GROUP}: exec("${command}") failed: ${result.error.code} ${result.error.message}`);
    this.outputs.push(output);
    return { exitCode: result.value.exitCode, output };
  }

  /** Runs `command` in the clone, failing the case unless it succeeds. */
  async ok(command: string, cwd = "project"): Promise<string> {
    const run = await this.run(command, cwd);
    if (run.exitCode !== 0) throw new Error(`${GROUP}: \`${command}\` exited ${run.exitCode}: ${run.output}`);
    return run.output;
  }

  async write(path: string, text: string): Promise<void> {
    const result = await this.fixture.env.writeFile(`project/${path}`, text, ctx);
    if (!result.ok) throw new Error(`${GROUP}: writing ${path} failed: ${result.error.message}`);
  }

  async read(path: string): Promise<string> {
    const result = await this.fixture.env.readTextFile(`project/${path}`, ctx);
    if (!result.ok) throw new Error(`${GROUP}: reading ${path} failed: ${result.error.message}`);
    return result.value;
  }

  /** The commit HEAD is at, as `git log -n 1` names it (an abbreviation or the whole id). */
  async logged(): Promise<string> {
    const id = /\b[0-9a-f]{7,40}\b/.exec(await this.ok("git log -n 1"))?.[0];
    if (id === undefined) throw new Error(`${GROUP}: git log -n 1 named no commit`);
    return id;
  }

  /** The clone, on the branch: the first two steps. */
  async cloned(): Promise<void> {
    await this.ok(`git clone ${this.fixture.remote} project`, ".");
    await this.ok(`cd project && git checkout -b ${BRANCH}`, ".");
  }
}

export function createWorkspaceGitConformance(
  factory: (files: Readonly<Record<string, string>>) => WorkspaceGitFixture | Promise<WorkspaceGitFixture>,
  options: WorkspaceGitConformanceOptions = {},
): readonly ConformanceCase[] {
  const gitCase = (name: string, run: (workspace: Workspace) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    async run() {
      const fixture = await factory(WORKSPACE_GIT_FILES);
      try {
        await run(new Workspace(fixture));
      } finally {
        await fixture.dispose?.();
      }
    },
  });

  /** Changes a and b, adds c (untracked), then stages a and c only. */
  const staged = async (workspace: Workspace) => {
    await workspace.write("src/a.ts", "export const a = 10;\n");
    await workspace.write("src/b.ts", "export const b = 20;\n");
    await workspace.write("src/c.ts", "export const c = 3;\n");
    await workspace.ok("git add src/a.ts src/c.ts");
  };

  const cases: ConformanceCase[] = [
    gitCase("git clone <remote> project gives the remote's main", async (workspace) => {
      await workspace.ok(`git clone ${workspace.fixture.remote} project`, ".");
      const main = await workspace.fixture.head("main");
      const logged = await workspace.logged();
      check(main?.startsWith(logged) === true, `the clone at the remote's main (${main}), not ${logged}`);
      same(await workspace.read("src/a.ts"), WORKSPACE_GIT_FILES["src/a.ts"], "a file of main");
      const status = await workspace.ok("git status");
      contains(status, "On branch main", "git status");
      contains(status, "nothing to commit, working tree clean", "git status");
    }),

    gitCase("git checkout -b makes the branch at HEAD and switches to it; the remote has none yet", async (workspace) => {
      await workspace.ok(`git clone ${workspace.fixture.remote} project`, ".");
      const before = await workspace.logged();
      await workspace.ok(`cd project && git checkout -b ${BRANCH}`, ".");
      contains(await workspace.ok("git status"), `On branch ${BRANCH}`, "git status");
      same(await workspace.logged(), before, "the branch's commit");
      same(await workspace.fixture.head(BRANCH), undefined, "the remote's branch before a push");
      const again = await workspace.run(`git checkout -b ${BRANCH}`, "project");
      check(again.exitCode !== 0, `a second git checkout -b ${BRANCH} to fail`);
    }),

    gitCase("git status and git diff show the changes; git add stages only what it is given", async (workspace) => {
      await workspace.cloned();
      await workspace.write("src/a.ts", "export const a = 10;\n");
      await workspace.write("src/b.ts", "export const b = 20;\n");
      await workspace.write("src/c.ts", "export const c = 3;\n");
      const status = await workspace.ok("git status");
      for (const file of ["src/a.ts", "src/b.ts", "src/c.ts"]) contains(status, file, "git status");
      not(status, "README.md", "git status");
      const diff = await workspace.ok("git diff");
      contains(diff, "+++ b/src/a.ts", "git diff");
      contains(diff, "+export const a = 10;", "git diff");
      contains(diff, "-export const a = 1;", "git diff");
      contains(diff, "+++ b/src/b.ts", "git diff");
      not(diff, "src/c.ts", "git diff (an untracked file)");
      same((await workspace.ok("git diff --staged")).trim(), "", "git diff --staged before git add");

      await workspace.ok("git add src/a.ts src/c.ts");
      const cached = await workspace.ok("git diff --staged");
      contains(cached, "+++ b/src/a.ts", "git diff --staged");
      contains(cached, "+export const c = 3;", "git diff --staged");
      not(cached, "src/b.ts", "git diff --staged (a change not added)");
      const unstaged = await workspace.ok("git diff");
      contains(unstaged, "+++ b/src/b.ts", "git diff after git add");
      not(unstaged, "src/a.ts", "git diff after git add");
    }),

    gitCase("git commit -m commits only what is staged: an edit not added stays unstaged; git log shows the commit", async (workspace) => {
      await workspace.cloned();
      const before = await workspace.logged();
      await staged(workspace);
      await workspace.write("notes.txt", "not added\n");
      await workspace.ok('git commit -m "Change a, add c"');
      const after = await workspace.logged();
      check(after !== before && !before.startsWith(after) && !after.startsWith(before), "a new commit at HEAD");
      contains(await workspace.ok("git log"), "Change a, add c", "git log");
      same((await workspace.ok("git diff --staged")).trim(), "", "git diff --staged after the commit");
      const diff = await workspace.ok("git diff");
      contains(diff, "+export const b = 20;", "git diff after the commit (b, not added)");
      not(diff, "src/a.ts", "git diff after the commit");
      const status = await workspace.ok("git status");
      contains(status, "src/b.ts", "git status after the commit");
      contains(status, "notes.txt", "git status after the commit (untracked)");
      not(status, "src/a.ts", "git status after the commit");
      not(status, "src/c.ts", "git status after the commit");

      // The steward's own step: everything, then a title and a description.
      await workspace.ok('git add -A && git commit -m "The rest" -m "b and the notes."');
      contains(await workspace.ok("git status"), "nothing to commit, working tree clean", "git status after git add -A and a commit");
      const log = await workspace.ok("git log");
      contains(log, "The rest", "git log");
      contains(log, "b and the notes.", "git log (the description)");
      contains(log, "Change a, add c", "git log (the earlier commit)");
    }),

    gitCase("git push origin pikit/self/<topic> puts the branch on the remote at the commit; main stays", async (workspace) => {
      await workspace.cloned();
      const main = await workspace.fixture.head("main");
      await staged(workspace);
      await workspace.ok('git commit -m "Change a, add c"');
      const committed = await workspace.logged();
      await workspace.ok(`git push origin ${BRANCH}`);
      const pushed = await workspace.fixture.head(BRANCH);
      check(pushed?.startsWith(committed) === true, `the remote's ${BRANCH} at ${committed}, not ${pushed}`);
      same(await workspace.fixture.head("main"), main, "the remote's main after the push");

      // Pushing again replaces it.
      await workspace.ok('git add -A && git commit -m "The rest"');
      const next = await workspace.logged();
      await workspace.ok(`git push origin ${BRANCH}`);
      check((await workspace.fixture.head(BRANCH))?.startsWith(next) === true, `the remote's ${BRANCH} at ${next} after a second push`);
    }),

    gitCase("a command outside the subset fails with a non-zero exit, naming it: there is no git pr", async (workspace) => {
      await workspace.cloned();
      const pr = await workspace.run(`git pr ${BRANCH} "A title"`, "project");
      check(pr.exitCode !== 0, "git pr to fail");
      contains(pr.output, "'pr'", "git pr's message");
    }),
  ];

  const credential = options.credential;
  if (credential !== undefined) {
    cases.push(
      gitCase("the remote's credential, used by clone and push, appears nowhere the agent can read", async (workspace) => {
        await workspace.cloned();
        await staged(workspace);
        await workspace.ok('git commit -m "Change a, add c"');
        await workspace.ok("git status && git diff && git log");
        await workspace.ok(`git push origin ${BRANCH}`);
        check((await workspace.fixture.head(BRANCH)) !== undefined, "the push to reach the remote (it needs the credential)");
        await workspace.ok("env", ".");
        await workspace.ok("printenv", ".");
        await workspace.run("set", ".");
        for (const [index, output] of workspace.outputs.entries()) check(!output.includes(credential), `the credential nowhere in the outputs (command ${index + 1})`);
        const files = await walk(workspace.fixture.env, workspace.fixture.env.cwd);
        check(files.some((file) => file.endsWith("/.git/config")), "the walk to read .git/config");
        for (const file of files) {
          const bytes = await workspace.fixture.env.readBinaryFile(file, ctx);
          if (!bytes.ok) throw new Error(`${GROUP}: reading ${file} failed: ${bytes.error.message}`);
          check(!new TextDecoder().decode(bytes.value).includes(credential), `the credential not in ${file}`);
        }
      }),
    );
  }
  return cases;
}

/** Every file under `dir`. */
async function walk(env: ExecutionEnv, dir: string): Promise<string[]> {
  const listed = await env.listDir(dir, ctx);
  if (!listed.ok) throw new Error(`${GROUP}: listing ${dir} failed: ${listed.error.message}`);
  const files: string[] = [];
  for (const entry of listed.value) {
    const path = `${dir}/${entry.name}`;
    if (entry.kind === "directory") files.push(...(await walk(env, path)));
    else if (entry.kind === "file") files.push(path);
  }
  return files;
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function contains(text: string, part: string, what: string): void {
  if (!text.includes(part)) throw new Error(`${GROUP}: ${what}: expected ${JSON.stringify(part)} in ${JSON.stringify(text)}`);
}

function not(text: string, part: string, what: string): void {
  if (text.includes(part)) throw new Error(`${GROUP}: ${what}: expected no ${JSON.stringify(part)} in ${JSON.stringify(text)}`);
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${GROUP}: expected ${what}`);
}
