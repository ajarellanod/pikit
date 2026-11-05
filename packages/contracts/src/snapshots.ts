/**
 * @pikit/contracts/snapshots: workspace snapshots of a server's directories, in `storage.blob`, in the
 * shared format (`workspace-snapshot.ts`): what workspace-local and execution-gondolin use to save an
 * idle workspace to a bucket, release its directory, and bring it back on its next use. Server only
 * (`node:fs`, `node:zlib`); the format's keys and manifest are in `@pikit/contracts`, neutral.
 *
 * - **Streaming end to end.** A checkpoint walks the directory into a tar (ustar, pax headers for
 *   long or non-ASCII names and sizes past 8 GiB), gzips it into a temporary file while hashing it
 *   (its key needs its SHA-256), then streams the file to `putStream` with that SHA-256, which the
 *   provider checks. A restore streams the archive from `getStream`, hashing it, through gunzip into
 *   the tar reader, which writes each file as it comes. Neither holds a workspace in memory.
 * - **What an archive holds**: the root's contents, paths relative; regular files (bytes, mode, mtime),
 *   directories (mode, mtime), and symbolic links whose target is relative, climbs (with leading `..`
 *   only) no higher than the root, and has no `..` after a name: following such a link never leaves
 *   the root, whatever the links on its way. Other links (an absolute one, one leading out) and other
 *   files (sockets, fifos, devices) are left out and counted. Owners are not kept; setuid, setgid and
 *   sticky bits are dropped.
 * - **A checkpoint loses nothing.** The local directory is the truth until the manifest naming the
 *   new archive is written and read back equal: `checkpointSnapshot` only writes; the caller releases
 *   (deletes) the directory after it returned. A failure at any step leaves the directory as it was
 *   (and at worst an archive no manifest names, which the next checkpoint deletes).
 * - **A restore checks before it swaps**: the manifest is checked (`parseSnapshotManifest`), the
 *   archive's size and SHA-256 are the manifest's, and it is extracted into an empty directory of its
 *   own (beside the workspace, same filesystem) renamed into place only once all of it was written and
 *   checked. A failure leaves no directory where the workspace goes.
 * - **No entry escapes the restore's directory**: an absolute path, a `..` segment, a NUL, an entry
 *   under a link, a link that would lead out (the rule above), a hard link or a device refuses the
 *   whole archive. Links are made last, so no file is ever written through one; files are created
 *   exclusively (a duplicate refuses the archive).
 * - **`WorkspaceSnapshots`** keeps the idle workspaces of one host: `use` before a workspace is
 *   worked in (it restores one that is not on disk), `sweep` checkpoints and releases those idle for
 *   `idleMs`, never one `busy` (the caller's policy) or used since its checkpoint began.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { Clock } from "@pikit/core";
import type { BlobStore } from "./blob.ts";
import {
  deleteSnapshotsBefore,
  deleteSupersededSnapshots,
  parseSnapshotManifest,
  SNAPSHOT_CONTENT_TYPE,
  SNAPSHOT_VERSION,
  type SnapshotManifest,
  snapshotArchiveKey,
  snapshotManifestJson,
  snapshotManifestKey,
} from "./workspace-snapshot.ts";

export {
  deleteSnapshotsBefore,
  deleteSupersededSnapshots,
  openSnapshotStore,
  parseSnapshotArchiveKey,
  parseSnapshotManifest,
  SNAPSHOT_CONTENT_TYPE,
  SNAPSHOT_MANIFEST,
  SNAPSHOT_NAMESPACE,
  SNAPSHOT_VERSION,
  type SnapshotManifest,
  snapshotArchiveKey,
  snapshotId,
  snapshotManifestJson,
  snapshotManifestKey,
} from "./workspace-snapshot.ts";

/** `snapshotId`, synchronously (`node:crypto`): the hex SHA-256 of `"<chatKey>\n<agent>"`. */
export function snapshotIdOf(chatKey: string, agent: string): string {
  if (typeof chatKey !== "string" || chatKey === "") throw new Error("workspace snapshots: a snapshot needs a non-empty chat key");
  if (typeof agent !== "string" || agent === "") throw new Error("workspace snapshots: a snapshot needs an agent");
  return createHash("sha256").update(`${chatKey}\n${agent}`).digest("hex");
}

/** A workspace to save or restore: its snapshot id, its agent, its directory on this host. */
export interface SnapshotTarget {
  id: string;
  agent: string;
  /** Absolute. */
  dir: string;
}

/** What a checkpoint left out of the archive. */
export interface SnapshotSkipped {
  /** Links that are absolute or lead outside the root. */
  links: number;
  /** Sockets, fifos, devices. */
  other: number;
}

/** An archive larger than the `maxBytes` its workspace may have: refused at checkpoint, the directory kept. */
export class SnapshotTooLargeError extends Error {
  readonly code = "snapshot_too_large";
  constructor(readonly maxBytes: number) {
    super(`workspace snapshots: the workspace's archive is larger than its ${maxBytes} bytes (snapshots.maxBytes): it stays on this host`);
    this.name = "SnapshotTooLargeError";
  }
}

/** An archive that is not what its manifest says, or not one a restore takes. Nothing is swapped in. */
export class SnapshotArchiveError extends Error {
  readonly code = "snapshot_archive";
  constructor(message: string) {
    super(`workspace snapshots: ${message}`);
    this.name = "SnapshotArchiveError";
  }
}

// ---------------------------------------------------------------------------------------------
// The tar format: ustar headers, pax records where ustar's fields do not hold a value.

const BLOCK = 512;
const READ_CHUNK = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** The largest size an ustar header holds (11 octal digits). */
const USTAR_MAX_SIZE = 0o77777777777;
const PERMISSIONS = 0o777;

/** Whether a link at `path` (relative, `/`-separated) with `target` stays inside the root, by the rule above. */
export function linkStaysInside(path: string, target: string): boolean {
  if (target === "" || target.includes("\0") || target.startsWith("/")) return false;
  const parts = target.split("/").filter((part) => part !== "" && part !== ".");
  let up = 0;
  while (parts[up] === "..") up++;
  if (parts.slice(up).includes("..")) return false;
  const depth = path.split("/").length - 1;
  return up <= depth;
}

function writeText(block: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = encoder.encode(text);
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeText(block, offset, length - 1, Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0"));
}

const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/** One pax record: its length counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const length = encoder.encode(body).byteLength;
  let n = length + 1;
  while (String(n).length + length !== n) n = String(n).length + length;
  return `${n}${body}`;
}

function headerBlock(name: string, type: string, size: number, mode: number, mtime: number, linkname: string): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeText(block, 0, 100, name);
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, mtime);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  writeText(block, 157, 100, linkname);
  writeText(block, 257, 6, "ustar\0");
  writeText(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeText(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

const padding = (size: number): Uint8Array => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The header blocks of an entry: a pax header first when a name, a link or the size does not fit ustar's fields. */
function entryHeader(path: string, type: "0" | "2" | "5", size: number, mode: number, mtime: number, linkname = ""): Uint8Array[] {
  const records: string[] = [];
  if (!isAscii(path) || encoder.encode(path).byteLength > 100) records.push(paxRecord("path", path));
  if (!isAscii(linkname) || encoder.encode(linkname).byteLength > 100) records.push(paxRecord("linkpath", linkname));
  if (size > USTAR_MAX_SIZE) records.push(paxRecord("size", String(size)));
  const out: Uint8Array[] = [];
  if (records.length > 0) {
    const pax = encoder.encode(records.join(""));
    out.push(headerBlock("././@PaxHeader", "x", pax.byteLength, 0o644, mtime, ""), pax, padding(pax.byteLength));
  }
  const short = (text: string) => (isAscii(text) && text.length <= 100 ? text : text.replace(/[^\x20-\x7e]/g, "_").slice(0, 100));
  out.push(headerBlock(short(path), type, size > USTAR_MAX_SIZE ? 0 : size, mode, mtime, short(linkname)));
  return out;
}

/** The tar of `root`'s contents, as it is read: depth first, names sorted. */
async function* tarOf(root: string, skipped: SnapshotSkipped): AsyncGenerator<Uint8Array> {
  async function* walk(rel: string): AsyncGenerator<Uint8Array> {
    const names = (await readdir(rel === "" ? root : join(root, rel))).sort();
    for (const name of names) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const full = join(root, path);
      const info = await lstat(full);
      const mtime = Math.floor(info.mtimeMs / 1000);
      const mode = info.mode & PERMISSIONS;
      if (info.isDirectory()) {
        yield* entryHeader(`${path}/`, "5", 0, mode, mtime);
        yield* walk(path);
      } else if (info.isFile()) {
        yield* entryHeader(path, "0", info.size, mode, mtime);
        const handle = await open(full, "r");
        try {
          for (let at = 0; at < info.size; ) {
            const chunk = new Uint8Array(Math.min(READ_CHUNK, info.size - at));
            const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, at);
            if (bytesRead === 0) throw new Error("workspace snapshots: a file shrank while it was archived (something is still writing in the workspace)");
            at += bytesRead;
            yield chunk.subarray(0, bytesRead);
          }
        } finally {
          await handle.close();
        }
        yield padding(info.size);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(full);
        if (!linkStaysInside(path, target)) {
          skipped.links++;
          continue;
        }
        yield* entryHeader(path, "2", 0, 0o777, mtime, target);
      } else {
        skipped.other++;
      }
    }
  }
  yield* walk("");
  yield new Uint8Array(2 * BLOCK);
}

/**
 * Writes the gzip'd tar of `root`'s contents to `file` (created, never replaced), hashing it: its
 * size, SHA-256 and what it left out. Past `maxBytes` it stops (`SnapshotTooLargeError`). `root`
 * must be a directory of its own, not a link.
 */
export async function writeSnapshotArchive(root: string, file: string, options: { maxBytes?: number } = {}): Promise<{ size: number; sha256: string; skipped: SnapshotSkipped }> {
  if (!(await lstat(root)).isDirectory()) throw new Error("workspace snapshots: a workspace to archive is a directory, not a link or a file");
  const skipped: SnapshotSkipped = { links: 0, other: 0 };
  const hash = createHash("sha256");
  let size = 0;
  const out = await open(file, "wx", 0o600);
  try {
    await pipeline(Readable.from(tarOf(root, skipped)), createGzip(), async (compressed: AsyncIterable<Uint8Array>) => {
      for await (const chunk of compressed) {
        size += chunk.byteLength;
        if (options.maxBytes !== undefined && size > options.maxBytes) throw new SnapshotTooLargeError(options.maxBytes);
        hash.update(chunk);
        await out.write(chunk);
      }
    });
    await out.sync();
  } finally {
    await out.close();
  }
  return { size, sha256: hash.digest("hex"), skipped };
}

const zeros = (block: Uint8Array) => block.every((byte) => byte === 0);

function readText(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readNumber(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  // GNU's base-256, for sizes past ustar's.
  if (((field[0] as number) & 0x80) !== 0) {
    let value = (field[0] as number) & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = decoder.decode(field).replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new SnapshotArchiveError("the archive has a header field that is not a number");
  return Number.parseInt(text, 8);
}

/** An entry's path as segments, refusing one that could leave the root. */
function segmentsOf(path: string): string[] {
  if (path.includes("\0")) throw new SnapshotArchiveError("the archive has a path with a NUL");
  if (path.startsWith("/")) throw new SnapshotArchiveError(`the archive has an absolute path (${JSON.stringify(path.slice(0, 80))})`);
  const segments = path.split("/").filter((part) => part !== "" && part !== ".");
  if (segments.includes("..")) throw new SnapshotArchiveError(`the archive has a path with .. (${JSON.stringify(path.slice(0, 80))})`);
  return segments;
}

/** Writes a tar's entries under `dest` (an empty directory), refusing anything that could leave it. */
class TarExtractor {
  private header = new Uint8Array(BLOCK);
  private headerFilled = 0;
  private ended = false;
  /** The body being read: its bytes left, its padding, and where it goes. */
  private body: { left: number; pad: number; file?: Awaited<ReturnType<typeof open>>; text?: Uint8Array[]; done: (bytes: Uint8Array) => void } | undefined;
  private paxPath: string | undefined;
  private paxLink: string | undefined;
  private paxSize: number | undefined;
  private longName: string | undefined;
  private longLink: string | undefined;
  private readonly seen = new Set<string>();
  private readonly links: { path: string; target: string }[] = [];
  private readonly linkPaths = new Set<string>();
  private readonly directories = new Map<string, { mode: number; mtime: number }>();
  private pendingFile: { path: string; mode: number; mtime: number } | undefined;

  constructor(private readonly dest: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    let at = 0;
    while (at < chunk.byteLength) {
      if (this.ended) return;
      if (this.body !== undefined) {
        const body = this.body;
        if (body.left > 0) {
          const n = Math.min(body.left, chunk.byteLength - at);
          const piece = chunk.subarray(at, at + n);
          if (body.file !== undefined) await body.file.write(piece);
          else body.text?.push(piece.slice());
          body.left -= n;
          at += n;
          if (body.left > 0) continue;
        }
        const n = Math.min(body.pad, chunk.byteLength - at);
        body.pad -= n;
        at += n;
        if (body.pad > 0) continue;
        this.body = undefined;
        await this.finishBody(body);
        continue;
      }
      const n = Math.min(BLOCK - this.headerFilled, chunk.byteLength - at);
      this.header.set(chunk.subarray(at, at + n), this.headerFilled);
      this.headerFilled += n;
      at += n;
      if (this.headerFilled < BLOCK) continue;
      this.headerFilled = 0;
      await this.entry(this.header);
      // An entry with no bytes is done at once.
      const body = this.body as TarExtractor["body"];
      if (body !== undefined && body.left === 0 && body.pad === 0) {
        this.body = undefined;
        await this.finishBody(body);
      }
    }
  }

  private async finishBody(body: NonNullable<TarExtractor["body"]>): Promise<void> {
    if (body.file !== undefined) {
      await body.file.close();
      const file = this.pendingFile;
      this.pendingFile = undefined;
      if (file !== undefined) {
        const full = join(this.dest, file.path);
        await chmod(full, file.mode);
        await utimes(full, file.mtime, file.mtime);
      }
      return;
    }
    const parts = body.text ?? [];
    const bytes = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    body.done(bytes);
  }

  private checkPlace(segments: string[], what: string): string {
    if (segments.length === 0) throw new SnapshotArchiveError(`the archive has a ${what} at its root itself`);
    for (let i = 1; i < segments.length; i++) {
      if (this.linkPaths.has(segments.slice(0, i).join("/"))) throw new SnapshotArchiveError("the archive has an entry under a link");
    }
    return segments.join("/");
  }

  private async entry(block: Uint8Array): Promise<void> {
    if (zeros(block)) {
      this.ended = true;
      return;
    }
    const stored = readNumber(block, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
    if (sum !== stored) throw new SnapshotArchiveError("the archive has a header whose checksum does not hold");
    const type = String.fromCharCode(block[156] as number);
    const size = this.paxSize ?? readNumber(block, 124, 12);
    const mode = readNumber(block, 100, 8) & PERMISSIONS;
    const mtime = readNumber(block, 136, 12);
    const ustar = readText(block, 257, 6) === "ustar";
    const prefix = ustar ? readText(block, 345, 155) : "";
    const raw = readText(block, 0, 100);
    const name = this.paxPath ?? this.longName ?? (prefix === "" ? raw : `${prefix}/${raw}`);
    const linkname = this.paxLink ?? this.longLink ?? readText(block, 157, 100);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    // Records for the next entry.
    const text = (done: (value: Uint8Array) => void) => {
      if (size > 1024 * 1024) throw new SnapshotArchiveError("the archive has a header record of more than 1 MiB");
      this.body = { left: size, pad, text: [], done };
    };
    if (type === "x") {
      return text((value) => {
        for (const [key, entry] of parsePax(value)) {
          if (key === "path") this.paxPath = entry;
          else if (key === "linkpath") this.paxLink = entry;
          else if (key === "size") this.paxSize = Number(entry);
        }
      });
    }
    if (type === "g") return text(() => {});
    if (type === "L") return text((value) => void (this.longName = decoder.decode(value).replace(/\0+$/, "")));
    if (type === "K") return text((value) => void (this.longLink = decoder.decode(value).replace(/\0+$/, "")));
    this.paxPath = this.paxLink = this.paxSize = this.longName = this.longLink = undefined;
    if (!Number.isSafeInteger(size) || size < 0) throw new SnapshotArchiveError("the archive has an entry with no valid size");

    const segments = segmentsOf(name);
    if (type === "5") {
      if (segments.length === 0) return;
      const path = this.checkPlace(segments, "directory");
      if (this.seen.has(path) && !this.directories.has(path)) throw new SnapshotArchiveError("the archive has a directory where it has another entry");
      this.seen.add(path);
      await mkdir(join(this.dest, path), { recursive: true, mode: 0o700 });
      this.directories.set(path, { mode, mtime });
      if (size > 0) this.body = { left: size, pad, text: [], done: () => {} };
      return;
    }
    if (type === "0" || type === "\0" || type === "7") {
      const path = this.checkPlace(segments, "file");
      if (this.seen.has(path)) throw new SnapshotArchiveError("the archive has two entries at one path");
      this.seen.add(path);
      const full = join(this.dest, path);
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      // Exclusive: never through a link, never over another entry.
      const file = await open(full, "wx", 0o600);
      this.pendingFile = { path, mode, mtime };
      this.body = { left: size, pad, file, done: () => {} };
      return;
    }
    if (type === "2") {
      const path = this.checkPlace(segments, "link");
      if (this.seen.has(path)) throw new SnapshotArchiveError("the archive has two entries at one path");
      if (!linkStaysInside(path, linkname)) throw new SnapshotArchiveError(`the archive has a link that leads outside it (${JSON.stringify(path.slice(0, 80))})`);
      this.seen.add(path);
      this.linkPaths.add(path);
      this.links.push({ path, target: linkname });
      return;
    }
    throw new SnapshotArchiveError(`the archive has an entry of type ${JSON.stringify(type)} (only files, directories and links inside are taken)`);
  }

  /** Closes the file being written, after a failure. */
  async abort(): Promise<void> {
    await this.body?.file?.close().catch(() => {});
    this.body = undefined;
  }

  /** Once the bytes ended: the links (none had anything under it), then the directories' modes and times, deepest first. */
  async end(): Promise<void> {
    if (this.body !== undefined || this.headerFilled !== 0) throw new SnapshotArchiveError("the archive ends in the middle of an entry");
    for (const path of this.seen) {
      if (this.linkPaths.has(path)) continue;
      for (let i = 1, parts = path.split("/"); i < parts.length; i++) {
        if (this.linkPaths.has(parts.slice(0, i).join("/"))) throw new SnapshotArchiveError("the archive has an entry under a link");
      }
    }
    for (const { path, target } of this.links) await symlink(target, join(this.dest, path));
    const deepest = [...this.directories].sort(([a], [b]) => b.split("/").length - a.split("/").length);
    for (const [path, { mode, mtime }] of deepest) {
      const full = join(this.dest, path);
      await chmod(full, mode);
      await utimes(full, mtime, mtime);
    }
  }
}

function parsePax(bytes: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  for (let at = 0; at < bytes.byteLength; ) {
    const space = bytes.indexOf(0x20, at);
    const length = Number(decoder.decode(bytes.subarray(at, space)));
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0 || at + length > bytes.byteLength) throw new SnapshotArchiveError("the archive has a pax record that does not hold");
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) out.push([record.slice(0, equals), record.slice(equals + 1)]);
    at += length;
  }
  return out;
}

/** Extracts the gzip'd tar `compressed` into `dest` (an empty directory), refusing any entry that could leave it. */
export async function extractSnapshotArchive(compressed: AsyncIterable<Uint8Array>, dest: string): Promise<void> {
  const extractor = new TarExtractor(dest);
  try {
    await pipeline(Readable.from(compressed), createGunzip(), async (tar: AsyncIterable<Uint8Array>) => {
      for await (const chunk of tar) await extractor.write(chunk);
    });
    await extractor.end();
  } catch (error) {
    await extractor.abort();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Checkpoint and restore.

/** Hooks a test uses to stop a checkpoint at a step, as a crash there would. */
export interface CheckpointSteps {
  /** After the archive is whole in the bucket, before the manifest: `false` stops (the workspace was used meanwhile). */
  beforeManifest?(): boolean;
}

/**
 * Saves `target.dir` as a snapshot: the archive (in `tmp`, then the bucket, its SHA-256 checked by the
 * provider and against what it stored), then the manifest, read back and compared. Returns the
 * manifest, or `undefined` when `beforeManifest` stopped it (the archive it uploaded then deleted).
 * It never touches the directory: release it after this returned. Superseded archives are the
 * caller's to delete (`deleteSupersededSnapshots`), once this returned.
 */
export async function checkpointSnapshot(
  store: BlobStore,
  target: SnapshotTarget,
  options: { tmp: string; now: number; maxBytes?: number } & CheckpointSteps,
): Promise<{ manifest: SnapshotManifest; skipped: SnapshotSkipped } | undefined> {
  await mkdir(options.tmp, { recursive: true, mode: 0o700 });
  const file = join(options.tmp, `archive-${randomUUID()}.tar.gz`);
  try {
    const archive = await writeSnapshotArchive(target.dir, file, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });
    const object = snapshotArchiveKey(target.id, options.now, archive.sha256);
    const stored = await store.putStream(object, createReadStream(file), { contentType: SNAPSHOT_CONTENT_TYPE, sha256: archive.sha256 });
    if (stored.size !== archive.size || stored.sha256 !== archive.sha256) throw new Error("workspace snapshots: the bucket stored another archive than the one sent");
    if (options.beforeManifest?.() === false) {
      await store.delete(object).catch(() => {});
      return undefined;
    }
    const manifest: SnapshotManifest = { version: SNAPSHOT_VERSION, object, sha256: archive.sha256, size: archive.size, createdAt: options.now, agent: target.agent };
    const json = snapshotManifestJson(manifest);
    await store.put(snapshotManifestKey(target.id), encoder.encode(json), { contentType: "application/json" });
    const back = await store.get(snapshotManifestKey(target.id));
    if (back === undefined || decoder.decode(back.bytes) !== json) throw new Error("workspace snapshots: the manifest read back is not the one written (another host checkpointing this workspace?)");
    return { manifest, skipped: archive.skipped };
  } finally {
    await rm(file, { force: true });
  }
}

/** The manifest of `target`, checked, or `undefined` when it has none. */
export async function readSnapshotManifest(store: BlobStore, target: Pick<SnapshotTarget, "id" | "agent">): Promise<SnapshotManifest | undefined> {
  const value = await store.get(snapshotManifestKey(target.id));
  return value === undefined ? undefined : parseSnapshotManifest(decoder.decode(value.bytes), target);
}

/**
 * Makes `dir`'s parents under `base` one at a time, each a real directory: never through a link.
 * Throws when one on the way is a link or a file.
 */
async function realParents(base: string, dir: string): Promise<void> {
  const rel = relative(base, dirname(dir));
  if (rel.startsWith("..") || resolve(base, rel) !== dirname(dir)) throw new Error("workspace snapshots: a workspace is outside its base directory");
  let path = base;
  await mkdir(base, { recursive: true });
  for (const part of rel === "" ? [] : rel.split(sep)) {
    path = join(path, part);
    await mkdir(path).catch((error: { code?: string }) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(path)).isDirectory()) throw new Error("workspace snapshots: a directory on the way to a workspace is a link or a file: nothing restored through it");
  }
}

/**
 * Restores `target`'s snapshot into `target.dir`, which must not exist: the manifest, then its
 * archive, streamed and hashed into a directory of its own in `tmp`, its size and SHA-256 checked,
 * then renamed into place (its parents made under `base`, never through a link). Resolves with the
 * manifest, or `undefined` when there is no snapshot (nothing made). On any failure nothing is at
 * `target.dir`.
 */
export async function restoreSnapshot(store: BlobStore, target: SnapshotTarget, options: { tmp: string; base: string }): Promise<SnapshotManifest | undefined> {
  // A manifest read just before another host replaced it names an archive that host deleted: read again.
  for (let attempt = 1; ; attempt++) {
    const manifest = await readSnapshotManifest(store, target);
    if (manifest === undefined) return undefined;
    const archive = await store.getStream(manifest.object);
    if (archive === undefined) {
      const again = await readSnapshotManifest(store, target);
      if (again !== undefined && again.object !== manifest.object && attempt < 3) continue;
      throw new SnapshotArchiveError("the manifest names an archive that is not in the bucket: delete the manifest to start this workspace empty");
    }
    await mkdir(options.tmp, { recursive: true, mode: 0o700 });
    const staging = join(options.tmp, `restore-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const hash = createHash("sha256");
      let size = 0;
      const counted = async function* () {
        for await (const chunk of archive.body) {
          size += chunk.byteLength;
          if (size > manifest.size) throw new SnapshotArchiveError(`the archive is larger than its manifest's ${manifest.size} bytes`);
          hash.update(chunk);
          yield chunk;
        }
      };
      await extractSnapshotArchive(counted(), staging);
      const sha256 = hash.digest("hex");
      if (size !== manifest.size || sha256 !== manifest.sha256) throw new SnapshotArchiveError(`the archive is not the manifest's (${size} bytes, SHA-256 ${sha256.slice(0, 16)}..., not ${manifest.size}, ${manifest.sha256.slice(0, 16)}...)`);
      await realParents(options.base, target.dir);
      await rename(staging, target.dir);
      return manifest;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// One host's workspaces: restored on use, checkpointed and released when idle.

export interface SnapshotLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface WorkspaceSnapshotsOptions {
  /** The component's name, at the start of every message. */
  name: string;
  /** The `workspace-snapshots` namespace, read at each use. */
  store(): BlobStore;
  /** Where every workspace is (`root`): parents are made under it, never through a link. */
  base: string;
  /** This component's own directory under `base` (archives, restores, released directories, the index): on the workspaces' filesystem. */
  state: string;
  /** How long a workspace is unused before it is checkpointed and released. */
  idleMs: number;
  /** The largest archive a workspace may have; a larger one stays on this host, the operator told. */
  maxBytes?: number;
  /** With `retentionDays`: snapshots whose newest archive is older than this are deleted from the bucket, hourly. */
  retentionMs?: number;
  clock: Clock;
  /** Whether something works in `dir` now (a command, a file operation): never checkpointed then. */
  busy?(dir: string): boolean;
  /** Before a checkpoint of `dir`, makes it quiet (closes its idle VM); `false` keeps it for now. */
  prepare?(dir: string): Promise<boolean>;
  /** Whether `dir` is still quiet (no VM booted since `prepare`): checked before the manifest and at the release. */
  quiet?(dir: string): boolean;
  /** After `dir` was released (its other files removed). */
  released?(dir: string): Promise<void>;
  log: SnapshotLog;
}

/** How often the sweep looks for idle workspaces. */
export const SNAPSHOT_SWEEP_MS = 60_000;
const HOUR = 3_600_000;

interface Known {
  target: SnapshotTarget;
  lastUse: number;
  /** Counts uses: a checkpoint that began before the last one is not released. */
  uses: number;
  /** No checkpoint before this (after a failure, or one too large until its next use). */
  notBefore: number;
  indexed: boolean;
}

export class WorkspaceSnapshots {
  private readonly known = new Map<string, Known>();
  /** Calls running in an environment given for each directory (`track`). */
  private readonly active = new Map<string, number>();
  private readonly restoring = new Map<string, Promise<void>>();
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly checkpointing = new Set<string>();
  private stopped = false;
  private wake: () => void = () => {};
  private loop: Promise<void> | undefined;

  constructor(private readonly options: WorkspaceSnapshotsOptions) {}

  private get tmp(): string {
    return join(this.options.state, "tmp");
  }
  private get index(): string {
    return join(this.options.state, "index");
  }

  /**
   * Notes that `target` is used now (call it before anything awaits) and resolves once it is on disk:
   * after a release in progress, restored from its snapshot when its directory is not there (one
   * restore at a time). Without a snapshot it resolves with no directory: the caller makes an empty
   * one. A restore that fails rejects, and nothing is at its directory.
   */
  use(target: SnapshotTarget): Promise<void> {
    const now = this.options.clock.now();
    const known = this.known.get(target.dir);
    if (known === undefined) this.known.set(target.dir, { target, lastUse: now, uses: 1, notBefore: 0, indexed: false });
    else {
      known.lastUse = now;
      known.uses++;
      known.notBefore = 0;
    }
    return this.ready(target, this.releasing.get(target.dir));
  }

  private async ready(target: SnapshotTarget, releasing: Promise<void> | undefined): Promise<void> {
    await releasing;
    if (!(await exists(target.dir))) {
      let restoring = this.restoring.get(target.dir);
      if (restoring === undefined) {
        restoring = this.restore(target).finally(() => this.restoring.delete(target.dir));
        this.restoring.set(target.dir, restoring);
      }
      await restoring;
    }
    const known = this.known.get(target.dir);
    if (known !== undefined && !known.indexed) {
      await mkdir(this.index, { recursive: true, mode: 0o700 });
      await writeFile(join(this.index, target.id), JSON.stringify({ dir: target.dir, agent: target.agent }));
      known.indexed = true;
    }
  }

  private async restore(target: SnapshotTarget): Promise<void> {
    const manifest = await restoreSnapshot(this.options.store(), target, { tmp: this.tmp, base: this.options.base });
    if (manifest !== undefined) this.options.log.info(`${this.options.name}: restored a workspace from its snapshot`, { bytes: manifest.size, agent: target.agent });
  }

  /** `value`, each call counted as `dir`'s while it runs (a command until it ends): never checkpointed then. */
  track<T extends object>(dir: string, value: T): T {
    const active = this.active;
    const done = () => {
      const left = (active.get(dir) ?? 1) - 1;
      if (left > 0) active.set(dir, left);
      else active.delete(dir);
    };
    return new Proxy(value, {
      get(target, property, receiver) {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        return function (this: unknown, ...args: unknown[]) {
          active.set(dir, (active.get(dir) ?? 0) + 1);
          let result: unknown;
          try {
            result = Reflect.apply(member, this, args);
          } catch (error) {
            done();
            throw error;
          }
          if (result instanceof Promise) return result.finally(done);
          done();
          return result;
        };
      },
    });
  }

  private busy(dir: string): boolean {
    return this.active.has(dir) || this.restoring.has(dir) || this.releasing.has(dir) || this.options.busy?.(dir) === true;
  }

  /** Checkpoints and releases every workspace unused for `idleMs` and not busy: how many, how many bytes in the bucket. */
  async sweep(): Promise<{ released: number; bytes: number }> {
    const swept = { released: 0, bytes: 0 };
    for (const known of [...this.known.values()]) {
      if (this.stopped) break;
      const { dir } = known.target;
      const now = this.options.clock.now();
      if (now - known.lastUse < this.options.idleMs || now < known.notBefore || this.checkpointing.has(dir) || this.busy(dir)) continue;
      this.checkpointing.add(dir);
      try {
        const bytes = await this.checkpoint(known);
        if (bytes !== undefined) {
          swept.released++;
          swept.bytes += bytes;
        }
      } catch (error) {
        known.notBefore = this.options.clock.now() + (error instanceof SnapshotTooLargeError ? Number.POSITIVE_INFINITY : this.options.idleMs);
        this.options.log.warn(`${this.options.name}: a workspace's snapshot failed; it stays on this host${error instanceof SnapshotTooLargeError ? " until it is used again" : ", and is tried again later"}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.checkpointing.delete(dir);
      }
    }
    this.options.log.debug(`${this.options.name}: snapshots swept`, swept);
    if (swept.released > 0) this.options.log.info(`${this.options.name}: saved idle workspaces to the bucket and released them here (snapshots)`, swept);
    return swept;
  }

  /** One workspace: the bytes of its archive when it was released, `undefined` when it was kept. */
  private async checkpoint(known: Known): Promise<number | undefined> {
    const { target } = known;
    const uses = known.uses;
    const unused = () => known.uses === uses && !this.active.has(target.dir) && this.options.busy?.(target.dir) !== true && this.options.quiet?.(target.dir) !== false;
    if (!(await exists(target.dir))) {
      // Gone meanwhile (deleted by hand, retired): nothing to save.
      this.known.delete(target.dir);
      await rm(join(this.index, target.id), { force: true });
      return undefined;
    }
    if (this.options.prepare !== undefined && !(await this.options.prepare(target.dir))) return undefined;
    if (!unused()) return undefined;
    const store = this.options.store();
    const saved = await checkpointSnapshot(store, target, {
      tmp: this.tmp,
      now: this.options.clock.now(),
      ...(this.options.maxBytes !== undefined && { maxBytes: this.options.maxBytes }),
      beforeManifest: unused,
    });
    if (saved === undefined) return undefined;
    if (saved.skipped.links + saved.skipped.other > 0) this.options.log.warn(`${this.options.name}: a workspace's snapshot left out links that lead outside it and special files`, { ...saved.skipped });
    // The manifest names the new archive: the ones before it go.
    await deleteSupersededSnapshots(store, target.id, saved.manifest.object).catch((error: unknown) =>
      this.options.log.warn(`${this.options.name}: superseded snapshots were not deleted; the next checkpoint tries again`, { error: error instanceof Error ? error.message : String(error) }),
    );
    // The check and the mark in one synchronous step: a use either came first (kept) or waits for the move.
    if (!unused() || this.releasing.has(target.dir)) return undefined;
    const trash = join(this.tmp, `released-${randomUUID()}`);
    const moved = (async () => {
      await mkdir(this.tmp, { recursive: true, mode: 0o700 });
      await rename(target.dir, trash);
    })();
    const gate = moved.then(
      () => undefined,
      () => undefined,
    );
    this.releasing.set(target.dir, gate);
    try {
      await moved;
    } finally {
      this.releasing.delete(target.dir);
    }
    if (this.known.get(target.dir) === known && known.uses === uses) this.known.delete(target.dir);
    await rm(join(this.index, target.id), { force: true });
    await rm(trash, { recursive: true, force: true });
    await this.options.released?.(target.dir);
    return saved.manifest.size;
  }

  /**
   * Cleans what a crash left (`tmp`), finds the workspaces of an earlier process (the index: each
   * counts as used now), then sweeps every minute (and, with `retentionMs`, deletes old snapshots
   * hourly) until `stop`.
   */
  async start(): Promise<void> {
    await rm(this.tmp, { recursive: true, force: true });
    let names: string[] = [];
    try {
      names = await readdir(this.index);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const now = this.options.clock.now();
    for (const id of names) {
      try {
        const { dir, agent } = JSON.parse(await readFile(join(this.index, id), "utf8")) as { dir: string; agent: string };
        if (typeof dir === "string" && typeof agent === "string" && /^[0-9a-f]{64}$/.test(id) && (await exists(dir))) {
          if (!this.known.has(dir)) this.known.set(dir, { target: { id, agent, dir }, lastUse: now, uses: 0, notBefore: 0, indexed: true });
        } else await rm(join(this.index, id), { force: true });
      } catch {
        await rm(join(this.index, id), { force: true });
      }
    }
    const { clock, log } = this.options;
    this.loop = (async () => {
      let next = clock.now() + SNAPSHOT_SWEEP_MS;
      let pruneAt = clock.now();
      while (!this.stopped) {
        if (this.options.retentionMs !== undefined && clock.now() >= pruneAt) {
          pruneAt = clock.now() + HOUR;
          try {
            const deleted = await deleteSnapshotsBefore(this.options.store(), clock.now() - this.options.retentionMs);
            if (deleted.length > 0) log.info(`${this.options.name}: deleted the snapshots of workspaces unused for retentionDays`, { workspaces: deleted.length });
          } catch (error) {
            log.warn(`${this.options.name}: old snapshots were not deleted; tried again in an hour`, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (clock.now() >= next) {
          await this.sweep().catch((error: unknown) => log.warn(`${this.options.name}: the snapshots' sweep failed`, { error: error instanceof Error ? error.message : String(error) }));
          next = clock.now() + SNAPSHOT_SWEEP_MS;
        }
        const woken = new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        await Promise.race([woken, clock.sleep(Math.max(0, Math.min(1_000, next - clock.now())))]);
      }
    })();
  }

  /** Ends the sweeps, after the checkpoint in progress. Workspaces on disk stay, and are found again at the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    await this.loop;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}
