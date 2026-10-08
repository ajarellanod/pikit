/**
 * The deployer with real git (a project, the proposals repository, the agent's clone, all in a
 * temporary directory) and a fake Docker: each `docker` command is recorded and answered as Docker
 * would (the checks' containers pass or fail, the build, `compose up`), and `/health` is a function.
 * No Docker needed; git is (the deployer's and the app's images have it).
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, spawnRunner } from "./commands.ts";
import { createDeployer, type DeployerState, type DockerSetup, runDeployer } from "./deployer.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const DOCKER: DockerSetup = { project: "my-agent", image: "my-agent-deployer", checksVolume: "my-agent_pikit-checks", appImage: "my-agent-app" };

/** git, as a person runs it. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnRunner(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, capture: true });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} exited with ${result.code}`);
  return result.stdout.trim();
}

/** Writes `files` in `dir`, commits them all, and resolves with the commit. */
async function commit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A server: the project (a git repository on main), the app's shared directory, the deployer's volume, and a fake Docker. */
async function server(options: { exits?: Record<string, number>; healthy?: boolean; running?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pikit-deployer-"));
  dirs.push(root);
  const project = join(root, "project");
  const state = join(root, "state", "self");
  const checks = join(root, "checks");
  for (const dir of [project, state, checks]) mkdirSync(dir, { recursive: true });
  await git(project, "init", "--quiet");
  const first = await commit(project, { "package.json": JSON.stringify({ name: "bot", scripts: { typecheck: "tsc --noEmit" } }), "README.md": "hello\n", "src/a.ts": "export const a = 1;\n", "compose.yaml": "services: {}\n" }, "The project");
  const docker: string[] = [];
  const said: string[] = [];
  const run: Runner = async (command, opts) => {
    if (command[0] !== "docker") return spawnRunner(command, opts);
    const line = command.join(" ");
    docker.push(line);
    const exit = Object.entries(options.exits ?? {}).find(([end]) => line.endsWith(end))?.[1];
    if (exit !== undefined) return { code: exit, stdout: "" };
    if (line.endsWith("ps --quiet app")) return { code: 0, stdout: options.running === false ? "" : "c0ffee\n" };
    if (line === "docker inspect --format {{.Image}} c0ffee") return { code: 0, stdout: "sha256:old-image\n" };
    return { code: 0, stdout: "" };
  };
  const deployer = createDeployer({ project, state, checks, run, docker: DOCKER, say: (line) => void said.push(line), health: async () => options.healthy ?? true });
  const bare = join(state, "project.git");
  const stateFile = () => JSON.parse(readFileSync(join(state, "deployer.json"), "utf8")) as DeployerState;
  /** The steward: clones the proposals repository, commits `files` on `pikit/self/<topic>`, pushes it. */
  const propose = async (topic: string, files: Record<string, string>, message = `Change ${topic}`) => {
    const work = join(root, `agent-${topic}-${Math.random().toString(36).slice(2)}`);
    await git(root, "clone", "--quiet", bare, work);
    await git(work, "checkout", "--quiet", "-b", `pikit/self/${topic}`);
    const head = await commit(work, files, message);
    // The agent's own branches: a push replaces what is there.
    await git(work, "push", "--quiet", "--force", "origin", `pikit/self/${topic}`);
    return head;
  };
  /** The operator approves `head` (proposals-local's `decisions.json`). */
  const approve = (topic: string, head: string) => {
    const path = join(state, "decisions.json");
    const kept = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { decisions: unknown[] }).decisions : [];
    writeFileSync(path, JSON.stringify({ decisions: [{ id: topic, branch: `pikit/self/${topic}`, head, decision: "approved", operator: "ops", at: new Date().toISOString(), title: `Change ${topic}` }, ...kept] }));
  };
  return { root, project, state, checks, bare, first, docker, said, deployer, stateFile, propose, approve };
}

const SANDBOX = `docker run --rm --user ${process.getuid?.()}:${process.getgid?.()} --env HOME=/tmp --volume my-agent_pikit-checks:`;

test("its first pass makes the proposals repository from the project's main, and writes its heartbeat", async () => {
  const s = await server();
  await s.deployer.pass();
  expect(await git(s.root, "--git-dir", s.bare, "rev-parse", "refs/heads/main")).toBe(s.first);
  expect(s.stateFile()).toMatchObject({ project: { ok: true, message: `main at ${s.first.slice(0, 7)}, nothing uncommitted.` }, outcomes: {} });
  expect(typeof s.stateFile().heartbeatAt).toBe("string");
  expect(s.docker).toEqual([]);

  // A commit of the operator's: the proposals repository's main follows.
  const second = await commit(s.project, { "README.md": "hello again\n" }, "By hand");
  await s.deployer.pass();
  expect(await git(s.root, "--git-dir", s.bare, "rev-parse", "refs/heads/main")).toBe(second);
});

test("approved → merged (fast-forward) → checked in sandboxes → built → recreated → healthy: deployed, and main follows", async () => {
  const s = await server();
  await s.deployer.pass();
  const head = await s.propose("greeting", { "src/hello.ts": "export const hello = 1;\n" });
  // Not approved: nothing happens.
  await s.deployer.pass();
  expect(s.docker).toEqual([]);

  s.approve("greeting", head);
  await s.deployer.pass();
  const repo = join(s.checks, "repo");
  expect(s.docker).toEqual([
    `${SANDBOX}${s.checks} --workdir ${repo} my-agent-deployer bun install --frozen-lockfile`,
    `${SANDBOX}${s.checks} --workdir ${repo} my-agent-deployer bun run typecheck`,
    `${SANDBOX}${s.checks} --workdir ${repo} my-agent-deployer bun test`,
    `docker compose --project-name my-agent --file ${s.project}/compose.yaml --project-directory ${s.project} ps --quiet app`,
    "docker inspect --format {{.Image}} c0ffee",
    "docker tag sha256:old-image my-agent-app:pikit-previous",
    `docker build --tag my-agent-app:latest ${repo}`,
    `docker compose --project-name my-agent --file ${s.project}/compose.yaml --project-directory ${s.project} up --detach --no-build --force-recreate --no-deps --wait app`,
  ]);
  const written = s.stateFile();
  expect(written.outcomes?.[head]).toMatchObject({ id: "greeting", outcome: "deployed", message: `deployed ${head.slice(0, 7)}.` });
  expect(written.outcomes?.[head]?.checks?.map((check) => [check.name, check.state])).toEqual([
    ["merge", "passing"],
    ["bun install", "passing"],
    ["typecheck", "passing"],
    ["bun test", "passing"],
    ["build", "passing"],
    ["/health", "passing"],
  ]);
  expect(written.lastDeploy).toMatchObject({ head, id: "greeting" });
  expect(written.deploying).toBeUndefined();
  // The project's main and the proposals repository's are the deployed commit.
  expect(await git(s.project, "rev-parse", "main")).toBe(head);
  expect(readFileSync(join(s.project, "src", "hello.ts"), "utf8")).toBe("export const hello = 1;\n");
  expect(await git(s.root, "--git-dir", s.bare, "rev-parse", "refs/heads/main")).toBe(head);

  // Done: the next pass deploys nothing.
  s.docker.length = 0;
  await s.deployer.pass();
  expect(s.docker).toEqual([]);
});

test("failing tests: not deployed, nothing built or restarted, main unchanged, recorded as failed", async () => {
  const s = await server({ exits: { "bun test": 1 } });
  await s.deployer.pass();
  const head = await s.propose("broken", { "src/broken.ts": "nope\n" });
  s.approve("broken", head);
  await s.deployer.pass();
  expect(s.docker.some((line) => line.startsWith("docker build") || line.startsWith("docker tag") || line.includes(" up "))).toBe(false);
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "failed", message: "bun test exited with code 1: not deployed" });
  expect(s.stateFile().lastFailure?.head).toBe(head);
  expect(await git(s.project, "rev-parse", "main")).toBe(s.first);
});

test("unhealthy after the restart: the previous image back, main unchanged, recorded as rolled back", async () => {
  const s = await server({ healthy: false });
  await s.deployer.pass();
  const head = await s.propose("slow", { "src/slow.ts": "export const slow = 1;\n" });
  s.approve("slow", head);
  await s.deployer.pass();
  expect(s.docker.slice(-3)).toEqual([
    `docker compose --project-name my-agent --file ${s.project}/compose.yaml --project-directory ${s.project} up --detach --no-build --force-recreate --no-deps --wait app`,
    "docker tag my-agent-app:pikit-previous my-agent-app:latest",
    `docker compose --project-name my-agent --file ${s.project}/compose.yaml --project-directory ${s.project} up --detach --no-build --force-recreate --no-deps --wait app`,
  ]);
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "rolled back" });
  expect(s.stateFile().lastRollback?.head).toBe(head);
  expect(await git(s.project, "rev-parse", "main")).toBe(s.first);

  // Without a previous image: failed, and said.
  const first = await server({ healthy: false, running: false });
  await first.deployer.pass();
  const other = await first.propose("first", { "x.txt": "x\n" });
  first.approve("first", other);
  await first.deployer.pass();
  expect(first.stateFile().outcomes?.[other]?.message).toContain("no previous image to roll back to");
});

test("main moved since the proposal: a merge commit is deployed; a conflict fails it, building nothing", async () => {
  const s = await server();
  await s.deployer.pass();
  const head = await s.propose("notes", { "NOTES.md": "notes\n" });
  const meanwhile = await commit(s.project, { "README.md": "changed by hand\n" }, "By hand");
  s.approve("notes", head);
  await s.deployer.pass();
  const deployed = await git(s.project, "rev-parse", "main");
  expect(deployed).not.toBe(head);
  expect(await git(s.project, "rev-parse", "main^1")).toBe(meanwhile);
  expect(await git(s.project, "rev-parse", "main^2")).toBe(head);
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "deployed", message: `deployed ${deployed.slice(0, 7)} (merged with main).` });

  const conflicting = await s.propose("readme", { "README.md": "the agent's readme\n" });
  await commit(s.project, { "README.md": "the operator's readme\n" }, "By hand, again");
  s.docker.length = 0;
  s.approve("readme", conflicting);
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[conflicting]).toMatchObject({ outcome: "failed", message: expect.stringContaining("conflicts with main") });
  expect(s.docker).toEqual([]);
});

test("refused: a change of the deployment's own files, or a branch that moved after the approval", async () => {
  const s = await server();
  await s.deployer.pass();
  const sneaky = await s.propose("socket", { "compose.yaml": "services: { app: { privileged: true } }\n" });
  s.approve("socket", sneaky);
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[sneaky]).toMatchObject({ outcome: "failed", message: expect.stringContaining("it changes the deployment itself (compose.yaml)") });

  const approved = await s.propose("moving", { "a.txt": "a\n" });
  s.approve("moving", approved);
  await s.propose("moving", { "b.txt": "b\n" });
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[approved]).toMatchObject({ outcome: "failed", message: expect.stringContaining("moved after it was approved") });
  expect(s.docker).toEqual([]);
});

test("uncommitted changes in the project: the approval waits, saying why, and deploys once they are committed", async () => {
  const s = await server();
  await s.deployer.pass();
  const head = await s.propose("later", { "later.txt": "later\n" });
  writeFileSync(join(s.project, "README.md"), "edited, not committed\n");
  s.approve("later", head);
  await s.deployer.pass();
  expect(s.stateFile().project).toMatchObject({ ok: false, message: expect.stringContaining("uncommitted changes (README.md)") });
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "waiting" });
  expect(s.docker).toEqual([]);

  await commit(s.project, {}, "Commit the edit");
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[head]?.outcome).toBe("deployed");
});

test("a project that is not a git repository: said, and nothing else", async () => {
  const s = await server();
  rmSync(join(s.project, ".git"), { recursive: true, force: true });
  await s.deployer.pass();
  expect(s.stateFile().project).toMatchObject({ ok: false, message: expect.stringContaining("is not a git repository") });
  expect(existsSync(s.bare)).toBe(false);
});

test("runDeployer polls until stopped, and a failing pass does not stop it", async () => {
  const s = await server();
  const said: string[] = [];
  const controller = new AbortController();
  let calls = 0;
  const run: Runner = async (command, opts) => {
    if (command[0] === "git" && ++calls === 1) throw new Error("git crashed");
    if (calls > 6) controller.abort();
    return spawnRunner(command, opts);
  };
  await runDeployer({ project: s.project, state: s.state, checks: s.checks, run, docker: DOCKER, say: (line) => void said.push(line), intervalMs: 5, signal: controller.signal });
  expect(said[0]).toBe("pikit deployer: deploying approved proposals, polling every 0 s");
  expect(said).toContain("pikit deployer: git crashed");
  expect(said.at(-1)).toBe("pikit deployer: stopped");
  expect(existsSync(join(s.bare, "HEAD"))).toBe(true);
});
