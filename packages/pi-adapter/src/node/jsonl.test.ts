/**
 * `createJsonlSessionStore` is Pi's `JsonlSessionRepo` with a default working directory. Pi's own
 * session suites run over it here, with the one JSONL gap pinned (`JSONL_REPO_CONFORMANCE_GAPS`).
 */

import { describe, expect, test } from "bun:test";
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

describe("find: a session's metadata by id, from an index", () => {
  /** Counts the listings, each of which reads every session file. */
  const countLists = (store: JsonlSessionStore): (() => number) => {
    let lists = 0;
    const list = store.list.bind(store);
    store.list = (options, context) => {
      lists++;
      return list(options, context);
    };
    return () => lists;
  };
  const created = async (store: JsonlSessionStore, n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const session = await store.create({}, ctx);
      ids.push(session.metadata.id);
      await session.close(ctx);
    }
    return ids;
  };

  test("a session this store created is found without listing, and opens", async () => {
    const { store, dispose } = fresh();
    const lists = countLists(store);
    const [id] = await created(store, 3);
    const metadata = await store.find(id as string, ctx);
    expect(metadata?.id).toBe(id as string);
    expect(lists()).toBe(0);
    const session = await store.open(metadata as NonNullable<typeof metadata>, ctx);
    expect(session.metadata.id).toBe(id as string);
    await session.close(ctx);
    await dispose();
  });

  test("after a restart, the first miss lists once for every session; concurrent misses share it", async () => {
    const { store, root, dispose } = fresh();
    const ids = await created(store, 5);
    await store.close(ctx);

    const restarted = createJsonlSessionStore({ root: join(root, "sessions"), cwd: root });
    const lists = countLists(restarted);
    const found = await Promise.all(ids.slice(0, 3).map((id) => restarted.find(id, ctx)));
    expect(found.map((m) => m?.id)).toEqual(ids.slice(0, 3));
    expect(lists()).toBe(1);
    expect((await restarted.find(ids[4] as string, ctx))?.id).toBe(ids[4] as string);
    expect(lists()).toBe(1);
    await restarted.close(ctx);
    await dispose();
  });

  test("an id no session has is undefined; a deleted session is forgotten", async () => {
    const { store, dispose } = fresh();
    const [id] = await created(store, 1);
    expect(await store.find("no-such-session", ctx)).toBeUndefined();
    const metadata = (await store.find(id as string, ctx)) as NonNullable<Awaited<ReturnType<typeof store.find>>>;
    await store.delete(metadata, ctx);
    expect(await store.find(id as string, ctx)).toBeUndefined();
    await dispose();
  });
});
