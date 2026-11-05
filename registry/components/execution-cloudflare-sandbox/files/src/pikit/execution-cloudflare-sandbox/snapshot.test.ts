/**
 * The shared snapshot format (`snapshot.ts`) and the archive check (`tar.ts`) on their own: the
 * order of the writes (the archive, checked, then the manifest, then the superseded ones deleted), what
 * a manifest must hold, and every kind of archive entry refused.
 */

import { describe, expect, test } from "bun:test";
import type { BlobStore } from "@pikit/contracts";
import { createMemoryBlobStorage } from "@pikit/contracts/testing";
import { craftArchive } from "./archive.test-support.ts";
import { archiveKey, MANIFEST, parseManifest, readSnapshot, SnapshotRefused, sha256Hex, snapshotPrefix, writeSnapshot } from "./snapshot.ts";
import { ArchiveRefused, entryPath, inspectArchive, linkStaysInside } from "./tar.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function recorded(store: BlobStore) {
  const log: string[] = [];
  const wrapped: BlobStore = {
    put: async (key, bytes, options) => (log.push(`put ${key}`), store.put(key, bytes, options)),
    get: (key) => store.get(key),
    delete: async (key) => (log.push(`delete ${key}`), store.delete(key)),
    list: (prefix, options) => store.list(prefix, options),
  };
  return { store: wrapped, log };
}

describe("writeSnapshot", () => {
  test("the archive first, then the manifest, then the superseded archives; the manifest's fields in order", async () => {
    const { store, log } = recorded(createMemoryBlobStorage().namespace("workspace-snapshots"));
    const prefix = await snapshotPrefix("execution-serve:s", "dev");
    const one = await craftArchive([{ name: "a", content: "1" }]);
    const two = await craftArchive([{ name: "a", content: "2" }]);
    const first = await writeSnapshot({ store, prefix, agent: "dev", archive: one, createdAt: 1000, maxBytes: 1 << 20 });
    const second = await writeSnapshot({ store, prefix, agent: "dev", archive: two, createdAt: 2000, maxBytes: 1 << 20 });
    if ("skipped" in first || "skipped" in second) throw new Error("not written");
    expect(first.object).toBe(archiveKey(prefix, 1000, await sha256Hex(one)));
    expect(log).toEqual([`put ${first.object}`, `put ${prefix}${MANIFEST}`, `put ${second.object}`, `put ${prefix}${MANIFEST}`, `delete ${first.object}`]);
    const manifest = JSON.parse(new TextDecoder().decode((await store.get(`${prefix}${MANIFEST}`))?.bytes));
    expect(manifest).toEqual({ version: 1, object: second.object, sha256: await sha256Hex(two), size: two.length, createdAt: 2000, agent: "dev" });
    expect(Object.keys(manifest)).toEqual(["version", "object", "sha256", "size", "createdAt", "agent"]);
    expect((await readSnapshot(store, prefix, "dev", 1 << 20))?.manifest).toEqual(second);
  });

  test("over maxBytes nothing is written; an upload the bucket does not list at its size writes no manifest", async () => {
    const memory = createMemoryBlobStorage().namespace("workspace-snapshots");
    const archive = await craftArchive([{ name: "a", content: "x" }]);
    expect(await writeSnapshot({ store: memory, prefix: "p/", agent: "a", archive, createdAt: 1, maxBytes: archive.length - 1 })).toEqual({ skipped: expect.stringContaining("maxBytes") });
    expect((await memory.list("")).entries).toEqual([]);
    const lossy: BlobStore = { ...memory, put: (key, bytes, options) => memory.put(key, key.endsWith(".tar.gz") ? bytes.subarray(1) : bytes, options) };
    await expect(writeSnapshot({ store: lossy, prefix: "p/", agent: "a", archive, createdAt: 1, maxBytes: 1 << 20 })).rejects.toThrow("not in the bucket at its size");
    expect(await memory.get(`p/${MANIFEST}`)).toBeUndefined();
  });
});

describe("parseManifest", () => {
  const prefix = "abc/";
  const sha = "a".repeat(64);
  const good = { version: 1, object: `${prefix}snapshot-5-${"a".repeat(16)}.tar.gz`, sha256: sha, size: 3, createdAt: 5, agent: "dev" };

  test("a manifest of the format, for its agent, is taken", () => {
    expect(parseManifest(encode(good), prefix, "dev")).toEqual(good as never);
  });

  test.each([
    ["another version", { version: 2 }],
    ["another agent's", { agent: "other" }],
    ["an object of another prefix", { object: `zzz/snapshot-5-${"a".repeat(16)}.tar.gz` }],
    ["an object whose name does not carry its sha256", { object: `${prefix}snapshot-5-${"b".repeat(16)}.tar.gz` }],
    ["an object outside the prefix", { object: `${prefix}../x/snapshot-5-${"a".repeat(16)}.tar.gz` }],
    ["a sha256 that is not one", { sha256: "xyz" }],
    ["a size that is not one", { size: -1 }],
  ])("%s is refused", (_, change) => {
    expect(() => parseManifest(encode({ ...good, ...change }), prefix, "dev")).toThrow(SnapshotRefused);
  });

  test("bytes that are not JSON are refused", () => {
    expect(() => parseManifest(new TextEncoder().encode("{"), prefix, "dev")).toThrow(SnapshotRefused);
  });
});

describe("the archive check", () => {
  test("files, directories, symlinks inside, long pax names are taken", async () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/f.txt`;
    const { entries } = await inspectArchive(await craftArchive([{ name: "./", type: "5" }, { name: "dir/", type: "5" }, { name: "dir/a", content: "a" }, { name: "dir/l", type: "2", linkname: "../dir/a" }]), 1 << 20);
    expect(entries).toEqual([
      { path: "", kind: "directory", size: 0 },
      { path: "dir", kind: "directory", size: 0 },
      { path: "dir/a", kind: "file", size: 1 },
      { path: "dir/l", kind: "symlink", size: 0, linkTarget: "../dir/a" },
    ]);
    const body = ` path=${long}\n`;
    let size = body.length;
    while (String(size).length + body.length !== size) size = String(size).length + body.length;
    const pax = await craftArchive([{ name: "PaxHeader", type: "x", content: `${size}${body}` }, { name: "short", content: "x" }]);
    expect((await inspectArchive(pax, 1 << 20)).entries.map((entry) => entry.path)).toEqual([long]);
  });

  test.each([
    ["an absolute path", [{ name: "/etc/x", content: "x" }]],
    ["a path leaving the root", [{ name: "a/../../x", content: "x" }]],
    ["a symlink pointing outside", [{ name: "l", type: "2" as const, linkname: "../x" }]],
    ["an absolute symlink", [{ name: "l", type: "2" as const, linkname: "/etc" }]],
    ["an entry below a symlink", [{ name: "l", type: "2" as const, linkname: "dir" }, { name: "l/x", content: "x" }]],
    ["a hard link", [{ name: "h", type: "1" as const, linkname: "a" }]],
    ["a FIFO", [{ name: "f", type: "6" as const }]],
    ["a bad checksum", [{ name: "a", content: "x", badChecksum: true }]],
  ])("%s is refused", async (_, entries) => {
    await expect(inspectArchive(await craftArchive(entries), 1 << 20)).rejects.toThrow(ArchiveRefused);
  });

  test("a truncated archive, gzip that is not, and more than maxUnpackedBytes are refused", async () => {
    await expect(inspectArchive(await craftArchive([{ name: "a", content: "x".repeat(2000) }], { truncate: true }), 1 << 20)).rejects.toThrow(ArchiveRefused);
    await expect(inspectArchive(new TextEncoder().encode("not gzip"), 1 << 20)).rejects.toThrow(ArchiveRefused);
    await expect(inspectArchive(await craftArchive([{ name: "a", content: "x".repeat(5000) }]), 4096)).rejects.toThrow("unpacks to more than");
  });

  test("zeros a tar padded its gzip output with are left out of the member", async () => {
    const archive = await craftArchive([{ name: "a", content: "x" }]);
    const padded = new Uint8Array(10240);
    padded.set(archive);
    const { length, entries } = await inspectArchive(padded, 1 << 20);
    expect(length).toBe(archive.length);
    expect(entries).toHaveLength(1);
  });

  test("paths and links, lexically", () => {
    expect(entryPath("./a/./b/")).toBe("a/b");
    expect(() => entryPath("a/../b")).toThrow(ArchiveRefused);
    expect(linkStaysInside("a/b/l", "../../c")).toBe(true);
    expect(linkStaysInside("a/l", "../../c")).toBe(false);
    expect(linkStaysInside("l", "")).toBe(false);
  });
});
