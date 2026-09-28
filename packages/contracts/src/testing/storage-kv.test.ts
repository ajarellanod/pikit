/**
 * The `storage.kv` suite against the memory storage the other tests use. It proves the suite asks
 * only what the contract promises (S12); `storage-kv-sql` is the real component.
 */

import { test } from "bun:test";
import { defineComponent } from "@pikit/core";
import { createKeyValueConformance, createMemoryKeyValueStorage } from "./storage-kv.ts";

for (const c of createKeyValueConformance(() => {
  // One storage per case, shared by the apps the case starts, as a file would be.
  const storage = createMemoryKeyValueStorage();
  return { components: [defineComponent({ name: "memory-kv", setup: (pikit) => void pikit.provide("storage.kv", storage) })] };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
