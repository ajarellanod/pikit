/**
 * The shared workspace snapshot format, in `storage.blob`: what every backend (Gondolin hosts, a
 * Cloudflare Sandbox, this boat gateway) writes and reads, so a workspace moves between them. Kept
 * apart from boat's own code (nothing here knows a VM): another component can take this file as it
 * is, until a shared helper replaces it.
 *
 * - **Where.** Namespace `workspace-snapshots`; a workspace's keys under `<hex SHA-256 of
 *   "<chat key>\n<agent>">/`: the archive `snapshot-<createdAt ms>-<first 16 hex of its SHA-256>.tar.gz`,
 *   then `manifest.json`, written last:
 *   `{ "version": 1, "object": "<archive key>", "sha256": "<hex>", "size": <bytes>, "createdAt": <ms>, "agent": "<agent>" }`.
 * - **The archive** is a gzip'd POSIX ustar/pax tar of the workspace root's contents: relative paths,
 *   none absolute, no `..`; regular files, directories and symbolic links that stay inside (resolved
 *   through the archive's own links, as on disk once extracted). `checkArchive` refuses anything else
 *   (hard links, devices, GNU long names, a link out), reading the archive as a stream.
 * - **Saved** (`saveSnapshot`): the archive is put, read back and its SHA-256 compared (the workspace's
 *   own copy stays the truth until then), then the manifest; only then are the archives it replaces
 *   deleted. A crash at any point leaves the previous manifest and its archive intact.
 * - **Loaded** (`loadSnapshot`): the manifest, then its archive, whose size and SHA-256 must match it
 *   and whose entries must pass `checkArchive`, before anything is extracted. Extracting into an empty
 *   directory and swapping it in is the backend's.
 */

import type { BlobStore } from "@pikit/contracts";

export const SNAPSHOT_NAMESPACE = "workspace-snapshots";
export const MANIFEST = "manifest.json";

export interface SnapshotManifest {
  version: 1;
  object: string;
  sha256: string;
  size: number;
  createdAt: number;
  agent: string;
}

/** A snapshot that is not one this format allows: never extracted, never saved. */
export class SnapshotError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The prefix of a workspace's keys: `<hex SHA-256 of "<chat key>\n<agent>">/`. */
export async function snapshotPrefix(chatKey: string, agent: string): Promise<string> {
  return `${await sha256Hex(encoder.encode(`${chatKey}\n${agent}`))}/`;
}

export function archiveKey(prefix: string, createdAt: number, sha256: string): string {
  return `${prefix}snapshot-${createdAt}-${sha256.slice(0, 16)}.tar.gz`;
}

const ARCHIVE = /^snapshot-[0-9]+-[0-9a-f]{16}\.tar\.gz$/;

/** The manifest in `bytes`, checked: its archive under `prefix`, named as the format names it. */
export function parseManifest(bytes: Uint8Array, prefix: string): SnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new SnapshotError("the snapshot manifest is not JSON");
  }
  const m = value as Partial<SnapshotManifest> | null;
  if (
    m === null ||
    typeof m !== "object" ||
    m.version !== 1 ||
    typeof m.object !== "string" ||
    !m.object.startsWith(prefix) ||
    !ARCHIVE.test(m.object.slice(prefix.length)) ||
    typeof m.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(m.sha256) ||
    !m.object.endsWith(`-${m.sha256.slice(0, 16)}.tar.gz`) ||
    !Number.isSafeInteger(m.size) ||
    (m.size as number) < 0 ||
    !Number.isSafeInteger(m.createdAt) ||
    typeof m.agent !== "string"
  ) {
    throw new SnapshotError("the snapshot manifest is not version 1 of the format (object, sha256, size, createdAt, agent)");
  }
  return { version: 1, object: m.object, sha256: m.sha256, size: m.size as number, createdAt: m.createdAt as number, agent: m.agent };
}

/** An entry's path as segments, refusing an absolute one, `..`, and an empty one. */
function segmentsOf(name: string, what: string): string[] {
  if (name === "" || name.includes("\0")) throw new SnapshotError(`the archive has an entry with an empty or invalid ${what}`);
  if (name.startsWith("/")) throw new SnapshotError(`the archive has an absolute ${what}: refused`);
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new SnapshotError(`the archive has a ${what} with "..": refused`);
  if (segments.length === 0) throw new SnapshotError(`the archive has an entry naming the root itself`);
  return segments;
}

/** Whether `start` (segments from the root) leaves the root, following the archive's own links. */
function escapes(links: Map<string, string>, start: string[]): boolean {
  const stack: string[] = [];
  let rest = [...start];
  let hops = 0;
  while (rest.length > 0) {
    const segment = rest.shift() as string;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return true;
      stack.pop();
      continue;
    }
    stack.push(segment);
    const target = links.get(stack.join("/"));
    if (target !== undefined) {
      if (target.startsWith("/") || ++hops > 64) return true;
      stack.pop();
      rest = [...target.split("/"), ...rest];
    }
  }
  return false;
}

const octal = (block: Uint8Array, at: number, length: number): number => {
  if ((block[at] as number) & 0x80) {
    // Base-256 (GNU, for sizes past 8 GiB): the remaining bytes, big-endian.
    let value = (block[at] as number) & 0x7f;
    for (let i = at + 1; i < at + length; i++) value = value * 256 + (block[i] as number);
    return value;
  }
  const text = decoder.decode(block.subarray(at, at + length)).replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new SnapshotError("the archive has a malformed tar header (a number)");
  return Number.parseInt(text, 8);
};
const field = (block: Uint8Array, at: number, length: number): string => {
  const raw = block.subarray(at, at + length);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
};

/** The `path`, `linkpath` and `size` records of a pax extended header. */
function paxRecords(data: Uint8Array): Record<string, string> {
  const text = decoder.decode(data);
  const out: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) throw new SnapshotError("the archive has a malformed pax header");
    // Lengths are in bytes: measure the record on the bytes.
    const recordBytes = encoder.encode(text.slice(at)).subarray(0, length);
    const record = decoder.decode(recordBytes);
    const body = record.slice(record.indexOf(" ") + 1, record.endsWith("\n") ? -1 : undefined);
    const equals = body.indexOf("=");
    if (equals > 0) out[body.slice(0, equals)] = body.slice(equals + 1);
    at += record.length;
  }
  return out;
}

export interface ArchiveSummary {
  files: number;
  directories: number;
  symlinks: number;
}

/**
 * Reads the gzip'd tar `bytes` as a stream (nothing extracted) and refuses anything outside the
 * format: an absolute path or `..`, a hard link, a device, a FIFO, GNU's long names, a pax header
 * that renames globally, a symbolic link that leaves the root. Its counts, when it passes.
 */
export async function checkArchive(bytes: Uint8Array): Promise<ArchiveSummary> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  } catch {
    throw new SnapshotError("the archive is not gzip");
  }
  const reader = stream.getReader();
  let pending = new Uint8Array(0);
  let ended = false;
  const need = async (n: number): Promise<boolean> => {
    while (pending.length < n && !ended) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new SnapshotError("the archive is not valid gzip");
      }
      if (chunk.done) ended = true;
      else {
        const joined = new Uint8Array(pending.length + chunk.value.length);
        joined.set(pending);
        joined.set(chunk.value, pending.length);
        pending = joined;
      }
    }
    return pending.length >= n;
  };
  const take = (n: number): Uint8Array => {
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return out;
  };
  const skip = async (n: number) => {
    let left = n;
    while (left > 0) {
      if (!(await need(1))) throw new SnapshotError("the archive ends inside an entry");
      const step = Math.min(left, pending.length);
      take(step);
      left -= step;
    }
  };

  const summary: ArchiveSummary = { files: 0, directories: 0, symlinks: 0 };
  const kinds = new Map<string, "file" | "directory" | "symlink">();
  const links = new Map<string, string>();
  let pax: Record<string, string> = {};
  let sawEnd = false;
  try {
    for (;;) {
      if (!(await need(512))) {
        if (pending.length === 0 && summary.files + summary.directories + summary.symlinks === 0 && !sawEnd) break;
        throw new SnapshotError("the archive ends without its end blocks");
      }
      const block = take(512).slice();
      if (block.every((byte) => byte === 0)) {
        sawEnd = true;
        break;
      }
      const sum = octal(block, 148, 8);
      let computed = 0;
      for (let i = 0; i < 512; i++) computed += i >= 148 && i < 156 ? 32 : (block[i] as number);
      if (sum !== computed) throw new SnapshotError("the archive has a tar header with a wrong checksum");
      if (field(block, 257, 5) !== "ustar") throw new SnapshotError("the archive is not a POSIX ustar/pax tar");
      const type = String.fromCharCode(block[156] as number);
      const size = pax.size !== undefined ? Number(pax.size) : octal(block, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) throw new SnapshotError("the archive has an entry with an invalid size");
      const padded = Math.ceil(size / 512) * 512;
      if (type === "x" || type === "g") {
        if (size > 1024 * 1024) throw new SnapshotError("the archive has an oversized pax header");
        if (!(await need(padded))) throw new SnapshotError("the archive ends inside a pax header");
        const records = paxRecords(take(padded).subarray(0, size).slice());
        if (type === "g") {
          if ("path" in records || "linkpath" in records) throw new SnapshotError("the archive has a global pax header that names paths: refused");
        } else pax = records;
        continue;
      }
      const prefix = field(block, 345, 155);
      const name = pax.path ?? (prefix === "" ? field(block, 0, 100) : `${prefix}/${field(block, 0, 100)}`);
      const linkname = pax.linkpath ?? field(block, 157, 100);
      pax = {};
      const segments = segmentsOf(name, "path");
      const path = segments.join("/");
      if (type === "0" || type === "\0" || type === "7") {
        if (type === "7") throw new SnapshotError("the archive has a contiguous file entry: refused");
        summary.files++;
        kinds.set(path, "file");
        links.delete(path);
        await skip(padded);
      } else if (type === "5") {
        summary.directories++;
        kinds.set(path, "directory");
        links.delete(path);
        await skip(padded);
      } else if (type === "2") {
        if (linkname === "") throw new SnapshotError("the archive has a symbolic link with no target");
        if (linkname.startsWith("/")) throw new SnapshotError("the archive has a symbolic link to an absolute path: refused");
        summary.symlinks++;
        kinds.set(path, "symlink");
        links.set(path, linkname);
        await skip(padded);
      } else {
        const what = { "1": "a hard link", "3": "a character device", "4": "a block device", "6": "a FIFO", L: "a GNU long name", K: "a GNU long link name" }[type] ?? `an entry of type ${JSON.stringify(type)}`;
        throw new SnapshotError(`the archive has ${what}: refused (regular files, directories and symbolic links only)`);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  for (const [path, target] of links) {
    if (escapes(links, [...path.split("/").slice(0, -1), ...target.split("/")])) {
      throw new SnapshotError("the archive has a symbolic link that leaves the workspace: refused");
    }
  }
  return summary;
}

/**
 * Saves `archive` as the workspace's snapshot: put, read back and compared, then the manifest (last),
 * then the archives it replaces deleted. The manifest, once everything was verified.
 */
export async function saveSnapshot(store: BlobStore, prefix: string, agent: string, archive: Uint8Array, createdAt: number): Promise<SnapshotManifest> {
  await checkArchive(archive);
  const sha256 = await sha256Hex(archive);
  const object = archiveKey(prefix, createdAt, sha256);
  await store.put(object, archive, { contentType: "application/gzip" });
  const back = await store.get(object);
  if (back === undefined || back.bytes.length !== archive.length || (await sha256Hex(back.bytes)) !== sha256) {
    throw new SnapshotError("the snapshot read back from storage.blob is not the one put: the manifest was not written");
  }
  const manifest: SnapshotManifest = { version: 1, object, sha256, size: archive.length, createdAt, agent };
  await store.put(`${prefix}${MANIFEST}`, encoder.encode(JSON.stringify(manifest)), { contentType: "application/json" });
  // Superseded: every other archive of this workspace, once the new manifest names this one.
  let cursor: string | undefined;
  do {
    const page = await store.list(`${prefix}snapshot-`, cursor === undefined ? {} : { cursor });
    for (const entry of page.entries) if (entry.key !== object && ARCHIVE.test(entry.key.slice(prefix.length))) await store.delete(entry.key);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return manifest;
}

/** The workspace's manifest, or `undefined` when it has none. */
export async function readManifest(store: BlobStore, prefix: string): Promise<SnapshotManifest | undefined> {
  const value = await store.get(`${prefix}${MANIFEST}`);
  return value === undefined ? undefined : parseManifest(value.bytes, prefix);
}

/** The workspace's snapshot, verified (size, SHA-256, entries), or `undefined` when it has none. */
export async function loadSnapshot(store: BlobStore, prefix: string): Promise<{ manifest: SnapshotManifest; archive: Uint8Array } | undefined> {
  const manifest = await readManifest(store, prefix);
  if (manifest === undefined) return undefined;
  const value = await store.get(manifest.object);
  if (value === undefined) throw new SnapshotError("the snapshot's manifest names an archive storage.blob does not have");
  if (value.bytes.length !== manifest.size) throw new SnapshotError(`the snapshot's archive is ${value.bytes.length} bytes, its manifest says ${manifest.size}`);
  if ((await sha256Hex(value.bytes)) !== manifest.sha256) throw new SnapshotError("the snapshot's archive does not match its manifest's sha256");
  await checkArchive(value.bytes);
  return { manifest, archive: value.bytes };
}
