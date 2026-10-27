/**
 * storage-blob-fs's tests. They are copied with the component and keep running in your project.
 * Every root is a temporary directory.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { BlobStorage } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createBlobConformance } from "@pikit/contracts/testing";
import storageBlobFs, { fileNames, HEADER_BYTES } from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory, and the root inside it (not created). */
function temporaryRoot(): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), "pikit-storage-blob-fs-"));
  directories.push(parent);
  return { parent, root: join(parent, "blobs") };
}

const configFor = (root: string) => ({ "storage-blob-fs": { root } });

for (const c of createBlobConformance(() => ({ components: [storageBlobFs], config: configFor(temporaryRoot().root) }))) {
  test(`storage-blob-fs ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

// Start and stop honour their deadline, and a fresh app over the same root starts again.
const lifecycleRoot = temporaryRoot().root;
for (const c of createLifecycleConformance(() => ({ component: storageBlobFs, config: configFor(lifecycleRoot) }))) {
  test(`storage-blob-fs ${c.group}: ${c.name}`, () => c.run());
}

/** An app of storage-blob-fs over `root`, started, and its `storage.blob`. */
async function started(root: string): Promise<{ storage: BlobStorage; stop(): Promise<void> }> {
  let storage: BlobStorage | undefined;
  const user = defineComponent({
    name: "storage-user",
    setup(pikit) {
      const handle = pikit.use("storage.blob");
      return { start: () => void (storage = handle.get()) };
    },
  });
  const app = await defineApp({ components: [storageBlobFs, user], config: configFor(root), logger: silentLogger }).create();
  await app.start();
  if (storage === undefined) throw new Error("storage.blob was not resolved");
  return { storage, stop: () => app.stop() };
}

/** Every path under `dir`, relative, sorted. */
const tree = (dir: string): string[] => (readdirSync(dir, { recursive: true }) as string[]).sort();

test("the layout: a directory per namespace and per segment, upper case escaped, the content type in a header", async () => {
  const { root } = temporaryRoot();
  const { storage, stop } = await started(root);
  const store = storage.namespace("tool-space-files");
  await store.put("spaces/s1/README", new Uint8Array([1, 2, 3]), { contentType: "text/markdown" });
  await store.put("spaces/s1/readme", new Uint8Array([4]));
  await store.put("spaces", new Uint8Array([5]));
  expect(tree(join(root, "tool-space-files"))).toEqual(["spaces", "spaces~", "spaces~/s1~", "spaces~/s1~/^r^e^a^d^m^e", "spaces~/s1~/readme"]);
  const file = readFileSync(join(root, "tool-space-files", "spaces~", "s1~", "^r^e^a^d^m^e"));
  expect(file.byteLength).toBe(HEADER_BYTES + 3);
  expect(file[0]).toBe("text/markdown".length);
  expect(file.subarray(1, 14).toString()).toBe("text/markdown");
  expect([...file.subarray(HEADER_BYTES)]).toEqual([1, 2, 3]);
  await stop();
});

test("a segment longer than one name is cut in pieces, none of them . or ..", () => {
  expect(fileNames(`${"q".repeat(200)}.`)).toEqual([`${"q".repeat(199)}+`, "q."]);
  expect(fileNames(`${"q".repeat(199)}..`)).toEqual([`${"q".repeat(198)}+`, "q.."]);
  expect(fileNames(`a/${"B".repeat(150)}/c`)).toEqual(["a~", `${"^b".repeat(100)}+`, `${"^b".repeat(50)}~`, "c"]);
  for (const names of [fileNames("aB".repeat(256)), fileNames(`x/${"Y".repeat(300)}/z`)]) {
    for (const name of names) expect(name.length).toBeLessThanOrEqual(201);
  }
});

test("deleting the last key under a directory removes the directories it emptied, not the namespace's", async () => {
  const { root } = temporaryRoot();
  const { storage, stop } = await started(root);
  const store = storage.namespace("ns");
  await store.put("a/b/c", new Uint8Array([1]));
  await store.put("a/d", new Uint8Array([2]));
  await store.delete("a/b/c");
  expect(tree(join(root, "ns"))).toEqual(["a~", "a~/d"]);
  await store.delete("a/d");
  expect(tree(join(root, "ns"))).toEqual([]);
  expect(existsSync(join(root, "ns"))).toBe(true);
  await stop();
});

test("puts and deletes racing in one directory all land", async () => {
  const { root } = temporaryRoot();
  const { storage, stop } = await started(root);
  const store = storage.namespace("ns");
  for (let round = 0; round < 50; round++) {
    await store.put("d/old", new Uint8Array([round]));
    await Promise.all([store.delete("d/old"), store.put("d/new", new Uint8Array([round]))]);
    expect((await store.get("d/new"))?.bytes).toEqual(new Uint8Array([round]));
    await store.delete("d/new");
  }
  expect(tree(join(root, "ns"))).toEqual([]);
  await stop();
});

test("what it did not write is never listed: temporary files, stray files, links out of the root", async () => {
  const { parent, root } = temporaryRoot();
  const { storage, stop } = await started(root);
  const store = storage.namespace("ns");
  await store.put("kept", new Uint8Array([1]));
  const outside = join(parent, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret"), "x".repeat(HEADER_BYTES + 1));
  symlinkSync(outside, join(root, "ns", "link~"));
  symlinkSync(join(outside, "secret"), join(root, "ns", "file"));
  writeFileSync(join(root, "ns", "#leftover"), "a crash's temporary file");
  writeFileSync(join(root, "ns", ".DS_Store"), "Finder's");
  mkdirSync(join(root, "ns", "plain-dir"));
  writeFileSync(join(root, "ns", "plain-dir", "x"), "x".repeat(HEADER_BYTES));
  expect((await store.list("")).entries).toEqual([{ key: "kept", size: 1 }]);
  await stop();
});

test("refused keys and namespaces touch nothing: the root holds only what was put", async () => {
  const { parent, root } = temporaryRoot();
  const { storage, stop } = await started(root);
  const store = storage.namespace("ns");
  for (const key of ["../escape", "a/../../escape", "/etc/passwd", "..", "a\\..\\b"]) {
    await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow("storage.blob");
    await expect(store.delete(key)).rejects.toThrow("storage.blob");
  }
  for (const name of ["..", "../escape", "/tmp", "a/b"]) expect(() => storage.namespace(name)).toThrow("storage.blob");
  expect(tree(parent)).toEqual(["blobs"]);
  await stop();
});

test("used after stop it says so", async () => {
  const { root } = temporaryRoot();
  const { storage, stop } = await started(root);
  await stop();
  await expect(storage.namespace("ns").get("k")).rejects.toThrow("storage-blob-fs: storage.blob used while the app is not running");
});

test("a root it cannot create fails the start, naming it", async () => {
  const { parent } = temporaryRoot();
  writeFileSync(join(parent, "file"), "a file where the root must go");
  const app = await defineApp({ components: [storageBlobFs], config: configFor(join(parent, "file")), logger: silentLogger }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(((error as Error).cause as Error).message).toContain(`storage-blob-fs: cannot keep values in ${join(parent, "file")}`);
});

test("maxBytes below the contract's 25 MiB is refused by the config", async () => {
  await expect((async () => defineApp({ components: [storageBlobFs], config: { "storage-blob-fs": { maxBytes: 1024 } }, logger: silentLogger }).create())()).rejects.toThrow("maxBytes");
});
