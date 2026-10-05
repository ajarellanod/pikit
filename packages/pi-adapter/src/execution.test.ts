/**
 * The `execution` contract on pi-durable: the suite (`execution-testing.ts`) holds on pi-durable's own
 * `NodeExecutionEnv` (the reference), with and without a shell, and on `createLocalExecution`, whose
 * commands never see this process's environment. `harnessEnv` picks a conversation's workspace, else
 * `execution`, at the agent's `cwd`.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { atCwd, BACKGROUND_CONTEXT, err, type ExecutionEnv, ExecutionError, getOrThrow, harnessEnv } from "./execution.ts";
import { createDurableExecutionConformance } from "./testing/execution.ts";
import { createLocalExecution, NodeExecutionEnv } from "./node.ts";

const ctx = BACKGROUND_CONTEXT;

function temporary() {
  // The real path: on macOS the temporary directory is behind a symlink, and `pwd -P` resolves it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-durable-execution-")));
  return { dir, dispose: async () => rmSync(dir, { recursive: true, force: true }) };
}

for (const c of createDurableExecutionConformance(() => {
  const { dir, dispose } = temporary();
  return { env: new NodeExecutionEnv({ cwd: dir }), dispose };
}, { expect })) {
  test(`pi-durable NodeExecutionEnv ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

/** pi-durable's filesystem with no shell: what an edge environment provides as `execution` only. */
class NoShell extends NodeExecutionEnv {
  override async exec(): ReturnType<ExecutionEnv["exec"]> {
    return err(new ExecutionError("shell_unavailable", "this environment has no shell"));
  }
}

for (const c of createDurableExecutionConformance(() => {
  const { dir, dispose } = temporary();
  return { env: new NoShell({ cwd: dir }), dispose };
}, { expect, shell: false })) {
  test(`without a shell ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

for (const c of createDurableExecutionConformance(() => {
  const { dir, dispose } = temporary();
  return { env: createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "" } }), dispose };
}, { expect })) {
  test(`local ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

test("a local command sees the variables given, not this process's environment", async () => {
  const { dir, dispose } = temporary();
  // Stands in for a secret of the server, such as PIKIT_HTTP_TOKEN.
  process.env.PIKIT_DURABLE_LOCAL_SECRET = "server-secret";
  const env = createLocalExecution({ cwd: dir, env: { PIKIT_GIVEN: "given" } });
  try {
    getOrThrow(await env.exec('printf "%s|%s|%s" "${PIKIT_GIVEN:-}" "${PIKIT_DURABLE_LOCAL_SECRET:-absent}" "${EXTRA:-}" > seen.txt', { env: { EXTRA: "extra" } }, ctx));
    getOrThrow(await env.exec('printf "%s" "${PIKIT_GIVEN:-absent}" > only.txt', { inheritEnv: false }, ctx));
  } finally {
    delete process.env.PIKIT_DURABLE_LOCAL_SECRET;
  }

  expect(readFileSync(join(dir, "seen.txt"), "utf8")).toBe("given|absent|extra");
  expect(readFileSync(join(dir, "only.txt"), "utf8")).toBe("absent");
  expect(env.id).toBe("node:local");
  await dispose();
});

const target = (cwd?: string): EnvTarget => ({ conversationId: 7 as unknown as EnvTarget["conversationId"], ...(cwd !== undefined && { cwd }), read: undefined as never });

test("harnessEnv: the conversation's workspace when there is one, otherwise execution, otherwise none", async () => {
  const { dir, dispose } = temporary();
  const execution = createLocalExecution({ cwd: dir, env: {} });
  const workspace = createLocalExecution({ cwd: join(dir, "agent"), env: {} });
  const asked: unknown[] = [];

  const withWorkspace = harnessEnv({
    execution: () => execution,
    workspace: async (t) => {
      asked.push(t.conversationId);
      return workspace;
    },
  });
  expect(await withWorkspace(target(), ctx)).toBe(workspace);
  expect(asked).toEqual([7]);
  expect(await harnessEnv({ execution: () => execution, workspace: async () => undefined })(target(), ctx)).toBe(execution);
  expect(await harnessEnv({ execution: () => execution })(target(), ctx)).toBe(execution);
  expect(await harnessEnv({ execution: () => undefined })(target("sub"), ctx)).toBeUndefined();
  await dispose();
});

test("harnessEnv at the agent's cwd: the same files, id and shell, another working directory", async () => {
  const { dir, dispose } = temporary();
  mkdirSync(join(dir, "sub"));
  const execution = createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "" } });
  const env = await harnessEnv({ execution: () => execution })(target("sub"), ctx);
  if (env === undefined) throw new Error("no environment");

  expect([env.cwd, env.id, execution.cwd]).toEqual([join(dir, "sub"), execution.id, dir]);
  getOrThrow(await env.writeFile("here.txt", "in sub", ctx));
  getOrThrow(await env.exec("pwd -P > where.txt", undefined, ctx));
  expect(readFileSync(join(dir, "sub", "here.txt"), "utf8")).toBe("in sub");
  expect(readFileSync(join(dir, "sub", "where.txt"), "utf8").trim()).toBe(join(dir, "sub"));
  // The same cwd, absolute or not, is the environment itself.
  expect(await atCwd(execution, dir, ctx)).toBe(execution);
  expect(await atCwd(execution, ".", ctx)).toBe(execution);
  await dispose();
});
