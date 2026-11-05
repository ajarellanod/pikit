/**
 * The workspace snapshot format: how a workspace (an agent's files in a chat) is kept in
 * `storage.blob` while no host holds it, the same for every backend that saves one (a Gondolin host,
 * workspace-local, a Cloudflare Sandbox, a boat.dev gateway), so any of them restores what another
 * saved. features/workspace-snapshots.md tells the flow; `@pikit/contracts/snapshots` does it on a
 * server's directories.
 *
 * - **Where**: the namespace `workspace-snapshots`, keys under `<id>/`, `id` the hex SHA-256 of
 *   `"<chat key>\n<agent>"` (`snapshotId`): the chat is `originOf(ref).key`, the unit a workspace is
 *   keyed by (features/agent-sandboxes.md). The chat key itself is never stored.
 * - **The archive** `<id>/snapshot-<createdAt ms>-<first 16 hex of its SHA-256>.tar.gz`: a gzip'd
 *   POSIX ustar or pax tar of the workspace root's contents, paths relative (no leading `/`, no `..`
 *   segment), only regular files, directories and symbolic links whose target stays inside.
 * - **The manifest** `<id>/manifest.json`, written LAST, after the archive is whole in the bucket:
 *   `{ "version": 1, "object": "<archive key>", "sha256": "<hex>", "size": <bytes>, "createdAt": <ms>,
 *   "agent": "<agent>" }`. A manifest names the snapshot to restore; an archive no manifest names is
 *   left over (a checkpoint that stopped before its manifest) and is deleted by the next one.
 * - **Restore**: the manifest, then its archive, its SHA-256 and size checked, extracted into an empty
 *   directory, swapped in. **Superseded archives** are deleted after a new manifest is written.
 *
 * - **One implementation** for every backend: the keys and the manifest here; the archive's entries
 *   checked as they stream (`SnapshotTarCheck`, `checkSnapshotArchive`, by the rules
 *   `@pikit/contracts/snapshots`' restore extracts by) and the steps of a backend whose archive is made
 *   in a container or a VM (`putSnapshotArchive`, `commitSnapshotManifest`, `readSnapshotArchive`)
 *   below; a server's directories through `@pikit/contracts/snapshots`.
 *
 * Neutral: Web APIs only (Web Crypto, `DecompressionStream`, `createBlobHash`), so a Worker runs it all.
 */

import { type BlobStorage, type BlobStore, createBlobHash } from "./blob.ts";

/** The `storage.blob` namespace every backend keeps snapshots in. */
export const SNAPSHOT_NAMESPACE = "workspace-snapshots";
/** The manifest's name under a workspace's `<id>/`. */
export const SNAPSHOT_MANIFEST = "manifest.json";
/** The manifest's `version`. */
export const SNAPSHOT_VERSION = 1;
/** The archive's content type. */
export const SNAPSHOT_CONTENT_TYPE = "application/gzip";

/**
 * The namespace snapshots are kept in: `workspace-snapshots`, the format's, shared by every backend
 * (the exception to "a component opens the namespace named after it": a snapshot one backend saved
 * is restored by another). `namespace` only to keep two fleets apart in one bucket.
 */
export function openSnapshotStore(storage: BlobStorage, namespace: string = SNAPSHOT_NAMESPACE): BlobStore {
  return storage.namespace(namespace);
}

/** A workspace's manifest: the snapshot to restore. */
export interface SnapshotManifest {
  version: typeof SNAPSHOT_VERSION;
  /** The archive's key, `<id>/snapshot-<createdAt>-<sha16>.tar.gz`. */
  object: string;
  /** The archive's hex SHA-256. */
  sha256: string;
  /** The archive's size in bytes. */
  size: number;
  /** When it was made, ms since the epoch. */
  createdAt: number;
  agent: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ARCHIVE = /^([0-9a-f]{64})\/snapshot-(\d{1,16})-([0-9a-f]{16})\.tar\.gz$/;

/** The hex SHA-256 of `"<chatKey>\n<agent>"`: the directory of a workspace's keys. */
export async function snapshotId(chatKey: string, agent: string): Promise<string> {
  if (typeof chatKey !== "string" || chatKey === "") throw new Error("workspace snapshots: a snapshot needs a non-empty chat key");
  if (typeof agent !== "string" || agent === "") throw new Error("workspace snapshots: a snapshot needs an agent");
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(new TextEncoder().encode(`${chatKey}\n${agent}`)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `<id>/manifest.json`. */
export function snapshotManifestKey(id: string): string {
  if (!HEX64.test(id)) throw new Error(`workspace snapshots: ${JSON.stringify(id)} is not a snapshot id (64 hex)`);
  return `${id}/${SNAPSHOT_MANIFEST}`;
}

/** `<id>/snapshot-<createdAt>-<first 16 hex of sha256>.tar.gz`. */
export function snapshotArchiveKey(id: string, createdAt: number, sha256: string): string {
  if (!HEX64.test(id)) throw new Error(`workspace snapshots: ${JSON.stringify(id)} is not a snapshot id (64 hex)`);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error(`workspace snapshots: ${createdAt} is not a time in ms`);
  if (!HEX64.test(sha256)) throw new Error("workspace snapshots: an archive's sha256 is 64 lowercase hex");
  return `${id}/snapshot-${createdAt}-${sha256.slice(0, 16)}.tar.gz`;
}

/** An archive's key read back: its id, time and SHA-256 prefix; `undefined` for any other key. */
export function parseSnapshotArchiveKey(key: string): { id: string; createdAt: number; sha16: string } | undefined {
  const match = ARCHIVE.exec(key);
  if (match === null) return undefined;
  const createdAt = Number(match[2]);
  return Number.isSafeInteger(createdAt) ? { id: match[1] as string, createdAt, sha16: match[3] as string } : undefined;
}

/** The manifest's JSON, as it is written. */
export function snapshotManifestJson(manifest: SnapshotManifest): string {
  const { version, object, sha256, size, createdAt, agent } = manifest;
  return JSON.stringify({ version, object, sha256, size, createdAt, agent });
}

/**
 * The manifest in `text`, checked: version 1, an archive key under `id` whose time and SHA-256 prefix
 * are the manifest's, a SHA-256, a size, and `agent`. Throws what is wrong: a manifest that does not
 * hold is never restored from.
 */
export function parseSnapshotManifest(text: string, expected: { id: string; agent: string }): SnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("workspace snapshots: the manifest is not JSON");
  }
  const m = value as Partial<SnapshotManifest> | null;
  const wrong = (what: string) => new Error(`workspace snapshots: the manifest's ${what}`);
  if (m === null || typeof m !== "object" || Array.isArray(m)) throw wrong("is not an object");
  if (m.version !== SNAPSHOT_VERSION) throw wrong(`version is ${JSON.stringify(m.version)}, not ${SNAPSHOT_VERSION}`);
  if (typeof m.sha256 !== "string" || !HEX64.test(m.sha256)) throw wrong("sha256 is not 64 lowercase hex");
  if (typeof m.size !== "number" || !Number.isSafeInteger(m.size) || m.size < 0) throw wrong("size is not a number of bytes");
  if (typeof m.createdAt !== "number" || !Number.isSafeInteger(m.createdAt) || m.createdAt < 0) throw wrong("createdAt is not a time in ms");
  if (m.agent !== expected.agent) throw wrong(`agent is ${JSON.stringify(m.agent)}, not ${JSON.stringify(expected.agent)}`);
  const archive = typeof m.object === "string" ? parseSnapshotArchiveKey(m.object) : undefined;
  if (archive === undefined || archive.id !== expected.id) throw wrong("object is not an archive of this workspace");
  if (archive.createdAt !== m.createdAt || archive.sha16 !== m.sha256.slice(0, 16)) throw wrong("object's name does not match its createdAt and sha256");
  return { version: SNAPSHOT_VERSION, object: m.object as string, sha256: m.sha256, size: m.size, createdAt: m.createdAt, agent: m.agent };
}

/** Every key under `prefix`, page after page. */
async function keysUnder(store: BlobStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(prefix, cursor === undefined ? {} : { cursor });
    for (const entry of page.entries) keys.push(entry.key);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return keys;
}

/** Deletes every archive of `id` but `keep` (the manifest's): superseded ones, and those no manifest ever named. The keys deleted. */
export async function deleteSupersededSnapshots(store: BlobStore, id: string, keep: string): Promise<string[]> {
  const deleted: string[] = [];
  for (const key of await keysUnder(store, `${id}/`)) {
    if (key === keep || parseSnapshotArchiveKey(key)?.id !== id) continue;
    await store.delete(key);
    deleted.push(key);
  }
  return deleted;
}

/**
 * Deletes the snapshots whose newest archive was made before `cutoff` (ms): the manifest first, so a
 * restore never finds a manifest without its archive, then its archives. The ids deleted. Every key
 * under the namespace that is not the format's is left alone.
 */
export async function deleteSnapshotsBefore(store: BlobStore, cutoff: number): Promise<string[]> {
  const byId = new Map<string, { newest: number; archives: string[]; manifest: boolean }>();
  for (const key of await keysUnder(store, "")) {
    const archive = parseSnapshotArchiveKey(key);
    const id = archive?.id ?? (key.endsWith(`/${SNAPSHOT_MANIFEST}`) && HEX64.test(key.slice(0, 64)) && key.length === 65 + SNAPSHOT_MANIFEST.length ? key.slice(0, 64) : undefined);
    if (id === undefined) continue;
    const entry = byId.get(id) ?? { newest: Number.NEGATIVE_INFINITY, archives: [], manifest: false };
    if (archive === undefined) entry.manifest = true;
    else {
      entry.archives.push(key);
      entry.newest = Math.max(entry.newest, archive.createdAt);
    }
    byId.set(id, entry);
  }
  const deleted: string[] = [];
  for (const [id, entry] of byId) {
    // A manifest with no archive left is a broken snapshot, nothing to restore: deleted too.
    if (entry.newest >= cutoff) continue;
    if (entry.manifest) {
      // Read again: a checkpoint since the listing names a newer archive, and keeps its snapshot.
      const current = await store.get(snapshotManifestKey(id));
      const named = current === undefined ? undefined : /"object":"([^"]*)"/.exec(new TextDecoder().decode(current.bytes))?.[1];
      if (named !== undefined && !entry.archives.includes(named)) continue;
      await store.delete(snapshotManifestKey(id));
    }
    for (const key of entry.archives) await store.delete(key);
    deleted.push(id);
  }
  return deleted;
}

// ---------------------------------------------------------------------------------------------
// The archive's entries, checked as they stream (Web APIs only): what a backend that extracts with a
// tar program (a container's, a VM's) runs before it extracts, and while it uploads what it made.

/** An archive a restore does not take: an entry that could leave the root, a header that does not hold, too large. Refused whole. */
export class SnapshotArchiveRefused extends Error {
  readonly code = "snapshot_archive_refused";
  constructor(message: string) {
    super(`workspace snapshots: ${message}`);
    this.name = "SnapshotArchiveRefused";
  }
}

/**
 * Whether a link at `path` (relative, `/`-separated) with `target` stays inside the root: `target` is
 * relative, climbs (with leading `..` only) no higher than the link's directory's depth, and has no `..`
 * after a name, so following it never leaves the root, whatever the links on its way. The rule every
 * backend keeps a link by (`@pikit/contracts/snapshots` has the same, `linkStaysInside`).
 */
export function snapshotLinkStaysInside(path: string, target: string): boolean {
  if (target === "" || target.includes("\0") || target.startsWith("/")) return false;
  const parts = target.split("/").filter((part) => part !== "" && part !== ".");
  let up = 0;
  while (parts[up] === "..") up++;
  if (parts.slice(up).includes("..")) return false;
  return up <= path.split("/").length - 1;
}

const TAR_BLOCK = 512;
const tarText = new TextDecoder();

function tarField(block: Uint8Array, at: number, length: number): string {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return tarText.decode(end === -1 ? field : field.subarray(0, end));
}

function tarNumber(block: Uint8Array, at: number, length: number): number {
  const field = block.subarray(at, at + length);
  // GNU's base-256, for sizes past ustar's.
  if (((field[0] as number) & 0x80) !== 0) {
    let value = (field[0] as number) & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = tarText.decode(field).replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new SnapshotArchiveRefused("the archive has a header field that is not a number");
  return Number.parseInt(text, 8);
}

function paxRecords(bytes: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  for (let at = 0; at < bytes.byteLength; ) {
    const space = bytes.indexOf(0x20, at);
    const length = space === -1 ? Number.NaN : Number(tarText.decode(bytes.subarray(at, space)));
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > bytes.byteLength || bytes[at + length - 1] !== 0x0a) throw new SnapshotArchiveRefused("the archive has a pax record that does not hold");
    const record = tarText.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw new SnapshotArchiveRefused("the archive has a pax record that does not hold");
    out.push([record.slice(0, equals), record.slice(equals + 1)]);
    at += length;
  }
  return out;
}

/** The pax keys a tar program reads as another name or another kind of file: refused (`GNU.sparse.name` renames). */
const PAX_REFUSED = /^GNU\.sparse\./;

/**
 * A tar's entries, checked header by header as its (decompressed) bytes come (`feed`, then `end`),
 * holding only the paths seen, with the rules `@pikit/contracts/snapshots`' restore extracts by, and
 * strict wherever a tar program could read an entry otherwise than this check did:
 *
 * - only regular files (`0`, `7`), directories and symbolic links, under pax (`x`) and GNU long-name
 *   (`L`, `K`) headers; a hard link, a device, a FIFO, a sparse file, any other kind refuses the archive;
 * - paths relative, with no `..` segment and no NUL; nothing at the root itself but a directory;
 * - a link only by `snapshotLinkStaysInside`, nothing under a link, two entries at one path only
 *   when both are directories;
 * - a header whose checksum does not hold, a directory or link with data, a pax and a GNU name for one
 *   entry, a global pax header naming a path or a size, a `GNU.sparse.*` record, bytes that are not
 *   zeros after the end-of-archive block, an archive cut short, or more than `maxUnpackedBytes` in all.
 */
export class SnapshotTarCheck {
  private readonly header = new Uint8Array(TAR_BLOCK);
  private headerFilled = 0;
  private ended = false;
  /** Data still to pass: a file's, or a header record's (collected). */
  private body: { left: number; pad: number; record?: Uint8Array[]; kind?: "x" | "g" | "L" | "K" } | undefined;
  private pax: Map<string, string> = new Map();
  private longName: string | undefined;
  private longLink: string | undefined;
  private readonly seen = new Map<string, "file" | "directory" | "symlink">();
  private readonly links = new Set<string>();
  private unpacked = 0;
  entries = 0;

  constructor(private readonly maxUnpackedBytes = Number.POSITIVE_INFINITY) {}

  feed(chunk: Uint8Array): void {
    this.unpacked += chunk.byteLength;
    if (this.unpacked > this.maxUnpackedBytes) throw new SnapshotArchiveRefused(`the archive unpacks to more than ${this.maxUnpackedBytes} bytes`);
    let at = 0;
    while (at < chunk.byteLength) {
      if (this.ended) {
        for (; at < chunk.byteLength; at++) if (chunk[at] !== 0) throw new SnapshotArchiveRefused("the archive has bytes after its end-of-archive block");
        return;
      }
      const body = this.body;
      if (body !== undefined) {
        if (body.left > 0) {
          const n = Math.min(body.left, chunk.byteLength - at);
          body.record?.push(chunk.slice(at, at + n));
          body.left -= n;
          at += n;
          if (body.left > 0) continue;
        }
        const n = Math.min(body.pad, chunk.byteLength - at);
        body.pad -= n;
        at += n;
        if (body.pad > 0) continue;
        this.body = undefined;
        this.finishRecord(body);
        continue;
      }
      const n = Math.min(TAR_BLOCK - this.headerFilled, chunk.byteLength - at);
      this.header.set(chunk.subarray(at, at + n), this.headerFilled);
      this.headerFilled += n;
      at += n;
      if (this.headerFilled < TAR_BLOCK) continue;
      this.headerFilled = 0;
      this.entry(this.header);
      const next = this.body as SnapshotTarCheck["body"];
      if (next !== undefined && next.left === 0 && next.pad === 0) {
        this.body = undefined;
        this.finishRecord(next);
      }
    }
  }

  /** Once the bytes ended: refused when cut short or when an entry is under a link. The entries' count. */
  end(): number {
    if (!this.ended) throw new SnapshotArchiveRefused("the archive ends before its end-of-archive block");
    for (const path of this.seen.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) if (this.links.has(parts.slice(0, i).join("/"))) throw new SnapshotArchiveRefused("the archive has an entry under a link");
    }
    return this.entries;
  }

  private finishRecord(body: NonNullable<SnapshotTarCheck["body"]>): void {
    if (body.kind === undefined) return;
    const parts = body.record ?? [];
    const bytes = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    if (body.kind === "L" || body.kind === "K") {
      const name = tarText.decode(bytes).replace(/\0+$/, "");
      if (body.kind === "L") this.longName = name;
      else this.longLink = name;
      return;
    }
    for (const [key, value] of paxRecords(bytes)) {
      if (PAX_REFUSED.test(key)) throw new SnapshotArchiveRefused(`the archive has a pax record ${JSON.stringify(key)} (a sparse file: not taken)`);
      if (body.kind === "g") {
        if (key === "path" || key === "linkpath" || key === "size") throw new SnapshotArchiveRefused("the archive has a global pax header that names a path or a size");
      } else this.pax.set(key, value);
    }
  }

  private entry(block: Uint8Array): void {
    if (block.every((byte) => byte === 0)) {
      this.ended = true;
      return;
    }
    const stored = tarNumber(block, 148, 8);
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
    if (sum !== stored) throw new SnapshotArchiveRefused("the archive has a header whose checksum does not hold");
    const type = String.fromCharCode(block[156] as number);
    const paxSize = this.pax.get("size");
    const size = paxSize !== undefined ? Number(paxSize) : tarNumber(block, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new SnapshotArchiveRefused("the archive has an entry with no valid size");
    const pad = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > 1024 * 1024) throw new SnapshotArchiveRefused("the archive has a header record of more than 1 MiB");
      this.body = { left: size, pad, record: [], kind: type };
      return;
    }
    const paxPath = this.pax.get("path");
    const paxLink = this.pax.get("linkpath");
    if ((paxPath !== undefined && this.longName !== undefined) || (paxLink !== undefined && this.longLink !== undefined)) throw new SnapshotArchiveRefused("the archive names an entry twice (a pax and a GNU long name)");
    const ustar = tarField(block, 257, 6) === "ustar";
    const prefix = ustar ? tarField(block, 345, 155) : "";
    const raw = tarField(block, 0, 100);
    const name = paxPath ?? this.longName ?? (prefix === "" ? raw : `${prefix}/${raw}`);
    const linkname = paxLink ?? this.longLink ?? tarField(block, 157, 100);
    this.pax = new Map();
    this.longName = this.longLink = undefined;

    const kind = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "directory" : type === "2" ? "symlink" : undefined;
    if (kind === undefined) {
      const what = { "1": "a hard link", "3": "a character device", "4": "a block device", "6": "a FIFO", S: "a sparse file" }[type] ?? `an entry of type ${JSON.stringify(type)}`;
      throw new SnapshotArchiveRefused(`the archive has ${what} (only files, directories and links inside are taken)`);
    }
    if (kind !== "file" && size > 0) throw new SnapshotArchiveRefused(`the archive has a ${kind} with data`);
    if (name.includes("\0")) throw new SnapshotArchiveRefused("the archive has a path with a NUL");
    if (name.startsWith("/")) throw new SnapshotArchiveRefused(`the archive has an absolute path (${JSON.stringify(name.slice(0, 80))})`);
    const segments = name.split("/").filter((part) => part !== "" && part !== ".");
    if (segments.includes("..")) throw new SnapshotArchiveRefused(`the archive has a path with .. (${JSON.stringify(name.slice(0, 80))})`);
    this.entries++;
    if (segments.length === 0) {
      if (kind !== "directory") throw new SnapshotArchiveRefused(`the archive has a ${kind} at its root itself`);
      return;
    }
    for (let i = 1; i < segments.length; i++) if (this.links.has(segments.slice(0, i).join("/"))) throw new SnapshotArchiveRefused("the archive has an entry under a link");
    const path = segments.join("/");
    const before = this.seen.get(path);
    if (before !== undefined && (before !== "directory" || kind !== "directory")) throw new SnapshotArchiveRefused("the archive has two entries at one path");
    this.seen.set(path, kind);
    if (kind === "symlink") {
      if (!snapshotLinkStaysInside(path, linkname)) throw new SnapshotArchiveRefused(`the archive has a link that leads outside it (${JSON.stringify(path.slice(0, 80))})`);
      this.links.add(path);
    }
    if (kind === "file") this.body = { left: size, pad };
  }
}

/** What a checked archive was: its size, hex SHA-256 and entries. */
export interface CheckedSnapshotArchive {
  size: number;
  sha256: string;
  entries: number;
}

/** A body as chunks: a `ReadableStream` read with its reader, any other async iterable as it is. */
async function* chunksOf(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (!(body instanceof ReadableStream)) {
    yield* body;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * `body`, a gzip'd tar archive, passed on as it comes (`chunks`: the same bytes), checked on the way:
 * counted (more than `maxBytes`, or than `expected.size`, refuses), hashed, and gunzipped into
 * `SnapshotTarCheck`. A problem throws `SnapshotArchiveRefused` from `chunks`, at the latest once
 * `body` ended and before `chunks` does: what consumes it (`putStream`, a file the archive is then
 * extracted from) takes the bytes only once `chunks` ended without throwing. Then `result()` is what
 * they were (and `expected`'s size and SHA-256, when given, were theirs). Memory: a gunzip window and
 * the paths seen.
 */
export function checkSnapshotArchive(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  options: { maxBytes?: number; maxUnpackedBytes?: number; expected?: { size: number; sha256: string } } = {},
): { chunks: AsyncIterable<Uint8Array>; result(): CheckedSnapshotArchive } {
  let checked: CheckedSnapshotArchive | undefined;
  const refusal = (error: unknown) => (error instanceof SnapshotArchiveRefused ? error : new SnapshotArchiveRefused(`the archive is not gzip'd tar (${error instanceof Error ? error.message : String(error)})`));
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const tar = new SnapshotTarCheck(options.maxUnpackedBytes);
    const hash = createBlobHash();
    const inflate = new DecompressionStream("gzip");
    const writer = inflate.writable.getWriter();
    const reader = inflate.readable.getReader();
    let failure: SnapshotArchiveRefused | undefined;
    const reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          tar.feed(value);
        }
      } catch (error) {
        failure ??= refusal(error);
        await reader.cancel().catch(() => {});
      }
    })();
    const limit = Math.min(options.maxBytes ?? Number.POSITIVE_INFINITY, options.expected?.size ?? Number.POSITIVE_INFINITY);
    let size = 0;
    let finished = false;
    try {
      for await (const chunk of chunksOf(body)) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("workspace snapshots: an archive's chunk is a Uint8Array");
        if (chunk.byteLength === 0) continue;
        size += chunk.byteLength;
        if (size > limit) throw new SnapshotArchiveRefused(options.expected !== undefined && size > options.expected.size ? `the archive is larger than its manifest's ${options.expected.size} bytes` : `the archive is larger than ${options.maxBytes} bytes`);
        hash.update(chunk);
        await writer.write(new Uint8Array(chunk)).catch((error: unknown) => void (failure ??= refusal(error)));
        if (failure !== undefined) throw failure;
        yield chunk;
      }
      await writer.close().catch((error: unknown) => void (failure ??= refusal(error)));
      await reading;
      if (failure !== undefined) throw failure;
      const entries = tar.end();
      const sha256 = hash.digest();
      if (options.expected !== undefined && (size !== options.expected.size || sha256 !== options.expected.sha256)) {
        throw new SnapshotArchiveRefused(`the archive is not its manifest's (${size} bytes, SHA-256 ${sha256.slice(0, 16)}..., not ${options.expected.size}, ${options.expected.sha256.slice(0, 16)}...)`);
      }
      checked = { size, sha256, entries };
      finished = true;
    } finally {
      if (!finished) {
        await writer.abort().catch(() => {});
        await reader.cancel().catch(() => {});
      }
    }
  }
  return {
    chunks: chunks(),
    result() {
      if (checked === undefined) throw new Error("workspace snapshots: an archive's check read before it ended");
      return checked;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Writing and reading a snapshot with the archive made elsewhere (a container, a VM): Web APIs only.

/**
 * Uploads a workspace's new archive: `body` (made beforehand, its SHA-256 `sha256` known: the key
 * carries it) checked as it streams (`checkSnapshotArchive`) into `putStream` at
 * `<id>/snapshot-<createdAt>-<sha16>.tar.gz`, with that SHA-256 (the provider refuses another); the
 * size and SHA-256 the bucket stored compared with the check's. Nothing names it yet: the manifest it
 * returns is written by `commitSnapshotManifest`, once this resolved. A failure at any step (the
 * body, the check, the bucket) writes no value (`putStream`'s guarantee) and no manifest.
 */
export async function putSnapshotArchive(
  store: BlobStore,
  input: { id: string; agent: string; createdAt: number; sha256: string; body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>; maxBytes?: number; maxUnpackedBytes?: number },
): Promise<SnapshotManifest> {
  const object = snapshotArchiveKey(input.id, input.createdAt, input.sha256);
  const checked = checkSnapshotArchive(input.body, {
    ...(input.maxBytes !== undefined && { maxBytes: input.maxBytes }),
    ...(input.maxUnpackedBytes !== undefined && { maxUnpackedBytes: input.maxUnpackedBytes }),
  });
  const stored = await store.putStream(object, checked.chunks, { contentType: SNAPSHOT_CONTENT_TYPE, sha256: input.sha256 });
  const { size, sha256 } = checked.result();
  if (stored.size !== size || stored.sha256 !== sha256 || sha256 !== input.sha256) {
    await store.delete(object).catch(() => {});
    throw new Error("workspace snapshots: the bucket stored another archive than the one sent");
  }
  return { version: SNAPSHOT_VERSION, object, sha256, size, createdAt: input.createdAt, agent: input.agent };
}

/**
 * Writes `manifest` (its archive whole in the bucket: `putSnapshotArchive` resolved) as its workspace's
 * manifest, then reads it back: another than the one written (another host checkpointing this
 * workspace) throws. Superseded archives are the caller's to delete then (`deleteSupersededSnapshots`).
 */
export async function commitSnapshotManifest(store: BlobStore, id: string, manifest: SnapshotManifest): Promise<void> {
  const json = snapshotManifestJson(manifest);
  await store.put(snapshotManifestKey(id), new TextEncoder().encode(json), { contentType: "application/json" });
  const back = await store.get(snapshotManifestKey(id));
  if (back === undefined || new TextDecoder().decode(back.bytes) !== json) throw new Error("workspace snapshots: the manifest read back is not the one written (another host checkpointing this workspace?)");
}

/**
 * The workspace's snapshot to restore, or `undefined` when it has none: its manifest, checked
 * (`parseSnapshotManifest`: another agent's, another workspace's or another version refuses), and its
 * archive as `chunks`, checked as they stream against the manifest's size and SHA-256 and by
 * `SnapshotTarCheck`. Take the bytes (extract what they were written to) only once `chunks` ended
 * without throwing; `SnapshotArchiveRefused` for a snapshot that does not hold (an archive missing
 * too). A manifest replaced between its read and its archive's is read again.
 */
export async function readSnapshotArchive(
  store: BlobStore,
  target: { id: string; agent: string },
  options: { maxUnpackedBytes?: number } = {},
): Promise<{ manifest: SnapshotManifest; chunks: AsyncIterable<Uint8Array>; result(): CheckedSnapshotArchive } | undefined> {
  const manifestOf = async () => {
    const value = await store.get(snapshotManifestKey(target.id));
    if (value === undefined) return undefined;
    try {
      return parseSnapshotManifest(new TextDecoder().decode(value.bytes), target);
    } catch (error) {
      throw new SnapshotArchiveRefused(error instanceof Error ? error.message.replace(/^workspace snapshots: /, "") : String(error));
    }
  };
  for (let attempt = 1; ; attempt++) {
    const manifest = await manifestOf();
    if (manifest === undefined) return undefined;
    const archive = await store.getStream(manifest.object);
    if (archive === undefined) {
      const again = await manifestOf();
      if (again !== undefined && again.object !== manifest.object && attempt < 3) continue;
      throw new SnapshotArchiveRefused("the manifest names an archive that is not in the bucket: delete the manifest to start this workspace empty");
    }
    const checked = checkSnapshotArchive(archive.body, { expected: { size: manifest.size, sha256: manifest.sha256 }, ...(options.maxUnpackedBytes !== undefined && { maxUnpackedBytes: options.maxUnpackedBytes }) });
    return { manifest, ...checked };
  }
}
