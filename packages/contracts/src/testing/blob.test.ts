/**
 * The `storage.blob` suite against its memory double, which proves the suite asks only what the
 * contract promises; then against broken doubles, each missing one guarantee, which proves the case
 * for that guarantee catches it. `storage-blob-fs` and `storage-blob-s3` are the real providers.
 */

import { expect, test } from "bun:test";
import { defineComponent } from "@pikit/core";
import { BLOB_MIN_MAX_BYTES, type BlobStorage, type BlobStore, checkBlobNamespace } from "../blob.ts";
import { BLOB_CASES, createBlobConformance, createMemoryBlobStorage } from "./blob.ts";

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
const wrap = (storage: BlobStorage, change: (store: BlobStore, name: string) => BlobStore, maxBytes = storage.maxBytes): BlobStorage => ({
  maxBytes,
  namespace: (name) => change(storage.namespace(name), name),
});

const BROKEN: Record<string, { fails: keyof typeof BLOB_CASES; storage: () => () => BlobStorage }> = {
  "shares one namespace among all": {
    fails: "namespaces",
    storage: () => {
      const base = createMemoryBlobStorage();
      return () => ({
        maxBytes: base.maxBytes,
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
        namespace: (name) => {
          checkBlobNamespace(name);
          return {
            put: (key, bytes, options) => flat.put(`${name}${key}`, bytes, options),
            get: (key) => flat.get(`${name}${key}`),
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
};

for (const [broken, { fails, storage }] of Object.entries(BROKEN)) {
  test(`a provider that ${broken} fails "${BLOB_CASES[fails]}"`, async () => {
    const c = createBlobConformance(() => provider(storage())).find((each) => each.name === BLOB_CASES[fails]);
    if (c === undefined) throw new Error(`no case "${BLOB_CASES[fails]}"`);
    await expect(c.run()).rejects.toThrow(SAYS[broken]);
  });
}
