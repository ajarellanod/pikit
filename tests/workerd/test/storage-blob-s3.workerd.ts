/**
 * storage-blob-s3 on Cloudflare: the `storage.blob` suite in a real SQLite-backed object's App, each
 * case in an object of its own, its keys Worker secrets read through `secrets-workers` (in the
 * host's env, as `wrangler secret put` leaves them). The bucket is the component's fake S3
 * (`fake-s3.test-support.ts`, which checks every signature as S3 does) behind `globalThis.fetch`: the
 * test and the object share one isolate, so the requests are signed with workerd's Web Crypto and
 * sent through the isolate's `fetch`, as R2's S3 API would be reached.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { BlobStorage } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { BLOB_CONFORMANCE_STREAM_BYTES, createBlobConformance } from "@pikit/contracts/testing";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import { afterEach, expect, it } from "vitest";
import secretsWorkers from "../../../registry/components/secrets-workers/files/src/pikit/secrets-workers/index.ts";
import { createFakeS3, type FakeS3, type FakeS3Options } from "../../../registry/components/storage-blob-s3/files/src/pikit/storage-blob-s3/fake-s3.test-support.ts";
import storageBlobS3 from "../../../registry/components/storage-blob-s3/files/src/pikit/storage-blob-s3/index.ts";
import { inObject, objectHost, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FAKE: FakeS3Options = { bucket: "pikit-blobs", region: "auto", accessKeyId: "r2-access-key-id", secretAccessKey: "r2-secret-access-key", pageSize: 5 };
const SECRETS = { S3_ACCESS_KEY_ID: FAKE.accessKeyId, S3_SECRET_ACCESS_KEY: FAKE.secretAccessKey };
/** As R2's S3 API is configured: its account endpoint, path-style, region `auto`. */
const CONFIG = {
  "storage-blob-s3": { endpoint: "https://account.r2.cloudflarestorage.com", region: "auto", bucket: FAKE.bucket, prefix: "pikit", partBytes: 5 * 1024 * 1024, maxStreamBytes: BLOB_CONFORMANCE_STREAM_BYTES },
};

/** The fake behind the isolate's `fetch`. */
function behindFetch(): FakeS3 {
  const fake = createFakeS3(FAKE);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => fake.handle(new Request(input, init))) as typeof globalThis.fetch;
  return fake;
}

for (const c of createBlobConformance(() => {
  behindFetch();
  return { components: withWorkersHost({ ...objectHost(), env: { ...workerEnv, ...SECRETS } }, [secretsWorkers, storageBlobS3]), config: CONFIG };
})) {
  it(`storage-blob-s3 in an object ${c.group}: ${c.name}`, () => inObject(c), 120_000);
}

it("storage-blob-s3 started as deployment-cloudflare starts an object's App: the objects land under the prefix, signed", () =>
  inObject(async (host) => {
    const fake = behindFetch();
    let storage: BlobStorage | undefined;
    const user = defineComponent({
      name: "storage-user",
      setup(pikit) {
        const handle = pikit.use("storage.blob");
        return { start: () => void (storage = handle.get()) };
      },
    });
    const app = await defineApp({ components: [secretsWorkers, storageBlobS3, user], config: CONFIG, target: "durable", logger: silentLogger }).create();
    await app.start(withContextValue(WORKERS_HOST, { ...host, env: { ...workerEnv, ...SECRETS } }, BACKGROUND_CONTEXT));
    await storage?.namespace("tool-space-files").put("spaces/s1/notes.md", new TextEncoder().encode("# notes"), { contentType: "text/markdown" });
    expect([...fake.objects.keys()]).toEqual(["pikit/tool-space-files/spaces/s1/notes.md"]);
    expect(fake.requests).toEqual([{ method: "PUT", path: "/pikit-blobs/pikit/tool-space-files/spaces/s1/notes.md", status: 200 }]);
    const value = await storage?.namespace("tool-space-files").get("spaces/s1/notes.md");
    expect(new TextDecoder().decode(value?.bytes)).toBe("# notes");
    expect(value?.contentType).toBe("text/markdown");
    await app.stop();
  }));

it("storage-blob-s3 in an object streams a value larger than maxBytes as a multipart upload, and aborts one whose body fails", () =>
  inObject(async (host) => {
    const fake = behindFetch();
    let storage: BlobStorage | undefined;
    const user = defineComponent({
      name: "storage-user",
      setup(pikit) {
        const handle = pikit.use("storage.blob");
        return { start: () => void (storage = handle.get()) };
      },
    });
    const app = await defineApp({ components: [secretsWorkers, storageBlobS3, user], config: CONFIG, target: "durable", logger: silentLogger }).create();
    await app.start(withContextValue(WORKERS_HOST, { ...host, env: { ...workerEnv, ...SECRETS } }, BACKGROUND_CONTEXT));
    const MiB = 1024 * 1024;
    const body = (total: number, failAfter?: number) =>
      (async function* () {
        for (let at = 0; at < total; at += MiB) {
          if (failAfter !== undefined && at >= failAfter) throw new Error("the body failed");
          yield new Uint8Array(Math.min(MiB, total - at)).fill(at / MiB);
        }
      })();
    const store = storage?.namespace("workspace-snapshots");
    const stored = await store?.putStream("a/snapshot.tar.gz", body(27 * MiB + 1), { contentType: "application/gzip" });
    expect(stored?.size).toBe(27 * MiB + 1);
    const methods = fake.requests.map((r) => r.method);
    expect(methods).toEqual(["POST", "PUT", "PUT", "PUT", "PUT", "PUT", "PUT", "POST"]);
    expect(fake.objects.get("pikit/workspace-snapshots/a/snapshot.tar.gz")?.bytes.byteLength).toBe(27 * MiB + 1);
    const streamed = await store?.getStream("a/snapshot.tar.gz");
    let size = 0;
    for await (const chunk of streamed?.body ?? []) size += chunk.byteLength;
    expect(size).toBe(27 * MiB + 1);
    await expect(store?.putStream("b", body(12 * MiB, 11 * MiB))).rejects.toThrow("the body failed");
    expect(fake.requests.at(-1)?.method).toBe("DELETE");
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.has("pikit/workspace-snapshots/b")).toBe(false);
    await app.stop();
  }), 120_000);
