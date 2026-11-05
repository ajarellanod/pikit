/**
 * For execution-boat's tests: the streaming half of `storage.blob` (`putStream`, `getStream`) over a
 * double's whole-value `put` and `get`, as the contract states it: the body read through
 * `blobStreamChunks` (past `maxStreamBytes`, a SHA-256 other than the one given, or a body that fails
 * partway refuse it, nothing stored), then stored whole; its size and SHA-256 answered. `get` refuses
 * a value past `maxBytes` (one put as a stream), as the contract says; `getStream` reads any.
 */

import { type BlobStore, blobStreamChunks, BlobTooLargeError } from "@pikit/contracts";

export function withStreams(store: Omit<BlobStore, "putStream" | "getStream">, maxStreamBytes: number, maxBytes = maxStreamBytes): BlobStore {
  return {
    ...store,
    async get(key) {
      const value = await store.get(key);
      if (value !== undefined && value.bytes.byteLength > maxBytes) throw new BlobTooLargeError(value.bytes.byteLength, maxBytes);
      return value;
    },
    async putStream(key, body, options) {
      const read = blobStreamChunks(body, { maxStreamBytes, ...(options?.sha256 !== undefined && { sha256: options.sha256 }) });
      const chunks: Uint8Array[] = [];
      for await (const chunk of read.chunks) chunks.push(chunk);
      await store.put(key, new Uint8Array(Buffer.concat(chunks)), options?.contentType === undefined ? undefined : { contentType: options.contentType });
      return read.stored();
    },
    async getStream(key) {
      const value = await store.get(key);
      return value === undefined ? undefined : { body: new Blob([new Uint8Array(value.bytes)]).stream(), size: value.bytes.byteLength };
    },
  };
}
