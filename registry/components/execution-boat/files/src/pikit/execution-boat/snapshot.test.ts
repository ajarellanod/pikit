/**
 * The shared snapshot format (`snapshot.ts`) on its own: the keys, the manifest, what an archive may
 * hold (refused: anything that escapes the workspace root), and the order of a save (archive, read
 * back, manifest last, superseded archives after).
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobStore } from "@pikit/contracts";
import { archiveKey, checkArchive, loadSnapshot, MANIFEST, parseManifest, SnapshotError, saveSnapshot, sha256Hex, snapshotPrefix } from "./snapshot.ts";
import { tarGz } from "./tar.test-support.ts";

const encoder = new TextEncoder();

function store() {
  const data = new Map<string, Uint8Array>();
  const log: string[] = [];
  const blob: BlobStore = {
    async put(key, bytes) {
      log.push(`put ${key}`);
      data.set(key, bytes.slice());
    },
    async get(key) {
      const bytes = data.get(key);
      return bytes === undefined ? undefined : { bytes: bytes.slice() };
    },
    async delete(key) {
      log.push(`delete ${key}`);
      data.delete(key);
    },
    async list(prefix) {
      return { entries: [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length })).sort((a, b) => (a.key < b.key ? -1 : 1)) };
    },
  };
  return { data, log, blob };
}

const refused = async (bytes: Uint8Array) => checkArchive(bytes).then(() => "accepted", (error: unknown) => (error instanceof SnapshotError ? `refused: ${error.message}` : `threw ${String(error)}`));

test("keys: the workspace's prefix is the hex SHA-256 of \"<chat key>\\n<agent>\", the archive named by time and hash", async () => {
  const prefix = await snapshotPrefix("execution-serve:k-abc", "designer");
  expect(prefix).toBe(`${new Bun.CryptoHasher("sha256").update("execution-serve:k-abc\ndesigner").digest("hex")}/`);
  expect(archiveKey(prefix, 1_700_000_000_000, "0123456789abcdef".repeat(4))).toBe(`${prefix}snapshot-1700000000000-0123456789abcdef.tar.gz`);
});

test("an archive of regular files, directories and links that stay inside passes (as GNU or bsdtar writes it)", async () => {
  const bytes = tarGz([
    { name: "notes/", type: "5" },
    { name: "notes/a.txt", content: "kept" },
    { name: "./b.txt", content: "dot-slash is relative" },
    { name: "node_modules/.bin/tool", type: "2", linkname: "../pkg/bin/tool" },
    { name: "link", type: "2", linkname: "notes/a.txt" },
    { name: "x", pax: { path: "a-long/path/".repeat(12) + "file.txt" }, content: "pax path" },
  ]);
  expect(await checkArchive(bytes)).toEqual({ files: 3, directories: 1, symlinks: 2 });
  // The system's own tar, of a real directory: what a backend's export makes.
  const dir = mkdtempSync(join(tmpdir(), "pikit-snapshot-"));
  try {
    mkdirSync(join(dir, "ws", "sub"), { recursive: true });
    writeFileSync(join(dir, "ws", "sub", "f.txt"), "x");
    symlinkSync("sub/f.txt", join(dir, "ws", "l"));
    const made = spawnSync("tar", ["-c", "-z", "-f", join(dir, "a.tar.gz"), "--format=pax", "--no-recursion", "-C", join(dir, "ws"), "sub", "sub/f.txt", "l"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    expect(made.status).toBe(0);
    expect(await checkArchive(new Uint8Array(readFileSync(join(dir, "a.tar.gz"))))).toEqual({ files: 1, directories: 1, symlinks: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archives escaping the root are refused: absolute names, .., links out (also through other links), hard links, devices", async () => {
  const cases: [string, Parameters<typeof tarGz>[0]][] = [
    ["an absolute name", [{ name: "/etc/passwd", content: "x" }]],
    ["a .. in a name", [{ name: "a/../../evil", content: "x" }]],
    ["a .. in a pax path", [{ name: "fine", pax: { path: "../evil" }, content: "x" }]],
    ["a link to an absolute path", [{ name: "l", type: "2", linkname: "/etc" }]],
    ["a link up and out", [{ name: "a/l", type: "2", linkname: "../../etc" }]],
    ["a link out through another link", [{ name: "s", type: "2", linkname: "." }, { name: "t", type: "2", linkname: "s/.." }]],
    ["a link out through a deeper link", [{ name: "d/", type: "5" }, { name: "d/up", type: "2", linkname: ".." }, { name: "u", type: "2", linkname: "d/up/.." }]],
    ["a pax linkpath out", [{ name: "l", type: "2", linkname: "ok", pax: { linkpath: "../../x" } }]],
    ["a hard link", [{ name: "a", content: "x" }, { name: "b", type: "1", linkname: "a" }]],
    ["a device", [{ name: "dev", type: "3" }]],
    ["a FIFO", [{ name: "fifo", type: "6" }]],
    ["a GNU long name", [{ name: "././@LongLink", type: "L", content: "../../evil" }]],
    ["a global pax header naming a path", [{ name: "", type: "g", pax: { path: "../x" } }]],
    ["the root itself", [{ name: "./", type: "5" }]],
  ];
  for (const [what, entries] of cases) {
    expect(`${what}: ${await refused(tarGz(entries))}`).toMatch(new RegExp(`^${what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: refused: `));
  }
  expect(await refused(tarGz([{ name: "a", content: "x", badChecksum: true }]))).toMatch(/wrong checksum/);
  expect(await refused(encoder.encode("not gzip at all"))).toMatch(/^refused: .*gzip/);
  expect(await refused(Bun.gzipSync(encoder.encode("x".repeat(700))))).toMatch(/^refused: /);
});

test("a manifest must be version 1, name an archive under its prefix whose name carries its sha256", async () => {
  const prefix = await snapshotPrefix("chat", "agent");
  const sha256 = "ab".repeat(32);
  const good = { version: 1, object: archiveKey(prefix, 5, sha256), sha256, size: 10, createdAt: 5, agent: "agent" };
  expect(parseManifest(encoder.encode(JSON.stringify(good)), prefix)).toEqual(good as never);
  for (const bad of [
    { ...good, version: 2 },
    { ...good, object: `other/${archiveKey("", 5, sha256)}` },
    { ...good, object: archiveKey(prefix, 5, "cd".repeat(32)) },
    { ...good, object: `${prefix}../x.tar.gz` },
    { ...good, size: -1 },
    { ...good, sha256: "nothex" },
  ]) {
    expect(() => parseManifest(encoder.encode(JSON.stringify(bad)), prefix)).toThrow(SnapshotError);
  }
  expect(() => parseManifest(encoder.encode("{"), prefix)).toThrow(SnapshotError);
});

test("save: archive, read back, manifest last, then superseded archives deleted; load verifies size, sha256 and entries", async () => {
  const { blob, log, data } = store();
  const prefix = await snapshotPrefix("chat", "support");
  const first = tarGz([{ name: "a.txt", content: "one" }]);
  const m1 = await saveSnapshot(blob, prefix, "support", first, 1000);
  expect(m1).toEqual({ version: 1, object: archiveKey(prefix, 1000, await sha256Hex(first)), sha256: await sha256Hex(first), size: first.length, createdAt: 1000, agent: "support" });
  expect(log).toEqual([`put ${m1.object}`, `put ${prefix}${MANIFEST}`]);
  log.length = 0;
  const second = tarGz([{ name: "a.txt", content: "two" }]);
  const m2 = await saveSnapshot(blob, prefix, "support", second, 2000);
  expect(log).toEqual([`put ${m2.object}`, `put ${prefix}${MANIFEST}`, `delete ${m1.object}`]);
  expect([...data.keys()].sort()).toEqual([`${prefix}${MANIFEST}`, m2.object].sort());
  expect(await loadSnapshot(blob, prefix)).toEqual({ manifest: m2, archive: second });
  expect(await loadSnapshot(blob, await snapshotPrefix("chat", "other"))).toBeUndefined();

  // A tampered archive, a wrong size, a missing one: never handed over.
  data.set(m2.object, tarGz([{ name: "a.txt", content: "evil" }]));
  await expect(loadSnapshot(blob, prefix)).rejects.toThrow(/its manifest says|sha256/);
  data.delete(m2.object);
  await expect(loadSnapshot(blob, prefix)).rejects.toThrow(/does not have/);
  // An archive escaping the root is never saved: nothing is put.
  log.length = 0;
  await expect(saveSnapshot(blob, prefix, "support", tarGz([{ name: "../x", content: "x" }]), 3000)).rejects.toThrow(SnapshotError);
  expect(log).toEqual([]);
});

test("save refuses to write the manifest when the archive read back differs", async () => {
  const { blob, log } = store();
  const lying: BlobStore = { ...blob, get: async (key) => (key.endsWith(".tar.gz") ? { bytes: tarGz([{ name: "other", content: "x" }]) } : blob.get(key)) };
  await expect(saveSnapshot(lying, "p/", "a", tarGz([{ name: "a", content: "a" }]), 1)).rejects.toThrow(/read back/);
  expect(log.some((entry) => entry.endsWith(MANIFEST))).toBe(false);
});
