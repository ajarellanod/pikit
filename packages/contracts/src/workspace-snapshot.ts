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
 * Neutral: Web Crypto only, so a Worker computes the same keys.
 */

import type { BlobStore } from "./blob.ts";

/** The `storage.blob` namespace every backend keeps snapshots in. */
export const SNAPSHOT_NAMESPACE = "workspace-snapshots";
/** The manifest's name under a workspace's `<id>/`. */
export const SNAPSHOT_MANIFEST = "manifest.json";
/** The manifest's `version`. */
export const SNAPSHOT_VERSION = 1;
/** The archive's content type. */
export const SNAPSHOT_CONTENT_TYPE = "application/gzip";

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
