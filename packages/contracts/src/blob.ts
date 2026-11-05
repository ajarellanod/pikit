/**
 * `storage.blob`: files a component keeps by key, too large for a row of `storage.sql` (a Durable
 * Object's row holds at most 2 MB) or a value of `storage.kv`: a space's saved files, a workspace's
 * snapshot. Bytes in, the same bytes out.
 *
 * - **A namespace per component.** A component opens the namespace named after it
 *   (`namespace("tool-space-files")`), as it prefixes its SQL tables with its name. Two namespaces
 *   never see each other's keys; a provider keeps them apart however it stores them (a directory, a
 *   key prefix in a bucket). A namespace's name is 1 to 100 characters of `a-z 0-9 - _ .`, not `.`
 *   or `..` (a component's name is one): one directory or one segment of a key wherever it is kept,
 *   the same on a file system that ignores case. Any other name is refused (`BlobKeyError`).
 * - **Keys** are 1 to 512 characters of `A-Z a-z 0-9 ! - _ . * ' ( ) /`, with no empty, `.` or `..`
 *   segment between slashes and no leading or trailing slash: the characters every S3-compatible store
 *   and every file system take as they are. Anything else is refused (`BlobKeyError`) and nothing is
 *   read or written. A component that needs other characters hashes or encodes them. Keys are
 *   case-sensitive (`a` and `A` are two keys), and a key and the keys under it (`a`, `a/b`) are
 *   separate values, as in a bucket.
 * - **`put` replaces** the value at its key, whole: a reader sees the old bytes or the new ones, never
 *   a mix, and once `put` resolves every later `get` (from any process) sees the new ones. There is no
 *   transaction across keys. It takes its own copy of the bytes when called: changing them afterwards,
 *   even before it resolves, changes nothing stored. Its content type, when given, is 1 to 255
 *   printable ASCII characters, with no space at either end (an HTTP header's value, which a hop may
 *   trim: `application/x-tar`); `get` gives it back as it was put, or none when none was put.
 * - **`get` returns a copy**: changing the bytes it gives changes nothing stored. A missing key is
 *   `undefined`. `delete` of a missing key is not an error.
 * - **`list(prefix)`** gives the keys that start with `prefix` (any string, `""` for all), in
 *   ascending code-unit order, with their sizes, at most `limit` at a time (an integer from 1; default
 *   and maximum 1000, a larger one is taken as 1000) and a `cursor` for the next page when there may
 *   be more. A page may hold fewer than `limit` (a bucket decides its pages), even none, and still
 *   have a cursor. A key put before `list` was called and not deleted is listed; one put or deleted
 *   during a listing may or may not be.
 * - **Size.** A provider states its largest whole value (`maxBytes`, at least 25 MiB); a larger `put`
 *   is refused (`BlobTooLargeError`) and stores nothing, and a `get` of a larger value (one put as a
 *   stream) is refused too: read it with `getStream`.
 * - **Streams**, for values larger than memory should hold (a workspace's snapshot, GBs):
 *   `putStream(key, body)` takes the bytes an async iterable yields (a `ReadableStream`, a file's read
 *   stream, a generator), each chunk a `Uint8Array` copied as it is read, up to the provider's
 *   `maxStreamBytes` (at least `maxBytes`). It replaces the value as `put` does, whole: nothing at the
 *   key changes, for `get`, `getStream` or `list`, until the last byte arrived and was checked. A body
 *   that fails partway (its iterator throws), one larger than `maxStreamBytes`
 *   (`BlobTooLargeError`), or one whose SHA-256 is not the `sha256` given (`BlobChecksumError`) rejects
 *   the put and leaves the key as it was: the old value whole, or none; no partial value is ever
 *   visible. It resolves with the size and hex SHA-256 of the bytes stored, for the caller to compare
 *   with its own. A put interrupted by a crash may leave unlisted space behind (a temporary file, an
 *   incomplete multipart upload a bucket's lifecycle rule aborts), never a value.
 *   `getStream(key)` gives the value as a `ReadableStream` with its size and content type (`undefined`
 *   when missing): the bytes of one value whole, never a mix of two puts; a read that fails errors
 *   the stream.
 *   Every provider reads a body through `blobStreamChunks`, which copies, counts, hashes and refuses,
 *   and commits only once it ended.
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

/** A value read as a stream: its bytes, its size, the content type it was put with, if any. */
export interface BlobStream {
  body: ReadableStream<Uint8Array>;
  /** Its size in bytes: what `body` gives in all. */
  size: number;
  contentType?: string;
}

/** What `putStream` stored: its size and the hex SHA-256 of its bytes. */
export interface BlobStored {
  size: number;
  sha256: string;
}

export interface BlobStreamPutOptions {
  contentType?: string;
  /** The hex SHA-256 (64 lowercase hex) the bytes must have: a body with another is refused (`BlobChecksumError`), nothing stored. */
  sha256?: string;
}

/** One component's namespace in `storage.blob`. */
export interface BlobStore {
  /** Writes `bytes` at `key`, replacing any value there. */
  put(key: string, bytes: Uint8Array, options?: { contentType?: string }): Promise<void>;
  /** The value at `key`, or `undefined` when there is none; `BlobTooLargeError` for one larger than `maxBytes`. */
  get(key: string): Promise<BlobValue | undefined>;
  /** Writes what `body` yields at `key`, replacing any value there once all of it arrived and was checked. */
  putStream(key: string, body: AsyncIterable<Uint8Array>, options?: BlobStreamPutOptions): Promise<BlobStored>;
  /** The value at `key` as a stream, or `undefined` when there is none. */
  getStream(key: string): Promise<BlobStream | undefined>;
  /** Removes the value at `key`, if there is one. */
  delete(key: string): Promise<void>;
  /** The keys starting with `prefix`, in order, a page at a time. */
  list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<BlobPage>;
}

export interface BlobStorage {
  /** The largest whole value (`put`, `get`) this provider keeps, in bytes (at least `BLOB_MIN_MAX_BYTES`). */
  readonly maxBytes: number;
  /** The largest value `putStream` takes, in bytes (at least `maxBytes`). */
  readonly maxStreamBytes: number;
  /** The namespace `name` (a component's name): a component opens the one named after it. */
  namespace(name: string): BlobStore;
}

/** The smallest `maxBytes` a provider may state: 25 MiB. */
export const BLOB_MIN_MAX_BYTES = 25 * 1024 * 1024;

/** The longest key. */
export const BLOB_MAX_KEY = 512;

/** The most keys one page of `list` gives, and its default. */
export const BLOB_LIST_LIMIT = 1000;

const KEY_CHARACTERS = /^[A-Za-z0-9!\-_.*'()/]+$/;
const NAMESPACE = /^[a-z0-9\-_.]{1,100}$/;
const CONTENT_TYPE = /^[\x21-\x7e]([\x20-\x7e]{0,253}[\x21-\x7e])?$/;

/** What is wrong with `name` as a namespace's name, or `undefined` when it is one. */
export function blobNamespaceProblem(name: string): string | undefined {
  if (typeof name !== "string" || !NAMESPACE.test(name) || name === "." || name === "..") return 'a blob namespace is 1 to 100 characters of a-z 0-9 - _ and ., not "." or ".."';
  return undefined;
}

/** Throws `BlobKeyError` unless `name` is a namespace's name: what every provider's `namespace` checks first. */
export function checkBlobNamespace(name: string): void {
  const problem = blobNamespaceProblem(name);
  if (problem !== undefined) throw new BlobKeyError(String(name), problem);
}

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

/**
 * What every provider's `put` checks before it reads or writes anything: the key (`BlobKeyError`),
 * the bytes (a `Uint8Array`, else `TypeError`), their size against `maxBytes` (`BlobTooLargeError`)
 * and the content type (`TypeError`).
 */
export function checkBlobPut(key: string, bytes: Uint8Array, contentType: string | undefined, maxBytes: number): void {
  checkBlobKey(key);
  if (!(bytes instanceof Uint8Array)) throw new TypeError("storage.blob: a value is a Uint8Array");
  if (bytes.byteLength > maxBytes) throw new BlobTooLargeError(bytes.byteLength, maxBytes);
  if (contentType !== undefined && (typeof contentType !== "string" || !CONTENT_TYPE.test(contentType))) {
    throw new TypeError("storage.blob: a content type is 1 to 255 printable ASCII characters, with no space at either end");
  }
}

/** A value whose bytes do not have the SHA-256 `putStream` was given. */
export class BlobChecksumError extends Error {
  readonly code = "blob_checksum";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`storage.blob: the bytes' SHA-256 is ${actual}, not the ${expected} given`);
    this.name = "BlobChecksumError";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * What every provider's `putStream` checks before it reads or writes anything: the key
 * (`BlobKeyError`), the body (an async iterable, else `TypeError`), the content type and the
 * `sha256` (64 lowercase hex, else `TypeError`).
 */
export function checkBlobPutStream(key: string, body: AsyncIterable<Uint8Array>, options: BlobStreamPutOptions | undefined): void {
  checkBlobKey(key);
  if (body === null || typeof body !== "object" || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
    throw new TypeError("storage.blob: a stream's body is an async iterable of Uint8Array (a ReadableStream, a generator)");
  }
  checkBlobPut(key, new Uint8Array(0), options?.contentType, 0);
  if (options?.sha256 !== undefined && (typeof options.sha256 !== "string" || !SHA256_HEX.test(options.sha256))) {
    throw new TypeError("storage.blob: a stream's sha256 is 64 lowercase hex characters");
  }
}

/** An incremental SHA-256: `update` with each chunk, `digest` once, as hex. */
export interface BlobHash {
  update(bytes: Uint8Array): void;
  digest(): string;
}

/**
 * A body read for a provider's `putStream` (`checkBlobPutStream` first): `chunks` yields each chunk
 * of `body` as a copy of its own (a `Uint8Array` over an `ArrayBuffer`), refusing one that is not a
 * `Uint8Array` (`TypeError`) and, before yielding it, the chunk that takes the total past
 * `maxStreamBytes` (`BlobTooLargeError`); once `body` ended, it throws `BlobChecksumError` when the
 * bytes' SHA-256 is not `sha256`. A provider commits the value only after its `for await` over
 * `chunks` completed, and then `stored()` is what it stored. `hash` makes the SHA-256 (a faster one
 * where the platform has it, `node:crypto`'s); `createBlobHash` by default.
 */
export function blobStreamChunks(
  body: AsyncIterable<Uint8Array>,
  options: { maxStreamBytes: number; sha256?: string; hash?: () => BlobHash },
): { chunks: AsyncIterable<Uint8Array<ArrayBuffer>>; stored(): BlobStored } {
  let result: BlobStored | undefined;
  async function* chunks(): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const hash = (options.hash ?? createBlobHash)();
    let size = 0;
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError("storage.blob: a stream's chunk is a Uint8Array");
      if (size + chunk.byteLength > options.maxStreamBytes) throw new BlobTooLargeError(size + chunk.byteLength, options.maxStreamBytes);
      if (chunk.byteLength === 0) continue;
      const copy = new Uint8Array(chunk);
      size += copy.byteLength;
      hash.update(copy);
      yield copy;
    }
    const sha256 = hash.digest();
    if (options.sha256 !== undefined && sha256 !== options.sha256) throw new BlobChecksumError(options.sha256, sha256);
    result = { size, sha256 };
  }
  return {
    chunks: chunks(),
    stored() {
      if (result === undefined) throw new Error("storage.blob: a stream's result read before it ended");
      return result;
    },
  };
}

// SHA-256 (FIPS 180-4) in plain JavaScript, for every target: Web Crypto has no incremental digest.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** A SHA-256 in plain JavaScript (about 160 MB/s in Bun): runs on every target. */
export function createBlobHash(): BlobHash {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const block = new Uint8Array(64);
  let filled = 0;
  let length = 0;
  let done = false;
  const compress = (d: Uint8Array, o: number) => {
    for (let t = 0; t < 16; t++) w[t] = ((d[o + 4 * t] as number) << 24) | ((d[o + 4 * t + 1] as number) << 16) | ((d[o + 4 * t + 2] as number) << 8) | (d[o + 4 * t + 3] as number);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15] as number;
      const y = w[t - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d0 = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let t = 0; t < 64; t++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + (K[t] as number) + (w[t] as number)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d0 + t1) | 0;
      d0 = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d0;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  };
  const update = (data: Uint8Array) => {
    if (done) throw new Error("storage.blob: a SHA-256 updated after its digest");
    length += data.byteLength;
    let i = 0;
    if (filled > 0) {
      const n = Math.min(64 - filled, data.byteLength);
      block.set(data.subarray(0, n), filled);
      filled += n;
      i = n;
      if (filled < 64) return;
      compress(block, 0);
      filled = 0;
    }
    for (; i + 64 <= data.byteLength; i += 64) compress(data, i);
    if (i < data.byteLength) {
      block.set(data.subarray(i), 0);
      filled = data.byteLength - i;
    }
  };
  return {
    update,
    digest() {
      const bits = length * 8;
      const tail = new Uint8Array((filled < 56 ? 64 : 128) - filled);
      tail[0] = 0x80;
      const view = new DataView(tail.buffer);
      view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
      view.setUint32(tail.length - 4, bits >>> 0);
      update(tail);
      done = true;
      return [...h].map((word) => word.toString(16).padStart(8, "0")).join("");
    },
  };
}

/** The page size `list` uses for `limit`: 1000 when absent, at most 1000; `RangeError` for one that is not an integer from 1. */
export function blobListLimit(limit: number | undefined): number {
  if (limit === undefined) return BLOB_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`storage.blob: a list's limit is an integer from 1, not ${String(limit)}`);
  return Math.min(limit, BLOB_LIST_LIMIT);
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "storage.blob": BlobStorage;
  }
}
