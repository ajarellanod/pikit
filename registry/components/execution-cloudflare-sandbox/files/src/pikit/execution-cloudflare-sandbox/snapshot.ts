/**
 * Workspace snapshots in `storage.blob`, in the format every pikit sandbox backend shares, so one can
 * read what another wrote (the README's "Snapshots"):
 *
 * - Namespace `workspace-snapshots` (shared by design: not this component's name), keys under
 *   `<hex SHA-256 of "<chat key>\n<agent>">/`. On this host the chat key is execution-serve's,
 *   `execution-serve:<sandbox>`, and the agent the request's `Pikit-Agent`, or `_<sandbox>` without
 *   one (execution-serve's `ConversationRef`).
 * - The archive `snapshot-<createdAt ms>-<first 16 hex of its SHA-256>.tar.gz`: a gzip'd POSIX tar of
 *   the workspace root's contents (relative paths; regular files, directories, symlinks pointing
 *   inside: `tar.ts` refuses anything else).
 * - Then, written LAST, `manifest.json`:
 *   `{ "version": 1, "object": "<archive key>", "sha256": "<hex>", "size": <bytes>, "createdAt": <ms>, "agent": "<agent>" }`.
 * - Superseded archives are deleted only after the new manifest is written.
 *
 * **Restore** reads the manifest, then the archive, checks its SHA-256 and size and its entries, and
 * only then is it extracted (into an empty directory, swapped in: `sandbox.ts`). **The local copy is
 * the truth until the upload is verified**: the container is released only after `writeSnapshot`
 * resolved with a manifest.
 *
 * **Whole values today.** `storage.blob` takes whole values up to its provider's `maxBytes`: an archive
 * over it is skipped (`{ skipped }`, logged by the caller), never cut. Uploading is `putArchive`
 * alone, kept apart so a streaming or multipart helper can replace it.
 */

import type { BlobStore } from "@pikit/contracts";
import { inspectArchive } from "./tar.ts";

export const SNAPSHOT_NAMESPACE = "workspace-snapshots";
export const MANIFEST = "manifest.json";
export const SNAPSHOT_VERSION = 1;
const ARCHIVE = /^snapshot-(\d{1,16})-([0-9a-f]{16})\.tar\.gz$/;

export interface SnapshotManifest {
  version: 1;
  object: string;
  sha256: string;
  size: number;
  createdAt: number;
  agent: string;
}

/** A snapshot that cannot be restored as it is: a manifest or archive that does not hold. */
export class SnapshotRefused extends Error {}

const encode = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The prefix of a chat and agent's snapshots: `<hex SHA-256 of "<chat key>\n<agent>">/`. */
export async function snapshotPrefix(chatKey: string, agent: string): Promise<string> {
  return `${await sha256Hex(encode(`${chatKey}\n${agent}`))}/`;
}

export function archiveKey(prefix: string, createdAt: number, sha256: string): string {
  return `${prefix}snapshot-${createdAt}-${sha256.slice(0, 16)}.tar.gz`;
}

/** The manifest at `prefix`, checked against the format and the agent it must be for. */
export function parseManifest(bytes: Uint8Array, prefix: string, agent: string): SnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SnapshotRefused(`${prefix}${MANIFEST} is not JSON`);
  }
  const manifest = value as Partial<SnapshotManifest> | null;
  const fail = (why: string): never => {
    throw new SnapshotRefused(`${prefix}${MANIFEST}: ${why}`);
  };
  if (manifest === null || typeof manifest !== "object") return fail("not an object");
  if (manifest.version !== SNAPSHOT_VERSION) return fail(`version ${JSON.stringify(manifest.version)}, not ${SNAPSHOT_VERSION}`);
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) return fail("sha256 is not 64 hex digits");
  if (typeof manifest.size !== "number" || !Number.isSafeInteger(manifest.size) || manifest.size < 0) return fail("size is not a size");
  if (typeof manifest.createdAt !== "number" || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0) return fail("createdAt is not a time");
  if (manifest.agent !== agent) return fail(`made for the agent ${JSON.stringify(manifest.agent)}, not ${JSON.stringify(agent)}`);
  const object = typeof manifest.object === "string" && manifest.object.startsWith(prefix) ? manifest.object.slice(prefix.length) : undefined;
  const match = object === undefined ? null : ARCHIVE.exec(object);
  if (match === null) return fail("object is not an archive of this prefix");
  if (match[2] !== manifest.sha256.slice(0, 16)) return fail("object's name does not carry its sha256");
  return { version: 1, object: `${prefix}${object}`, sha256: manifest.sha256, size: manifest.size, createdAt: manifest.createdAt, agent };
}

/**
 * Uploads an archive whole: `storage.blob` today. Isolated so a streaming or multipart helper can take
 * its place; storage-blob-s3 has S3 check the signed SHA-256 of the body.
 */
export async function putArchive(store: BlobStore, key: string, bytes: Uint8Array): Promise<void> {
  await store.put(key, bytes, { contentType: "application/gzip" });
}

export interface WriteSnapshot {
  store: BlobStore;
  prefix: string;
  agent: string;
  archive: Uint8Array;
  createdAt: number;
  /** The provider's largest value. */
  maxBytes: number;
}

/**
 * Writes `archive` as the chat and agent's snapshot: the archive, checked in the bucket (its listed
 * size), then the manifest, then the superseded archives deleted. `{ skipped }` when the archive is
 * over `maxBytes` (nothing written).
 */
export async function writeSnapshot(input: WriteSnapshot): Promise<SnapshotManifest | { skipped: string }> {
  const { store, prefix, agent, archive, createdAt, maxBytes } = input;
  if (archive.length > maxBytes) return { skipped: `the archive is ${archive.length} bytes, more than storage.blob's maxBytes (${maxBytes})` };
  const sha256 = await sha256Hex(archive);
  const object = archiveKey(prefix, createdAt, sha256);
  await putArchive(store, object, archive);
  // Verified before the manifest points at it: the bucket lists it at its size.
  const listed = (await store.list(object, { limit: 1 })).entries.find((entry) => entry.key === object);
  if (listed?.size !== archive.length) throw new Error(`execution-cloudflare-sandbox: ${object} is not in the bucket at its size after its upload (listed: ${listed?.size ?? "none"})`);
  const manifest: SnapshotManifest = { version: 1, object, sha256, size: archive.length, createdAt, agent };
  await store.put(`${prefix}${MANIFEST}`, encode(JSON.stringify(manifest)), { contentType: "application/json" });
  for (let cursor: string | undefined, first = true; first || cursor !== undefined; first = false) {
    const page = await store.list(`${prefix}snapshot-`, { ...(cursor !== undefined && { cursor }) });
    for (const entry of page.entries) {
      if (entry.key !== object && ARCHIVE.test(entry.key.slice(prefix.length))) await store.delete(entry.key);
    }
    cursor = page.cursor;
  }
  return manifest;
}

/**
 * The chat and agent's snapshot, checked (manifest, size, SHA-256, entries), or `undefined` when there
 * is none. `SnapshotRefused` when there is one that does not hold.
 */
export async function readSnapshot(store: BlobStore, prefix: string, agent: string, maxUnpackedBytes: number): Promise<{ manifest: SnapshotManifest; archive: Uint8Array } | undefined> {
  const stored = await store.get(`${prefix}${MANIFEST}`);
  if (stored === undefined) return undefined;
  const manifest = parseManifest(stored.bytes, prefix, agent);
  const archive = (await store.get(manifest.object))?.bytes;
  if (archive === undefined) throw new SnapshotRefused(`${manifest.object}, which the manifest names, is not in the bucket`);
  if (archive.length !== manifest.size) throw new SnapshotRefused(`${manifest.object} is ${archive.length} bytes, the manifest says ${manifest.size}`);
  if ((await sha256Hex(archive)) !== manifest.sha256) throw new SnapshotRefused(`${manifest.object}'s SHA-256 is not the manifest's`);
  try {
    await inspectArchive(archive, maxUnpackedBytes);
  } catch (error) {
    throw new SnapshotRefused(`${manifest.object}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { manifest, archive };
}
