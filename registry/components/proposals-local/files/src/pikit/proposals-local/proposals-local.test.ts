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
import { type Proposals, ProposalsError } from "@pikit/contracts";
import { createProposalsConformance } from "@pikit/contracts/testing";
import git from "isomorphic-git";
import proposalsLocal, { type Decision, type DeployerFile, HEARTBEAT_MS } from "./index.ts";
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

for (const c of createProposalsConformance(async () => {
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
})) {
  test(`proposals-local ${c.group}: ${c.name}`, () => c.run());
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
  expect([(error as ProposalsError).code, (error as ProposalsError).status]).toEqual(["not_connected", 503]);
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
      draft: false,
    },
  ]);
  const detail = await proposals.get("tools/calendar", ctx);
  expect(detail).toMatchObject({ head, base: "main", defaultBranch: "main", mergeableState: "clean", changedFiles: 4, additions: 2, deletions: 2, checks: { state: "none" } });
  expect(detail.body).toBe("Adds a tool that reads the calendar.\n\nChecked: bun test (12 pass).\n\nEarlier commits:\n- Start a calendar tool");
  expect(detail.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
    ["README.md", "modified", 1, 1],
    ["logo.png", "modified", 0, 0],
    ["src/a.ts", "removed", 0, 1],
    ["src/calendar.ts", "added", 1, 0],
  ]);
  expect(detail.files[0]?.patch).toBe("@@ -1,2 +1,2 @@\n hello\n-world\n+there");
  expect(detail.files[1]?.patch).toBeUndefined();
  expect(await proposals.remote(ctx)).toEqual({ kind: "path", path: gitdir, mainBranch: "main", branchPrefix: "pikit/self/" });
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

  const deployer = (file: DeployerFile) => writeFileSync(join(directory, "deployer.json"), JSON.stringify(file));
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
