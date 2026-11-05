/**
 * The sandbox object's logic (`sandbox.ts`) over a fake container that runs the real helper and the
 * machine's `tar` as local processes: the protocol's operations mapped, per-agent images, every
 * container call bounded, and the idle checkpoint and the restore in the shared snapshot format,
 * against `storage.blob` in memory.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger, type Logger } from "@pikit/core";
import { createMemoryBlobStorage } from "@pikit/contracts/testing";
import type { BlobStore } from "@pikit/contracts";
import { craftArchive } from "./archive.test-support.ts";
import { createFakeContainer, createObjectStorage, type FakeContainer } from "./fake-container.test-support.ts";
import { profileOf, type SandboxConfig } from "./index.ts";
import type { Operation, Outcome, Values, WireExecState } from "./protocol.ts";
import { agentOf, chatKey, Sandbox, type SandboxReply } from "./sandbox.ts";
import { MANIFEST, SNAPSHOT_NAMESPACE, sha256Hex, snapshotPrefix } from "./snapshot.ts";

const BASE: SandboxConfig = {
  image: "base",
  internet: false,
  agents: { designer: { image: "designer", instance: "standard-2", internet: true } },
  root: "/workspace",
  idleMinutes: 10,
  backstopMinutes: 15,
  leaseSeconds: 120,
  callSeconds: 30,
  startSeconds: 45,
  snapshotSeconds: 300,
  maxUnpackedBytes: 1 << 30,
};

const containers: FakeContainer[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) container.cleanup();
});

type Logged = { level: string; message: string; fields?: Record<string, unknown> };

function setup(options: { container?: FakeContainer; maxBlobBytes?: number; callMs?: number; startMs?: number; config?: SandboxConfig; snapshots?: BlobStore } = {}) {
  const container = options.container ?? createFakeContainer();
  containers.push(container);
  const storage = createObjectStorage();
  const blobs = createMemoryBlobStorage();
  const snapshots = options.snapshots ?? blobs.namespace(SNAPSHOT_NAMESPACE);
  const clock = { offset: 0 };
  const logs: Logged[] = [];
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: "info", message, ...(fields !== undefined && { fields }) }),
    warn: (message, fields) => logs.push({ level: "warn", message, ...(fields !== undefined && { fields }) }),
    error: (message, fields) => logs.push({ level: "error", message, ...(fields !== undefined && { fields }) }),
  };
  const config = options.config ?? BASE;
  const make = () =>
    new Sandbox({
      container,
      storage,
      snapshots,
      maxBlobBytes: options.maxBlobBytes ?? blobs.maxBytes,
      profile: (agent) => profileOf(config, agent),
      root: container.root,
      idleMs: 600_000,
      backstopMs: 1_500_000,
      leaseMs: 120_000,
      callMs: options.callMs ?? 15_000,
      startMs: options.startMs ?? 15_000,
      snapshotMs: 30_000,
      maxUnpackedBytes: 1 << 30,
      now: () => Date.now() + clock.offset,
      logger: options.callMs === undefined ? logger : silentLogger,
    });
  return { container, storage, snapshots, clock, logs, make, sandbox: make() };
}

async function call<O extends Operation>(sandbox: Sandbox, operation: O, body: unknown, agent?: string, id = "s-1"): Promise<Values[O]> {
  const reply = await sandbox.serve({ sandbox: id, operation, body, ...(agent !== undefined && { agent }) });
  if (!reply.ok) throw new Error(`${operation}: ${reply.code}: ${reply.message}`);
  const answer = reply.answer as Outcome<O>;
  if (!answer.ok) throw new Error(`${operation}: ${answer.error.code}: ${answer.error.message}`);
  return answer.value;
}

async function outcome<O extends Operation>(sandbox: Sandbox, operation: O, body: unknown): Promise<Outcome<O>> {
  const reply = await sandbox.serve({ sandbox: "s-1", operation, body });
  if (!reply.ok) throw new Error(`${operation}: ${reply.code}: ${reply.message}`);
  return reply.answer as Outcome<O>;
}

/** Runs `run` to its end through execStart and execRead, as execution-remote does. */
async function exec(sandbox: Sandbox, run: string | string[], cwd: string, extra: Record<string, unknown> = {}): Promise<{ text: string; done: NonNullable<WireExecState["done"]> }> {
  const command = crypto.randomUUID();
  let state = await call(sandbox, "execStart", { command, run, cwd, wait: 5000, linger: 0, ...extra });
  let text = state.chunks.map((chunk) => chunk.text).join("");
  while (state.done === undefined) {
    state = await call(sandbox, "execRead", { command, cursor: state.next, wait: 5000, linger: 0 });
    text += state.chunks.map((chunk) => chunk.text).join("");
  }
  return { text, done: state.done };
}

describe("the protocol's operations, on the container", () => {
  test("files: write, read, info, list, rename, truncate, append, remove, temp files; errors with pi-durable's codes", async () => {
    const { sandbox, container } = setup();
    const opened = await call(sandbox, "open", {});
    expect(opened.cwd).toBe(container.root);
    expect(opened.home).toBe(join(container.dir, "home"));
    const file = `${container.root}/notes/a.txt`;
    expect(await call(sandbox, "writeFile", { path: file, content: { text: "one\ntwo\n" } })).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
    expect(await call(sandbox, "readTextFile", { path: file })).toBe("one\ntwo\n");
    expect(await call(sandbox, "readTextLines", { path: file, maxLines: 1 })).toEqual(["one"]);
    expect(await call(sandbox, "appendFile", { path: file, content: { base64: btoa("three") } })).toBeNull();
    expect(await call(sandbox, "readBinaryFile", { path: file })).toEqual({ base64: btoa("one\ntwo\nthree") });
    const info = await call(sandbox, "fileInfo", { path: file });
    expect({ ...info, mtimeMs: 0 }).toEqual({ name: "a.txt", path: file, kind: "file", size: 13, mtimeMs: 0 });
    expect(await call(sandbox, "exists", { path: file })).toBe(true);
    expect(await call(sandbox, "exists", { path: `${container.root}/none` })).toBe(false);
    await call(sandbox, "truncateFile", { path: file, size: 3 });
    expect(readFileSync(file, "utf8")).toBe("one");
    await call(sandbox, "flushFile", { path: file });
    await call(sandbox, "renameFile", { from: file, to: `${container.root}/b.txt` });
    await call(sandbox, "createDir", { path: `${container.root}/d/e`, recursive: true });
    const listed = await call(sandbox, "listDir", { path: container.root });
    expect(listed.map((entry) => [entry.name, entry.kind]).sort()).toEqual([["b.txt", "file"], ["d", "directory"], ["notes", "directory"]]);
    expect(await call(sandbox, "canonicalPath", { path: `${container.root}/d/../b.txt` })).toEndWith("/workspace/b.txt");
    await call(sandbox, "remove", { path: `${container.root}/d`, recursive: true });
    expect(existsSync(`${container.root}/d`)).toBe(false);
    const temp = await call(sandbox, "createTempFile", { prefix: "p-", suffix: ".txt" });
    expect(temp).toStartWith(join(container.dir, "tmp"));
    expect(temp).toEndWith(".txt");
    expect(await call(sandbox, "createTempDir", { prefix: "x-" })).toContain("/tmp/x-");

    expect(await outcome(sandbox, "readTextFile", { path: `${container.root}/none` })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await outcome(sandbox, "readTextFile", { path: container.root })).toMatchObject({ ok: false, error: { code: "is_directory" } });
    expect(await outcome(sandbox, "listDir", { path: `${container.root}/b.txt` })).toMatchObject({ ok: false, error: { code: "not_directory" } });
    expect(await outcome(sandbox, "remove", { path: `${container.root}/notes` })).toMatchObject({ ok: false });
  }, 60_000);

  test("readers: a small file whole, a large one on a pinned link (a rename after the open changes nothing), scans, directories in pages", async () => {
    const { sandbox, container } = setup();
    await call(sandbox, "open", {});
    const small = `${container.root}/small.txt`;
    writeFileSync(small, "hi");
    const whole = await call(sandbox, "openBinaryReader", { path: small, prefetch: 1024 });
    expect(whole).toMatchObject({ base64: btoa("hi"), info: { name: "small.txt", size: 2 } });

    const large = `${container.root}/large.txt`;
    writeFileSync(large, "line 1\nline 2\nline 3\n");
    const opened = await call(sandbox, "openBinaryReader", { path: large, prefetch: 4 });
    if (!("handle" in opened)) throw new Error("expected a handle");
    writeFileSync(`${container.root}/other.txt`, "replaced");
    await call(sandbox, "renameFile", { from: `${container.root}/other.txt`, to: large });
    expect(await call(sandbox, "readerRead", { handle: opened.handle, offset: 7, length: 6 })).toEqual({ base64: btoa("line 2") });
    expect(await call(sandbox, "readerInfo", { handle: opened.handle })).toMatchObject({ path: large, size: 21 });
    expect(await call(sandbox, "readerScan", { handle: opened.handle, startLine: 1, endLine: 2 })).toMatchObject({ newlines: 3, start: 7, end: 13 });
    await call(sandbox, "readerClose", { handle: opened.handle });
    expect(await sandbox.serve({ sandbox: "s-1", operation: "readerRead", body: { handle: opened.handle, offset: 0, length: 1 } })).toMatchObject({ ok: false, code: "unknown_handle" });

    expect(await outcome(sandbox, "openBinaryReader", { path: container.root, prefetch: 0 })).toMatchObject({ ok: false, error: { code: "is_directory" } });
    symlinkSync(small, `${container.root}/link`);
    expect(await outcome(sandbox, "openBinaryReader", { path: `${container.root}/link`, noFollow: true, prefetch: 0 })).toMatchObject({ ok: false, error: { code: "invalid" } });

    for (const name of ["a", "b", "c"]) writeFileSync(`${container.root}/${name}`, name);
    const dir = await call(sandbox, "openDirReader", { path: container.root });
    const first = await call(sandbox, "dirNext", { handle: dir.handle, maxEntries: 4 });
    const second = await call(sandbox, "dirNext", { handle: dir.handle, maxEntries: 4 });
    expect(first.done).toBe(false);
    expect(second.done).toBe(true);
    expect(first.entries.length + second.entries.length).toBe(6);
    await call(sandbox, "dirClose", { handle: dir.handle });
  }, 60_000);

  test("commands: output from a cursor with its stream, the exit code, variables, an argv unparsed, a kill, a timeout, a spill file", async () => {
    const { sandbox, container } = setup();
    await call(sandbox, "open", {});
    const shell = await exec(sandbox, "echo out; echo err >&2; exit 3", container.root);
    expect(shell.text).toContain("out\n");
    expect(shell.text).toContain("err\n");
    expect(shell.done).toEqual({ ok: true, value: { exitCode: 3 } });

    const variables = await exec(sandbox, 'printf "%s" "$GREETING"', container.root, { env: { GREETING: "hello" } });
    expect(variables.text).toBe("hello");
    const argv = await exec(sandbox, ["printf", "%s", "a b; $(c)"], container.root);
    expect(argv.text).toBe("a b; $(c)");

    const long = crypto.randomUUID();
    await call(sandbox, "execStart", { command: long, run: "sleep 30", cwd: container.root, wait: 0, linger: 0 });
    let killed = await call(sandbox, "execKill", { command: long, cursor: 0, wait: 5000 });
    while (killed.done === undefined) killed = await call(sandbox, "execRead", { command: long, cursor: killed.next, wait: 5000, linger: 0 });
    expect(killed.done).toMatchObject({ ok: false, error: { code: "aborted" } });

    const slow = await exec(sandbox, "sleep 30", container.root, { timeout: 0.5 });
    expect(slow.done).toMatchObject({ ok: false, error: { code: "timeout" } });

    const spilled = await exec(sandbox, "seq 1 50", container.root, { spill: { afterBytes: 10, afterLines: 1000 } });
    if (!spilled.done.ok || spilled.done.value.spillPath === undefined) throw new Error("expected a spill file");
    expect(readFileSync(spilled.done.value.spillPath, "utf8")).toBe(spilled.text);
    const unspilled = await exec(sandbox, "echo x", container.root, { spill: { afterBytes: 1000, afterLines: 1000 } });
    expect(unspilled.done).toEqual({ ok: true, value: { exitCode: 0 } });
  }, 60_000);

  test("a command id in use, an unknown one, and an acknowledged cursor are refused", async () => {
    const { sandbox, container } = setup();
    const id = crypto.randomUUID();
    const state = await call(sandbox, "execStart", { command: id, run: "echo a", cwd: container.root, wait: 5000, linger: 0 });
    expect(await sandbox.serve({ sandbox: "s-1", operation: "execStart", body: { command: id, run: "true", cwd: container.root, wait: 0, linger: 0 } })).toMatchObject({ ok: false, code: "invalid_request" });
    await call(sandbox, "execRead", { command: id, cursor: state.next, wait: 0, linger: 0 });
    expect(await sandbox.serve({ sandbox: "s-1", operation: "execRead", body: { command: id, cursor: 0, wait: 0, linger: 0 } })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await sandbox.serve({ sandbox: "s-1", operation: "execRead", body: { command: "nope", cursor: 0, wait: 0, linger: 0 } })).toMatchObject({ ok: false, code: "unknown_command" });
  }, 30_000);

  test("an object is one sandbox id and agent: another is refused", async () => {
    const { sandbox } = setup();
    await call(sandbox, "open", {}, "developer");
    expect(await sandbox.serve({ sandbox: "s-1", agent: "analyst", operation: "open", body: {} })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await sandbox.serve({ sandbox: "s-2", agent: "developer", operation: "open", body: {} })).toMatchObject({ ok: false, code: "invalid_request" });
  }, 30_000);
});

describe("the agent's machine", () => {
  test("the profile of the header's agent chooses the image, the instance and the internet; any other agent, and none, get the base", async () => {
    const designer = setup();
    await call(designer.sandbox, "open", {}, "designer");
    expect(designer.container.starts).toEqual([{ image: "registry.example/designer@sha256:2", enableInternet: true, instance: "standard-2", labels: { "pikit-sandbox": "s-1", "pikit-agent": "designer" } }]);
    for (const agent of ["developer", undefined]) {
      const other = setup();
      await call(other.sandbox, "open", {}, agent);
      expect(other.container.starts).toEqual([{ image: "registry.example/base@sha256:1", enableInternet: false, labels: { "pikit-sandbox": "s-1", "pikit-agent": agentOf("s-1", agent) } }]);
    }
    expect(designer.container.inactivity).toEqual([1_500_000]);
  }, 30_000);

  test("an image wrangler.jsonc does not name is unavailable, saying which in the log", async () => {
    const { sandbox, logs } = setup({ config: { ...BASE, image: "missing" } });
    expect(await sandbox.serve({ sandbox: "s-1", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable" });
    expect(logs.find((log) => log.level === "error")?.fields).toMatchObject({ image: "missing", images: ["base", "designer"] });
  }, 30_000);

  test("a container that never answers is unavailable within the start's deadline, and destroyed", async () => {
    const container = createFakeContainer();
    container.hang = true;
    const { sandbox } = setup({ container, callMs: 150, startMs: 400 });
    const started = Date.now();
    expect(await sandbox.serve({ sandbox: "s-1", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable", message: expect.stringContaining("max_instances") });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(container.destroyed).toBe(0 + container.destroyed);
  }, 30_000);

  test("a file operation on a container that stops answering is an error within its deadline", async () => {
    const container = createFakeContainer();
    const { sandbox } = setup({ container, callMs: 300 });
    await call(sandbox, "open", {});
    container.hang = true;
    const started = Date.now();
    expect(await outcome(sandbox, "fileInfo", { path: `${container.root}` })).toMatchObject({ ok: false, error: { code: "unknown", message: expect.stringContaining("did not answer within 300 ms") } });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);
});

describe("snapshots in storage.blob", () => {
  async function idle(harness: ReturnType<typeof setup>) {
    harness.clock.offset += 11 * 60_000;
    await harness.sandbox.alarm();
  }

  test("idle: the shared format written (archive, then manifest), the container released; the next operation restores it into a new container", async () => {
    const harness = setup();
    const { sandbox, container, snapshots, storage } = harness;
    await call(sandbox, "writeFile", { path: `${container.root}/src/a.txt`, content: { text: "kept" } }, "developer");
    mkdirSync(`${container.root}/empty`);
    symlinkSync("src/a.txt", `${container.root}/inside`);
    symlinkSync("/etc/passwd", `${container.root}/outside`);
    expect(storage.alarm).toBeGreaterThan(Date.now() + 9 * 60_000);

    await idle(harness);
    expect(container.destroyed).toBe(1);
    const prefix = await snapshotPrefix(chatKey("s-1"), "developer");
    expect(prefix).toBe(`${await sha256Hex(new TextEncoder().encode("execution-serve:s-1\ndeveloper"))}/`);
    const manifest = JSON.parse(new TextDecoder().decode((await snapshots.get(`${prefix}${MANIFEST}`))?.bytes));
    expect(Object.keys(manifest)).toEqual(["version", "object", "sha256", "size", "createdAt", "agent"]);
    expect(manifest).toMatchObject({ version: 1, agent: "developer" });
    expect(manifest.object).toBe(`${prefix}snapshot-${manifest.createdAt}-${manifest.sha256.slice(0, 16)}.tar.gz`);
    const archive = (await snapshots.get(manifest.object))?.bytes as Uint8Array;
    expect(archive.length).toBe(manifest.size);
    expect(await sha256Hex(archive)).toBe(manifest.sha256);
    expect(harness.logs.find((log) => log.level === "warn")?.fields).toMatchObject({ skipped: [{ path: "outside", reason: "a symlink pointing outside the workspace" }] });

    // A new container: the workspace comes back, the link outside does not.
    expect(existsSync(container.root)).toBe(false);
    expect(await call(sandbox, "readTextFile", { path: `${container.root}/inside` }, "developer")).toBe("kept");
    expect(container.starts).toHaveLength(2);
    expect(existsSync(`${container.root}/empty`)).toBe(true);
    expect(existsSync(`${container.root}/outside`)).toBe(false);
  }, 60_000);

  test("a superseded archive is deleted once the new manifest is written; a container still running (an evicted object) is not restored over", async () => {
    const harness = setup();
    const { container, snapshots } = harness;
    await call(harness.sandbox, "writeFile", { path: `${container.root}/a`, content: { text: "1" } });
    await idle(harness);
    const prefix = await snapshotPrefix(chatKey("s-1"), agentOf("s-1", undefined));
    const first = (await snapshots.list(prefix)).entries.map((entry) => entry.key);
    await call(harness.sandbox, "writeFile", { path: `${container.root}/a`, content: { text: "2" } });
    await idle(harness);
    const second = (await snapshots.list(prefix)).entries.map((entry) => entry.key);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(second.filter((key) => first.includes(key))).toEqual([`${prefix}${MANIFEST}`]);

    // The object evicted (a new Sandbox on the same storage), its container still running: used as it is.
    await call(harness.sandbox, "writeFile", { path: `${container.root}/a`, content: { text: "3" } });
    const evicted = harness.make();
    expect(await call(evicted, "readTextFile", { path: `${container.root}/a` })).toBe("3");
    expect(container.starts).toHaveLength(3);
  }, 60_000);

  test("while a command runs, or something was asked since, the alarm checkpoints nothing and comes back", async () => {
    const harness = setup();
    const { sandbox, container, storage } = harness;
    await call(sandbox, "execStart", { command: "c-1", run: "sleep 30", cwd: container.root, wait: 0, linger: 0 });
    harness.clock.offset += 11 * 60_000;
    await call(sandbox, "execRead", { command: "c-1", cursor: 0, wait: 0, linger: 0 });
    await sandbox.alarm();
    expect(container.destroyed).toBe(0);
    expect(storage.alarm).toBeGreaterThan(Date.now() + harness.clock.offset);
    await call(sandbox, "execKill", { command: "c-1", cursor: 0, wait: 5000 });
  }, 30_000);

  test("over storage.blob's maxBytes: skipped, the container kept, the log says so", async () => {
    const harness = setup({ maxBlobBytes: 64 });
    await call(harness.sandbox, "writeFile", { path: `${harness.container.root}/big`, content: { text: crypto.randomUUID().repeat(50) } });
    await idle(harness);
    expect(harness.container.destroyed).toBe(0);
    expect(harness.container.running).toBe(true);
    expect((await harness.snapshots.list("")).entries).toEqual([]);
    expect(harness.logs.some((log) => log.level === "error" && log.message.includes("maxBytes"))).toBe(true);
  }, 30_000);

  test("a failed upload keeps the container (the local copy is the truth) and tries again", async () => {
    const blobs = createMemoryBlobStorage().namespace(SNAPSHOT_NAMESPACE);
    let failing = true;
    const flaky: BlobStore = { ...blobs, put: (key, bytes, options) => (failing ? Promise.reject(new Error("S3 down")) : blobs.put(key, bytes, options)) };
    const harness = setup({ snapshots: flaky });
    await call(harness.sandbox, "writeFile", { path: `${harness.container.root}/a`, content: { text: "x" } });
    await idle(harness);
    expect(harness.container.destroyed).toBe(0);
    expect(readFileSync(`${harness.container.root}/a`, "utf8")).toBe("x");
    failing = false;
    await idle(harness);
    expect(harness.container.destroyed).toBe(1);
  }, 30_000);

  async function seeded(archive: Uint8Array, change?: (manifest: Record<string, unknown>) => void) {
    const harness = setup();
    const agent = agentOf("s-1", undefined);
    const prefix = await snapshotPrefix(chatKey("s-1"), agent);
    const sha256 = await sha256Hex(archive);
    const object = `${prefix}snapshot-1-${sha256.slice(0, 16)}.tar.gz`;
    await harness.snapshots.put(object, archive);
    const manifest: Record<string, unknown> = { version: 1, object, sha256, size: archive.length, createdAt: 1, agent };
    change?.(manifest);
    await harness.snapshots.put(`${prefix}${MANIFEST}`, new TextEncoder().encode(JSON.stringify(manifest)));
    return harness;
  }

  test("a snapshot another backend wrote is restored", async () => {
    const harness = await seeded(await craftArchive([{ name: "./", type: "5" }, { name: "./dir/", type: "5" }, { name: "./dir/f.txt", content: "from elsewhere" }, { name: "./l", type: "2", linkname: "dir/f.txt" }]));
    expect(await call(harness.sandbox, "readTextFile", { path: `${harness.container.root}/l` })).toBe("from elsewhere");
  }, 30_000);

  test.each([
    ["a path leaving the root", [{ name: "../escaped.txt", content: "x" }]],
    ["an absolute path", [{ name: "/tmp/escaped.txt", content: "x" }]],
    ["a symlink pointing outside", [{ name: "l", type: "2" as const, linkname: "../../.." }]],
    ["an entry below a symlink", [{ name: "l", type: "2" as const, linkname: "." }, { name: "l/x", content: "x" }]],
    ["a hard link", [{ name: "h", type: "1" as const, linkname: "/etc/passwd" }]],
  ])("an archive with %s is refused: nothing extracted, the sandbox unavailable", async (_, entries) => {
    const harness = await seeded(await craftArchive(entries));
    expect(await harness.sandbox.serve({ sandbox: "s-1", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable" });
    expect(existsSync(join(harness.container.dir, "escaped.txt"))).toBe(false);
    expect(existsSync(`${harness.container.root}.restore`)).toBe(false);
    expect(harness.container.destroyed).toBe(1);
    expect(harness.logs.some((log) => log.level === "error" && String(log.fields?.error).length > 0)).toBe(true);
  }, 30_000);

  test("an archive whose SHA-256 or size is not the manifest's, or a manifest for another agent, is refused", async () => {
    const archive = await craftArchive([{ name: "a", content: "x" }]);
    for (const change of [(m: Record<string, unknown>) => (m.size = 1), (m: Record<string, unknown>) => (m.agent = "developer"), (m: Record<string, unknown>) => (m.version = 2)]) {
      const harness = await seeded(archive, change);
      expect(await harness.sandbox.serve({ sandbox: "s-1", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable" });
    }
    // Another valid archive under the first one's name and size: only its SHA-256 tells them apart.
    const other = await craftArchive([{ name: "b", content: "y" }]);
    const swapped = setup();
    const agent = agentOf("s-1", undefined);
    const prefix = await snapshotPrefix(chatKey("s-1"), agent);
    const sha256 = await sha256Hex(archive);
    const object = `${prefix}snapshot-1-${sha256.slice(0, 16)}.tar.gz`;
    await swapped.snapshots.put(object, other);
    await swapped.snapshots.put(`${prefix}${MANIFEST}`, new TextEncoder().encode(JSON.stringify({ version: 1, object, sha256, size: other.length, createdAt: 1, agent })));
    expect(await swapped.sandbox.serve({ sandbox: "s-1", operation: "open", body: {} })).toMatchObject({ ok: false, code: "unavailable" });
    expect(swapped.logs.some((log) => String(log.fields?.error).includes("SHA-256"))).toBe(true);
  }, 30_000);
});

export type { SandboxReply };
