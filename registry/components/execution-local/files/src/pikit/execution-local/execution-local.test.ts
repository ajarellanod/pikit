/**
 * execution-local's tests. They are copied with the component and keep running in your project.
 * Every environment works in a temporary directory.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { createExecutionConformance } from "@pikit/pi-adapter/testing";
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
  const app = await defineApp({ components: [executionLocal, reader], config: { "execution-local": config }, logger: silentLogger }).create();
  await app.start();
  if (found === undefined) throw new Error("execution was not resolved");
  return { app, ...found };
}

// Pi's ExecutionEnv contract, with a shell (SPEC §14).
for (const c of createExecutionConformance(async () => {
  const { app, shell } = await started({ root: temporaryRoot() });
  return { env: shell, shell: true, dispose: () => app.stop() };
})) {
  test(`execution-local ${c.group}: ${c.name}`, () => c.run());
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
