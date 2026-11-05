/**
 * Acceptance: one workspace snapshot format, three backends (features/workspace-snapshots.md). A
 * workspace checkpointed by the server helper (`@pikit/contracts/snapshots`' `checkpointSnapshot`, as
 * execution-gondolin and workspace-local save one) is restored by execution-cloudflare-sandbox's restore
 * (over its fake container) and by execution-boat's (over its fake boat API), byte for byte; what each of
 * them checkpoints then is restored by the server helper, byte for byte; a manifest of another agent is
 * refused by all three. One bucket for all, whose `maxBytes` (4 KiB) is below every archive's size: each
 * backend streams (`putStream`, `getStream`), none reads an archive whole.
 *
 * And the id: behind a sandbox host the three key a workspace by the same chat key and agent
 * (execution-serve's `ConversationRef`: `execution-serve:<sandbox>`, the request's agent or
 * `_<sandbox>`), so they compute the same `<id>/`, and a workspace moves between them.
 *
 * A repository test, copied with no component: it imports several components' files.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationRef, openSnapshotStore, originOf, snapshotId, snapshotManifestJson, snapshotManifestKey } from "@pikit/contracts";
import { checkpointSnapshot, deleteSupersededSnapshots, readSnapshotManifest, restoreSnapshot, snapshotIdOf } from "@pikit/contracts/snapshots";
import { createMemoryBlobStorage } from "@pikit/contracts/testing";
import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { BACKGROUND_CONTEXT } from "@pikit/pi-adapter/execution";
import { FakeBoat } from "../../registry/components/execution-boat/files/src/pikit/execution-boat/fake-boat.test-support.ts";
import { createExecutionBoat, workspaceOf } from "../../registry/components/execution-boat/files/src/pikit/execution-boat/index.ts";
import { createFakeContainer, createObjectStorage, type FakeContainer } from "../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/fake-container.test-support.ts";
import { agentOf, chatKey, Sandbox } from "../../registry/components/execution-cloudflare-sandbox/files/src/pikit/execution-cloudflare-sandbox/sandbox.ts";
import { sandboxConversation } from "../../registry/components/execution-serve/files/src/pikit/execution-serve/host.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const containers: FakeContainer[] = [];
afterAll(() => {
  for (const container of containers) container.cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temporary = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-ws-compat-")));
  dirs.push(dir);
  return dir;
};

/**
 * A directory as a comparable value: every entry's kind, bytes (their SHA-256), link target, and whether
 * it is executable. Names compared in NFC: macOS's bsdtar (the fakes' tar) extracts a name in NFD,
 * where a container's or a VM's GNU tar keeps its bytes.
 */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(rel === "" ? root : join(root, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const full = join(root, path);
      const key = path.normalize("NFC");
      const info = lstatSync(full);
      if (info.isSymbolicLink()) out[key] = `link -> ${readlinkSync(full)}`;
      else if (info.isDirectory()) {
        out[key] = "directory";
        walk(path);
      } else out[key] = `file${(info.mode & 0o100) !== 0 ? " +x" : ""} ${new Bun.CryptoHasher("sha256").update(readFileSync(full)).digest("hex")} ${info.size}`;
    }
  };
  walk("");
  return out;
}

/** A workspace with what a format has to carry: nested and empty directories, binary bytes, a long and a non-ASCII name, links inside, an executable. */
function makeWorkspace(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "empty"));
  mkdirSync(join(dir, "deep", "a", "b"), { recursive: true });
  mkdirSync(join(dir, "été"));
  writeFileSync(join(dir, "src", "main.py"), "print('moved between backends')\n");
  const noise = new Uint8Array(48 * 1024);
  crypto.getRandomValues(noise);
  writeFileSync(join(dir, "src", "data.bin"), noise);
  writeFileSync(join(dir, "deep", "a", "b", `${"n".repeat(120)}.txt`), "a long name");
  writeFileSync(join(dir, "été", "ünï.txt"), "non-ASCII");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  symlinkSync("src/main.py", join(dir, "main"));
  symlinkSync("../../src", join(dir, "deep", "a", "src"));
}

const SANDBOX = "s-compat";
const AGENT = "developer";
const blobs = createMemoryBlobStorage({ maxBytes: 4096 });
const store = openSnapshotStore(blobs);

/** execution-cloudflare-sandbox's object logic over a fake container, on the shared bucket. */
function cloudflare(agent: string | undefined = AGENT) {
  const container = createFakeContainer();
  containers.push(container);
  const clock = { offset: 0 };
  const errors: string[] = [];
  const sandbox = new Sandbox({
    container,
    storage: createObjectStorage(),
    snapshots: store,
    maxArchiveBytes: blobs.maxStreamBytes,
    profile: () => ({ image: "base", internet: false }),
    root: container.root,
    idleMs: 600_000,
    backstopMs: 1_500_000,
    leaseMs: 120_000,
    callMs: 15_000,
    startMs: 15_000,
    snapshotMs: 30_000,
    maxUnpackedBytes: 1 << 30,
    now: () => Date.now() + clock.offset,
    logger: { ...silentLogger, error: (message, fields) => void errors.push(`${message} ${JSON.stringify(fields)}`) },
  });
  const serve = (operation: string, body: unknown, sandboxId = SANDBOX) => sandbox.serve({ sandbox: sandboxId, ...(agent !== undefined && { agent }), operation: operation as never, body });
  const idle = async () => {
    clock.offset += 11 * 60_000;
    await sandbox.alarm();
  };
  return { container, sandbox, serve, idle, errors };
}

/** execution-boat's App over a fake boat API, on the shared bucket and a manual clock. */
async function boat(): Promise<{ app: App; fake: FakeBoat; provider: WorkspaceProvider; vmWorkspace(workspace: string): string; clock: ReturnType<typeof createManualClock> }> {
  const root = temporary();
  const clock = createManualClock();
  const fake = new FakeBoat(join(root, "vms"), "boat_key_0123456789", clock);
  const proc = join(root, "proc");
  mkdirSync(proc);
  let provider: WorkspaceProvider | undefined;
  const app = await defineApp({
    components: [
      defineComponent({ name: "secrets-test", setup: (pikit) => void pikit.provide("secrets", { get: async (name: string) => (name === "BOAT_API_KEY" ? "boat_key_0123456789" : undefined) }) }),
      defineComponent({ name: "blob-test", setup: (pikit) => void pikit.provide("storage.blob", blobs) }),
      createExecutionBoat({ fetch: fake.fetch, paths: FakeBoat.paths(join(root, "vms")), pollMs: 5, proc }),
      defineComponent({
        name: "reader",
        setup(pikit) {
          const workspace = pikit.use("workspace");
          return { start: () => void (provider = workspace.get()) };
        },
      }),
    ],
    config: { "execution-boat": { snapshots: true } },
    logger: silentLogger,
    clock,
  }).create();
  await app.start();
  return { app, fake, provider: provider as WorkspaceProvider, vmWorkspace: (workspace) => join(FakeBoat.paths(join(root, "vms"))(workspace).home, "workspace"), clock };
}

const until = async (condition: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** The archives the bucket has for `id`: one, once a checkpoint deleted those it superseded. */
const archivesOf = async (id: string) => (await store.list(`${id}/`)).entries.filter((entry) => entry.key.endsWith(".tar.gz"));

test("behind a sandbox host the three compute one id: the same chat key and agent", async () => {
  for (const agent of [AGENT, undefined]) {
    const ref: ConversationRef = sandboxConversation(SANDBOX, agent);
    const chat = originOf(ref).key;
    expect(chat).toBe(chatKey(SANDBOX));
    expect(ref.agent).toBe(agentOf(SANDBOX, agent));
    const server = snapshotIdOf(chat, ref.agent as string);
    expect(await snapshotId(chatKey(SANDBOX), agentOf(SANDBOX, agent))).toBe(server);
    expect(workspaceOf(chat, ref.agent as string)).toBe(server);
  }
});

test("server → Cloudflare and boat, then each → server: byte for byte, archives streamed, one archive left each time", async () => {
  const id = snapshotIdOf(chatKey(SANDBOX), AGENT);
  const base = temporary();
  const source = join(base, "source");
  mkdirSync(source);
  makeWorkspace(source);
  const original = treeOf(source);

  // The server helper checkpoints it (execution-gondolin's, workspace-local's way).
  const saved = await checkpointSnapshot(store, { id, agent: AGENT, dir: source }, { tmp: join(base, "tmp"), now: 1000 });
  expect(saved?.manifest.size).toBeGreaterThan(blobs.maxBytes);
  await expect(store.get(saved?.manifest.object as string)).rejects.toThrow(/larger/);

  // Cloudflare restores it into a new container.
  const cf = cloudflare();
  expect(await cf.serve("open", {})).toMatchObject({ ok: true });
  expect(treeOf(cf.container.root)).toEqual(original);

  // boat restores it into a new VM, for the conversation execution-serve resolves this sandbox as.
  const b = await boat();
  const env: ExecutionEnv = (await b.provider.resolve(sandboxConversation(SANDBOX, AGENT), b.app.context())).env;
  expect(await env.readTextFile("main", ctx)).toEqual({ ok: true, value: "print('moved between backends')\n" });
  expect(treeOf(b.vmWorkspace(id))).toEqual(original);

  // Cloudflare's checkpoint, restored by the server helper.
  expect(await cf.serve("writeFile", { path: `${cf.container.root}/from-cloudflare.txt`, content: { text: "cf" } })).toMatchObject({ ok: true });
  const fromCloudflare = treeOf(cf.container.root);
  await cf.idle();
  expect(cf.errors).toEqual([]);
  expect(cf.container.destroyed).toBe(1);
  const afterCloudflare = await readSnapshotManifest(store, { id, agent: AGENT });
  expect(afterCloudflare?.object).not.toBe(saved?.manifest.object);
  expect((await archivesOf(id)).map((entry): string | undefined => entry.key)).toEqual([afterCloudflare?.object]);
  const restoredA = join(base, "restored-a", "ws");
  await restoreSnapshot(store, { id, agent: AGENT, dir: restoredA }, { tmp: join(base, "tmp"), base });
  expect(treeOf(restoredA)).toEqual(fromCloudflare);
  expect(fromCloudflare["from-cloudflare.txt"]).toBeDefined();

  // boat's export (its idle stop), restored by the server helper.
  expect((await env.writeFile("from-boat.txt", "boat", ctx)).ok).toBe(true);
  const fromBoat = treeOf(b.vmWorkspace(id));
  await b.clock.advance(600_000);
  await until(async () => (await readSnapshotManifest(store, { id, agent: AGENT }))?.object !== afterCloudflare?.object, "boat's export");
  const afterBoat = await readSnapshotManifest(store, { id, agent: AGENT });
  await until(async () => (await archivesOf(id)).length === 1, "the superseded archive's deletion");
  expect((await archivesOf(id)).map((entry): string | undefined => entry.key)).toEqual([afterBoat?.object]);
  const restoredB = join(base, "restored-b", "ws");
  await restoreSnapshot(store, { id, agent: AGENT, dir: restoredB }, { tmp: join(base, "tmp"), base });
  expect(treeOf(restoredB)).toEqual(fromBoat);
  expect(fromBoat["from-boat.txt"]).toBeDefined();
  expect(fromBoat["from-cloudflare.txt"]).toBeUndefined();

  // The server's own checkpoint supersedes boat's, as the helper's callers delete: one archive left.
  const again = await checkpointSnapshot(store, { id, agent: AGENT, dir: restoredB }, { tmp: join(base, "tmp"), now: 2000 });
  await deleteSupersededSnapshots(store, id, again?.manifest.object as string);
  expect((await archivesOf(id)).map((entry): string | undefined => entry.key)).toEqual([again?.manifest.object]);
  await b.app.stop();
  await b.fake.settle();
}, 120_000);

test("a manifest of another agent at a workspace's id is refused by all three: nothing restored", async () => {
  const sandbox = "s-theirs";
  const id = snapshotIdOf(chatKey(sandbox), AGENT);
  const base = temporary();
  const source = join(base, "source");
  mkdirSync(source);
  makeWorkspace(source);
  // A valid archive at this id, its manifest naming another agent.
  const saved = await checkpointSnapshot(store, { id, agent: AGENT, dir: source }, { tmp: join(base, "tmp"), now: 1000 });
  await store.put(snapshotManifestKey(id), new TextEncoder().encode(snapshotManifestJson({ ...(saved?.manifest as NonNullable<typeof saved>["manifest"]), agent: "ops" })));

  await expect(restoreSnapshot(store, { id, agent: AGENT, dir: join(base, "restored", "ws") }, { tmp: join(base, "tmp"), base })).rejects.toThrow(/agent is "ops", not "developer"/);

  const cf = cloudflare();
  expect(await cf.serve("open", {}, sandbox)).toMatchObject({ ok: false, code: "unavailable" });
  expect(cf.errors.join("\n")).toMatch(/agent is \\?"ops\\?", not \\?"developer\\?"/);

  const b = await boat();
  const env = (await b.provider.resolve(sandboxConversation(sandbox, AGENT), b.app.context())).env;
  const read = await env.exists("main", ctx);
  expect(read.ok ? "" : read.error.message).toMatch(/agent is "ops", not "developer"/);
  expect(b.fake.of(id)).toEqual([]);
  await b.app.stop();
  await b.fake.settle();
}, 60_000);
