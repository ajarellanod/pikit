/**
 * execution-gondolin's snapshots (`snapshots.ts`) over the fake guest: a chat's sandbox idle for
 * `idleMinutes` has its VM closed, its workspace saved to `storage.blob` (the memory double) and
 * deleted here; its next use restores the same bytes and modes before anything runs; a sandbox with a
 * command running is never released; a shared one never; another host restores it.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStorage, SNAPSHOT_NAMESPACE } from "@pikit/contracts";
import { snapshotIdOf } from "@pikit/contracts/snapshots";
import { createMemoryBlobStorage } from "@pikit/contracts/testing";
import { type App, defineApp, defineComponent, type Logger } from "@pikit/core";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT } from "@pikit/pi-adapter/execution";
import { FakeLauncher } from "./fake-guest.test-support.ts";
import { createExecutionGondolin, TMP_DIR } from "./index.ts";
import { SNAPSHOTS_DIR } from "./snapshots.ts";

const ctx = BACKGROUND_CONTEXT;
const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
const temporaryDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-gondolin-snapshots-")));
  directories.push(dir);
  return dir;
};
const chat = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex");

interface Started {
  app: App;
  launcher: FakeLauncher;
  root: string;
  clock: ManualClock;
  storage: BlobStorage;
  env(key: string, agent?: string): Promise<ExecutionEnv>;
  logs: { level: string; message: string }[];
}

async function started(config: Record<string, unknown> = { snapshots: {} }, options: { storage?: BlobStorage; withBlob?: boolean; root?: string } = {}): Promise<Started> {
  const launcher = new FakeLauncher();
  const root = options.root ?? join(temporaryDir(), "gondolin");
  const storage = options.storage ?? createMemoryBlobStorage({ maxStreamBytes: 2 ** 30 });
  let workspace: WorkspaceProvider | undefined;
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const handle = pikit.use("workspace");
      return { start: () => void (workspace = handle.get()) };
    },
  });
  const blob = defineComponent({ name: "storage-blob-test", setup: (pikit) => void pikit.provide("storage.blob", storage) });
  const logs: Started["logs"] = [];
  const push = (level: string) => (message: string) => void logs.push({ level, message });
  const logger: Logger = { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
  const clock = createManualClock(Date.now());
  const app = await defineApp({
    components: [...(options.withBlob === false ? [] : [blob]), createExecutionGondolin(launcher), reader],
    // A VM that would stay up for an hour: the snapshot closes it first.
    config: { "execution-gondolin": { root, idleSeconds: 3600, ...config } },
    logger,
    clock,
  }).create();
  await app.start();
  const found = workspace as WorkspaceProvider;
  return { app, launcher, root, clock, storage, logs, env: async (key, agent = "support") => (await found.resolve({ key, agent, conversationId: `${agent}-${key}` }, app.context())).env };
}

const keysOf = async (s: Started, key: string, agent = "support") => (await s.storage.namespace(SNAPSHOT_NAMESPACE).list(`${snapshotIdOf(key, agent)}/`)).entries.map((entry) => entry.key.slice(65));
async function idle(s: Started, minutes: number): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    await s.clock.advance(60_000);
    await Bun.sleep(20);
  }
}
const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
};

test("a chat's sandbox idle for 10 minutes: its VM closed, its workspace in the bucket and deleted here; the next use restores the same bytes and modes", async () => {
  const s = await started();
  const env = await s.env("test:snap");
  expect((await env.writeFile("/workspace/notes.md", "# notes", ctx)).ok).toBe(true);
  expect((await env.writeFile("/workspace/bin/run.sh", "echo run", ctx)).ok).toBe(true);
  const host = join(s.root, "chats", chat("test:snap"), "support");
  chmodSync(join(host, "bin", "run.sh"), 0o750);
  symlinkSync("bin/run.sh", join(host, "run"));
  expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
  expect(s.launcher.live).toHaveLength(1);
  expect(existsSync(join(s.root, TMP_DIR, "chats", chat("test:snap"), "support"))).toBe(true);

  await idle(s, 9);
  expect(existsSync(host)).toBe(true);
  expect(s.launcher.live).toHaveLength(1);
  await idle(s, 3);
  await until(() => !existsSync(host));
  expect(s.launcher.live).toHaveLength(0);
  expect(existsSync(join(s.root, TMP_DIR, "chats", chat("test:snap"), "support"))).toBe(false);
  const keys = await keysOf(s, "test:snap");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe("manifest.json");
  expect(s.logs.some((log) => log.message === "execution-gondolin: closing an idle VM, for its workspace's snapshot")).toBe(true);

  // The next resolve restores it before the tool runs; the next command's VM mounts it.
  const again = await s.env("test:snap");
  expect(await again.readTextFile("/workspace/notes.md", ctx)).toEqual({ ok: true, value: "# notes" });
  expect(statSync(join(host, "bin", "run.sh")).mode & 0o777).toBe(0o750);
  expect(readlinkSync(join(host, "run"))).toBe("bin/run.sh");
  expect((await again.exec("true", undefined, ctx)).ok).toBe(true);
  expect(s.launcher.live.at(-1)?.spec.mounts["/workspace"]).toBe(host);
  await s.app.stop();
});

test("a sandbox with a command running is never released, however long; it goes once the command ended", async () => {
  const s = await started();
  s.launcher.respond = (command) => (command.command === "hang" ? { hang: true } : { exitCode: 0 });
  const env = await s.env("test:busy");
  expect((await env.writeFile("/workspace/a.txt", "a", ctx)).ok).toBe(true);
  const command = env.exec("hang", undefined, ctx);
  await until(() => s.launcher.guests.some((guest) => guest.running === 1));
  const host = join(s.root, "chats", chat("test:busy"), "support");
  await idle(s, 30);
  expect(existsSync(host)).toBe(true);
  expect(s.launcher.live).toHaveLength(1);
  expect(await keysOf(s, "test:busy")).toEqual([]);
  await env.cleanup(ctx);
  await command;
  await idle(s, 1);
  await until(() => !existsSync(host));
  expect(await keysOf(s, "test:busy")).toHaveLength(2);
  await s.app.stop();
});

test("a VM booted while the checkpoint runs (an environment held, no resolve) keeps the workspace here", async () => {
  const base = createMemoryBlobStorage({ maxStreamBytes: 2 ** 30 });
  let onUpload: () => Promise<void> = async () => {};
  const storage: BlobStorage = {
    ...base,
    namespace: (name) => {
      const store = base.namespace(name);
      return { ...store, putStream: async (key, body, options) => (await onUpload(), await store.putStream(key, body, options)) };
    },
  };
  const s = await started({ snapshots: {} }, { storage });
  const env = await s.env("test:held");
  expect((await env.writeFile("/workspace/a.txt", "a", ctx)).ok).toBe(true);
  onUpload = async () => {
    onUpload = async () => {};
    expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
  };
  await idle(s, 10);
  await until(() => s.launcher.guests.length === 1);
  await Bun.sleep(100);
  expect(s.launcher.live).toHaveLength(1);
  const host = join(s.root, "chats", chat("test:held"), "support");
  expect(existsSync(join(host, "a.txt"))).toBe(true);
  // Still unused: the next sweep closes that VM first, then releases it.
  await idle(s, 1);
  await until(() => !existsSync(host));
  expect(s.launcher.live).toHaveLength(0);
  await s.app.stop();
});

test("a shared sandbox (workspace: \"agent\") is never released; a new host restores a chat's sandbox from the bucket", async () => {
  const storage = createMemoryBlobStorage({ maxStreamBytes: 2 ** 30 });
  const s = await started({ snapshots: {}, agents: { librarian: { workspace: "agent" } } }, { storage });
  expect((await (await s.env("test:one", "librarian")).writeFile("/workspace/shared.md", "shared", ctx)).ok).toBe(true);
  expect((await (await s.env("test:one")).writeFile("/workspace/chat.md", "chat", ctx)).ok).toBe(true);
  await idle(s, 12);
  await until(() => !existsSync(join(s.root, "chats", chat("test:one"), "support")));
  expect(existsSync(join(s.root, "agents", "librarian", "shared.md"))).toBe(true);
  expect(await keysOf(s, "test:one", "librarian")).toEqual([]);
  await s.app.stop();

  // The host is replaced: an empty root, the same bucket.
  const next = await started({ snapshots: {} }, { storage });
  expect(await (await next.env("test:one")).readTextFile("/workspace/chat.md", ctx)).toEqual({ ok: true, value: "chat" });
  expect(existsSync(join(next.root, SNAPSHOTS_DIR, "index", snapshotIdOf("test:one", "support")))).toBe(true);
  await next.app.stop();
});

test("snapshots need a storage.blob provider: refused at start without one", async () => {
  const error = await started({ snapshots: {} }, { withBlob: false }).then(() => undefined, (thrown: Error) => thrown);
  expect(((error?.cause as Error | undefined) ?? error)?.message).toContain("snapshots need a storage.blob provider");
  await expect(started({ snapshots: { idleMinutes: 0 } })).rejects.toThrow();
});
