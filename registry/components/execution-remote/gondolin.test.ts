/**
 * The whole remote path on real micro-VMs: a client App with execution-remote, and a sandbox host
 * App of server-bun, execution-serve and execution-gondolin (QEMU), over HTTP on 127.0.0.1. What the
 * other tests prove apart, together: a command runs in a Linux guest, a file written through the
 * remote file API is the guest's `/workspace`, two conversations' sandboxes see nothing of each
 * other, and the host's files are out of reach.
 *
 * Skipped, saying so, when QEMU is missing (execution-gondolin's own rule). A repository test, not
 * copied with either component: it imports other components' files (SPEC P4).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, BACKGROUND_CONTEXT, defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import executionGondolin from "../execution-gondolin/files/src/pikit/execution-gondolin/index.ts";
import { qemuProblem } from "../execution-gondolin/files/src/pikit/execution-gondolin/qemu.ts";
import executionServe from "../execution-serve/files/src/pikit/execution-serve/index.ts";
import { createServerBun } from "../server-bun/files/src/pikit/server-bun/index.ts";
import executionRemote from "./files/src/pikit/execution-remote/index.ts";
import { secretsOf } from "./sandbox-host.test-support.ts";

const ctx = BACKGROUND_CONTEXT;
const TOKEN = "sandbox-token-for-the-gondolin-test-0123456789";
const problem = qemuProblem();

const conversation = (key: string): ConversationRef => ({ key, agent: "assistant", conversationId: `c-${key}` });

/** Runs `command` in `env`, its stdout and exit code. */
async function run(env: ExecutionEnv, command: string): Promise<{ exitCode: number | undefined; out: string }> {
  let out = "";
  const result = await env.exec(command, { onOutput: (text: string) => void (out += text), timeout: 60 }, ctx);
  return { exitCode: result.ok ? result.value.exitCode : undefined, out };
}

if (problem !== undefined) {
  test.skip(`execution-remote over execution-gondolin: skipped, ${problem}`, () => {});
} else {
  let root: string;
  let host: App;
  let client: App;
  let workspace: WorkspaceProvider;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pikit-remote-gondolin-"));
    let url: URL | undefined;
    host = await defineApp({
      components: [secretsOf({ PIKIT_SANDBOX_TOKEN: TOKEN }), executionGondolin, executionServe, createServerBun({ onListening: (listening) => void (url = listening) })],
      config: {
        "server-bun": { port: 0, hostname: "127.0.0.1" },
        "execution-gondolin": { root, maxVms: 2, idleSeconds: 30 },
      },
      logger: silentLogger,
    }).create();
    await host.start();
    if (url === undefined) throw new Error("the sandbox host did not listen");

    let handle: Handle<WorkspaceProvider> | undefined;
    const reader = defineComponent({ name: "reader-test", setup: (pikit) => void (handle = pikit.use("workspace")) });
    client = await defineApp({
      components: [secretsOf({ PIKIT_SANDBOX_TOKEN: TOKEN }), executionRemote, reader],
      config: { "execution-remote": { endpoint: url.origin } },
      logger: silentLogger,
    }).create();
    await client.start();
    workspace = (handle as Handle<WorkspaceProvider>).get();
  }, 300_000);

  afterAll(async () => {
    await client?.stop();
    await host?.stop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  test("a command runs in a Linux guest, on the files the remote file API wrote", async () => {
    const { env } = await workspace.resolve(conversation("alice"), ctx);
    const written = await env.writeFile(await joined(env, "note.txt"), "from the client", ctx);
    expect(written.ok).toBe(true);

    const uname = await run(env, "uname -s");
    expect(uname).toEqual({ exitCode: 0, out: "Linux\n" });
    const cat = await run(env, "cat note.txt && pwd");
    expect(cat.exitCode).toBe(0);
    expect(cat.out).toBe("from the client/workspace\n"); // the file has no newline of its own
  }, 300_000);

  test("two conversations' sandboxes see nothing of each other, and the host is out of reach", async () => {
    const alice = (await workspace.resolve(conversation("alice"), ctx)).env;
    const bob = (await workspace.resolve(conversation("bob"), ctx)).env;
    expect((await run(alice, "echo alice > mine.txt")).exitCode).toBe(0);

    const seen = await run(bob, "ls /workspace; cat /workspace/mine.txt 2>/dev/null || echo absent");
    expect(seen.out).toBe("absent\n");
    // The host's sandbox root (alice's files among them) is no path in the guest.
    const hostFiles = await run(bob, `ls ${JSON.stringify(root)} 2>/dev/null || echo unreachable`);
    expect(hostFiles.out).toBe("unreachable\n");
  }, 300_000);
}

/** `name` inside `env`'s working directory. */
async function joined(env: ExecutionEnv, name: string): Promise<string> {
  const path = await env.absolutePath(name, ctx);
  if (!path.ok) throw path.error;
  return path.value;
}
