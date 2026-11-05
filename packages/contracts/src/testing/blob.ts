/**
 * `storage.blob` conformance: what every `BlobStorage` must do, wherever its bytes live (a directory,
 * a bucket). Runner-independent, like the other suites:
 *
 *   for (const c of createBlobConformance(() => myFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite reaches the storage through the capability, as a component would. It writes a value of
 * the provider's `maxBytes` (and one byte more): configure a fixture's provider with the smallest it
 * allows, `BLOB_MIN_MAX_BYTES`, so a case holds no more than about 50 MiB. The stream cases put a
 * stream of `maxBytes` + 5 MiB and one of `maxStreamBytes` + 1: give the fixture's provider a small
 * `maxStreamBytes` too (`BLOB_CONFORMANCE_STREAM_BYTES`, 40 MiB).
 */

import { type App, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import {
  BLOB_LIST_LIMIT,
  BlobChecksumError,
  blobStreamChunks,
  checkBlobPutStream,
  createBlobHash,
  BLOB_MAX_KEY,
  BLOB_MIN_MAX_BYTES,
  type BlobEntry,
  type BlobPage,
  type BlobStorage,
  type BlobStore,
  blobListLimit,
  BlobTooLargeError,
  checkBlobKey,
  checkBlobNamespace,
  checkBlobPut,
} from "../blob.ts";
import { checker, expecter } from "./assert.ts";

/** A fresh, empty storage, built for one case. */
export interface BlobFixture {
  /**
   * The component providing `storage.blob`, and anything it uses. The suite may create several apps
   * from them over the same bytes, one after the other, so the bytes live outside the components'
   * setup (a directory, a bucket, a map the fixture holds).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /** Release what the fixture holds (temporary files, a fake server). */
  dispose?(): Promise<void>;
}

const GROUP = "storage.blob";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** The case names a broken provider's test looks up (`blob.test.ts`). */
export const BLOB_CASES = {
  bytes: "every byte value reads back as it was put, an empty value too; a missing key is undefined",
  replace: "put replaces a value and its content type; the content type comes back as it was put",
  copies: "values are copies: changing what was put (even before put resolves) or what get gave changes nothing stored",
  concurrent: "of concurrent puts to one key, a get sees one of them whole",
  delete: "delete removes a value and nothing else; deleting a missing key is not an error",
  separate: "keys are case-sensitive, and a key and the keys under it are separate values",
  longKeys: "the longest key, a long segment, and every character a key may have",
  refused: "a key, a namespace, a value or a content type the contract refuses is refused, and nothing is stored",
  namespaces: "namespaces never see each other's keys, even one whose name starts with another's",
  order: "list gives the keys starting with a prefix, in code-unit order, with their sizes",
  paging: "list pages with a cursor: every key once, in order, at most limit a page",
  defaultLimit: "a page holds at most 1000 keys, whatever the limit asked; a limit that is not an integer from 1 is refused",
  size: "a value of maxBytes is kept; one byte more is refused and stores nothing",
  restart: "values, content types and listings survive a new app over the same storage",
  streamBytes: "a stream reads back as it was put, from chunks of any shape (none, empty, views, a reused buffer); put resolves with its size and SHA-256",
  streamLarge: "a stream larger than maxBytes is kept and listed with its size; get refuses it whole, getStream gives it, also after a restart",
  streamInterrupted: "a stream that fails partway stores nothing: the old value stays whole, nothing partial is read or listed",
  streamChecksum: "a stream whose SHA-256 is not the one given is refused and stores nothing; with the right one it is kept",
  streamSize: "a stream of maxStreamBytes + 1 is refused and stores nothing",
} as const;

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with nothing"),
  );

/** `promise` rejects with an error whose `code` is `code` (`blob_key`, `blob_too_large`) or that is an instance of `type`. */
async function refused(promise: Promise<unknown>, kind: string | (new (...args: never[]) => Error), what: string): Promise<void> {
  const error = await rejection(promise);
  if (typeof kind === "string") check((error as { code?: unknown } | undefined)?.code === kind, `${what} to be refused with ${kind}, not ${describe(error)}`);
  else check(error instanceof kind, `${what} to be refused with a ${kind.name}, not ${describe(error)}`);
}

const describe = (error: unknown): string => (error === undefined ? "resolving" : error instanceof Error ? `${error.name}: ${error.message}` : String(error));

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/** `bytes` as read back from `store` at `key`, with the content type it was put with. */
async function expectValue(store: BlobStore, key: string, bytes: Uint8Array, contentType: string | undefined, what: string): Promise<void> {
  const value = await store.get(key);
  check(value !== undefined, `${what}: a value at ${JSON.stringify(key)}`);
  if (value === undefined) return;
  check(value.bytes instanceof Uint8Array, `${what}: the bytes at ${JSON.stringify(key)} as a Uint8Array`);
  check(sameBytes(value.bytes, bytes), `${what}: the ${bytes.byteLength} bytes put at ${JSON.stringify(key)}, not ${value.bytes.byteLength} other ones`);
  expect(value.contentType, contentType, `${what}: the content type at ${JSON.stringify(key)}`);
}

/** Every entry of `store.list(prefix)`, page after page; each page checked against `limit`. */
async function listAll(store: BlobStore, prefix: string, limit?: number): Promise<{ entries: BlobEntry[]; pages: BlobPage[] }> {
  const entries: BlobEntry[] = [];
  const pages: BlobPage[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 2_000; n++) {
    const page = await store.list(prefix, { ...(cursor !== undefined && { cursor }), ...(limit !== undefined && { limit }) });
    pages.push(page);
    check(page.entries.length <= Math.min(limit ?? BLOB_LIST_LIMIT, BLOB_LIST_LIMIT), `a page of at most ${Math.min(limit ?? BLOB_LIST_LIMIT, BLOB_LIST_LIMIT)} keys, not ${page.entries.length}`);
    entries.push(...page.entries);
    if (page.cursor === undefined) return { entries, pages };
    check(page.cursor !== cursor, "a cursor that moves the listing on");
    cursor = page.cursor;
  }
  throw new Error(`${GROUP}: a listing of ${JSON.stringify(prefix)} that never ends`);
}

const keysOf = (entries: readonly BlobEntry[]): string[] => entries.map((entry) => entry.key);
/** Ascending code-unit order: JavaScript's default sort of strings. */
const sorted = (keys: readonly string[]): string[] => [...keys].sort();

/** `n` bytes of a pattern `seed` changes. */
function pattern(n: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
  return bytes;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The `maxStreamBytes` to configure a fixture's provider with: the suite streams one byte more. */
export const BLOB_CONFORMANCE_STREAM_BYTES = 40 * 1024 * 1024;

const MiB = 1024 * 1024;

/** The byte of `pattern(…, seed)` at `i`, for streams too large to hold. */
const patternByte = (i: number, seed: number): number => (i * 31 + seed * 7 + (i >> 8)) & 0xff;

/**
 * `total` bytes of the pattern `seed`, in chunks of `chunk` (from a buffer reused for every chunk:
 * a provider that keeps a chunk without copying it stores garbage); throws `fail` once `failAfter`
 * bytes were given.
 */
async function* patternStream(total: number, seed: number, chunk = MiB + 17, fail?: { after: number; error: Error }): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(chunk);
  for (let at = 0; at < total; ) {
    if (fail !== undefined && at >= fail.after) throw fail.error;
    const n = Math.min(chunk, total - at);
    for (let i = 0; i < n; i++) buffer[i] = patternByte(at + i, seed);
    yield buffer.subarray(0, n);
    buffer.fill(0xee);
    at += n;
  }
  if (fail !== undefined) throw fail.error;
}

/** The hex SHA-256 of `pattern(total, seed)`, made a chunk at a time. */
async function patternSha256(total: number, seed: number): Promise<string> {
  const hash = createBlobHash();
  for await (const chunk of patternStream(total, seed)) hash.update(chunk);
  return hash.digest();
}

/** What `body` gives: its size and hex SHA-256, read without holding it. */
async function readStream(body: ReadableStream<Uint8Array>): Promise<{ size: number; sha256: string }> {
  const hash = createBlobHash();
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    check(value instanceof Uint8Array, "a stream's chunks as Uint8Arrays");
    size += value.byteLength;
    hash.update(value);
  }
  return { size, sha256: hash.digest() };
}

const sha256Of = (bytes: Uint8Array): string => {
  const hash = createBlobHash();
  hash.update(bytes);
  return hash.digest();
};

/** `store.getStream(key)` gives `bytes` (by SHA-256) with `contentType`. */
async function expectStream(store: BlobStore, key: string, expected: { size: number; sha256: string }, contentType: string | undefined, what: string): Promise<void> {
  const value = await store.getStream(key);
  check(value !== undefined, `${what}: a stream at ${JSON.stringify(key)}`);
  if (value === undefined) return;
  expect(value.size, expected.size, `${what}: the size getStream states at ${JSON.stringify(key)}`);
  expect(value.contentType, contentType, `${what}: the content type getStream gives at ${JSON.stringify(key)}`);
  expect(await readStream(value.body), expected, `${what}: the bytes getStream gives at ${JSON.stringify(key)} (size and SHA-256)`);
}

async function* chunksOf(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

export function createBlobConformance(factory: () => BlobFixture | Promise<BlobFixture>): readonly ConformanceCase[] {
  const blobCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const apps: App[] = [];
      try {
        await run(createSubject(fixture, apps));
      } finally {
        for (const app of apps) await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  return [
    blobCase(BLOB_CASES.bytes, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const every = new Uint8Array(512);
      for (let i = 0; i < every.length; i++) every[i] = i % 256;
      await store.put("bytes/every", every);
      await expectValue(store, "bytes/every", every, undefined, "every byte value");
      await store.put("bytes/empty", new Uint8Array(0));
      await expectValue(store, "bytes/empty", new Uint8Array(0), undefined, "an empty value, which is a value");
      // A view into a larger buffer: only its own bytes are put.
      const backing = pattern(64, 3);
      await store.put("bytes/view", backing.subarray(8, 24));
      await expectValue(store, "bytes/view", backing.slice(8, 24), undefined, "a view's own bytes");
      expect(await store.get("bytes/missing"), undefined, "a key never put");
      expect(await store.get("bytes"), undefined, "a key that only starts other keys");
    }),

    blobCase(BLOB_CASES.replace, async (s) => {
      const store = (await s.open()).namespace("conformance");
      await store.put("k", text("first"), { contentType: "text/plain" });
      await store.put("k", text("second, longer"));
      await expectValue(store, "k", text("second, longer"), undefined, "a put with no content type replaces one with");
      await store.put("k", text("3"), { contentType: 'Application/X-Tar; note="A b"' });
      await expectValue(store, "k", text("3"), 'Application/X-Tar; note="A b"', "the content type as it was put, case and spaces kept");
      await store.put("k", text("4"), { contentType: "image/png" });
      await expectValue(store, "k", text("4"), "image/png", "a new content type");
      expect((await listAll(store, "")).entries, [{ key: "k", size: 1 }], "one key, its last size");
    }),

    blobCase(BLOB_CASES.copies, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const put = pattern(1024, 1);
      const original = put.slice();
      const putting = store.put("k", put);
      put.fill(0);
      await putting;
      put.fill(1);
      await expectValue(store, "k", original, undefined, "the value as it was when put was called");
      const first = await store.get("k");
      first?.bytes.fill(9);
      await expectValue(store, "k", original, undefined, "the value after changing what get gave");
      const [a, b] = await Promise.all([store.get("k"), store.get("k")]);
      check(a !== undefined && b !== undefined && a.bytes !== b.bytes, "two gets to give two arrays");
    }),

    blobCase(BLOB_CASES.concurrent, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const values = Array.from({ length: 8 }, (_, i) => pattern(64 * 1024 + i, i));
      await Promise.all(values.map((value, i) => store.put("race", value, { contentType: `application/x-${i}` })));
      const read = await store.get("race");
      const i = values.findIndex((value) => read !== undefined && sameBytes(read.bytes, value));
      check(i >= 0, "the bytes of one of the puts, whole");
      expect(read?.contentType, `application/x-${i}`, "the content type of the same put");
      expect((await listAll(store, "")).entries, [{ key: "race", size: 64 * 1024 + i }], "one key with that put's size");
    }),

    blobCase(BLOB_CASES.delete, async (s) => {
      const store = (await s.open()).namespace("conformance");
      for (const key of ["k", "k/sub", "k!", "kk"]) await store.put(key, text(key));
      await store.delete("k");
      expect(await store.get("k"), undefined, "no value after delete");
      await store.delete("k");
      await store.delete("never/put");
      for (const key of ["k/sub", "k!", "kk"]) await expectValue(store, key, text(key), undefined, "a key delete did not name");
      await store.delete("k/sub");
      await store.put("k", text("again"));
      await expectValue(store, "k", text("again"), undefined, "a key put again after delete");
      expect(keysOf((await listAll(store, "")).entries), ["k", "k!", "kk"], "the keys left");
    }),

    blobCase(BLOB_CASES.separate, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const keys = ["a", "A", "a/b", "a/b/c", "A/b", "a.b", "readme", "README", "ReadMe"];
      for (const key of keys) await store.put(key, text(`value of ${key}`));
      for (const key of keys) await expectValue(store, key, text(`value of ${key}`), undefined, "a key of its own");
      await store.delete("a");
      await store.delete("README");
      for (const key of ["A", "a/b", "a/b/c", "readme", "ReadMe"]) await expectValue(store, key, text(`value of ${key}`), undefined, "a key that only differs from a deleted one");
      expect(keysOf((await listAll(store, "")).entries), sorted(["A", "A/b", "a/b", "a/b/c", "a.b", "readme", "ReadMe"]), "the keys left, in order");
    }),

    blobCase(BLOB_CASES.longKeys, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const segments = Array.from({ length: 32 }, (_, i) => `segment${String(i).padStart(2, "0")}x`);
      const deep = `${segments.join("/")}/${"z".repeat(BLOB_MAX_KEY - segments.join("/").length - 1)}`;
      const keys = [
        deep,
        "aB".repeat(BLOB_MAX_KEY / 2),
        `${"q".repeat(200)}.`,
        `${"q".repeat(199)}..`,
        `x/${"Y".repeat(300)}/z`,
        "x/!-_.*'()/y",
        "...",
        "a/.../b",
        "_",
        "0",
      ];
      check(deep.length === BLOB_MAX_KEY && keys[1]?.length === BLOB_MAX_KEY, `keys of ${BLOB_MAX_KEY} characters`);
      for (const [i, key] of keys.entries()) await store.put(key, pattern(i + 1, i));
      for (const [i, key] of keys.entries()) await expectValue(store, key, pattern(i + 1, i), undefined, "a long or unusual key");
      expect((await listAll(store, "")).entries, sorted(keys).map((key) => ({ key, size: keys.indexOf(key) + 1 })), "every key listed");
      expect(keysOf((await listAll(store, "x/")).entries), sorted([`x/${"Y".repeat(300)}/z`, "x/!-_.*'()/y"]), "the keys under x/");
      expect(keysOf((await listAll(store, `x/${"Y".repeat(250)}`)).entries), [`x/${"Y".repeat(300)}/z`], "a prefix ending inside a long segment");
    }),

    blobCase(BLOB_CASES.refused, async (s) => {
      const storage = await s.open();
      const store = storage.namespace("conformance");
      const keys = ["", "/a", "a/", "a//b", "./a", "a/.", "a/../b", "..", ".", "a b", "ñ", "a\\b", "a?b", "a#b", "a%2Fb", "a\nb", "x".repeat(BLOB_MAX_KEY + 1)];
      for (const key of keys) {
        await refused(store.put(key, text("x")), "blob_key", `put at ${JSON.stringify(key)}`);
        await refused(store.get(key), "blob_key", `get at ${JSON.stringify(key)}`);
        await refused(store.delete(key), "blob_key", `delete at ${JSON.stringify(key)}`);
      }
      await refused(store.put("k", "text" as unknown as Uint8Array), TypeError, "a value that is a string");
      await refused(store.put("k", [1, 2] as unknown as Uint8Array), TypeError, "a value that is an array");
      await refused(store.put("k", new ArrayBuffer(2) as unknown as Uint8Array), TypeError, "a value that is an ArrayBuffer");
      for (const contentType of ["", " text/plain", "text/plain ", "text/plain\n", "text/plaín", "x".repeat(256)]) {
        await refused(store.put("k", text("x"), { contentType }), TypeError, `the content type ${JSON.stringify(contentType)}`);
      }
      for (const name of ["", ".", "..", "A", "a/b", "a b", "ñ", "../conformance", "x".repeat(101)]) {
        let error: unknown;
        try {
          storage.namespace(name);
        } catch (thrown) {
          error = thrown;
        }
        check((error as { code?: unknown } | undefined)?.code === "blob_key", `the namespace ${JSON.stringify(name)} to be refused with blob_key, not ${describe(error)}`);
      }
      expect(await store.get("k"), undefined, "no value after the refused puts");
      expect((await listAll(store, "")).entries, [], "no key after the refused puts");
      expect((await listAll(storage.namespace("x".repeat(100)), "")).entries, [], "a namespace of 100 characters, empty");
    }),

    blobCase(BLOB_CASES.namespaces, async (s) => {
      const storage = await s.open();
      const a = storage.namespace("a");
      const ab = storage.namespace("ab");
      const other = storage.namespace("a.b-c_d");
      // A provider that joins namespace and key with nothing between them stores these at one place.
      await a.put("bx", text("a's"));
      await ab.put("x", text("ab's"));
      await a.put("b/x", text("a's under b"));
      await other.put("x", text("other's"));
      await expectValue(a, "bx", text("a's"), undefined, "a's key");
      await expectValue(ab, "x", text("ab's"), undefined, "ab's key");
      expect(await a.get("x"), undefined, "a key of another namespace");
      expect(await ab.get("bx"), undefined, "a key of another namespace");
      expect(keysOf((await listAll(a, "")).entries), ["b/x", "bx"], "a's keys only, not those of ab, whose name starts with a's");
      expect(keysOf((await listAll(a, "b")).entries), ["b/x", "bx"], "a's keys under a prefix");
      expect(keysOf((await listAll(ab, "")).entries), ["x"], "ab's keys only");
      await ab.put("bx", text("ab's bx"));
      await ab.delete("bx");
      await expectValue(a, "bx", text("a's"), undefined, "a value another namespace put and deleted under the same key");
      expect(keysOf((await listAll(storage.namespace("b"), "")).entries), [], "a namespace never written");
      expect(keysOf((await listAll(other, "")).entries), ["x"], "the keys of a namespace with every character a name may have");
    }),

    blobCase(BLOB_CASES.order, async (s) => {
      const store = (await s.open()).namespace("conformance");
      // Code-unit order: ! ' ( ) * - . / 0-9 A-Z _ a-z. A directory walk lists a/b before a0 but after a!.
      const keys = ["b", "a0", "a/b/c", "aa", "a_", "a.", "a-", "a*", "a)", "a(", "a'", "a!", "a/b", "a", "aZ", "B", "a/b0", "a/b/c/d"];
      for (const [i, key] of keys.entries()) await store.put(key, pattern(i, i));
      await store.put("a/gone", text("deleted"));
      await store.delete("a/gone");
      const size = (key: string) => keys.indexOf(key);
      expect((await listAll(store, "")).entries, sorted(keys).map((key) => ({ key, size: size(key) })), "every key, in order, with its size");
      expect(keysOf((await listAll(store, "a")).entries), sorted(keys.filter((key) => key.startsWith("a"))), "the keys starting with a");
      expect(keysOf((await listAll(store, "a/")).entries), ["a/b", "a/b/c", "a/b/c/d", "a/b0"], "the keys under a/");
      expect(keysOf((await listAll(store, "a/b")).entries), ["a/b", "a/b/c", "a/b/c/d", "a/b0"], "the keys starting with a/b");
      expect(keysOf((await listAll(store, "a/b/")).entries), ["a/b/c", "a/b/c/d"], "the keys under a/b/");
      expect(keysOf((await listAll(store, "a/b/c/d")).entries), ["a/b/c/d"], "a prefix that is a whole key");
      for (const prefix of ["a/b/c/d/", "c", "A", "ñ", "a b", "%", "a//"]) expect((await listAll(store, prefix)).entries, [], `no key starting with ${JSON.stringify(prefix)}`);
    }),

    blobCase(BLOB_CASES.paging, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const keys = Array.from({ length: 25 }, (_, i) => `p/${String(i).padStart(2, "0")}`);
      for (const key of [...keys].reverse()) await store.put(key, text(key));
      await store.put("q", text("not under p/"));
      for (const limit of [1, 7, 25, 1000]) {
        const { entries, pages } = await listAll(store, "p/", limit);
        expect(keysOf(entries), keys, `every key under p/ once, in order, ${limit} a page`);
        if (limit < keys.length) check(pages.length >= Math.ceil(keys.length / limit), `at least ${Math.ceil(keys.length / limit)} pages of ${limit}`);
      }
      const { entries } = await listAll(store, "", 10);
      expect(keysOf(entries), [...keys, "q"], "every key, ten a page");
    }),

    blobCase(BLOB_CASES.defaultLimit, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const keys = Array.from({ length: BLOB_LIST_LIMIT + 1 }, (_, i) => `k${String(i).padStart(4, "0")}`);
      for (let i = 0; i < keys.length; i += 50) await Promise.all(keys.slice(i, i + 50).map((key) => store.put(key, new Uint8Array(0))));
      for (const limit of [undefined, BLOB_LIST_LIMIT + 1, 100_000]) {
        const { entries, pages } = await listAll(store, "", limit);
        expect(entries.length, keys.length, `every key listed, limit ${String(limit)}`);
        check(keysOf(entries).every((key, i) => key === keys[i]), `every key once, in order, limit ${String(limit)}`);
        check(pages.length >= 2, `${keys.length} keys in two pages or more, limit ${String(limit)}`);
      }
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await refused(store.list("", { limit }), RangeError, `a limit of ${String(limit)}`);
      }
    }),

    blobCase(BLOB_CASES.size, async (s) => {
      const storage = await s.open();
      check(Number.isInteger(storage.maxBytes) && storage.maxBytes >= BLOB_MIN_MAX_BYTES, `maxBytes to be an integer of at least ${BLOB_MIN_MAX_BYTES}, not ${storage.maxBytes}`);
      const store = storage.namespace("conformance");
      const largest = pattern(storage.maxBytes, 5);
      await store.put("largest", largest, { contentType: "application/octet-stream" });
      await expectValue(store, "largest", largest, "application/octet-stream", `a value of maxBytes (${storage.maxBytes})`);
      const larger = new Uint8Array(storage.maxBytes + 1);
      await refused(store.put("larger", larger), "blob_too_large", "a value of maxBytes + 1");
      expect(await store.get("larger"), undefined, "no value after the refused put");
      await refused(store.put("largest", larger), "blob_too_large", "a value of maxBytes + 1 over another");
      expect((await listAll(store, "")).entries, [{ key: "largest", size: storage.maxBytes }], "the value of maxBytes only, as it was");
      const error = await rejection(store.put("larger", larger));
      check(error instanceof BlobTooLargeError && error.size === storage.maxBytes + 1 && error.maxBytes === storage.maxBytes, "a BlobTooLargeError with the size and maxBytes");
    }),

    blobCase(BLOB_CASES.restart, async (s) => {
      const storage = await s.open();
      await storage.namespace("conformance").put("kept/one", text("one"), { contentType: "text/plain" });
      await storage.namespace("conformance").put("kept/two", pattern(300, 2));
      await storage.namespace("other").put("kept/one", text("other's"));
      await s.stopAll();
      const again = await s.open();
      const store = again.namespace("conformance");
      await expectValue(store, "kept/one", text("one"), "text/plain", "a value after a restart");
      await expectValue(store, "kept/two", pattern(300, 2), undefined, "a value with no content type after a restart");
      expect((await listAll(store, "")).entries, [{ key: "kept/one", size: 3 }, { key: "kept/two", size: 300 }], "the listing after a restart");
      await expectValue(again.namespace("other"), "kept/one", text("other's"), undefined, "another namespace after a restart");
    }),

    blobCase(BLOB_CASES.streamBytes, async (s) => {
      const store = (await s.open()).namespace("conformance");
      const empty = await store.putStream("s/empty", chunksOf());
      expect(empty, { size: 0, sha256: sha256Of(new Uint8Array(0)) }, "an empty stream's size and SHA-256");
      await expectValue(store, "s/empty", new Uint8Array(0), undefined, "an empty stream, which is a value");
      const bytes = pattern(3000, 4);
      const backing = new Uint8Array(4000);
      backing.set(bytes, 500);
      const view = backing.subarray(500, 3500);
      // One byte, an empty chunk, views into a larger buffer.
      const stored = await store.putStream("s/k", chunksOf(view.subarray(0, 1), new Uint8Array(0), view.subarray(1, 700), view.subarray(700)), { contentType: "application/gzip", sha256: sha256Of(bytes) });
      expect(stored, { size: 3000, sha256: sha256Of(bytes) }, "the size and SHA-256 putStream resolves with");
      await expectValue(store, "s/k", bytes, "application/gzip", "a stream read back whole");
      await expectStream(store, "s/k", stored, "application/gzip", "a stream read back as a stream");
      // A reused buffer: each chunk is copied as it is read.
      const reused = await store.putStream("s/reused", patternStream(200_000, 9, 4096));
      expect(reused, { size: 200_000, sha256: await patternSha256(200_000, 9) }, "a stream from a reused buffer");
      await expectValue(store, "s/reused", pattern(200_000, 9), undefined, "a stream from a reused buffer, read back");
      // A ReadableStream is a body too.
      await store.putStream("s/readable", new Blob([bytes]).stream());
      await expectValue(store, "s/readable", bytes, undefined, "a ReadableStream's bytes");
      // A value put whole is read as a stream, and replaced by one.
      await store.put("s/whole", bytes, { contentType: "text/plain" });
      await expectStream(store, "s/whole", { size: 3000, sha256: sha256Of(bytes) }, "text/plain", "a value put whole, as a stream");
      await store.putStream("s/whole", chunksOf(text("streamed")));
      await expectValue(store, "s/whole", text("streamed"), undefined, "a stream with no content type over a value with one");
      expect(await store.getStream("s/missing"), undefined, "getStream of a key never put");
      expect((await listAll(store, "s/")).entries, [
        { key: "s/empty", size: 0 },
        { key: "s/k", size: 3000 },
        { key: "s/readable", size: 3000 },
        { key: "s/reused", size: 200_000 },
        { key: "s/whole", size: 8 },
      ], "every stream listed with its size");
      // Refused before anything is read: a key, a body, a content type, a SHA-256; a chunk that is no Uint8Array as it comes.
      await refused(store.putStream("../k", chunksOf(text("x"))), "blob_key", "a stream at a refused key");
      await refused(store.getStream("a//b"), "blob_key", "getStream at a refused key");
      await refused(store.putStream("r", text("x") as unknown as AsyncIterable<Uint8Array>), TypeError, "a body that is bytes, not a stream");
      await refused(store.putStream("r", chunksOf(text("x")), { contentType: " text/plain" }), TypeError, "a stream's content type with a space");
      await refused(store.putStream("r", chunksOf(text("x")), { sha256: "ABC" }), TypeError, "a sha256 that is not 64 lowercase hex");
      await refused(store.putStream("r", chunksOf(text("x"), "y" as unknown as Uint8Array)), TypeError, "a chunk that is a string");
      expect(await store.get("r"), undefined, "no value after the refused streams");
    }),

    blobCase(BLOB_CASES.streamLarge, async (s) => {
      const storage = await s.open();
      const size = storage.maxBytes + 5 * MiB + 3;
      check(Number.isInteger(storage.maxStreamBytes) && storage.maxStreamBytes >= size, `maxStreamBytes of at least ${size} for this case (configure BLOB_CONFORMANCE_STREAM_BYTES), not ${storage.maxStreamBytes}`);
      const store = storage.namespace("conformance");
      const sha256 = await patternSha256(size, 6);
      const stored = await store.putStream("large", patternStream(size, 6), { contentType: "application/gzip" });
      expect(stored, { size, sha256 }, `the size and SHA-256 of a stream of ${size} bytes`);
      expect((await listAll(store, "")).entries, [{ key: "large", size }], "the large value listed with its size");
      await refused(store.get("large"), "blob_too_large", "a whole get of a value larger than maxBytes");
      await expectStream(store, "large", { size, sha256 }, "application/gzip", "a value larger than maxBytes, as a stream");
      await s.stopAll();
      await expectStream((await s.open()).namespace("conformance"), "large", { size, sha256 }, "application/gzip", "a large value after a restart");
    }),

    blobCase(BLOB_CASES.streamInterrupted, async (s) => {
      const storage = await s.open();
      const store = storage.namespace("conformance");
      await store.put("k", text("old"), { contentType: "text/plain" });
      // Past maxBytes before it fails: a provider that uploads in parts has sent several.
      const failing = () => patternStream(storage.maxBytes + 2 * MiB, 7, MiB, { after: storage.maxBytes + MiB, error: new Error("the body failed") });
      check((await rejection(store.putStream("k", failing()))) !== undefined, "a stream that failed partway to reject the put");
      await expectValue(store, "k", text("old"), "text/plain", "the old value after a stream over it failed");
      await expectStream(store, "k", { size: 3, sha256: sha256Of(text("old")) }, "text/plain", "the old value as a stream after a stream over it failed");
      check((await rejection(store.putStream("fresh", failing()))) !== undefined, "a stream that failed partway to a new key to reject the put");
      expect(await store.get("fresh"), undefined, "no value where a stream failed");
      expect(await store.getStream("fresh"), undefined, "no stream where a stream failed");
      expect((await listAll(store, "")).entries, [{ key: "k", size: 3 }], "nothing partial listed");
      // Nothing left over gets in the way of the next put.
      await store.putStream("fresh", chunksOf(text("whole")));
      await expectValue(store, "fresh", text("whole"), undefined, "a stream put where one failed");
    }),

    blobCase(BLOB_CASES.streamChecksum, async (s) => {
      const storage = await s.open();
      const store = storage.namespace("conformance");
      const size = storage.maxBytes + 1;
      const sha256 = await patternSha256(size, 8);
      const wrong = await patternSha256(size, 9);
      await store.put("c", text("old"));
      const error = await rejection(store.putStream("c", patternStream(size, 8), { sha256: wrong }));
      check(error instanceof BlobChecksumError && error.expected === wrong && error.actual === sha256, `a BlobChecksumError with the SHA-256 given and the bytes', not ${describe(error)}`);
      await expectValue(store, "c", text("old"), undefined, "the old value after a stream with another SHA-256");
      await refused(store.putStream("fresh", patternStream(1000, 8), { sha256: wrong }), "blob_checksum", "a small stream with another SHA-256");
      expect((await listAll(store, "")).entries, [{ key: "c", size: 3 }], "nothing stored by the refused streams");
      expect(await store.putStream("c", patternStream(size, 8), { sha256 }), { size, sha256 }, "a stream with its own SHA-256");
      await expectStream(store, "c", { size, sha256 }, undefined, "the stream with its own SHA-256");
    }),

    blobCase(BLOB_CASES.streamSize, async (s) => {
      const storage = await s.open();
      check(Number.isInteger(storage.maxStreamBytes) && storage.maxStreamBytes >= storage.maxBytes, `maxStreamBytes to be an integer of at least maxBytes (${storage.maxBytes}), not ${storage.maxStreamBytes}`);
      const store = storage.namespace("conformance");
      await store.put("big", text("old"));
      const error = await rejection(store.putStream("big", patternStream(storage.maxStreamBytes + 1, 3, 4 * MiB)));
      check(error instanceof BlobTooLargeError && error.maxBytes === storage.maxStreamBytes && error.size > storage.maxStreamBytes, `a BlobTooLargeError naming maxStreamBytes, not ${describe(error)}`);
      await expectValue(store, "big", text("old"), undefined, "the old value after a stream too large");
      await refused(store.putStream("other", patternStream(storage.maxStreamBytes + 1, 3, 4 * MiB)), "blob_too_large", "a stream of maxStreamBytes + 1 to a new key");
      expect((await listAll(store, "")).entries, [{ key: "big", size: 3 }], "nothing stored by the streams too large");
    }),
  ];
}

interface Subject {
  /** Starts a new app over the fixture's storage and returns its `storage.blob`. */
  open(): Promise<BlobStorage>;
  /** Stops every app started so far, as a process that exits. */
  stopAll(): Promise<void>;
}

function createSubject(fixture: BlobFixture, apps: App[]): Subject {
  return {
    async open() {
      let storage: BlobStorage | undefined;
      const consumer = defineComponent({
        name: "storage-blob-conformance",
        setup(pikit) {
          const handle = pikit.use("storage.blob");
          return {
            start() {
              storage = handle.get();
            },
          };
        },
      });
      const app = await defineApp({
        components: [...fixture.components, consumer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger: silentLogger,
      }).create();
      apps.push(app);
      await app.start();
      if (storage === undefined) throw new Error(`${GROUP}: storage.blob was not resolved`);
      return storage;
    },
    async stopAll() {
      for (const app of apps.splice(0)) await app.stop();
    },
  };
}

/**
 * `storage.blob` in memory, for tests: the bytes live as long as the object, so apps started one
 * after the other over it see the same values, as they would over a directory. It checks what every
 * provider checks (`checkBlobPut`, `checkBlobNamespace`, `blobListLimit`) and copies in and out.
 */
export function createMemoryBlobStorage(options: { maxBytes?: number; maxStreamBytes?: number } = {}): BlobStorage {
  const maxBytes = options.maxBytes ?? BLOB_MIN_MAX_BYTES;
  const maxStreamBytes = options.maxStreamBytes ?? BLOB_CONFORMANCE_STREAM_BYTES;
  const namespaces = new Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>();
  return {
    maxBytes,
    maxStreamBytes,
    namespace(name) {
      checkBlobNamespace(name);
      const values = (): Map<string, { bytes: Uint8Array; contentType?: string }> => {
        let map = namespaces.get(name);
        if (map === undefined) namespaces.set(name, (map = new Map()));
        return map;
      };
      return {
        async put(key, bytes, putOptions) {
          checkBlobPut(key, bytes, putOptions?.contentType, maxBytes);
          values().set(key, { bytes: bytes.slice(), ...(putOptions?.contentType !== undefined && { contentType: putOptions.contentType }) });
        },
        async get(key) {
          checkBlobKey(key);
          const value = values().get(key);
          if (value !== undefined && value.bytes.byteLength > maxBytes) throw new BlobTooLargeError(value.bytes.byteLength, maxBytes);
          return value === undefined ? undefined : { bytes: value.bytes.slice(), ...(value.contentType !== undefined && { contentType: value.contentType }) };
        },
        async putStream(key, body, putOptions) {
          checkBlobPutStream(key, body, putOptions);
          const read = blobStreamChunks(body, { maxStreamBytes, ...(putOptions?.sha256 !== undefined && { sha256: putOptions.sha256 }) });
          const chunks: Uint8Array[] = [];
          for await (const chunk of read.chunks) chunks.push(chunk);
          const stored = read.stored();
          const bytes = new Uint8Array(stored.size);
          let at = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.byteLength;
          }
          values().set(key, { bytes, ...(putOptions?.contentType !== undefined && { contentType: putOptions.contentType }) });
          return stored;
        },
        async getStream(key) {
          checkBlobKey(key);
          const value = values().get(key);
          if (value === undefined) return undefined;
          const bytes = value.bytes;
          let at = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (at >= bytes.byteLength) return controller.close();
              controller.enqueue(bytes.slice(at, at + 1024 * 1024));
              at += 1024 * 1024;
            },
          });
          return { body, size: bytes.byteLength, ...(value.contentType !== undefined && { contentType: value.contentType }) };
        },
        async delete(key) {
          checkBlobKey(key);
          values().delete(key);
        },
        async list(prefix, listOptions) {
          const limit = blobListLimit(listOptions?.limit);
          const after = listOptions?.cursor;
          const keys = [...values().keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort();
          const page = keys.slice(0, limit);
          return {
            entries: page.map((key) => ({ key, size: values().get(key)?.bytes.byteLength ?? 0 })),
            ...(keys.length > limit && { cursor: page[page.length - 1] }),
          };
        },
      };
    },
  };
}
