/**
 * The deployer protocol's suite (`@pikit/contracts/testing`) on its two real sides: proposals-local in
 * an App writes the decisions, deployment-docker's deployer (`createDeployer`) reads them and writes
 * its state, on one shared directory. Real git (a project, the proposals repository, the agent's
 * clones) and a fake Docker whose checks pass, as in `deployer.test.ts`; no Docker needed.
 *
 * A repository test, not copied with either component: a component's files never import another
 * component's (SPEC P4), so it lives beside `files/`.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISIONS_FILE, DEPLOYER_STATE_FILE } from "@pikit/contracts/deployer";
import { createDeployerProtocolConformance } from "@pikit/contracts/testing";
import proposalsLocal from "../proposals-local/files/src/pikit/proposals-local/index.ts";
import { type Runner, spawnRunner } from "./files/src/pikit/deployment-docker/commands.ts";
import { createDeployer } from "./files/src/pikit/deployment-docker/deployer.ts";

const PREFIX = "pikit/self/";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnRunner(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, capture: true });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} exited with ${result.code}`);
  return result.stdout.trim();
}

async function commit(dir: string, file: string, text: string, message: string): Promise<string> {
  writeFileSync(join(dir, file), text);
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

for (const c of createDeployerProtocolConformance(async () => {
  const root = mkdtempSync(join(tmpdir(), "pikit-deployer-protocol-"));
  const project = join(root, "project");
  const shared = join(root, "state", "self");
  const checks = join(root, "checks");
  for (const dir of [project, shared, checks]) mkdirSync(dir, { recursive: true });
  await git(project, "init", "--quiet");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "bot" }));
  await commit(project, "compose.yaml", "services: {}\n", "The project");
  const built: string[] = [];
  const run: Runner = async (command, options) => {
    if (command[0] !== "docker") return spawnRunner(command, options);
    // What the image is built of: the clone's checkout at that moment.
    if (command[1] === "build") built.push(await git(join(checks, "repo"), "rev-parse", "HEAD"));
    return { code: 0, stdout: "" };
  };
  const deployer = createDeployer({ project, state: shared, checks, run, docker: { project: "bot", image: "bot-deployer", checksVolume: "bot_checks", appImage: "bot-app" }, say: () => {}, health: async () => true });
  // Its first pass makes the proposals repository from the project's main.
  await deployer.pass();
  const bare = join(shared, "project.git");
  let clones = 0;
  /** The agent: clones the proposals repository, commits on `<prefix><topic>`, pushes it. */
  const push = async (topic: string, from: "main" | "branch") => {
    const work = join(root, `agent-${++clones}`);
    await git(root, "clone", "--quiet", bare, work);
    await git(work, "checkout", "--quiet", ...(from === "main" ? ["-b", `${PREFIX}${topic}`] : [`${PREFIX}${topic}`]));
    const head = await commit(work, `${topic}-${clones}.txt`, `${topic}\n`, `Change ${topic}`);
    await git(work, "push", "--quiet", "--force", "origin", `${PREFIX}${topic}`);
    return head;
  };
  return {
    components: () => [proposalsLocal],
    config: { "proposals-local": { directory: shared, branchPrefix: PREFIX } },
    propose: async (topic) => ({ id: topic, head: await push(topic, "main") }),
    pushAgain: (id) => push(id, "branch"),
    pass: () => deployer.pass(),
    built: async () => [...built],
    read: async (name) => (existsSync(join(shared, name)) ? readFileSync(join(shared, name), "utf8") : undefined),
    dispose: async () => rmSync(root, { recursive: true, force: true }),
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run(), 30_000);
}

test("the deployer's own copies of the file names are the protocol's", () => {
  const source = readFileSync(join(import.meta.dir, "files", "src", "pikit", "deployment-docker", "deployer.ts"), "utf8");
  for (const name of [DECISIONS_FILE, DEPLOYER_STATE_FILE]) expect(source).toContain(`"${name}"`);
});
