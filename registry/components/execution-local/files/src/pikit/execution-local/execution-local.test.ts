/**
 * execution-local's tests. They are copied with the component and keep running in your project.
 * Every environment works in a temporary directory.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { createDurableExecutionConformance, createWorkspaceGitConformance } from "@pikit/pi-adapter/execution/testing";
import executionLocal from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-execution-local-"));
  directories.push(dir);
  return join(dir, "workspace");
}

/** A started app with this component, and the environments it provides. */
async function started(config: Record<string, unknown>): Promise<{ app: App; files: ExecutionEnv; shell: ExecutionEnv }> {
  let found: { files: ExecutionEnv; shell: ExecutionEnv } | undefined;
  const reader = defineComponent({
    name: "execution-reader",
    setup(pikit) {
      const files = pikit.use("execution");
      const shell = pikit.use("execution.shell");
      return { start: () => void (found = { files: files.get(), shell: shell.get() }) };
    },
  });
  const app = await defineApp({
    components: [executionLocal, reader],
    config: { "execution-local": config },
    logger: silentLogger,
  }).create();
  await app.start();
  if (found === undefined) throw new Error("execution was not resolved");
  return { app, ...found };
}

// pi-durable's ExecutionEnv contract, with a shell.
for (const c of createDurableExecutionConformance(async () => {
  const { app, shell } = await started({ root: temporaryRoot() });
  return { env: shell, dispose: () => app.stop() };
}, { expect })) {
  test(`execution-local ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

// The steward's git flow, with the machine's own git, against a bare repository as proposals-local's.
const hasGit = Bun.which("git") !== null;
if (!hasGit) test.skip("execution-local workspace git: skipped, git is not installed on this machine (the suite runs the real git)", () => {});
for (const c of hasGit ? createWorkspaceGitConformance(gitFixture) : []) {
  test(`execution-local ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

/** A bare repository whose main holds `files`, and execution-local with a git identity of its own (not this machine's). */
async function gitFixture(files: Readonly<Record<string, string>>) {
  const root = temporaryRoot();
  const base = dirname(root);
  const config = join(base, "gitconfig");
  writeFileSync(config, "[user]\n\tname = pikit agent\n\temail = agent@pikit.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const gitEnv = { PATH: process.env.PATH ?? "", HOME: base, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: base, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: out.trim(), err };
  };
  const remote = join(base, "remote.git");
  const work = join(base, "seed");
  await git("init", "--bare", "-b", "main", remote);
  await git("init", "-b", "main", work);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  for (const args of [["add", "-A"], ["commit", "-m", "The project"], ["push", remote, "main"]]) {
    const done = await git("-C", work, ...args);
    if (done.code !== 0) throw new Error(`git ${args.join(" ")}: ${done.err}`);
  }
  // Its commands start from these variables only: the identity above, never this machine's config.
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" });
  try {
    const { app, shell } = await started({ root, variables: ["HOME", "LANG", "PATH", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] });
    return {
      env: shell,
      remote,
      async head(branch: string) {
        const found = await git("--git-dir", remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
        return found.code === 0 ? found.out : undefined;
      },
      dispose: () => app.stop(),
    };
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// Start and stop honour their deadline.
const lifecycleRoot = temporaryRoot();
for (const c of createLifecycleConformance(() => ({ component: executionLocal, config: { "execution-local": { root: lifecycleRoot } } }))) {
  test(`execution-local ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [executionLocal], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([
    { name: "execution-local", provides: ["execution", "execution.shell"], requires: [], optional: [] },
  ]);
});

test("files and shell are one environment, working in root", async () => {
  const root = temporaryRoot();
  const { app, files, shell } = await started({ root });

  expect(files).toBe(shell);
  expect(files.cwd).toBe(root);
  await app.stop();
});

test("a command does not see the server's variables, only the allowed ones", async () => {
  const root = temporaryRoot();
  // Stands in for a secret of the server, such as PIKIT_HTTP_TOKEN or ANTHROPIC_API_KEY.
  process.env.PIKIT_EXECUTION_LOCAL_SECRET = "server-secret";
  process.env.PIKIT_EXECUTION_LOCAL_ALLOWED = "allowed";
  try {
    const plain = await started({ root });
    const widened = await started({ root, variables: ["PIKIT_EXECUTION_LOCAL_ALLOWED"] });
    await plain.shell.exec('printf "%s|%s" "${PIKIT_EXECUTION_LOCAL_SECRET:-absent}" "${HOME:-no home}" > plain.txt', undefined, plain.app.context());
    await widened.shell.exec('printf "%s" "${PIKIT_EXECUTION_LOCAL_ALLOWED:-absent}" > widened.txt', undefined, widened.app.context());

    expect(readFileSync(join(root, "plain.txt"), "utf8")).toBe(`absent|${process.env.HOME}`);
    expect(readFileSync(join(root, "widened.txt"), "utf8")).toBe("allowed");
    await plain.app.stop();
    await widened.app.stop();
  } finally {
    delete process.env.PIKIT_EXECUTION_LOCAL_SECRET;
    delete process.env.PIKIT_EXECUTION_LOCAL_ALLOWED;
  }
});

test("stopping the app kills the commands still running", async () => {
  const root = temporaryRoot();
  const { app, shell } = await started({ root });
  const before = Date.now();
  const running = shell.exec("touch running; sleep 30", undefined, app.context());
  while (!existsSync(join(root, "running"))) await Bun.sleep(5);

  await app.stop();
  const result = await running;

  expect(Date.now() - before).toBeLessThan(5000);
  expect(result.ok && result.value.exitCode === 0).toBe(false);
});

test("it refuses to start when root cannot be a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-execution-local-"));
  directories.push(dir);
  writeFileSync(join(dir, "blocked"), "a file where the workspace should be");
  const app = await defineApp({
    components: [executionLocal],
    config: { "execution-local": { root: join(dir, "blocked", "workspace") } },
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(String((error as Error).message)).toContain('"execution-local" failed to start');
});
