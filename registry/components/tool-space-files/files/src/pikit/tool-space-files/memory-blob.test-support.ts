/**
 * An in-memory `storage.blob` for tool-space-files' tests (and the workerd lane's): the contract
 * (`@pikit/contracts`' `blob.ts`) as it states it. Keys checked (`checkBlobKey`), a value larger than
 * `maxBytes` refused (`BlobTooLargeError`), bytes copied in and out, namespaces apart, `list` by prefix in
 * code-unit order a page at a time. Not a provider: nothing survives the process.
 */

import { defineComponent } from "@pikit/core";
import { BLOB_MIN_MAX_BYTES, type BlobPage, type BlobStorage, type BlobStore, BlobTooLargeError, checkBlobKey } from "@pikit/contracts";

const PAGE_MAX = 1000;

/** What the double keeps: namespace → key → value. Shared by every `namespace` call of one double. */
export type MemoryBlobData = Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>;

export function createMemoryBlobStorage(options: { maxBytes?: number; data?: MemoryBlobData } = {}): BlobStorage & { data: MemoryBlobData } {
  const maxBytes = options.maxBytes ?? BLOB_MIN_MAX_BYTES;
  const data: MemoryBlobData = options.data ?? new Map();
  const values = (name: string) => {
    let kept = data.get(name);
    if (kept === undefined) data.set(name, (kept = new Map()));
    return kept;
  };
  return {
    maxBytes,
    data,
    namespace(name: string): BlobStore {
      return {
        async put(key, bytes, put) {
          checkBlobKey(key);
          if (bytes.byteLength > maxBytes) throw new BlobTooLargeError(bytes.byteLength, maxBytes);
          values(name).set(key, { bytes: bytes.slice(), ...(put?.contentType !== undefined && { contentType: put.contentType }) });
        },
        async get(key) {
          checkBlobKey(key);
          const value = values(name).get(key);
          return value === undefined ? undefined : { bytes: value.bytes.slice(), ...(value.contentType !== undefined && { contentType: value.contentType }) };
        },
        async delete(key) {
          checkBlobKey(key);
          values(name).delete(key);
        },
        async list(prefix, list): Promise<BlobPage> {
          const limit = Math.min(Math.max(list?.limit ?? PAGE_MAX, 1), PAGE_MAX);
          const keys = [...values(name).keys()].filter((key) => key.startsWith(prefix) && (list?.cursor === undefined || key > list.cursor)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const page = keys.slice(0, limit);
          const entries = page.map((key) => ({ key, size: values(name).get(key)?.bytes.byteLength ?? 0 }));
          const last = page.at(-1);
          return keys.length > limit && last !== undefined ? { entries, cursor: last } : { entries };
        },
      };
    },
  };
}

/** The double as a component providing `storage.blob`. */
export const memoryBlob = (storage: BlobStorage = createMemoryBlobStorage()) =>
  defineComponent({ name: "storage-blob-test", setup: (pikit) => pikit.provide("storage.blob", storage) });
