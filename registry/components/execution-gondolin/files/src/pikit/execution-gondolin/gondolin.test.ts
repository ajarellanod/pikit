/**
 * execution-gondolin over real Gondolin VMs (QEMU). Skipped, saying so, where QEMU is not installed.
 * The first boot on a machine downloads Gondolin's guest image (about 200 MB, into
 * `~/.cache/gondolin`), so the first case may take minutes; a boot then takes seconds.
 *
 * It runs pi-durable's `ExecutionEnv` conformance with a real shell on one VM (each case in a
 * directory of its own under `/workspace`), then what only a real VM shows: a conversation's shell
 * sees its own files and none of the host's, the network is closed but for allowed hosts, a secret
 * is a placeholder in the guest, a timeout kills what the command started, and a VM closed when idle
 * leaves its files for the next one.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type ComponentDefinition, defineApp, defineComponent, type Logger } from "@pikit/core";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { atCwd, BACKGROUND_CONTEXT } from "@pikit/pi-adapter/execution";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import executionGondolin from "./index.ts";
import { qemuProblem } from "./qemu.ts";

const ctx = BACKGROUND_CONTEXT;
const problem = qemuProblem();
/** Long enough for the first boot's image download. */
const BOOT_MS = 600_000;

const directories: string[] = [];
const apps: App[] = [];
afterAll(async () => {
  for (const app of apps) await app.stop();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-gondolin-it-")));
  directories.push(dir);
  return dir;
}

interface Running {
  app: App;
  root: string;
  workspace: WorkspaceProvider;
  env(id: string): Promise<ExecutionEnv>;
  logs: string[];
}

async function start(config: Record<string, unknown> = {}, providers: ComponentDefinition[] = []): Promise<Running> {
  const root = join(temporaryDir(), "gondolin");
  let workspace: WorkspaceProvider | undefined;
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const found = pikit.use("workspace");
      return { start: () => void (workspace = found.get()) };
    },
  });
  const logs: string[] = [];
  const logger: Logger = { debug: () => {}, info: (m) => void logs.push(m), warn: (m) => void logs.push(m), error: (m) => void logs.push(m) };
  const app = await defineApp({ components: [...providers, executionGondolin, reader], config: { "execution-gondolin": { root, ...config } }, logger }).create();
  await app.start();
  apps.push(app);
  const provider = workspace as WorkspaceProvider;
  return { app, root, workspace: provider, logs, env: async (id) => (await provider.resolve({ key: `it:${id}`, agent: "it", conversationId: id }, app.context())).env };
}

/** The directory under root of chat `it:<id>`'s agent `it` (the hex SHA-256 of the key, computed here). */
const chatDir = (id: string) => join("chats", new Bun.CryptoHasher("sha256").update(`it:${id}`).digest("hex"), "it");

async function sh(env: ExecutionEnv, command: string, options: Parameters<ExecutionEnv["exec"]>[1] = {}) {
  let output = "";
  const result = await env.exec(command, { ...options, onOutput: (text) => void (output += text) }, ctx);
  return { result, output };
}

if (problem !== undefined) {
  test.skip(`execution-gondolin over QEMU: skipped, ${problem}`, () => {});
} else {
  // One VM for the whole suite: each case in a new directory of one conversation's workspace.
  let shared: Promise<{ base: ExecutionEnv }> | undefined;
  let cases = 0;
  const sharedEnv = () =>
    (shared ??= start({ idleSeconds: 600 }).then(async (running) => {
      const base = await running.env("conformance");
      return { base };
    }));

  for (const c of createDurableExecutionConformance(async () => {
    const { base } = await sharedEnv();
    const dir = `/workspace/case-${++cases}`;
    const made = await base.createDir(dir, { recursive: true }, ctx);
    if (!made.ok) throw made.error;
    return { env: await atCwd(base, dir, ctx) };
  }, { expect, watch: false })) {
    test(`execution-gondolin over QEMU ${c.group}: ${c.name}`, () => c.run(), Math.max(c.timeoutMs ?? 0, BOOT_MS));
  }

  test("a conversation's shell sees its own files, and none of another conversation's or of the host", async () => {
    const running = await start();
    const one = await running.env("1");
    const two = await running.env("2");
    expect((await one.writeFile("mine.txt", "one's", ctx)).ok).toBe(true);
    // The server's state, next to the sandboxes on the host.
    const sentinel = join(running.root, "state-sentinel.txt");
    writeFileSync(sentinel, "every conversation");

    const own = await sh(one, "cat /workspace/mine.txt");
    const other = await sh(two, `ls -A /workspace; test -e '${sentinel}' && echo host-visible; test -e '${join(running.root, chatDir("1"))}' && echo sibling-visible; echo done`);

    expect(own.output).toBe("one's");
    expect(other.output).toBe("done\n");
    expect(other.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  }, BOOT_MS);

  test("the network is closed but for allowed hosts, and a secret is a placeholder in the guest", async () => {
    const value = "pikit-it-secret-value-0123456789";
    const secrets = defineComponent({
      name: "secrets-it",
      setup(pikit) {
        pikit.provide("secrets", { get: async (name: string) => (name === "IT_TOKEN" ? value : undefined) });
      },
    });
    const running = await start({ secrets: [{ name: "IT_TOKEN", hosts: ["api.example.invalid"] }] }, [secrets]);
    const env = await running.env("net");

    const seen = await sh(env, 'printf "%s" "$IT_TOKEN"');
    const blocked = await sh(env, "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com/");

    expect(seen.output).not.toBe("");
    expect(seen.output).not.toContain(value);
    // Gondolin answers a host that is not allowed itself, without going out.
    expect(blocked.output).toBe("403");
    expect(running.logs.join("\n")).not.toContain(value);
  }, BOOT_MS);

  test("a timeout kills the command and every process it started", async () => {
    const running = await start();
    const env = await running.env("kill");

    const timedOut = await sh(env, "sleep 301 & sleep 302; echo never", { timeout: 1 });
    const left = await sh(env, "ps -o args | grep -c '^sleep 30[12]' || true");

    expect(timedOut.result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(timedOut.output).not.toContain("never");
    expect(left.output.trim()).toBe("0");
  }, BOOT_MS);

  test("what a command writes in /workspace is on the host; an idle VM is closed, and the next one finds the files, also after a reset of the chat", async () => {
    const running = await start({ idleSeconds: 1 });
    const env = await running.env("idle");

    const wrote = await sh(env, "echo kept > made.txt; echo gone > /root/scratch.txt");
    expect(wrote.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(readFileSync(join(running.root, chatDir("idle"), "made.txt"), "utf8")).toBe("kept\n");

    const deadline = Date.now() + 30_000;
    while (!running.logs.includes("execution-gondolin: closing an idle VM")) {
      if (Date.now() > deadline) throw new Error("the idle VM was not closed");
      await Bun.sleep(100);
    }
    const again = await sh(env, "cat made.txt; test -e /root/scratch.txt && echo scratch-survived; true");

    expect(again.output).toBe("kept\n");
    expect(existsSync(join(running.root, chatDir("idle"), "made.txt"))).toBe(true);
    // A reset of the chat (/new: a new conversationId under the same key) is the same sandbox: its shell finds the file.
    const reset = (await running.workspace.resolve({ key: "it:idle", agent: "it", conversationId: "after-new" }, running.app.context())).env;
    expect((await sh(reset, "cat made.txt")).output).toBe("kept\n");
  }, BOOT_MS);
}
