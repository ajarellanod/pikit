/**
 * proposals-local's tests: the `proposals` conformance suite over a proposals repository made with
 * isomorphic-git (`repository.test-support.ts`, no git binary needed), then what it reads from and
 * writes to the files it shares with the deployer. Each test works in a temporary directory. They are
 * copied with the component and keep running in your project.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import { type ApproveRequest, type Proposals, ProposalsError } from "@pikit/contracts";
import type { Decision, DeployerState } from "@pikit/contracts/deployer";
import { createProposalsConformance, createProposalsServeConformance, type ProposalsFixture } from "@pikit/contracts/testing";
import git from "isomorphic-git";
import proposalsLocal, { HEARTBEAT_MS } from "./index.ts";
import { commitOnto, makeRepository } from "./repository.test-support.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-proposals-local-"));
  directories.push(dir);
  return join(dir, "self");
};
const OPERATOR = { id: "ops" };

/** A connected proposals repository (the conformance suites' fixture). */
async function fixture(): Promise<ProposalsFixture> {
  const directory = temporary();
  const gitdir = join(directory, "project.git");
  const main = await makeRepository(gitdir);
  // A deployer seen just now: set up, as a server after `pikit up`.
  writeFileSync(join(directory, "deployer.json"), JSON.stringify({ heartbeatAt: new Date().toISOString() }));
  let tick = 0;
  return {
    components: () => [proposalsLocal],
    config: { "proposals-local": { directory } },
    async propose({ topic, title, body, file, text }) {
      const head = await commitOnto(gitdir, `refs/heads/pikit/self/${topic}`, main, { [file]: text }, `${title}\n\n${body}`);
      return { id: topic, head };
    },
    async pushAgain(id) {
      const head = await git.resolveRef({ fs, gitdir, ref: `refs/heads/pikit/self/${id}` });
      return await commitOnto(gitdir, `refs/heads/pikit/self/${id}`, head, { [`again-${++tick}.txt`]: "again\n" }, "Again");
    },
    async other(branch) {
      await commitOnto(gitdir, `refs/heads/${branch}`, main, { "other.txt": "other\n" }, "Not a proposal");
    },
  };
}

for (const c of createProposalsConformance(fixture)) {
  test(`proposals-local ${c.group}: ${c.name}`, () => c.run());
}

// The remote over git's smart HTTP (`serve.ts`): the machine's git answers it.
const hasGit = Bun.which("git") !== null;
if (!hasGit) test.skip("proposals-local proposals serve: skipped, git is not installed on this machine (serve runs the real git)", () => {});
for (const c of hasGit ? createProposalsServeConformance(fixture) : []) {
  test(`proposals-local ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

async function started(directory: string, now = Date.parse("2026-10-01T10:00:00Z")) {
  let handle: Handle<Proposals> | undefined;
  const consumer = defineComponent({ name: "consumer-test", setup: (pikit) => void (handle = pikit.use("proposals")) });
  const app = await defineApp({
    components: [proposalsLocal, consumer],
    config: { "proposals-local": { directory } },
    logger: silentLogger,
    clock: { now: () => now, sleep: (ms: number) => Bun.sleep(ms) },
  }).create();
  await app.start();
  return { app, proposals: handle?.get() as Proposals, ctx: app.context() };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const { app } = await started(temporary());
  expect(app.describe().components.find((component) => component.name === "proposals-local")).toEqual({ name: "proposals-local", provides: ["proposals"], requires: [], optional: [] });
  await app.stop();
});

test("before the deployer made the repository: status says what is missing, the rest is not_connected, no remote", async () => {
  const directory = temporary();
  const { app, proposals, ctx } = await started(directory);
  const status = await proposals.status(ctx);
  expect(status.connected).toBe(false);
  expect(status.checks.map((check) => [check.id, check.state])).toEqual([
    ["repository", "missing"],
    ["deployer", "missing"],
  ]);
  const error = await proposals.list(ctx).catch((thrown: unknown) => thrown as ProposalsError);
  expect((error as ProposalsError).code).toBe("not_connected");
  expect(await proposals.remote(ctx)).toBeUndefined();
  // Its directory is there for the deployer.
  expect(fs.existsSync(directory)).toBe(true);
  await app.stop();
});

test("a proposal: its title and description from the head commit, its files against main, earlier commits listed", async () => {
  const directory = temporary();
  const gitdir = join(directory, "project.git");
  const main = await makeRepository(gitdir, { "README.md": "hello\nworld\n", "src/a.ts": "export const a = 1;\n", "logo.png": "\u0000png" });
  const first = await commitOnto(gitdir, "refs/heads/pikit/self/tools/calendar", main, { "src/calendar.ts": "export const calendar = true;\n" }, "Start a calendar tool", 1_790_000_100);
  const head = await commitOnto(
    gitdir,
    "refs/heads/pikit/self/tools/calendar",
    first,
    { "README.md": "hello\nthere\n", "src/a.ts": null, "logo.png": "\u0000png2" },
    "A calendar tool\n\nAdds a tool that reads the calendar.\n\nChecked: bun test (12 pass).",
    1_790_000_200,
  );
  const { app, proposals, ctx } = await started(directory);
  const list = await proposals.list(ctx);
  expect(list).toMatchObject({ where: "this server's proposals repository", branchPrefix: "pikit/self/", checksRun: "after-approval" });
  expect(list.proposals).toEqual([
    {
      id: "tools/calendar",
      title: "A calendar tool",
      author: "pikit agent",
      branch: "pikit/self/tools/calendar",
      createdAt: new Date(1_790_000_100_000).toISOString(),
      updatedAt: new Date(1_790_000_200_000).toISOString(),
      state: "open",
    },
  ]);
  const detail = await proposals.get("tools/calendar", ctx);
  expect(detail.mergeDetail).toBeUndefined();
  expect(detail).toMatchObject({ head, base: "main", defaultBranch: "main", changedFiles: 4, additions: 2, deletions: 2, checks: { state: "none" } });
  expect(detail.body).toBe("Adds a tool that reads the calendar.\n\nChecked: bun test (12 pass).\n\nEarlier commits:\n- Start a calendar tool");
  expect(detail.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
    ["README.md", "modified", 1, 1],
    ["logo.png", "modified", 0, 0],
    ["src/a.ts", "removed", 0, 1],
    ["src/calendar.ts", "added", 1, 0],
  ]);
  expect(detail.files[0]?.patch).toBe("@@ -1,2 +1,2 @@\n hello\n-world\n+there");
  expect(detail.files[1]?.patch).toBeUndefined();
  expect(await proposals.remote(ctx)).toEqual({ kind: "path", path: gitdir, mainBranch: "main", branchPrefix: "pikit/self/", serve: expect.any(Function) });
  // main moves on: the proposal is behind it, said in plain words.
  await commitOnto(gitdir, "refs/heads/main", main, { "NEWS.md": "news\n" }, "Main moves on", 1_790_000_300);
  expect(await proposals.get("tools/calendar", ctx)).toMatchObject({ mergeable: null, mergeDetail: "behind main: the deployer merges it in" });
  await app.stop();
});

test("approve records the operator's head for the deployer; its deploy, as the deployer writes it, is the proposal's state", async () => {
  const directory = temporary();
  const gitdir = join(directory, "project.git");
  const main = await makeRepository(gitdir);
  const head = await commitOnto(gitdir, "refs/heads/pikit/self/greeting", main, { "hello.txt": "hi\n" }, "Say hello");
  const now = Date.parse("2026-10-01T10:00:00Z");
  const { app, proposals, ctx } = await started(directory, now);

  expect(await proposals.approve("greeting", { head, operator: OPERATOR }, ctx)).toMatchObject({ ok: true, id: "greeting", head, merged: false });
  const written = JSON.parse(readFileSync(join(directory, "decisions.json"), "utf8")) as { decisions: Decision[] };
  expect(written.decisions).toEqual([{ id: "greeting", branch: "pikit/self/greeting", head, decision: "approved", operator: "ops", at: "2026-10-01T10:00:00.000Z", title: "Say hello" }]);
  expect((await proposals.list(ctx)).proposals[0]).toMatchObject({ state: "approved", deploy: { outcome: "waiting" } });

  const deployer = (file: DeployerState) => writeFileSync(join(directory, "deployer.json"), JSON.stringify(file));
  deployer({
    heartbeatAt: new Date(now - 5_000).toISOString(),
    project: { ok: true, message: "main at 1234567, clean." },
    outcomes: {
      [head]: {
        id: "greeting",
        outcome: "rolled back",
        message: "failed /health: rolled back to 1234567",
        at: "2026-10-01T10:02:00.000Z",
        checks: [
          { name: "bun install", state: "passing", detail: "done" },
          { name: "bun test", state: "passing", detail: "done" },
          { name: "/health", state: "failing", detail: "503" },
        ],
      },
    },
    lastRollback: { head, id: "greeting", message: "failed /health", at: "2026-10-01T10:02:00.000Z" },
  });
  const detail = await proposals.get("greeting", ctx);
  expect(detail).toMatchObject({ state: "failed", deploy: { outcome: "rolled back" }, checks: { state: "failing", passed: 2, failed: 1 } });
  const status = await proposals.status(ctx);
  expect(status.connected).toBe(true);
  expect(status.checks.map((check) => [check.id, check.state])).toEqual([
    ["repository", "ok"],
    ["deployer", "ok"],
    ["project", "ok"],
  ]);
  expect(status.deploys?.lastRollback?.head).toBe(head);

  deployer({ heartbeatAt: new Date(now - HEARTBEAT_MS - 1).toISOString(), outcomes: { [head]: { outcome: "deployed", message: "deployed", at: "2026-10-01T10:03:00.000Z" } } });
  expect((await proposals.list(ctx)).proposals[0]?.state).toBe("merged");
  const stale = await proposals.status(ctx);
  expect([stale.connected, stale.checks.find((check) => check.id === "deployer")?.state]).toEqual([false, "failing"]);
  await app.stop();
});

test("approve without the head the operator read is moved and writes no decision for the deployer", async () => {
  const directory = temporary();
  const gitdir = join(directory, "project.git");
  const main = await makeRepository(gitdir);
  const head = await commitOnto(gitdir, "refs/heads/pikit/self/greeting", main, { "hello.txt": "hi\n" }, "Say hello");
  const { app, proposals, ctx } = await started(directory);

  for (const request of [{}, { head: "" }, { head: 42 }, { head: head.toUpperCase() }, { head: main }]) {
    const outcome = await proposals.approve("greeting", { ...request, override: true, operator: OPERATOR } as ApproveRequest, ctx);
    expect([request, outcome.ok ? "approved" : outcome.code]).toEqual([request, "moved"]);
  }
  expect(fs.existsSync(join(directory, "decisions.json"))).toBe(false);
  expect((await proposals.list(ctx)).proposals[0]?.state).toBe("open");
  await app.stop();
});

test("reject keeps the head under refs/pikit/rejected/, deletes the branch, and keeps the comment; a new push on the topic is open again", async () => {
  const directory = temporary();
  const gitdir = join(directory, "project.git");
  const main = await makeRepository(gitdir);
  const head = await commitOnto(gitdir, "refs/heads/pikit/self/risky", main, { "risky.txt": "x\n" }, "Risky");
  const { app, proposals, ctx } = await started(directory);
  expect((await proposals.reject("risky", { comment: "Not now.", operator: OPERATOR }, ctx)).ok).toBe(true);
  expect(await git.resolveRef({ fs, gitdir, ref: "refs/pikit/rejected/risky" })).toBe(head);
  expect(await git.listBranches({ fs, gitdir })).toEqual(["main"]);
  expect((await proposals.list(ctx)).proposals).toMatchObject([{ id: "risky", state: "closed", title: "Risky", author: "ops" }]);
  expect((await proposals.get("risky", ctx)).body).toBe("Rejected by ops: Not now.");

  await commitOnto(gitdir, "refs/heads/pikit/self/risky", main, { "safer.txt": "y\n" }, "Safer");
  expect((await proposals.list(ctx)).proposals.map((proposal) => [proposal.id, proposal.state, proposal.title])).toEqual([["risky", "open", "Safer"]]);
  await app.stop();
});

test.skipIf(!hasGit)("a real git client over serve: clones, pushes a proposal, and is told why a push to main is refused, main unmoved", async () => {
  const directory = temporary();
  const gitdir = join(directory, "project.git");
  const main = await makeRepository(gitdir);
  writeFileSync(join(directory, "deployer.json"), JSON.stringify({ heartbeatAt: new Date().toISOString() }));
  const { app, proposals, ctx } = await started(directory, Date.now());
  const remote = await proposals.remote(ctx);
  if (remote?.kind !== "path") throw new Error("a path remote");
  // As a VM's requests reach it: over HTTP, to whatever host, answered by serve alone.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => remote.serve(request) });
  const work = join(directory, "..", "work");
  // Async: the server answers in this same process (a synchronous spawn would wait on itself).
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-c", "user.name=pikit agent", "-c", "user.email=agent@pikit.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: join(directory, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: `${out}${err}` };
  };
  try {
    expect((await git("clone", `http://127.0.0.1:${server.port}/project.git`, work)).code).toBe(0);
    writeFileSync(join(work, "hello.txt"), "hello\n");
    expect((await git("-C", work, "checkout", "-b", "pikit/self/hello")).code).toBe(0);
    expect((await git("-C", work, "add", "-A")).code).toBe(0);
    expect((await git("-C", work, "commit", "-m", "Say hello")).code).toBe(0);
    expect((await git("-C", work, "push", "origin", "pikit/self/hello")).code).toBe(0);
    expect((await proposals.list(ctx)).proposals.map((each) => each.id)).toContain("hello");

    const refused = await git("-C", work, "push", "origin", "HEAD:main");
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("pushing to main is refused");
    const deleted = await git("-C", work, "push", "origin", ":pikit/self/hello");
    expect(deleted.code).not.toBe(0);
    expect(deleted.output).toContain("deleting refs/heads/pikit/self/hello is refused");
    expect(await git_resolve(gitdir, "refs/heads/main")).toBe(main);
    expect(await git_resolve(gitdir, "refs/heads/pikit/self/hello")).toBeString();
  } finally {
    server.stop(true);
    await app.stop();
  }
}, 60_000);

const git_resolve = (gitdir: string, ref: string) => git.resolveRef({ fs, gitdir, ref });
