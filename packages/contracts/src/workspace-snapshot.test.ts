/**
 * The format's neutral half on its own (`workspace-snapshot.ts`): the archive check every backend that
 * extracts with a tar program runs (what it takes, what it refuses, and that it takes what the server's
 * checkpoint writes), the link rule shared with `@pikit/contracts/snapshots`, and the steps of a backend
 * whose archive is made elsewhere: the archive whole before the manifest, a body that fails partway
 * leaving neither, a restore's bytes checked against the manifest.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobStore } from "./blob.ts";
import { linkStaysInside, writeSnapshotArchive } from "./snapshots.ts";
import { createMemoryBlobStorage } from "./testing/index.ts";
import {
  checkSnapshotArchive,
  commitSnapshotManifest,
  putSnapshotArchive,
  readSnapshotArchive,
  SnapshotArchiveRefused,
  snapshotArchiveKey,
  snapshotId,
  snapshotLinkStaysInside,
  snapshotManifestKey,
} from "./workspace-snapshot.ts";

interface Entry {
  name: string;
  type?: string;
  content?: string | Uint8Array;
  linkname?: string;
  size?: number;
  badChecksum?: boolean;
  magic?: string;
}

const encoder = new TextEncoder();

function header(entry: Entry, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (at: number, text: string) => block.set(encoder.encode(text), at);
  put(0, entry.name.slice(0, 100));
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, entry.type ?? "0");
  if (entry.linkname !== undefined) put(157, entry.linkname);
  put(257, entry.magic ?? "ustar\0");
  put(263, "00");
  put(148, "        ");
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, `${(entry.badChecksum === true ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** A pax record's text: its length counts itself. */
function pax(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let n = body.length + 1;
  while (String(n).length + body.length !== n) n = String(n).length + body.length;
  return `${n}${body}`;
}

function tar(entries: Entry[], options: { end?: Uint8Array | false } = {}): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = typeof entry.content === "string" ? encoder.encode(entry.content) : (entry.content ?? new Uint8Array());
    blocks.push(header(entry, entry.size ?? content.length));
    if (content.length > 0) {
      const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  if (options.end !== false) blocks.push(options.end ?? new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, block) => n + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

const gzip = (bytes: Uint8Array) => Bun.gzipSync(bytes as Uint8Array<ArrayBuffer>);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function check(bytes: Uint8Array, options: Parameters<typeof checkSnapshotArchive>[1] = {}): Promise<string> {
  const checked = checkSnapshotArchive((async function* () {
    // In pieces, as a stream comes.
    for (let at = 0; at < bytes.length; at += 333) yield bytes.subarray(at, at + 333);
  })(), options);
  try {
    let size = 0;
    for await (const chunk of checked.chunks) size += chunk.byteLength;
    const result = checked.result();
    expect(result.size).toBe(size);
    expect(result.sha256).toBe(sha256(bytes));
    return `taken: ${result.entries}`;
  } catch (error) {
    return error instanceof SnapshotArchiveRefused ? `refused: ${error.message}` : `threw: ${String(error)}`;
  }
}

describe("the archive check", () => {
  test("files, directories, links inside, pax and GNU long names, GNU headers: taken, the same bytes passed on", async () => {
    const long = `${"d".repeat(70)}/${"e".repeat(70)}/f.txt`;
    expect(await check(gzip(tar([
      { name: "./", type: "5" },
      { name: "dir/", type: "5" },
      { name: "dir/", type: "5" },
      { name: "dir/a", content: "a" },
      { name: "dir/l", type: "2", linkname: "../dir/a" },
      { name: "PaxHeader", type: "x", content: pax("path", long) + pax("mtime", "1.5") },
      { name: "short", content: "x" },
      { name: "././@LongLink", type: "L", content: `${"g".repeat(120)}\0` },
      { name: "cut", content: "y" },
      { name: "c", type: "7", content: "contiguous is a file" },
      { name: "gnu", content: "z", magic: "ustar  \0" },
    ])))).toBe("taken: 9");
  });

  test.each([
    ["an absolute path", [{ name: "/etc/x", content: "x" }]],
    ["a path with ..", [{ name: "a/../../x", content: "x" }]],
    ["a pax path with ..", [{ name: "P", type: "x", content: pax("path", "../x") }, { name: "fine", content: "x" }]],
    ["a GNU long name with ..", [{ name: "././@LongLink", type: "L", content: "../evil" }, { name: "fine", content: "x" }]],
    ["a NUL in a long name", [{ name: "././@LongLink", type: "L", content: "a\0/../../x" }, { name: "fine", content: "x" }]],
    ["a link out", [{ name: "a/l", type: "2", linkname: "../../etc" }]],
    ["an absolute link", [{ name: "l", type: "2", linkname: "/etc" }]],
    ["a link with .. after a name", [{ name: "l", type: "2", linkname: "d/../x" }]],
    ["a pax linkpath out", [{ name: "P", type: "x", content: pax("linkpath", "../../x") }, { name: "l", type: "2", linkname: "ok" }]],
    ["an entry under a link", [{ name: "l", type: "2", linkname: "." }, { name: "l/x", content: "x" }]],
    ["a link after an entry under it", [{ name: "l/x", content: "x" }, { name: "l", type: "2", linkname: "." }]],
    ["two entries at one path", [{ name: "a", content: "1" }, { name: "./a", content: "2" }]],
    ["a file where a directory is", [{ name: "a/", type: "5" }, { name: "a", content: "x" }]],
    ["a file at the root itself", [{ name: "./", content: "x" }]],
    ["a hard link", [{ name: "a", content: "x" }, { name: "b", type: "1", linkname: "a" }]],
    ["a device", [{ name: "d", type: "3" }]],
    ["a FIFO", [{ name: "f", type: "6" }]],
    ["a GNU sparse file", [{ name: "s", type: "S" }]],
    ["a pax sparse record", [{ name: "P", type: "x", content: pax("GNU.sparse.name", "../x") }, { name: "fine", content: "x" }]],
    ["a global header naming a path", [{ name: "G", type: "g", content: pax("path", "x") }, { name: "fine", content: "x" }]],
    ["a pax and a GNU name for one entry", [{ name: "././@LongLink", type: "L", content: "a" }, { name: "P", type: "x", content: pax("path", "b") }, { name: "fine", content: "x" }]],
    ["a directory with data", [{ name: "d/", type: "5", size: 512 }, { name: "hidden", content: "x" }]],
    ["a link with data", [{ name: "l", type: "2", linkname: "a", size: 512 }]],
    ["a bad checksum", [{ name: "a", content: "x", badChecksum: true }]],
  ] as [string, Entry[]][])("%s is refused", async (_, entries) => {
    expect(await check(gzip(tar(entries)))).toMatch(/^refused: /);
  });

  test("cut short, no end block, bytes after the end, not gzip, past maxBytes or maxUnpackedBytes: refused", async () => {
    const whole = tar([{ name: "a", content: "x".repeat(2000) }]);
    expect(await check(gzip(whole.subarray(0, 1200)))).toMatch(/^refused: .*ends before/);
    expect(await check(gzip(tar([{ name: "a", content: "x" }], { end: false })))).toMatch(/^refused: .*ends before/);
    const smuggled = new Uint8Array(1024);
    smuggled.set(header({ name: "evil", content: "" }, 0), 512);
    expect(await check(gzip(tar([{ name: "a", content: "x" }], { end: new Uint8Array([...new Uint8Array(512), ...smuggled]) })))).toMatch(/^refused: .*after its end-of-archive/);
    expect(await check(encoder.encode("not gzip at all"))).toMatch(/^refused: .*not gzip/);
    expect(await check(gzip(whole), { maxBytes: 10 })).toMatch(/^refused: .*larger than 10 bytes/);
    expect(await check(gzip(whole), { maxUnpackedBytes: 1024 })).toMatch(/^refused: .*unpacks to more than 1024/);
    // A tar's zero padding after its end blocks is taken.
    expect(await check(gzip(tar([{ name: "a", content: "x" }], { end: new Uint8Array(10240) })))).toBe("taken: 1");
  });

  test("against the manifest's size and SHA-256", async () => {
    const archive = gzip(tar([{ name: "a", content: "x" }]));
    expect(await check(archive, { expected: { size: archive.length, sha256: sha256(archive) } })).toBe("taken: 1");
    expect(await check(archive, { expected: { size: archive.length - 1, sha256: sha256(archive) } })).toMatch(/larger than its manifest's/);
    expect(await check(archive, { expected: { size: archive.length + 1, sha256: sha256(archive) } })).toMatch(/not its manifest's/);
    expect(await check(archive, { expected: { size: archive.length, sha256: "0".repeat(64) } })).toMatch(/not its manifest's/);
  });

  test("the server's checkpoint archive (`writeSnapshotArchive`) is taken", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pikit-ws-check-"));
    try {
      const root = join(dir, "ws");
      mkdirSync(join(root, "sub", "deep"), { recursive: true });
      writeFileSync(join(root, "sub", "deep", `${"n".repeat(120)}.txt`), "long");
      writeFileSync(join(root, "été.txt"), "non-ASCII");
      symlinkSync("../été.txt", join(root, "sub", "up"));
      symlinkSync("/etc/hosts", join(root, "out"));
      const made = await writeSnapshotArchive(root, join(dir, "a.tar.gz"));
      const bytes = new Uint8Array(await Bun.file(join(dir, "a.tar.gz")).arrayBuffer());
      expect(made.skipped.links).toBe(1);
      expect(await check(bytes)).toBe("taken: 5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the link rule is the server's, case by case", () => {
    const cases: [string, string][] = [
      ["l", "a"], ["l", "./a"], ["l", "a/b/c"], ["a/l", "../b"], ["a/l", "../../b"], ["a/b/l", "../../c"], ["l", ".."], ["l", "a/../b"],
      ["l", "/abs"], ["l", ""], ["l", "a\0b"], ["a/l", "..//../x"], ["a/l", "./../x"], ["a/b/l", "../x/../y"], ["l", "."], ["a/l", ".."],
    ];
    for (const [path, target] of cases) expect([path, target, snapshotLinkStaysInside(path, target)]).toEqual([path, target, linkStaysInside(path, target)]);
  });
});

describe("a snapshot made elsewhere", () => {
  function recorded() {
    const store = createMemoryBlobStorage().namespace("workspace-snapshots");
    const log: string[] = [];
    const wrapped: BlobStore = {
      ...store,
      put: async (key, bytes, options) => (log.push(`put ${key}`), store.put(key, bytes, options)),
      putStream: async (key, body, options) => {
        log.push(`putStream ${key}`);
        return await store.putStream(key, body, options);
      },
      get: (key) => store.get(key),
      getStream: (key) => store.getStream(key),
      delete: async (key) => (log.push(`delete ${key}`), store.delete(key)),
      list: (prefix, options) => store.list(prefix, options),
    };
    return { store: wrapped, log };
  }

  test("the archive streamed and checked into the bucket, then the manifest, read back; a restore reads it checked", async () => {
    const { store, log } = recorded();
    const id = await snapshotId("execution-serve:s-1", "dev");
    const archive = gzip(tar([{ name: "a", content: "kept" }]));
    const manifest = await putSnapshotArchive(store, { id, agent: "dev", createdAt: 1000, sha256: sha256(archive), body: new Blob([archive as Uint8Array<ArrayBuffer>]).stream() });
    expect(manifest).toEqual({ version: 1, object: snapshotArchiveKey(id, 1000, sha256(archive)), sha256: sha256(archive), size: archive.length, createdAt: 1000, agent: "dev" });
    expect(await store.get(snapshotManifestKey(id))).toBeUndefined();
    await commitSnapshotManifest(store, id, manifest);
    expect(log).toEqual([`putStream ${manifest.object}`, `put ${snapshotManifestKey(id)}`]);

    const read = await readSnapshotArchive(store, { id, agent: "dev" });
    if (read === undefined) throw new Error("no snapshot");
    const chunks: Uint8Array[] = [];
    for await (const chunk of read.chunks) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(archive));
    expect(read.result()).toEqual({ size: archive.length, sha256: sha256(archive), entries: 1 });
    await expect(readSnapshotArchive(store, { id, agent: "other" })).rejects.toThrow(SnapshotArchiveRefused);
    expect(await readSnapshotArchive(store, { id: await snapshotId("execution-serve:s-2", "dev"), agent: "dev" })).toBeUndefined();
  });

  test("a body that fails partway, an archive refused, a SHA-256 that is not the key's: no value, no manifest", async () => {
    const id = await snapshotId("chat", "dev");
    const archive = gzip(tar([{ name: "a", content: "x".repeat(5000) }]));
    const failing = (async function* () {
      yield archive.subarray(0, 20);
      throw new Error("the container went away");
    })();
    const bodies: [string, AsyncIterable<Uint8Array>, string][] = [
      ["failing", failing, sha256(archive)],
      ["refused", new Blob([gzip(tar([{ name: "../x", content: "x" }]))]).stream() as unknown as AsyncIterable<Uint8Array>, sha256(gzip(tar([{ name: "../x", content: "x" }])))],
      ["another SHA-256", new Blob([archive as Uint8Array<ArrayBuffer>]).stream() as unknown as AsyncIterable<Uint8Array>, "0".repeat(64)],
    ];
    for (const [what, body, sha] of bodies) {
      const { store } = recorded();
      await expect(putSnapshotArchive(store, { id, agent: "dev", createdAt: 1, sha256: sha, body }), what).rejects.toThrow();
      expect((await store.list("")).entries, what).toEqual([]);
    }
  });

  test("a restore's archive tampered with, or missing, is refused once its bytes are read", async () => {
    const { store } = recorded();
    const id = await snapshotId("chat", "dev");
    const archive = gzip(tar([{ name: "a", content: "one" }]));
    const manifest = await putSnapshotArchive(store, { id, agent: "dev", createdAt: 1, sha256: sha256(archive), body: new Blob([archive as Uint8Array<ArrayBuffer>]).stream() });
    await commitSnapshotManifest(store, id, manifest);
    await store.put(manifest.object, gzip(tar([{ name: "a", content: "two" }])));
    const read = await readSnapshotArchive(store, { id, agent: "dev" });
    const drain = async () => {
      for await (const _ of read?.chunks ?? []) void _;
    };
    await expect(drain()).rejects.toThrow(/not its manifest's|larger than its manifest's/);
    await store.delete(manifest.object);
    await expect(readSnapshotArchive(store, { id, agent: "dev" })).rejects.toThrow(/not in the bucket/);
  });
});
