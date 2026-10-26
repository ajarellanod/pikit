/**
 * `storage.blob`: files a component keeps by key, too large for a row of `storage.sql` (a Durable
 * Object's row holds at most 2 MB) or a value of `storage.kv`: a space's saved files, a workspace's
 * snapshot. Bytes in, the same bytes out.
 *
 * - **A namespace per component.** A component opens the namespace named after it
 *   (`namespace("tool-space-files")`), as it prefixes its SQL tables with its name. Two namespaces
 *   never see each other's keys; a provider keeps them apart however it stores them (a directory, a
 *   key prefix in a bucket).
 * - **Keys** are 1 to 512 characters of `A-Z a-z 0-9 ! - _ . * ' ( ) /`, with no empty, `.` or `..`
 *   segment between slashes and no leading or trailing slash: the characters every S3-compatible store
 *   and every file system take as they are. Anything else is refused (`BlobKeyError`) and nothing is
 *   read or written. A component that needs other characters hashes or encodes them.
 * - **`put` replaces** the value at its key, whole: a reader sees the old bytes or the new ones, never
 *   a mix, and once `put` resolves every later `get` (from any process) sees the new ones. There is no
 *   transaction across keys.
 * - **`get` returns a copy**: changing the bytes it gives changes nothing stored. A missing key is
 *   `undefined`. `delete` of a missing key is not an error.
 * - **`list(prefix)`** gives the keys that start with `prefix` (any string, `""` for all), in
 *   ascending code-unit order, with their sizes, `limit` at a time (default and maximum 1000) and a
 *   `cursor` for the next page when there are more. A key put before `list` was called and not deleted
 *   is listed; one put or deleted during a listing may or may not be.
 * - **Size.** A provider states its largest value (`maxBytes`, at least 25 MiB); a larger `put` is
 *   refused (`BlobTooLargeError`) and stores nothing. Values are whole `Uint8Array`s: streaming is not
 *   part of the contract yet.
 *
 * Pi first: Pi keeps no files outside a session's workspace; this is a component's own storage, across
 * conversations.
 */

/** A value read back: its bytes (a copy) and the content type it was put with, if any. */
export interface BlobValue {
  bytes: Uint8Array;
  contentType?: string;
}

/** One listed key. */
export interface BlobEntry {
  key: string;
  /** Its size in bytes. */
  size: number;
}

/** One page of `list`. */
export interface BlobPage {
  entries: BlobEntry[];
  /** Give it back to `list` for the next page; absent on the last one. */
  cursor?: string;
}

/** One component's namespace in `storage.blob`. */
export interface BlobStore {
  /** Writes `bytes` at `key`, replacing any value there. */
  put(key: string, bytes: Uint8Array, options?: { contentType?: string }): Promise<void>;
  /** The value at `key`, or `undefined` when there is none. */
  get(key: string): Promise<BlobValue | undefined>;
  /** Removes the value at `key`, if there is one. */
  delete(key: string): Promise<void>;
  /** The keys starting with `prefix`, in order, a page at a time. */
  list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<BlobPage>;
}

export interface BlobStorage {
  /** The largest value this provider keeps, in bytes (at least `BLOB_MIN_MAX_BYTES`). */
  readonly maxBytes: number;
  /** The namespace `name` (a component's name): a component opens the one named after it. */
  namespace(name: string): BlobStore;
}

/** The smallest `maxBytes` a provider may state: 25 MiB. */
export const BLOB_MIN_MAX_BYTES = 25 * 1024 * 1024;

/** The longest key. */
export const BLOB_MAX_KEY = 512;

const KEY_CHARACTERS = /^[A-Za-z0-9!\-_.*'()/]+$/;

/** What is wrong with `key` as a blob key, or `undefined` when it is one. */
export function blobKeyProblem(key: string): string | undefined {
  if (typeof key !== "string" || key.length === 0 || key.length > BLOB_MAX_KEY) return `a blob key is 1 to ${BLOB_MAX_KEY} characters`;
  if (!KEY_CHARACTERS.test(key)) return "a blob key has only A-Z a-z 0-9 ! - _ . * ' ( ) and /";
  if (key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return 'a blob key has no empty, "." or ".." segment';
  return undefined;
}

/** A key `storage.blob` refuses (`blobKeyProblem`). */
export class BlobKeyError extends Error {
  readonly code = "blob_key";
  constructor(key: string, problem: string) {
    super(`storage.blob: ${JSON.stringify(key.slice(0, 80))}: ${problem}`);
    this.name = "BlobKeyError";
  }
}

/** A value larger than the provider's `maxBytes`. */
export class BlobTooLargeError extends Error {
  readonly code = "blob_too_large";
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`storage.blob: a value of ${size} bytes is larger than this provider's ${maxBytes}`);
    this.name = "BlobTooLargeError";
  }
}

/** Throws `BlobKeyError` unless `key` is a blob key: what every provider checks first. */
export function checkBlobKey(key: string): void {
  const problem = blobKeyProblem(key);
  if (problem !== undefined) throw new BlobKeyError(String(key), problem);
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "storage.blob": BlobStorage;
  }
}
