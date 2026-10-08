/**
 * execution-local's tests. They are copied with the component and keep running in your project.
 * Every environment works in a temporary directory. `git` runs against a fake GitHub
 * (`git-server.test-support.ts`) put in place of the global `fetch`: no network.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { branchAllowed, githubRepository } from "./git.ts";
import { createFakeGitHub, type FakeGitHub } from "./git-server.test-support.ts";
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

/** A started app with this component, a `secrets` holding `secrets` when given, and the environments it provides. */
async function started(config: Record<string, unknown>, secrets?: Record<string, string>): Promise<{ app: App; files: ExecutionEnv; shell: ExecutionEnv }> {
  let found: { files: ExecutionEnv; shell: ExecutionEnv } | undefined;
  const reader = defineComponent({
    name: "execution-reader",
    setup(pikit) {
      const files = pikit.use("execution");
      const shell = pikit.use("execution.shell");
      return { start: () => void (found = { files: files.get(), shell: shell.get() }) };
    },
  });
  const secretsComponent = defineComponent({
    name: "secrets-test",
    setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => secrets?.[name] }),
  });
  const app = await defineApp({
    components: [...(secrets === undefined ? [] : [secretsComponent]), executionLocal, reader],
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

// Start and stop honour their deadline.
const lifecycleRoot = temporaryRoot();
for (const c of createLifecycleConformance(() => ({ component: executionLocal, config: { "execution-local": { root: lifecycleRoot } } }))) {
  test(`execution-local ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [executionLocal], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([
    { name: "execution-local", provides: ["execution", "execution.shell"], requires: [], optional: ["secrets"] },
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

// git: the server's own, reached from the shell through the `git` program on its PATH.

const ctx = BACKGROUND_CONTEXT;
const TOKEN = "ghp_test-token-never-shown";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Runs `command` as Pi's `bash` tool does, and returns its exit code and combined output. */
async function run(env: ExecutionEnv, command: string, cwd?: string) {
  let output = "";
  const result = await env.exec(command, { ...(cwd !== undefined && { cwd }), onOutput: (text) => void (output += text) }, ctx);
  if (!result.ok) throw new Error(`exec failed: ${result.error.code} ${result.error.message}`);
  return { exitCode: result.value.exitCode, output };
}

/** A fake GitHub with `acme/app` (public) and `acme/secret` (private), in place of the global fetch. */
async function fakeGitHub(): Promise<FakeGitHub> {
  const dir = mkdtempSync(join(tmpdir(), "pikit-execution-local-github-"));
  directories.push(dir);
  const github = await createFakeGitHub(
    dir,
    { "acme/app": { files: { "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" } }, "acme/secret": { files: { "README.md": "secret\n" }, private: true } },
    TOKEN,
  );
  globalThis.fetch = github.fetch as typeof fetch;
  return github;
}

test("GitHub URLs and pushed branches are checked", () => {
  expect(githubRepository("https://github.com/acme/app.git")).toEqual({ owner: "acme", name: "app" });
  expect(githubRepository("git@github.com:acme/app.git")).toBeUndefined();
  expect(githubRepository("https://gitlab.com/acme/app")).toBeUndefined();
  expect(branchAllowed("pikit/self/better-readme", "pikit/self/")).toBe(true);
  for (const branch of ["main", "pikit/self/", "pikit/self/../main", "pikit/self/x.lock", "pikit/selfish", "pikit/self/-x"]) {
    expect(branchAllowed(branch, "pikit/self/")).toBe(false);
  }
});

test("git: clone, status, diff, commit, log, push and a pull request, with the token only on GitHub's requests", async () => {
  const github = await fakeGitHub();
  const root = temporaryRoot();
  const { app, shell } = await started({ root, git: { pushRepositories: ["acme/app"] } }, { GITHUB_TOKEN: TOKEN });

  const clone = await run(shell, "git clone https://github.com/acme/app");
  expect(clone.output).toContain("you may push branches pikit/self/");
  // Shallow: only the latest commit came.
  expect((await run(shell, "git log", "app")).output).toBe(`${(await github.head("acme/app")).slice(0, 7)} second commit (fake github)\n`);
  writeFileSync(join(root, "app", "README.md"), "hello\n(second commit)\nmore\n");
  writeFileSync(join(root, "app", "src", "b.ts"), "export const b = 2;\n");
  expect((await run(shell, "git status", "app/src")).output).toBe("On branch main\n M README.md\n?? src/b.ts\n");
  expect((await run(shell, "git diff README.md", "app")).output).toContain("+more\n");
  expect((await run(shell, "git add . && git commit -m 'Explain more'", "app")).output).toMatch(/^\[main [0-9a-f]{7}\] Explain more\n 2 file\(s\) changed: README.md, src\/b.ts\n$/);
  expect((await run(shell, "git status", "app")).output).toBe("On branch main\nnothing to commit, working tree clean\n");

  const push = await run(shell, "git push origin pikit/self/explain-more && git pr pikit/self/explain-more 'Explain more' -b 'Why: clarity'", "app");
  expect(push.exitCode).toBe(0);
  expect(push.output).toContain("Pull request opened: https://github.com/acme/app/pull/1");
  const [committed] = (await run(shell, "git log -n 1", "app")).output.split(" ");
  expect(github.pushes.map((pushed) => [pushed.repository, pushed.ref, pushed.oid.slice(0, 7)])).toEqual([["acme/app", "refs/heads/pikit/self/explain-more", committed ?? ""]]);
  expect(github.pulls).toEqual([{ repository: "acme/app", head: "pikit/self/explain-more", base: "main", title: "Explain more", body: "Why: clarity" }]);
  // The token went to GitHub, and never to the shell: not in its variables, nor in the program it runs, nor in the checkout.
  expect(github.requests.every((request) => request.authorization !== null)).toBe(true);
  expect((await run(shell, 'env; set; cat "$(command -v git)"')).output).not.toContain(TOKEN);
  expect((await run(shell, "grep -r ghp_ app/.git || echo none")).output).toBe("none\n");
  await app.stop();
});

test("git push and pr are fenced: the branch prefix, the allowed repositories, a token, and the origin checked at each push", async () => {
  const github = await fakeGitHub();
  const allowed = await started({ root: temporaryRoot(), git: { pushRepositories: ["acme/app"] } }, { GITHUB_TOKEN: TOKEN });
  await run(allowed.shell, "git clone https://github.com/acme/app && cd app && echo x >> README.md && git commit -m change");
  expect(await run(allowed.shell, "git push origin main", "app")).toEqual({ exitCode: 1, output: expect.stringContaining("only to new branches pikit/self/<topic>") });
  expect((await run(allowed.shell, "git push origin feature/x", "app")).exitCode).toBe(1);
  expect((await run(allowed.shell, "git pr main 'title'", "app")).exitCode).toBe(1);
  // The shell may edit .git/config (it is not fenced here), but the remote is checked at the push.
  await run(allowed.shell, "sed -i.bak 's#github.com/acme/app#example.com/acme/app#' .git/config", "app");
  expect((await run(allowed.shell, "git push origin pikit/self/x", "app")).output).toContain("origin is not a GitHub repository");

  const otherRepository = await started({ root: temporaryRoot(), git: { pushRepositories: ["acme/other"] } }, { GITHUB_TOKEN: TOKEN });
  await run(otherRepository.shell, "git clone https://github.com/acme/app && cd app && echo x >> README.md && git commit -m change");
  expect((await run(otherRepository.shell, "git push origin pikit/self/x", "app")).output).toContain("pushing to acme/app is not allowed here");

  const noToken = await started({ root: temporaryRoot(), git: { pushRepositories: ["acme/app"] } });
  expect((await run(noToken.shell, "git clone https://github.com/acme/app")).output).toContain("read-only");
  expect((await run(noToken.shell, "git push origin pikit/self/x", "app")).output).toContain("there is no GitHub token here");
  expect(github.pushes).toEqual([]);
  expect(github.pulls).toEqual([]);
  for (const each of [allowed, otherRepository, noToken]) await each.app.stop();
});

test("git clone: GitHub over HTTPS only, a private repository needs the token, a failed clone leaves nothing, and only inside the workspace", async () => {
  const github = await fakeGitHub();
  const { app, shell } = await started({ root: temporaryRoot() });
  expect((await run(shell, "git clone https://gitlab.com/acme/app")).exitCode).toBe(128);
  expect((await run(shell, "git clone https://github.com/acme/secret")).exitCode).toBe(128);
  expect(await run(shell, "ls")).toEqual({ exitCode: 0, output: "" });
  expect(await run(shell, "cd / && git clone https://github.com/acme/app")).toEqual({ exitCode: 128, output: expect.stringContaining("only inside the workspace") });

  // The server answers the discovery, then fails the download: the half-made clone is removed.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/git-upload-pack") ? new Response("Not Found", { status: 404 }) : github.fetch(input, init)) as typeof fetch;
  expect((await run(shell, "git clone https://github.com/acme/app")).exitCode).toBe(128);
  expect(await run(shell, "ls")).toEqual({ exitCode: 0, output: "" });

  const withToken = await started({ root: temporaryRoot() }, { GITHUB_TOKEN: TOKEN });
  globalThis.fetch = github.fetch as typeof fetch;
  expect((await run(withToken.shell, "git clone https://github.com/acme/secret && cat secret/README.md")).output).toContain("secret\n(second commit)\n");
  expect((await run(withToken.shell, "git clone https://github.com/acme/secret")).output).toContain("already exists");
  await app.stop();
  await withToken.app.stop();
});

test("git's program leaves with the app, and the token is never one of the commands' variables", async () => {
  const { app, shell } = await started({ root: temporaryRoot() });
  const program = (await run(shell, "command -v git")).output.trim();
  expect(existsSync(program)).toBe(true);
  await app.stop();
  expect(existsSync(program)).toBe(false);

  const refused = await defineApp({
    components: [executionLocal],
    config: { "execution-local": { root: temporaryRoot(), variables: ["PATH", "GITHUB_TOKEN"] } },
    logger: silentLogger,
  })
    .create()
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
  expect(String((refused as Error).message)).toContain("variables lists GITHUB_TOKEN");
});
