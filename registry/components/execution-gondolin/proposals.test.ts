/**
 * Self-improvement on a server with the agent's shell in a VM: proposals-local and execution-gondolin
 * in one App, over real Gondolin VMs (QEMU). Skipped, saying so, where QEMU is not installed.
 *
 * - The steward's git flow (`createWorkspaceGitConformance`) in a conversation's VM, against
 *   proposals-local's repository as the steward is told to reach it (`file://<path>`): `git` is in the
 *   image (`packages`, added because `proposals` is installed), and the guest's requests reach the
 *   repository only through `serve`, answered in the host.
 * - The lock: the guest cannot move the main branch, delete a proposal, or see the repository or the
 *   operator's decisions; what it pushes under the prefix is a proposal the operator approves.
 *
 * A repository test, not copied with the component: it composes another component's files. The image
 * with git is made once (a VM that reaches only the Alpine mirror), into a root shared by the cases.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proposals } from "@pikit/contracts";
import { type App, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT } from "@pikit/pi-adapter/execution";
import { createWorkspaceGitConformance } from "@pikit/pi-adapter/execution/testing";
import git from "isomorphic-git";
import proposalsLocal from "../proposals-local/files/src/pikit/proposals-local/index.ts";
import { makeRepository } from "../proposals-local/files/src/pikit/proposals-local/repository.test-support.ts";
import executionGondolin from "./files/src/pikit/execution-gondolin/index.ts";
import { qemuProblem } from "./files/src/pikit/execution-gondolin/qemu.ts";

const ctx = BACKGROUND_CONTEXT;
const problem = qemuProblem();
/** Long enough for a first boot's image download and the image with git. */
const BOOT_MS = 600_000;

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
const temporaryDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-gondolin-proposals-")));
  directories.push(dir);
  return dir;
};
/** One sandbox root for every case: the image with git is made once. */
const root = join(temporaryDir(), "gondolin");
let conversations = 0;

interface Running {
  app: App;
  proposals: Proposals;
  /** proposals-local's directory: the repository, the decisions. */
  directory: string;
  gitdir: string;
  env: ExecutionEnv;
}

/** proposals-local over a new repository whose main holds `files`, and execution-gondolin; a new conversation's environment. */
async function start(files: Readonly<Record<string, string>>): Promise<Running> {
  const directory = join(temporaryDir(), "self");
  const gitdir = join(directory, "project.git");
  await makeRepository(gitdir, { ...files });
  let found: { workspace: WorkspaceProvider; proposals: Proposals } | undefined;
  const reader = defineComponent({
    name: "reader",
    setup(pikit) {
      const workspace: Handle<WorkspaceProvider> = pikit.use("workspace");
      const proposals = pikit.use("proposals");
      return { start: () => void (found = { workspace: workspace.get(), proposals: proposals.get() }) };
    },
  });
  const app = await defineApp({
    components: [proposalsLocal, executionGondolin, reader],
    config: { "proposals-local": { directory }, "execution-gondolin": { root, idleSeconds: 30 } },
    logger: silentLogger,
  }).create();
  await app.start();
  if (found === undefined) throw new Error("not resolved");
  const id = `steward-${++conversations}`;
  const { env } = await found.workspace.resolve({ key: `test:${id}`, agent: "steward", conversationId: id }, app.context());
  return { app, proposals: found.proposals, directory, gitdir, env };
}

async function sh(env: ExecutionEnv, command: string): Promise<{ exitCode: number; output: string }> {
  let output = "";
  const result = await env.exec(command, { onOutput: (text) => void (output += text) }, ctx);
  if (!result.ok) throw new Error(`exec failed: ${result.error.code} ${result.error.message}`);
  return { exitCode: result.value.exitCode, output };
}

if (problem !== undefined) test.skip(`proposals in a VM: skipped, ${problem}`, () => {});

for (const c of problem === undefined
  ? createWorkspaceGitConformance(async (files) => {
      const running = await start(files);
      return {
        env: running.env,
        remote: `file://${running.gitdir}`,
        head: (branch) => git.resolveRef({ fs, gitdir: running.gitdir, ref: `refs/heads/${branch}` }).catch(() => undefined),
        dispose: () => running.app.stop(),
      };
    })
  : []) {
  test(`execution-gondolin with proposals-local ${c.group}: ${c.name}`, () => c.run(), BOOT_MS);
}

test.skipIf(problem !== undefined)(
  "the lock: the guest pushes a proposal, but cannot move main, delete a proposal, or reach the repository or the decisions; the operator approves",
  async () => {
    const { app, proposals, directory, gitdir, env } = await start({ "README.md": "# The project\n" });
    try {
      const main = await git.resolveRef({ fs, gitdir, ref: "refs/heads/main" });
      const clone = await sh(env, `git clone file://${gitdir} project && cd project && git checkout -b pikit/self/hello && echo hello > hello.txt && git add -A && git commit -qm "Say hello" && git push origin pikit/self/hello 2>&1`);
      expect(clone.exitCode).toBe(0);

      const toMain = await sh(env, "cd project && git push origin HEAD:main 2>&1");
      expect(toMain.exitCode).not.toBe(0);
      expect(toMain.output).toContain("pushing to main is refused");
      const deleting = await sh(env, "cd project && git push origin :pikit/self/hello 2>&1");
      expect(deleting.exitCode).not.toBe(0);
      expect(deleting.output).toContain("is refused");
      expect(await git.resolveRef({ fs, gitdir, ref: "refs/heads/main" })).toBe(main);

      // The host's files are not in the VM: neither the repository nor where decisions are written.
      writeFileSync(join(directory, "decisions.json"), JSON.stringify({ decisions: [] }));
      const reach = await sh(env, `ls ${gitdir} 2>&1; ls ${directory} 2>&1; echo '{"decisions":[]}' > ${directory}/decisions.json 2>&1; echo done`);
      expect(reach.output).toContain("No such file or directory");
      expect(reach.output).toContain("done");
      expect(fs.readFileSync(join(directory, "decisions.json"), "utf8")).toBe(JSON.stringify({ decisions: [] }));

      // What it pushed is a proposal; only the operator's call approves it.
      const appCtx = app.context();
      const listed = (await proposals.list(appCtx)).proposals.find((each) => each.id === "hello");
      expect(listed?.state).toBe("open");
      const head = (await proposals.get("hello", appCtx)).head;
      const outcome = await proposals.approve("hello", { head, operator: { id: "ops" } }, appCtx);
      expect(outcome.ok).toBe(true);
      expect(existsSync(join(directory, "decisions.json"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(join(directory, "decisions.json"), "utf8")).decisions[0]).toMatchObject({ id: "hello", head, decision: "approved", operator: "ops" });
    } finally {
      await app.stop();
    }
  },
  BOOT_MS,
);
