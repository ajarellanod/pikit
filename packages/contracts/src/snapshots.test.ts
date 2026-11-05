/**
 * The workspace snapshot helper on real directories and the memory `storage.blob`: the format (keys,
 * manifest, an archive system tar reads and one it writes), a crash at each step of a checkpoint and
 * of a restore losing nothing, archives that try to leave the directory refused, checksums checked,
 * superseded archives deleted, and `WorkspaceSnapshots` on a manual clock.
 */

import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManualClock } from "@pikit/core/testing";
import type { BlobStore } from "./blob.ts";
import {
  checkpointSnapshot,
  extractSnapshotArchive,
  linkStaysInside,
  restoreSnapshot,
  SNAPSHOT_NAMESPACE,
  SNAPSHOT_SWEEP_MS,
  SnapshotArchiveError,
  snapshotId,
  snapshotIdOf,
  type SnapshotTarget,
  WorkspaceSnapshots,
  writeSnapshotArchive,
} from "./snapshots.ts";
import { createMemoryBlobStorage } from "./testing/blob.ts";
import { deleteSnapshotsBefore, parseSnapshotManifest, snapshotArchiveKey, snapshotManifestKey } from "./workspace-snapshot.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-snapshots-"));
  dirs.push(dir);
  return dir;
}

const storeOf = () => createMemoryBlobStorage({ maxStreamBytes: 2 ** 30 }).namespace(SNAPSHOT_NAMESPACE);
const ID = snapshotIdOf("telegram:42", "support");

/** A workspace with a bit of everything: nested files, modes, an empty file and directory, long and non-ASCII names, links in and out. */
function workspace(root: string): string {
  const dir = join(root, "ws");
  mkdirSync(join(dir, "src", "deep", "er"), { recursive: true });
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "README.md"), "# hello\n");
  writeFileSync(join(dir, "src", "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(dir, "src", "run.sh"), 0o755);
  writeFileSync(join(dir, "src", "deep", "er", "frozen.txt"), "read only");
  chmodSync(join(dir, "src", "deep", "er", "frozen.txt"), 0o444);
  writeFileSync(join(dir, "empty.txt"), "");
  const bytes = new Uint8Array(3 * 1024 * 1024 + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
  writeFileSync(join(dir, "src", "blob.bin"), bytes);
  writeFileSync(join(dir, `${"long-name-".repeat(15)}.txt`), "long");
  writeFileSync(join(dir, "ñandú café.txt"), "unicode");
  mkdirSync(join(dir, "d".repeat(90), "e".repeat(90)), { recursive: true });
  writeFileSync(join(dir, "d".repeat(90), "e".repeat(90), "f.txt"), "deep path");
  symlinkSync("../README.md", join(dir, "src", "readme-link"));
  symlinkSync("src/deep", join(dir, "deep-link"));
  symlinkSync("/etc/passwd", join(dir, "absolute-link"));
  symlinkSync("../../outside", join(dir, "src", "escaping-link"));
  chmodSync(join(dir, "src", "deep"), 0o750);
  utimesSync(join(dir, "README.md"), 1_700_000_000, 1_700_000_000);
  return dir;
}

/** Every path under `dir` with what it is: a file's mode, bytes' hash and mtime, a link's target, a directory's mode. */
function describe(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of (readdirSync(dir, { recursive: true }) as string[]).sort()) {
    const full = join(dir, path);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) out[path] = `link ${readlinkSync(full)}`;
    else if (info.isDirectory()) out[path] = `dir ${(info.mode & 0o777).toString(8)}`;
    else out[path] = `file ${(info.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 12)} ${Math.floor(info.mtimeMs / 1000)}`;
  }
  return out;
}

const target = (dir: string, id = ID): SnapshotTarget => ({ id, agent: "support", dir });

test("the keys: the id is the SHA-256 of chat and agent, the archive's name its time and SHA-256, the manifest written last", async () => {
  expect(await snapshotId("telegram:42", "support")).toBe(ID);
  expect(ID).toBe(createHash("sha256").update("telegram:42\nsupport").digest("hex"));
  const root = temporary();
  const dir = workspace(root);
  const base = storeOf();
  const order: string[] = [];
  const store: BlobStore = {
    ...base,
    put: (key, bytes, options) => (order.push(`put ${key}`), base.put(key, bytes, options)),
    putStream: (key, body, options) => (order.push(`putStream ${key}`), base.putStream(key, body, options)),
  };
  const saved = await checkpointSnapshot(store, target(dir), { tmp: join(root, "tmp"), now: 1_750_000_000_123 });
  const manifest = saved?.manifest;
  expect(manifest?.object).toBe(snapshotArchiveKey(ID, 1_750_000_000_123, manifest?.sha256 as string));
  expect(manifest?.object).toMatch(new RegExp(`^${ID}/snapshot-1750000000123-[0-9a-f]{16}\\.tar\\.gz$`));
  expect(order).toEqual([`putStream ${manifest?.object}`, `put ${ID}/manifest.json`]);
  const json = JSON.parse(new TextDecoder().decode((await base.get(snapshotManifestKey(ID)))?.bytes));
  expect(json).toEqual({ version: 1, object: manifest?.object, sha256: manifest?.sha256, size: manifest?.size, createdAt: 1_750_000_000_123, agent: "support" });
  expect(JSON.stringify(json)).not.toContain("telegram");
  const archive = await base.getStream(manifest?.object as string);
  expect(archive?.size).toBe(manifest?.size as number);
  expect(archive?.contentType).toBe("application/gzip");
  // Links that lead out are left out, and counted.
  expect(saved?.skipped).toEqual({ links: 2, other: 0 });
  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(join(root, "tmp"))).toEqual([]);
});

test("a restore gives back the same files, bytes, modes, times and the links that stay inside", async () => {
  const root = temporary();
  const dir = workspace(root);
  const before = describe(dir);
  const store = storeOf();
  await checkpointSnapshot(store, target(dir), { tmp: join(root, "tmp"), now: 1 });
  const again = join(root, "chats", "x", "support");
  const manifest = await restoreSnapshot(store, target(again), { tmp: join(root, "tmp"), base: root });
  expect(manifest?.createdAt).toBe(1);
  const expected = { ...before };
  delete expected["absolute-link"];
  delete expected["src/escaping-link"];
  expect(describe(again)).toEqual(expected);
  expect(readFileSync(join(again, "deep-link", "er", "frozen.txt"), "utf8")).toBe("read only");
  expect(readdirSync(join(root, "tmp"))).toEqual([]);
  // None: nothing made.
  expect(await restoreSnapshot(store, target(join(root, "none"), snapshotIdOf("other", "support")), { tmp: join(root, "tmp"), base: root })).toBeUndefined();
  expect(existsSync(join(root, "none"))).toBe(false);
});

test("the archive is a tar system tar reads, and an archive system tar wrote is restored", async () => {
  const root = temporary();
  const dir = workspace(root);
  const file = join(root, "a.tar.gz");
  await writeSnapshotArchive(dir, file);
  const out = join(root, "out");
  mkdirSync(out);
  const tar = Bun.spawn(["tar", "-xzf", file, "-C", out], { stderr: "pipe" });
  expect(await tar.exited).toBe(0);
  for (const path of ["README.md", "src/blob.bin", `${"long-name-".repeat(15)}.txt`, "ñandú café.txt", `${"d".repeat(90)}/${"e".repeat(90)}/f.txt`]) {
    expect(readFileSync(join(out, path))).toEqual(readFileSync(join(dir, path)));
  }
  expect(readlinkSync(join(out, "src", "readme-link"))).toBe("../README.md");
  expect(statSync(join(out, "src", "run.sh")).mode & 0o777).toBe(0o755);

  const theirs = join(root, "theirs.tar.gz");
  const made = Bun.spawn(["tar", "-czf", theirs, "-C", out, "."], { stderr: "pipe" });
  expect(await made.exited).toBe(0);
  const restored = join(root, "restored");
  mkdirSync(restored);
  await extractSnapshotArchive(Bun.file(theirs).stream(), restored);
  expect(readFileSync(join(restored, `${"d".repeat(90)}/${"e".repeat(90)}/f.txt`), "utf8")).toBe("deep path");
  expect(readFileSync(join(restored, "ñandú café.txt"), "utf8")).toBe("unicode");
  expect(readlinkSync(join(restored, "deep-link"))).toBe("src/deep");
});

// A tar written by hand: what an archive from elsewhere could hold.
function header(name: string, type: string, size: number, linkname = "", mode = 0o644): Uint8Array {
  const block = new Uint8Array(512);
  const text = (offset: number, value: string) => block.set(new TextEncoder().encode(value), offset);
  text(0, name);
  text(100, `${mode.toString(8).padStart(7, "0")}\0`);
  text(108, "0000000\0");
  text(116, "0000000\0");
  text(124, `${size.toString(8).padStart(11, "0")}\0`);
  text(136, `${"0".repeat(11)}\0`);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  text(157, linkname);
  text(257, "ustar\0");
  text(263, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  text(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}
type Entry = { name: string; type?: string; body?: string; link?: string };
function tarOf(entries: Entry[], end = true): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const body = new TextEncoder().encode(entry.body ?? "");
    parts.push(header(entry.name, entry.type ?? "0", body.byteLength, entry.link ?? ""), body, new Uint8Array((512 - (body.byteLength % 512)) % 512));
  }
  if (end) parts.push(new Uint8Array(1024));
  return new Uint8Array(Bun.gzipSync(new Uint8Array(Buffer.concat(parts))));
}
async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

test("an archive with an entry that could leave the directory is refused whole, and nothing is written outside", async () => {
  const tricks: Record<string, Entry[]> = {
    "a .. segment": [{ name: "ok.txt", body: "ok" }, { name: "../evil.txt", body: "evil" }],
    "a .. inside a path": [{ name: "a/../../evil.txt", body: "evil" }],
    "an absolute path": [{ name: "/tmp/pikit-evil.txt", body: "evil" }],
    "an absolute link": [{ name: "l", type: "2", link: "/etc" }],
    "a link that climbs out": [{ name: "a/l", type: "2", link: "../../evil" }],
    "a link with .. after a name": [{ name: "l", type: "2", link: "x/../.." }],
    "a file under a link": [{ name: "l", type: "2", link: "." }, { name: "l/evil.txt", body: "evil" }],
    "a link under a link": [{ name: "a", type: "2", link: "b" }, { name: "a/c", type: "2", link: "." }],
    "a file under a link, the file first": [{ name: "l/evil.txt", body: "evil" }, { name: "l", type: "2", link: "." }],
    "two entries at one path": [{ name: "x", body: "one" }, { name: "x", body: "two" }],
    "a hard link": [{ name: "x", body: "x" }, { name: "h", type: "1", link: "x" }],
    "a device": [{ name: "dev", type: "3" }],
    "a NUL in a pax path": [{ name: "PaxHeader", type: "x", body: "18 path=a\0/../b\n" }, { name: "ignored", body: "x" }],
  };
  for (const [trick, entries] of Object.entries(tricks)) {
    const root = temporary();
    const dest = join(root, "dest");
    mkdirSync(dest);
    const error = await extractSnapshotArchive(once(tarOf(entries)), dest).then(() => undefined, (thrown: unknown) => thrown);
    expect({ trick, refused: error instanceof SnapshotArchiveError || (error as { code?: string })?.code === "EEXIST" }).toEqual({ trick, refused: true });
    expect(readdirSync(root)).toEqual(["dest"]);
    expect(existsSync("/tmp/pikit-evil.txt")).toBe(false);
  }
  // A broken header checksum, and an archive cut in the middle of an entry.
  const root = temporary();
  const broken = tarOf([{ name: "x", body: "x" }]);
  const raw = Bun.gunzipSync(broken);
  raw[0] = 0x79;
  await expect(extractSnapshotArchive(once(Bun.gzipSync(raw)), root)).rejects.toThrow("checksum");
  const cut = Bun.gzipSync(Bun.gunzipSync(tarOf([{ name: "y", body: "y".repeat(2000) }], false)).slice(0, 1024));
  await expect(extractSnapshotArchive(once(cut), temporary())).rejects.toThrow("middle of an entry");
});

test("the link rule: relative, leading .. only, never above the root", () => {
  expect(linkStaysInside("a", "b")).toBe(true);
  expect(linkStaysInside("a/b/l", "../../x")).toBe(true);
  expect(linkStaysInside("a/b/l", "../../../x")).toBe(false);
  expect(linkStaysInside("l", "..")).toBe(false);
  expect(linkStaysInside("l", "./x/./y")).toBe(true);
  expect(linkStaysInside("l", "x/../y")).toBe(false);
  expect(linkStaysInside("l", "/x")).toBe(false);
  expect(linkStaysInside("l", "")).toBe(false);
});

/** `store` failing at the first call `fails` names (`putStream`, `put`, `get`…), as a crash there would. */
function failingAt(store: BlobStore, fails: (op: string, key: string) => boolean): BlobStore {
  const wrap =
    <A extends unknown[], R>(op: string, call: (key: string, ...rest: A) => Promise<R>) =>
    async (key: string, ...rest: A): Promise<R> => {
      if (fails(op, key)) throw new Error(`crash at ${op}`);
      return await call(key, ...rest);
    };
  return {
    put: wrap("put", store.put),
    get: wrap("get", store.get),
    delete: wrap("delete", store.delete),
    list: wrap("list", store.list),
    putStream: wrap("putStream", store.putStream),
    getStream: wrap("getStream", store.getStream),
  };
}

test("a checkpoint that stops at any step leaves the directory and the snapshot before it; the next one completes and deletes what it left", async () => {
  const root = temporary();
  const dir = workspace(root);
  const before = describe(dir);
  const store = storeOf();
  const tmp = join(root, "tmp");
  const first = await checkpointSnapshot(store, target(dir), { tmp, now: 100 });
  const manifestOf = async () => parseSnapshotManifest(new TextDecoder().decode((await store.get(snapshotManifestKey(ID)))?.bytes), { id: ID, agent: "support" });
  const archives = async () => (await store.list(`${ID}/snapshot-`)).entries.map((entry) => entry.key);
  writeFileSync(join(dir, "README.md"), "# changed\n");
  const changed = describe(dir);
  expect(changed).not.toEqual(before);

  // The archive cannot be written (its temporary area is a file).
  writeFileSync(join(root, "blocked"), "");
  await expect(checkpointSnapshot(store, target(dir), { tmp: join(root, "blocked"), now: 200 })).rejects.toThrow();
  // The upload fails; the manifest's put fails (the archive stays, named by nothing); the manifest read back fails.
  for (const [op, now] of [["putStream", 300], ["put", 400], ["get", 500]] as const) {
    await expect(checkpointSnapshot(failingAt(store, (o) => o === op), target(dir), { tmp, now })).rejects.toThrow(`crash at ${op}`);
    expect(describe(dir)).toEqual(changed);
  }
  // The read back failed after the manifest was written: that snapshot is whole, and it is the one named.
  expect((await manifestOf()).createdAt).toBe(500);
  expect((await archives()).length).toBe(3);
  // A use while it uploaded: the archive it sent is deleted, the manifest left as it was.
  expect(await checkpointSnapshot(store, target(dir), { tmp, now: 600, beforeManifest: () => false })).toBeUndefined();
  expect((await manifestOf()).createdAt).toBe(500);
  expect((await archives()).length).toBe(3);
  expect(readdirSync(tmp)).toEqual([]);
  expect(first?.manifest.createdAt).toBe(100);

  // The snapshot named restores the changed files; the next checkpoint's cleanup leaves only its own.
  const saved = await checkpointSnapshot(store, target(dir), { tmp, now: 700 });
  const { deleteSupersededSnapshots } = await import("./workspace-snapshot.ts");
  await deleteSupersededSnapshots(store, ID, saved?.manifest.object as string);
  expect(await archives()).toEqual([saved?.manifest.object as string]);
  const restored = join(root, "restored");
  await restoreSnapshot(store, target(restored), { tmp, base: root });
  const kept = { ...changed };
  delete kept["absolute-link"];
  delete kept["src/escaping-link"];
  expect(describe(restored)).toEqual(kept);
});

test("a restore that fails at any step, or finds an archive that is not its manifest's, leaves no directory", async () => {
  const root = temporary();
  const dir = workspace(root);
  const store = storeOf();
  const tmp = join(root, "tmp");
  const saved = await checkpointSnapshot(store, target(dir), { tmp, now: 1 });
  const manifest = saved?.manifest as NonNullable<typeof saved>["manifest"];
  const dest = join(root, "chats", "c", "support");
  const restore = (s: BlobStore) => restoreSnapshot(s, target(dest), { tmp, base: root });
  const nothing = () => {
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  };

  await expect(restore(failingAt(store, (op) => op === "get"))).rejects.toThrow("crash at get");
  nothing();
  await expect(restore(failingAt(store, (op) => op === "getStream"))).rejects.toThrow("crash at getStream");
  nothing();
  // The archive's body fails partway.
  const cut: BlobStore = {
    ...store,
    getStream: async (key) => {
      const value = await store.getStream(key);
      if (value === undefined) return undefined;
      const reader = value.body.getReader();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent > 0) return controller.error(new Error("connection reset"));
          const { value: chunk } = await reader.read();
          sent++;
          controller.enqueue(chunk as Uint8Array);
        },
      });
      return { ...value, body };
    },
  };
  await expect(restore(cut)).rejects.toThrow("connection reset");
  nothing();

  // Other bytes under the archive's key: refused, before anything is swapped in.
  const original = await store.getStream(manifest.object);
  const bytes = new Uint8Array(await new Response(original?.body).arrayBuffer());
  const corrupt = new Uint8Array(bytes);
  corrupt[corrupt.length - 9] = (corrupt[corrupt.length - 9] as number) ^ 0xff;
  await store.put(manifest.object, corrupt);
  await expect(restore(store)).rejects.toThrow();
  nothing();
  // A whole, valid archive of other files under its key: extracted aside, then refused by its SHA-256.
  const elsewhere = temporary();
  const otherDir = workspace(elsewhere);
  writeFileSync(join(otherDir, "README.md"), "# other\n");
  await writeSnapshotArchive(otherDir, join(elsewhere, "o.tar.gz"));
  await store.put(manifest.object, readFileSync(join(elsewhere, "o.tar.gz")));
  await store.put(snapshotManifestKey(ID), new TextEncoder().encode(JSON.stringify({ ...manifest, size: statSync(join(elsewhere, "o.tar.gz")).size })));
  await expect(restore(store)).rejects.toThrow("the archive is not the manifest's");
  nothing();
  await store.put(snapshotManifestKey(ID), new TextEncoder().encode(JSON.stringify(manifest)));
  // A manifest whose size is not its archive's.
  await store.put(manifest.object, bytes);
  await store.put(snapshotManifestKey(ID), new TextEncoder().encode(JSON.stringify({ ...manifest, size: manifest.size - 1 })));
  await expect(restore(store)).rejects.toThrow("larger than its manifest's");
  nothing();
  // Another agent's manifest, or one of another version, is never restored from.
  await store.put(snapshotManifestKey(ID), new TextEncoder().encode(JSON.stringify({ ...manifest, agent: "ops" })));
  await expect(restore(store)).rejects.toThrow("agent");
  await store.put(snapshotManifestKey(ID), new TextEncoder().encode(JSON.stringify({ ...manifest, version: 2 })));
  await expect(restore(store)).rejects.toThrow("version");
  // A manifest naming an archive that is gone.
  await store.put(snapshotManifestKey(ID), new TextEncoder().encode(JSON.stringify(manifest)));
  await store.delete(manifest.object);
  await expect(restore(store)).rejects.toThrow("not in the bucket");
  nothing();
  // And the right one, restored.
  await store.put(manifest.object, bytes);
  await restore(store);
  expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("# hello\n");
  // A directory on the way that is a link: nothing restored through it.
  const linked = temporary();
  symlinkSync(temporary(), join(linked, "chats"));
  await expect(restoreSnapshot(store, target(join(linked, "chats", "c", "support")), { tmp: join(linked, "tmp"), base: linked })).rejects.toThrow("link");
});

test("deleteSnapshotsBefore: the workspaces whose newest archive is older go, manifest first; the others stay", async () => {
  const root = temporary();
  const dir = workspace(root);
  const store = storeOf();
  const old = snapshotIdOf("old", "support");
  const fresh = snapshotIdOf("fresh", "support");
  await checkpointSnapshot(store, target(dir, old), { tmp: join(root, "tmp"), now: 1_000 });
  await checkpointSnapshot(store, target(dir, fresh), { tmp: join(root, "tmp"), now: 1_000 });
  await checkpointSnapshot(store, target(dir, fresh), { tmp: join(root, "tmp"), now: 5_000 });
  await store.put("not-a-snapshot", new Uint8Array([1]));
  expect(await deleteSnapshotsBefore(store, 2_000)).toEqual([old]);
  const keys = (await store.list("")).entries.map((entry) => entry.key);
  expect(keys.filter((key) => key.startsWith(old))).toEqual([]);
  expect(keys.filter((key) => key.startsWith(fresh))).toHaveLength(3);
  expect(keys).toContain("not-a-snapshot");
});

/** A manager over `root/ws/<n>` with a manual clock, and its logs. */
function manager(root: string, store: BlobStore, options: { busy?: (dir: string) => boolean; maxBytes?: number } = {}) {
  const clock = createManualClock(1_800_000_000_000);
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, ...(fields !== undefined && { fields }) });
  const snapshots = new WorkspaceSnapshots({
    name: "test",
    store: () => store,
    base: root,
    state: join(root, ".state"),
    idleMs: 10 * 60_000,
    clock,
    log: { debug: push("debug"), info: push("info"), warn: push("warn") },
    ...(options.busy !== undefined && { busy: options.busy }),
    ...(options.maxBytes !== undefined && { maxBytes: options.maxBytes }),
  });
  return { snapshots, clock, logs };
}

test("WorkspaceSnapshots: idle for idleMs, checkpointed and released; the next use restores it; a busy one, or one used meanwhile, is kept", async () => {
  const root = temporary();
  const store = storeOf();
  let busy = false;
  const { snapshots, clock, logs } = manager(root, store, { busy: () => busy });
  await snapshots.start();
  const ws = target(join(root, "chats", "c1", "support"));
  await snapshots.use(ws);
  mkdirSync(ws.dir, { recursive: true });
  writeFileSync(join(ws.dir, "notes.md"), "kept");
  chmodSync(join(ws.dir, "notes.md"), 0o640);

  // 9 minutes: kept. Busy at 11: kept.
  await clock.advance(9 * 60_000);
  expect(existsSync(ws.dir)).toBe(true);
  busy = true;
  await clock.advance(2 * 60_000);
  await clock.advance(SNAPSHOT_SWEEP_MS);
  expect(existsSync(ws.dir)).toBe(true);
  busy = false;
  await clock.advance(SNAPSHOT_SWEEP_MS);
  for (let i = 0; i < 50 && existsSync(ws.dir); i++) await Bun.sleep(10);
  expect(existsSync(ws.dir)).toBe(false);
  const kept = (await store.list(`${ID}/`)).entries.map((e) => e.key.slice(65));
  expect(kept).toHaveLength(2);
  expect(kept[0]).toBe("manifest.json");
  expect(kept[1]).toMatch(/^snapshot-1800000\d+-[0-9a-f]{16}\.tar\.gz$/);
  expect(logs.some((log) => log.message === "test: saved idle workspaces to the bucket and released them here (snapshots)")).toBe(true);
  expect(readdirSync(join(root, ".state", "index"))).toEqual([]);

  // The next use restores it, identical.
  await snapshots.use(ws);
  expect(readFileSync(join(ws.dir, "notes.md"), "utf8")).toBe("kept");
  expect(statSync(join(ws.dir, "notes.md")).mode & 0o777).toBe(0o640);

  // A call in flight (track) keeps it, however long; once it ended it goes.
  let finish: () => void = () => {};
  const tracked = snapshots.track(ws.dir, { run: () => new Promise<void>((resolve) => (finish = resolve)) });
  const running = tracked.run();
  await clock.advance(30 * 60_000);
  await clock.advance(SNAPSHOT_SWEEP_MS);
  expect(existsSync(ws.dir)).toBe(true);
  finish();
  await running;
  await clock.advance(SNAPSHOT_SWEEP_MS);
  for (let i = 0; i < 50 && existsSync(ws.dir); i++) await Bun.sleep(10);
  expect(existsSync(ws.dir)).toBe(false);
  await snapshots.stop();
});

test("WorkspaceSnapshots: a use during the checkpoint keeps the directory; a restart finds the workspaces on disk; an archive past maxBytes stays, told", async () => {
  const root = temporary();
  const base = storeOf();
  let onUpload: () => void = () => {};
  const store: BlobStore = {
    ...base,
    putStream: async (key, body, options) => {
      onUpload();
      return await base.putStream(key, body, options);
    },
  };
  const first = manager(root, store);
  await first.snapshots.start();
  const ws = target(join(root, "chats", "c1", "support"));
  await first.snapshots.use(ws);
  mkdirSync(ws.dir, { recursive: true });
  writeFileSync(join(ws.dir, "a.txt"), "a");
  // Used again while its archive uploads: not released, and the archive sent is not named.
  onUpload = () => {
    onUpload = () => {};
    void first.snapshots.use(ws);
  };
  await first.clock.advance(11 * 60_000);
  await first.clock.advance(SNAPSHOT_SWEEP_MS);
  await Bun.sleep(50);
  expect(existsSync(ws.dir)).toBe(true);
  expect(await base.get(snapshotManifestKey(ID))).toBeUndefined();
  await first.snapshots.stop();

  // A new process: the workspace is found from the index, counts as used at start, and goes when idle.
  const second = manager(root, store);
  mkdirSync(join(root, ".state", "tmp", "restore-left-by-a-crash"), { recursive: true });
  await second.snapshots.start();
  expect(existsSync(join(root, ".state", "tmp"))).toBe(false);
  await second.clock.advance(11 * 60_000);
  for (let i = 0; i < 50 && existsSync(ws.dir); i++) await Bun.sleep(10);
  expect(existsSync(ws.dir)).toBe(false);
  expect(await base.get(snapshotManifestKey(ID))).toBeDefined();
  await second.snapshots.stop();

  // Too large: kept, the operator told, not tried again until it is used.
  const third = manager(root, store, { maxBytes: 10 });
  await third.snapshots.start();
  await third.snapshots.use(ws);
  expect(readFileSync(join(ws.dir, "a.txt"), "utf8")).toBe("a");
  await third.clock.advance(11 * 60_000);
  await third.clock.advance(SNAPSHOT_SWEEP_MS);
  await Bun.sleep(50);
  expect(existsSync(ws.dir)).toBe(true);
  expect(third.logs.filter((log) => log.level === "warn").map((log) => log.fields?.error)).toEqual([expect.stringContaining("larger than its 10 bytes")]);
  await third.clock.advance(SNAPSHOT_SWEEP_MS);
  expect(third.logs.filter((log) => log.level === "warn")).toHaveLength(1);
  await third.snapshots.stop();
});

test("WorkspaceSnapshots: two uses of a released workspace restore it once", async () => {
  const root = temporary();
  const store = storeOf();
  const dir = workspace(root);
  await checkpointSnapshot(store, target(dir), { tmp: join(root, "tmp"), now: 1 });
  const { snapshots } = manager(root, store);
  await snapshots.start();
  const ws = target(join(root, "chats", "c9", "support"));
  await Promise.all([snapshots.use(ws), snapshots.use(ws), snapshots.use(ws)]);
  expect(readFileSync(join(ws.dir, "README.md"), "utf8")).toBe("# hello\n");
  await snapshots.stop();
});
