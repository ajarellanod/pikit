/**
 * The `storage.blob` suite against its memory double, which proves the suite asks only what the
 * contract promises; then against broken doubles, each missing one guarantee, which proves the case
 * for that guarantee catches it. `storage-blob-fs` and `storage-blob-s3` are the real providers.
 */

import { expect, test } from "bun:test";
import { defineComponent } from "@pikit/core";
import { BLOB_MIN_MAX_BYTES, type BlobStorage, type BlobStore, blobStreamChunks, checkBlobNamespace, createBlobHash } from "../blob.ts";
import { BLOB_CASES, BLOB_CONFORMANCE_STREAM_BYTES, createBlobConformance, createMemoryBlobStorage } from "./blob.ts";

const provider = (storage: () => BlobStorage) => ({
  components: [defineComponent({ name: "memory-blob", setup: (pikit) => void pikit.provide("storage.blob", storage()) })],
});

// One storage per case, shared by the apps the case starts, as a directory would be.
for (const c of createBlobConformance(() => {
  const storage = createMemoryBlobStorage();
  return provider(() => storage);
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}

/** `storage` with each of its namespaces' stores changed by `change`. */
const wrap = (storage: BlobStorage, change: (store: BlobStore, name: string) => BlobStore, maxBytes = storage.maxBytes, maxStreamBytes = storage.maxStreamBytes): BlobStorage => ({
  maxBytes,
  maxStreamBytes,
  namespace: (name) => change(storage.namespace(name), name),
});

const BROKEN: Record<string, { fails: keyof typeof BLOB_CASES; storage: () => () => BlobStorage }> = {
  "shares one namespace among all": {
    fails: "namespaces",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => ({
        maxBytes: base.maxBytes,
        maxStreamBytes: base.maxStreamBytes,
        namespace: (name) => {
          checkBlobNamespace(name);
          return base.namespace("all");
        },
      });
    },
  },
  "joins a namespace's name and a key with nothing between them": {
    fails: "namespaces",
    storage: () => {
      const base = createMemoryBlobStorage();
      const flat = base.namespace("flat");
      return () => ({
        maxBytes: base.maxBytes,
        maxStreamBytes: base.maxStreamBytes,
        namespace: (name) => {
          checkBlobNamespace(name);
          return {
            put: (key, bytes, options) => flat.put(`${name}${key}`, bytes, options),
            get: (key) => flat.get(`${name}${key}`),
            putStream: (key, body, options) => flat.putStream(`${name}${key}`, body, options),
            getStream: (key) => flat.getStream(`${name}${key}`),
            delete: (key) => flat.delete(`${name}${key}`),
            list: async (prefix, options) => {
              const page = await flat.list(`${name}${prefix}`, options);
              return { ...page, entries: page.entries.map((entry) => ({ ...entry, key: entry.key.slice(name.length) })) };
            },
          };
        },
      });
    },
  },
  "lists a page in reverse": {
    fails: "order",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, list: async (prefix, options) => {
        const page = await store.list(prefix, options);
        return { ...page, entries: [...page.entries].reverse() };
      } }));
    },
  },
  "gives the same array to every get": {
    fails: "copies",
    storage: () => {
      const base = createMemoryBlobStorage();
      const given = new Map<string, Awaited<ReturnType<BlobStore["get"]>>>();
      return () => wrap(base, (store) => ({ ...store, get: async (key) => {
        if (!given.has(key)) given.set(key, await store.get(key));
        return given.get(key);
      } }));
    },
  },
  "reads the bytes after put was called": {
    fails: "copies",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, put: async (key, bytes, options) => {
        await Promise.resolve();
        await store.put(key, bytes, options);
      } }));
    },
  },
  "ignores the limit": {
    fails: "paging",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, list: (prefix, options) => store.list(prefix, { ...(options?.cursor !== undefined && { cursor: options.cursor }) }) }));
    },
  },
  "gives a cursor that starts over": {
    fails: "paging",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, list: async (prefix, options) => {
        const page = await store.list(prefix, { ...(options?.limit !== undefined && { limit: options.limit }) });
        return options?.cursor === undefined ? page : { entries: page.entries.slice(1) };
      } }));
    },
  },
  "drops the content type": {
    fails: "replace",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, put: (key, bytes) => store.put(key, bytes) }));
    },
  },
  "keeps a value larger than the maxBytes it states": {
    fails: "size",
    storage: () => {
      const base = createMemoryBlobStorage({ maxBytes: BLOB_MIN_MAX_BYTES + 10 });
      return () => wrap(base, (store) => store, BLOB_MIN_MAX_BYTES);
    },
  },
  "stores a key the contract refuses, encoded": {
    fails: "refused",
    storage: () => {
      const base = createMemoryBlobStorage();
      const encode = (key: string) => (key === "" ? "empty" : encodeURIComponent(key).replace(/%/g, "_").slice(0, 500).replace(/^\.+|\.+$/g, "d"));
      return () => wrap(base, (store) => ({ ...store, put: (key, bytes, options) => store.put(encode(key), bytes, options) }));
    },
  },
  "forgets everything on a restart": {
    fails: "restart",
    storage: () => () => createMemoryBlobStorage(),
  },
  "replaces a value by appending to it": {
    fails: "replace",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, put: async (key, bytes, options) => {
        const old = await store.get(key);
        const joined = new Uint8Array((old?.bytes.byteLength ?? 0) + bytes.byteLength);
        if (old !== undefined) joined.set(old.bytes);
        joined.set(bytes, old?.bytes.byteLength ?? 0);
        await store.put(key, joined, options);
      } }));
    },
  },
  "clears the old value before a stream arrived": {
    fails: "streamInterrupted",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, putStream: async (key, body, options) => {
        await store.delete(key);
        return await store.putStream(key, body, options);
      } }));
    },
  },
  "ignores the SHA-256 it is given": {
    fails: "streamChecksum",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, putStream: (key, body, options) => store.putStream(key, body, options?.contentType === undefined ? {} : { contentType: options.contentType }) }));
    },
  },
  "takes a stream larger than the maxStreamBytes it states": {
    fails: "streamSize",
    storage: () => {
      const base = createMemoryBlobStorage({ maxStreamBytes: BLOB_CONFORMANCE_STREAM_BYTES + 10 });
      return () => wrap(base, (store) => store, base.maxBytes, BLOB_CONFORMANCE_STREAM_BYTES);
    },
  },
  "gives a value larger than maxBytes to a whole get": {
    fails: "streamLarge",
    storage: () => {
      const base = createMemoryBlobStorage({ maxBytes: 2 * BLOB_CONFORMANCE_STREAM_BYTES });
      return () => wrap(base, (store) => store, BLOB_MIN_MAX_BYTES, BLOB_CONFORMANCE_STREAM_BYTES);
    },
  },
  "resolves a stream with the SHA-256 of nothing": {
    fails: "streamBytes",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => wrap(base, (store) => ({ ...store, putStream: async (key, body, options) => ({ ...(await store.putStream(key, body, options)), sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }) }));
    },
  },
};

/** What the case says about each broken provider: it fails for the guarantee it breaks, not by accident. */
const SAYS: Record<string, string> = {
  "shares one namespace among all": "ab's key: the 4 bytes put at \"x\", not 7 other ones",
  "joins a namespace's name and a key with nothing between them": "a's key: the 3 bytes put at \"bx\", not 4 other ones",
  "lists a page in reverse": "every key, in order, with its size",
  "gives the same array to every get": "the value after changing what get gave",
  "reads the bytes after put was called": "the value as it was when put was called",
  "ignores the limit": "a page of at most 1 keys, not 25",
  "gives a cursor that starts over": "every key under p/ once, in order, 1 a page",
  "drops the content type": "the content type at \"k\": expected \"Application/X-Tar; note=\\\"A b\\\"\", got undefined",
  "keeps a value larger than the maxBytes it states": "a value of maxBytes + 1 to be refused with blob_too_large, not resolving",
  "stores a key the contract refuses, encoded": "to be refused with blob_key, not resolving",
  "forgets everything on a restart": "a value after a restart: a value at \"kept/one\"",
  "replaces a value by appending to it": "the 14 bytes put at \"k\", not 19 other ones",
  "clears the old value before a stream arrived": "the old value after a stream over it failed: a value at \"k\"",
  "ignores the SHA-256 it is given": "a BlobChecksumError with the SHA-256 given and the bytes', not resolving",
  "takes a stream larger than the maxStreamBytes it states": "a BlobTooLargeError naming maxStreamBytes, not resolving",
  "gives a value larger than maxBytes to a whole get": "a whole get of a value larger than maxBytes to be refused with blob_too_large, not resolving",
  "resolves a stream with the SHA-256 of nothing": "the size and SHA-256 putStream resolves with",
};

for (const [broken, { fails, storage }] of Object.entries(BROKEN)) {
  test(`a provider that ${broken} fails "${BLOB_CASES[fails]}"`, async () => {
    const c = createBlobConformance(() => provider(storage())).find((each) => each.name === BLOB_CASES[fails]);
    if (c === undefined) throw new Error(`no case "${BLOB_CASES[fails]}"`);
    await expect(c.run()).rejects.toThrow(SAYS[broken]);
  });
}

test("createBlobHash is SHA-256: FIPS 180-4's examples, and node:crypto's digest over chunks of every split", async () => {
  const { createHash } = await import("node:crypto");
  const digest = (...chunks: Uint8Array[]) => {
    const hash = createBlobHash();
    for (const chunk of chunks) hash.update(chunk);
    return hash.digest();
  };
  const ascii = (text: string) => new TextEncoder().encode(text);
  expect(digest()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(digest(ascii("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(digest(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  expect(digest(new Uint8Array(1_000_000).fill(0x61))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  const bytes = new Uint8Array(300);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 151 + 7) & 0xff;
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 300]) {
    const value = bytes.subarray(0, size);
    const expected = createHash("sha256").update(value).digest("hex");
    for (const split of [0, 1, 17, 63, 64, 65, size]) {
      const at = Math.min(split, size);
      expect(digest(value.subarray(0, at), value.subarray(at))).toBe(expected);
    }
  }
});

test("blobStreamChunks copies, counts, hashes and refuses; its result only once the body ended", async () => {
  const read = blobStreamChunks((async function* () {
    const buffer = new Uint8Array([1, 2, 3]);
    yield buffer;
    buffer.fill(9);
    yield new Uint8Array(0);
  })(), { maxStreamBytes: 10 });
  expect(() => read.stored()).toThrow("before it ended");
  const got: number[][] = [];
  for await (const chunk of read.chunks) got.push([...chunk]);
  expect(got).toEqual([[1, 2, 3]]);
  expect(read.stored()).toEqual({ size: 3, sha256: createHash3([1, 2, 3]) });
});

function createHash3(bytes: number[]): string {
  const hash = createBlobHash();
  hash.update(new Uint8Array(bytes));
  return hash.digest();
}
