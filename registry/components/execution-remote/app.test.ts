/**
 * execution-remote against a real execution-serve: the client's App (secrets, execution-remote) and a
 * sandbox host's App (server-bun on `Bun.serve`, execution-serve, a provider keyed as
 * execution-gondolin's over execution-local in a temporary directory: `sandbox-host.test-support.ts`),
 * talking HTTP on 127.0.0.1. pi-durable's `ExecutionEnv` suite and the `workspace` suite pass end to
 * end; pi-durable's own tools work on it; a sandbox per conversation key and agent on a server, per
 * object and agent on Cloudflare; workspace-local behind the host, a directory per agent; what a
 * command and a read cost in requests.
 *
 * A repository test, not copied with the component: it imports other components' files (SPEC P4),
 * so it lives beside `files/`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type App, BACKGROUND_CONTEXT, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { createDurableExecutionConformance, runToolCalls } from "@pikit/pi-adapter/execution/testing";
import { createWorkspaceConformance } from "@pikit/pi-adapter/testing";
import { withAbortSignal } from "@pikit/pi-adapter/execution";
import { createBashTool, createReadTool, createWriteTool } from "@pikit/pi-adapter/tools";
import executionRemote, { keySandbox, objectSandbox } from "./files/src/pikit/execution-remote/index.ts";
import { type SandboxHost, secretsOf, startSandboxHost } from "./sandbox-host.test-support.ts";

const ctx = BACKGROUND_CONTEXT;
const TOKEN = "sandbox-token-for-the-tests-0123456789";

let host: SandboxHost;
let client: { app: App; workspace: WorkspaceProvider; execution: ExecutionEnv };

/** A client App on `host`, with `components` (a Durable Object's host, for one) around execution-remote. */
async function startClient(wrap: (components: ReturnType<typeof defineComponent>[]) => ReturnType<typeof defineComponent>[] = (c) => c, on: SandboxHost = host) {
  let workspace: Handle<WorkspaceProvider> | undefined;
  let execution: Handle<ExecutionEnv> | undefined;
  const reader = defineComponent({
    name: "reader-test",
    setup(pikit) {
      workspace = pikit.use("workspace");
      execution = pikit.use("execution.shell");
    },
  });
  const app = await defineApp({
    components: [secretsOf({ PIKIT_SANDBOX_TOKEN: TOKEN }), ...wrap([executionRemote]), reader],
    config: { "execution-remote": { endpoint: on.url.origin } },
    logger: silentLogger,
  }).create();
  await app.start();
  return { app, workspace: (workspace as Handle<WorkspaceProvider>).get(), execution: (execution as Handle<ExecutionEnv>).get() };
}

let cases = 0;
const conversation = (key: string, agent = "assistant"): ConversationRef => ({ key, agent, conversationId: `conversation-${key}` });

beforeAll(async () => {
  host = await startSandboxHost({ token: TOKEN });
  client = await startClient();
});

afterAll(async () => {
  await client?.app.stop();
  await host?.stop();
});

test("execution-remote and execution-serve carry identical copies of protocol.ts", () => {
  const remote = readFileSync(join(import.meta.dir, "files/src/pikit/execution-remote/protocol.ts"), "utf8");
  const serve = readFileSync(join(import.meta.dir, "../execution-serve/files/src/pikit/execution-serve/protocol.ts"), "utf8");
  expect(remote).toBe(serve);
});

// pi-durable's ExecutionEnv contract, end to end: each case in a sandbox of its own (a new conversation key).
for (const c of createDurableExecutionConformance(async () => ({ env: (await client.workspace.resolve(conversation(`conformance:${++cases}`), ctx)).env }), { expect, watch: false })) {
  test(`execution-remote ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs ?? 20_000);
}

// The workspace contract: a conversation finds its files again; two conversations are apart.
for (const c of createWorkspaceConformance(async () => {
  const fresh = await startClient();
  return { provider: fresh.workspace, dispose: () => fresh.app.stop() };
})) {
  test(`execution-remote ${c.group}: ${c.name}`, () => c.run());
}

test("on a server, each conversation key and agent has its own sandbox, k-<SHA-256 of key and agent>, resolved for that agent; execution alone works in `shared`, for no agent", async () => {
  const one = (await client.workspace.resolve(conversation("telegram:1"), ctx)).env;
  const again = (await client.workspace.resolve({ ...conversation("telegram:1"), conversationId: "after-a-reset" }, ctx)).env;
  const other = (await client.workspace.resolve(conversation("telegram:1", "other-agent"), ctx)).env;
  const two = (await client.workspace.resolve(conversation("telegram:2"), ctx)).env;
  await one.writeFile("mine.txt", "one's", ctx);
  await client.execution.writeFile("shared.txt", "shared", ctx);

  const sandbox = await keySandbox("telegram:1", "assistant");
  expect(sandbox).toMatch(/^k-[0-9a-f]{64}$/);
  // The host resolved it as `remote-<sandbox>` for the agent the header named.
  expect(one.cwd).toBe(join(host.root, "sandboxes", `remote-${sandbox}`, "assistant"));
  expect(again).toBe(one);
  expect(other.cwd).toBe(join(host.root, "sandboxes", `remote-${await keySandbox("telegram:1", "other-agent")}`, "other-agent"));
  expect(await other.exists("mine.txt", ctx)).toEqual({ ok: true, value: false });
  expect(await two.exists("mine.txt", ctx)).toEqual({ ok: true, value: false });
  expect(existsSync(join(host.root, "sandboxes", "remote-shared", "_shared", "shared.txt"))).toBe(true);
  expect(one.id).toBe(`execution-remote:${host.url.origin}#${sandbox}`);
});

test("in a Durable Object, each agent of the object works in a sandbox of its own, o-<SHA-256 of object and agent>: a delegated child of another agent too", async () => {
  const objectId = "0123456789abcdef".repeat(4);
  const object = { id: objectId, storage: {}, onAlarm() {}, onDeliver() {} };
  const durable = await startClient((components) => withWorkersHost({ env: {}, object }, components));
  try {
    const root = (await durable.workspace.resolve(conversation("telegram:9"), ctx)).env;
    const child = (await durable.workspace.resolve({ ...conversation("delegate:1:task-1", "helper"), channel: "delegate" }, ctx)).env;
    const sameAgent = (await durable.workspace.resolve({ ...conversation("delegate:1:task-2"), channel: "delegate" }, ctx)).env;
    await root.writeFile("plan.md", "# Plan", ctx);

    const sandbox = await objectSandbox(objectId, "assistant");
    expect(sandbox).toMatch(/^o-[0-9a-f]{64}$/);
    expect(root.cwd).toBe(join(host.root, "sandboxes", `remote-${sandbox}`, "assistant"));
    expect(child.cwd).toBe(join(host.root, "sandboxes", `remote-${await objectSandbox(objectId, "helper")}`, "helper"));
    expect(await child.exists("plan.md", ctx)).toEqual({ ok: true, value: false });
    // A child of the same agent shares its parent's sandbox.
    expect(sameAgent).toBe(root);
    // `execution` alone is the object's own, for no agent.
    expect(durable.execution).not.toBe(root);
    await durable.execution.writeFile("own.txt", "own", ctx);
    expect(existsSync(join(host.root, "sandboxes", `remote-o-${objectId}`, `_o-${objectId}`, "own.txt"))).toBe(true);
  } finally {
    await durable.app.stop();
  }
});

test("behind workspace-local, the host gives each agent a directory, whatever the conversation", async () => {
  const local = await startSandboxHost({ token: TOKEN, workspace: "workspace-local" });
  const remote = await startClient(undefined, local);
  try {
    const one = (await remote.workspace.resolve(conversation("telegram:1", "developer"), ctx)).env;
    const two = (await remote.workspace.resolve(conversation("telegram:2", "developer"), ctx)).env;
    const analyst = (await remote.workspace.resolve(conversation("telegram:1", "analyst"), ctx)).env;
    await one.writeFile("mine.txt", "developer's", ctx);

    expect(one.cwd).toBe(join(local.root, "sandboxes", "developer"));
    expect(two.cwd).toBe(one.cwd);
    expect(await two.readTextFile("mine.txt", ctx)).toEqual({ ok: true, value: "developer's" });
    expect(analyst.cwd).toBe(join(local.root, "sandboxes", "analyst"));
    expect(await analyst.exists("mine.txt", ctx)).toEqual({ ok: true, value: false });
  } finally {
    await remote.app.stop();
    await local.stop();
  }
});

test("pi-durable's own write, read and bash tools work on a remote sandbox, a long output through the window", async () => {
  const env = (await client.workspace.resolve(conversation("tools"), ctx)).env;
  const results = await runToolCalls({
    tools: [createWriteTool(), createReadTool(), createBashTool()],
    env: () => env,
    calls: [
      { name: "write", args: { path: "notes/plan.md", content: "# Plan\n\n- clone\n- change\n" } },
      { name: "read", args: { path: "notes/plan.md" } },
      { name: "bash", args: { command: "wc -l < notes/plan.md; i=0; while [ $i -lt 5000 ]; do echo line-$i; i=$((i+1)); done" } },
    ],
  });

  expect(results.map((result) => [result.name, result.isError])).toEqual([
    ["write", false],
    ["read", false],
    ["bash", false],
  ]);
  expect(results[1]?.text).toBe("# Plan\n\n- clone\n- change\n");
  // The Harness keeps the tail; the whole output is in the sandbox, whose path it gives.
  expect(results[2]?.text).toContain("line-4999");
  expect(results[2]?.text).not.toContain("line-10\n");
  const spill = /Full output: (\S+)/.exec(results[2]?.text ?? "")?.[1];
  expect(spill).toBeDefined();
  const whole = await env.readTextFile(spill as string, ctx);
  expect(whole.ok ? whole.value : "").toMatch(/^\s*4\nline-0\nline-1\n[\s\S]*line-4999\n$/);
});

test("a command that ends quickly costs one request, a small file's read one, and a relative path none", async () => {
  const env = (await client.workspace.resolve(conversation("requests"), ctx)).env;
  await env.writeFile("a.txt", "hello\n", ctx);
  const realFetch = globalThis.fetch;
  const operations: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    operations.push(String(input).split("/").at(-1) ?? "");
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    let output = "";
    const run = await env.exec("echo hi", { onOutput: (text) => void (output += text) }, ctx);
    expect(run.ok && run.value.exitCode).toBe(0);
    expect(output).toBe("hi\n");
    const reader = await env.openBinaryReader("a.txt", undefined, ctx);
    if (!reader.ok) throw reader.error;
    expect(await reader.value.scanLines({ startLine: 0 }, ctx)).toMatchObject({ ok: true, value: { newlines: 1 } });
    await reader.value.close(ctx);
    expect(await env.absolutePath("sub/../b.txt", ctx)).toEqual({ ok: true, value: join(env.cwd, "b.txt") });
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(operations).toEqual(["execStart", "openBinaryReader"]);
});

test("a cancelled command is stopped on the host: its process does not run on", async () => {
  const env = (await client.workspace.resolve(conversation("cancel"), ctx)).env;
  const controller = new AbortController();
  const running = env.exec("echo $$ > pid; sleep 30; echo late > late.txt", undefined, withAbortSignal(controller.signal, ctx));
  await waitFor(async () => (await env.exists("pid", ctx)).ok && (await env.readTextFile("pid", ctx)).ok);
  controller.abort();
  const result = await running;

  expect(result.ok ? "ok" : result.error.code).toBe("aborted");
  const pid = await env.readTextFile("pid", ctx);
  if (!pid.ok) throw pid.error;
  await waitFor(async () => !alive(Number(pid.value)));
  expect(await env.exists("late.txt", ctx)).toEqual({ ok: true, value: false });
});

test("a host that refuses the token: the client's operations fail as permission_denied, its commands as unknown, nothing throws", async () => {
  let env: ExecutionEnv | undefined;
  let workspace: WorkspaceProvider | undefined;
  const reading = await defineApp({
    components: [
      secretsOf({ PIKIT_SANDBOX_TOKEN: `${TOKEN}-wrong` }),
      executionRemote,
      defineComponent({
        name: "reader-test",
        setup(pikit) {
          const execution = pikit.use("execution.shell");
          const provided = pikit.use("workspace");
          return {
            start() {
              env = execution.get();
              workspace = provided.get();
            },
          };
        },
      }),
    ],
    config: { "execution-remote": { endpoint: host.url.origin } },
    logger: silentLogger,
  }).create();
  await reading.start();
  try {
    const read = await (env as ExecutionEnv).readTextFile("x", ctx);
    expect(read.ok ? "ok" : read.error.code).toBe("permission_denied");
    const run = await (env as ExecutionEnv).exec("echo hi", undefined, ctx);
    expect(run.ok ? "ok" : run.error.code).toBe("unknown");
    await expect((workspace as WorkspaceProvider).resolve(conversation("refused"), ctx)).rejects.toThrow("unauthorized");
  } finally {
    await reading.stop();
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await Bun.sleep(20);
  }
}
