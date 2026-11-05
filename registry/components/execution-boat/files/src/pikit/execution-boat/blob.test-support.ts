/**
 * For execution-boat's tests: the streaming half of `storage.blob` (`putStream`, `getStream`) over a
 * double's whole-value `put` and `get`, as the contract states it (the whole body taken, then stored;
 * its size and SHA-256 answered). The doubles here keep whole values only.
 */

import type { BlobStore } from "@pikit/contracts";

export function withStreams(store: Omit<BlobStore, "putStream" | "getStream">): BlobStore {
  return {
    ...store,
    async putStream(key, body, options) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      await store.put(key, bytes, options?.contentType === undefined ? undefined : { contentType: options.contentType });
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return { size: bytes.byteLength, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
    },
    async getStream(key) {
      const value = await store.get(key);
      return value === undefined ? undefined : { body: new Blob([new Uint8Array(value.bytes)]).stream(), size: value.bytes.byteLength };
    },
  };
}
