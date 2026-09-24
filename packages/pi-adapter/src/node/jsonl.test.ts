/**
 * `createJsonlSessionStore` is Pi's `JsonlSessionRepo` with a default working directory. Pi's own
 * session suites run over it here, with the one JSONL gap pinned (`JSONL_REPO_CONFORMANCE_GAPS`).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createSessionRepoConformance, createStorageConformance, JSONL_REPO_CONFORMANCE_GAPS, storageOf } from "../testing/index.ts";
import { createJsonlSessionStore, type JsonlSessionStore } from "./index.ts";

const ctx = BACKGROUND_CONTEXT;

function fresh(): { store: JsonlSessionStore; root: string; dispose(): Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "pikit-jsonl-"));
  const store = createJsonlSessionStore({ root: join(dir, "sessions"), cwd: dir });
  return {
    store,
    root: dir,
    async dispose() {
      await store.close(ctx);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a session created without a cwd records the store's, and reopens from its file", async () => {
  const { store, root, dispose } = fresh();
  const session = await store.create({}, ctx);
  await session.setName("kept", ctx);
  await session.close(ctx);

  const [metadata] = await store.list(undefined, ctx);
  const reopened = await store.open(metadata, ctx);

  expect(session.metadata.cwd).toBe(root);
  expect(await reopened.getName(ctx)).toBe("kept");
  await reopened.close(ctx);
  await dispose();
});

let current: ReturnType<typeof fresh> | undefined;
for (const c of createSessionRepoConformance(
  async () => {
    current = fresh();
    return current.store;
  },
  async () => current?.dispose(),
)) {
  (JSONL_REPO_CONFORMANCE_GAPS.includes(c.name) ? test.failing : test)(`JSONL ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createStorageConformance(async () => {
  const { store, dispose } = fresh();
  const session = await store.create({}, ctx);
  return {
    storage: storageOf(session),
    [Symbol.asyncDispose]: async () => {
      await session.close(ctx);
      await dispose();
    },
  };
})) {
  test(`JSONL storage ${c.group}: ${c.name}`, () => c.run());
}
