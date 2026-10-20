/**
 * The whole remote path on real micro-VMs: a client App with execution-remote, and a sandbox host
 * App of server-bun, execution-serve and execution-gondolin (QEMU), over HTTP on 127.0.0.1. What the
 * other tests prove apart, together: a command runs in a Linux guest, a file written through the
 * remote file API is the guest's `/workspace`, a reset of the chat and a delegated child of the same
 * agent find it again, two conversations' sandboxes see nothing of each
 * other, the host's files are out of reach, and each agent boots its own machine (features/
 * agent-sandboxes.md): the developer's profile holds a secret placeholder, an agent with no profile
 * gets the base (no secret, no network), and the two never share a VM or a file.
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
const GH_TOKEN = "ghp_the-real-value-never-in-a-guest-0123456789";
const problem = qemuProblem();

const conversation = (key: string, agent = "assistant"): ConversationRef => ({ key, agent, conversationId: `c-${key}` });

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
      components: [secretsOf({ PIKIT_SANDBOX_TOKEN: TOKEN, GH_TOKEN }), executionGondolin, executionServe, createServerBun({ onListening: (listening) => void (url = listening) })],
      config: {
        "server-bun": { port: 0, hostname: "127.0.0.1" },
        "execution-gondolin": {
          root,
          maxVms: 2,
          idleSeconds: 30,
          agents: { developer: { secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com"] }] } },
        },
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

  test("a reset of the chat (/new) and a delegated child of the same agent find the files; a child of another agent does not", async () => {
    const origin = conversation("carol");
    const { env } = await workspace.resolve(origin, ctx);
    expect((await run(env, "echo before > kept.txt")).exitCode).toBe(0);

    const reset = (await workspace.resolve({ ...origin, conversationId: "c-carol-after-new" }, ctx)).env;
    const child = (await workspace.resolve({ key: "delegate:1:assistant:t-1", agent: "assistant", conversationId: "c-carol-child", channel: "delegate", origin }, ctx)).env;
    const other = (await workspace.resolve({ key: "delegate:1:assistant:t-2", agent: "helper", conversationId: "c-carol-helper", channel: "delegate", origin }, ctx)).env;
    expect((await run(reset, "cat kept.txt")).out).toBe("before\n");
    expect((await run(child, "cat kept.txt")).out).toBe("before\n");
    expect((await run(other, "cat /workspace/kept.txt 2>/dev/null || echo absent")).out).toBe("absent\n");
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

  test("each agent of one conversation boots its own machine: the developer's secret is a placeholder only it holds", async () => {
    const developer = (await workspace.resolve(conversation("team", "developer"), ctx)).env;
    const assistant = (await workspace.resolve(conversation("team"), ctx)).env;
    expect(developer).not.toBe(assistant); // both see /workspace, each its own

    const held = await run(developer, 'printf "%s" "${GH_TOKEN:-unset}"');
    expect(held.exitCode).toBe(0);
    expect(held.out).not.toBe("unset");
    expect(held.out).not.toContain(GH_TOKEN);
    const none = await run(assistant, 'printf "%s" "${GH_TOKEN:-unset}"');
    expect(none.out).toBe("unset");
    // The base machine reaches nothing, the secret's host included (Gondolin answers 403 itself).
    const blocked = await run(assistant, "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://api.github.com/");
    expect(blocked.out).toBe("403");

    expect((await run(developer, "echo developer > mine.txt")).exitCode).toBe(0);
    expect((await run(assistant, "cat /workspace/mine.txt 2>/dev/null || echo absent")).out).toBe("absent\n");
  }, 300_000);
}

/** `name` inside `env`'s working directory. */
async function joined(env: ExecutionEnv, name: string): Promise<string> {
  const path = await env.absolutePath(name, ctx);
  if (!path.ok) throw path.error;
  return path.value;
}
