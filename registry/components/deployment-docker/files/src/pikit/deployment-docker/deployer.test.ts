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
import type { DeployerState } from "@pikit/contracts/deployer";
import { type Runner, spawnRunner } from "./commands.ts";
import { composeFiles, createDeployer, type DockerSetup, runDeployer } from "./deployer.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const DOCKER: DockerSetup = { project: "my-agent", image: "my-agent-deployer", checksVolume: "my-agent_pikit-checks", appImage: "my-agent-app" };

/** git, as a person runs it. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnRunner(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, capture: true });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} exited with ${result.code}`);
  return result.stdout.trim();
}

/** Writes `files` in `dir` (`null` deletes one), commits them all, and resolves with the commit. */
async function commit(dir: string, files: Record<string, string | null>, message: string): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(join(dir, path));
      continue;
    }
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
  const first = await commit(
    project,
    {
      "package.json": JSON.stringify({ name: "bot", scripts: { typecheck: "tsc --noEmit" } }),
      "README.md": "hello\n",
      "src/a.ts": "export const a = 1;\n",
      "compose.yaml": "services: {}\n",
      // A component that runs a service beside the app, as `pikit add` records it.
      "pikit.json": PIKIT_JSON,
      "src/pikit/expose-a/compose.yaml": "services: { side: { image: side } }\n",
    },
    "The project",
  );
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
  const propose = async (topic: string, files: Record<string, string | null>, message = `Change ${topic}`) => {
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

/** The project's pikit.json, as `pikit add` writes it. */
const pikitJson = (components: Record<string, unknown>) => `${JSON.stringify({ version: 1, targets: ["server"], registries: {}, components }, null, 2)}\n`;
const PIKIT_JSON = pikitJson({ "expose-a": { compose: "src/pikit/expose-a/compose.yaml" }, "deployment-docker": {} });

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

test("refused before anything runs: a change of a Compose file pikit.json lists, or of that list; the head moved, refused too", async () => {
  const s = await server();
  await s.deployer.pass();
  const refused = async (topic: string, files: Record<string, string | null>, said: string) => {
    const head = await s.propose(topic, files);
    s.approve(topic, head);
    await s.deployer.pass();
    expect([topic, s.stateFile().outcomes?.[head]]).toEqual([topic, expect.objectContaining({ outcome: "failed", message: expect.stringContaining(said) })]);
  };
  const SIDE = "src/pikit/expose-a/compose.yaml";
  // A listed file, changed, removed, or moved: `--no-renames` names the old path too.
  await refused("edit-side", { [SIDE]: "services: { side: { image: side, privileged: true } }\n" }, `it changes the deployment itself (${SIDE})`);
  await refused("remove-side", { [SIDE]: null }, `it changes the deployment itself (${SIDE})`);
  await refused("move-side", { [SIDE]: null, "src/pikit/expose-a/side.yaml": "services: { side: { image: side } }\n" }, `it changes the deployment itself (${SIDE})`);
  // The list: a Compose file added (proposals-local's, which turns this deployer on), one dropped, another file named one.
  const OVERRIDE = "src/pikit/proposals-local/compose.yaml";
  await refused(
    "turn-on",
    { [OVERRIDE]: "services:\n  deployer:\n    profiles: !reset []\n", "pikit.json": pikitJson({ "expose-a": { compose: SIDE }, "deployment-docker": {}, "proposals-local": { compose: OVERRIDE } }) },
    `it changes the deployment itself (${OVERRIDE}, the Compose files pikit.json lists: [${SIDE}] on main, [${SIDE}, ${OVERRIDE}] on the branch)`,
  );
  await refused("drop-side", { "pikit.json": pikitJson({ "expose-a": {}, "deployment-docker": {} }) }, `the Compose files pikit.json lists: [${SIDE}] on main, [] on the branch`);
  await refused("name-a-file", { "pikit.json": pikitJson({ "expose-a": { compose: SIDE }, "deployment-docker": { compose: "src/a.ts" } }) }, `[${SIDE}, src/a.ts] on the branch`);
  // A list that cannot be read is never taken as empty.
  await refused("not-json", { "pikit.json": "{" }, "its Compose files cannot be told (pikit.json is not JSON)");
  await refused("outside", { "pikit.json": pikitJson({ "expose-a": { compose: "../compose.yaml" } }) }, 'lists a Compose file that is not a project-relative path ("../compose.yaml")');
  await refused("absolute", { "pikit.json": pikitJson({ "expose-a": { compose: "/srv/compose.yaml" } }) }, "not a project-relative path");
  await refused("not-text", { "pikit.json": pikitJson({ "expose-a": { compose: 5 } }) }, "not a project-relative path (5)");
  await refused("list-of-components", { "pikit.json": `${JSON.stringify({ components: [] })}\n` }, "pikit.json's components is not an object");
  // The approved head, never what the branch holds later.
  const approved = await s.propose("moved", { "a.txt": "a\n" });
  s.approve("moved", approved);
  await s.propose("moved", { "b.txt": "b\n" });
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[approved]).toMatchObject({ outcome: "failed", message: expect.stringContaining("moved after it was approved") });
  // Nothing ran: no check, no build, no restart.
  expect(s.docker).toEqual([]);
  expect(await git(s.project, "rev-parse", "main")).toBe(s.first);
});

test("a listed Compose file with an odd name (a leading space, a tab, non-ASCII) is matched as it is, never quoted or trimmed", async () => {
  const s = await server();
  const ODD = " odd ñ\t.yaml";
  await commit(s.project, { [ODD]: "services: {}\n", "pikit.json": pikitJson({ "expose-a": { compose: "src/pikit/expose-a/compose.yaml" }, "tool-o": { compose: ODD } }) }, "An odd name");
  await s.deployer.pass();
  const head = await s.propose("odd", { [ODD]: "services: { side: { privileged: true } }\n" });
  s.approve("odd", head);
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "failed", message: expect.stringContaining(`it changes the deployment itself (${ODD})`) });
  expect(s.docker).toEqual([]);
});

test("a newline in a Compose path cannot disguise a different list of files", async () => {
  const s = await server();
  const combined = "A.yaml\nB.yaml";
  await commit(s.project, {
    "A.yaml": "services: {}\n",
    "B.yaml": "services: {}\n",
    [combined]: "services: {}\n",
    "pikit.json": pikitJson({ a: { compose: "A.yaml" }, b: { compose: "B.yaml" } }),
  }, "Files with ambiguous joined names");
  await s.deployer.pass();
  const head = await s.propose("newline", { "pikit.json": pikitJson({ a: { compose: combined } }) });
  s.approve("newline", head);
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "failed", message: expect.stringContaining("it changes the deployment itself") });
  expect(s.docker).toEqual([]);
});

test("main's list against the branch's: one an operator changed since the branch left main is refused, saying both", async () => {
  const s = await server();
  await s.deployer.pass();
  const head = await s.propose("stale", { "src/b.ts": "export const b = 1;\n" });
  await commit(s.project, { "pikit.json": pikitJson({ "expose-a": { compose: "src/pikit/expose-a/compose.yaml" }, "deployment-docker": {}, "tool-c": { compose: "src/pikit/tool-c/compose.yaml" } }), "src/pikit/tool-c/compose.yaml": "services: {}\n" }, "Add tool-c");
  s.approve("stale", head);
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[head]?.message).toContain("[src/pikit/expose-a/compose.yaml, src/pikit/tool-c/compose.yaml] on main, [src/pikit/expose-a/compose.yaml] on the branch");
  expect(s.docker).toEqual([]);
});

test("what the merge makes is checked too: two clean edits of pikit.json that change its list together are refused before the checks", async () => {
  const s = await server();
  // A hand-edited pikit.json with a key twice: JSON takes the last one.
  const lines = ['{"components": {', '  "x": {"compose": "X.yaml"},', '  "p1": {},', '  "p2": {},', '  "p3": {},', '  "x": {"compose": "X.yaml"}', "}}"];
  await commit(s.project, { "pikit.json": `${lines.join("\n")}\n`, "X.yaml": "services: {}\n" }, "By hand");
  await s.deployer.pass();
  // The branch drops the second x (still [X.yaml]); main changes the first (still [X.yaml]); merged, [Y.yaml].
  const head = await s.propose("twice", { "pikit.json": `${lines.with(5, '  "q": {}').join("\n")}\n` });
  await commit(s.project, { "pikit.json": `${lines.with(1, '  "x": {"compose": "Y.yaml"},').join("\n")}\n` }, "By hand, again");
  s.approve("twice", head);
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "failed", message: expect.stringContaining("it changes the deployment itself (the merge's pikit.json lists [Y.yaml], not main's)") });
  expect(s.docker).toEqual([]);
});

test("pikit.json's other fields are a proposal's to change: deployed", async () => {
  const s = await server();
  await s.deployer.pass();
  const head = await s.propose("tool", {
    "pikit.json": pikitJson({ "expose-a": { compose: "src/pikit/expose-a/compose.yaml", version: "0.0.1" }, "deployment-docker": {}, "tool-d": { hooks: { doctor: "src/pikit/tool-d/doctor.ts" } } }),
    "src/pikit/tool-d/index.ts": "export default {};\n",
  });
  s.approve("tool", head);
  await s.deployer.pass();
  expect(s.stateFile().outcomes?.[head]).toMatchObject({ outcome: "deployed" });
  expect(s.docker.some((line) => line.startsWith("docker build"))).toBe(true);
});

test("composeFiles: pikit.json's Compose files in its order; none without components; anything unreadable throws", () => {
  expect(composeFiles(pikitJson({ a: { compose: "src/pikit/a/compose.yaml" }, b: {}, c: { compose: "src/pikit/c/c.yml" } }))).toEqual(["src/pikit/a/compose.yaml", "src/pikit/c/c.yml"]);
  expect(composeFiles("{}")).toEqual([]);
  for (const text of ["", "null", "[]", '{"components": null}', '{"components": {"a": null}}', '{"components": {"a": {"compose": ""}}}', '{"components": {"a": {"compose": "src/./a.yaml"}}}', '{"components": {"a": {"compose": "src\\\\a.yaml"}}}', '{"components": {"a": {"compose": "src//a.yaml"}}}']) {
    expect(() => composeFiles(text)).toThrow();
  }
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
