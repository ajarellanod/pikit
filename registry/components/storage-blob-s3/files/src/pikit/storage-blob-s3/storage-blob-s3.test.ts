/**
 * storage-blob-s3's tests. They are copied with the component and keep running in your project. S3 is
 * a fake (`fake-s3.test-support.ts`): one bucket in memory that checks each request's signature as S3
 * does, recomputed from what it received, served on a free port (`Bun.serve`, path-style) or from
 * the global `fetch` (virtual-hosted, where the bucket is in the host name). No test reaches the
 * network or needs real credentials, unless you point the opt-in one at a store: set
 * `PIKIT_S3_TEST_ENDPOINT`, `PIKIT_S3_TEST_BUCKET`, `PIKIT_S3_TEST_REGION`,
 * `PIKIT_S3_TEST_ACCESS_KEY_ID` and `PIKIT_S3_TEST_SECRET_ACCESS_KEY` (a bucket it may fill and empty).
 */

import { afterEach, expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type BlobStorage, type SecretStore } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createBlobConformance } from "@pikit/contracts/testing";
import { createFakeS3, type FakeS3, type FakeS3Options } from "./fake-s3.test-support.ts";
import storageBlobS3, { CONTENT_TYPE_META } from "./index.ts";

const ACCESS_KEY = "AKIAEXAMPLE0BLOB0S3T";
const SECRET_KEY = "blob-test-secret/0123456789+abcdefghijklmn";
const FAKE: FakeS3Options = { bucket: "pikit-blobs", region: "eu-west-1", accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };

/** `secrets` holding `values`. */
function secrets(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}
const KEYS = { S3_ACCESS_KEY_ID: ACCESS_KEY, S3_SECRET_ACCESS_KEY: SECRET_KEY };

/** The fake on a free port, path-style, as MinIO or rustfs is reached. */
function served(options: FakeS3Options = FAKE): { fake: FakeS3; endpoint: string; stop(): Promise<void> } {
  const fake = createFakeS3(options);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => fake.handle(request) });
  return { fake, endpoint: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The fake behind the global `fetch`, for any host: virtual-hosted URLs need no DNS. */
function behindFetch(options: FakeS3Options): FakeS3 {
  const fake = createFakeS3(options);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => fake.handle(new Request(input as string, init))) as typeof fetch;
  return fake;
}

// Path-style over HTTP, every page as large as asked.
for (const c of createBlobConformance(() => {
  const { endpoint, stop } = served();
  return {
    components: [secrets(KEYS), storageBlobS3],
    config: { "storage-blob-s3": { endpoint, region: FAKE.region, bucket: FAKE.bucket } },
    dispose: stop,
  };
})) {
  test(`storage-blob-s3 path-style ${c.group}: ${c.name}`, () => c.run(), 60_000);
}

// Virtual-hosted on AWS's endpoint, under a key prefix, with a session token, pages of at most 3 keys.
for (const c of createBlobConformance(() => {
  behindFetch({ ...FAKE, sessionToken: "session-token", pageSize: 3 });
  return {
    components: [secrets({ ...KEYS, S3_SESSION_TOKEN: "session-token" }), storageBlobS3],
    config: { "storage-blob-s3": { region: FAKE.region, bucket: FAKE.bucket, prefix: "/pikit/test/" } },
  };
})) {
  test(`storage-blob-s3 virtual-hosted ${c.group}: ${c.name}`, () => c.run(), 60_000);
}

for (const c of createLifecycleConformance(() => {
  behindFetch(FAKE);
  return { component: storageBlobS3, providers: [secrets(KEYS)], config: { "storage-blob-s3": { region: FAKE.region, bucket: FAKE.bucket } } };
})) {
  test(`storage-blob-s3 ${c.group}: ${c.name}`, () => c.run());
}

/** An app of storage-blob-s3 with `config` and `values` as its secrets, started, and its `storage.blob`. */
async function started(config: Record<string, unknown>, values: Record<string, string> = KEYS): Promise<{ storage: BlobStorage; stop(): Promise<void> }> {
  let storage: BlobStorage | undefined;
  const user = defineComponent({
    name: "storage-user",
    setup(pikit) {
      const handle = pikit.use("storage.blob");
      return { start: () => void (storage = handle.get()) };
    },
  });
  const app = await defineApp({ components: [secrets(values), storageBlobS3, user], config: { "storage-blob-s3": config }, logger: silentLogger }).create();
  await app.start();
  if (storage === undefined) throw new Error("storage.blob was not resolved");
  return { storage, stop: () => app.stop() };
}

async function startFailure(config: Record<string, unknown>, values: Record<string, string> = KEYS): Promise<string> {
  const error = await started(config, values).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected start() to fail");
  return error.cause instanceof Error ? error.cause.message : error.message;
}

test("the objects in the bucket: the prefix, the namespace, the key encoded once; the content type as metadata", async () => {
  const { fake, endpoint, stop: stopServer } = served();
  const { storage, stop } = await started({ endpoint: `${endpoint}/`, region: FAKE.region, bucket: FAKE.bucket, prefix: "apps/one" });
  await storage.namespace("tool-space-files").put("spaces/s1/it's(1)*!.md", new Uint8Array([1, 2]), { contentType: "text/markdown" });
  await storage.namespace("tool-space-files").put("plain", new Uint8Array([3]));
  expect([...fake.objects.keys()].sort()).toEqual(["apps/one/tool-space-files/plain", "apps/one/tool-space-files/spaces/s1/it's(1)*!.md"].sort());
  expect(fake.objects.get("apps/one/tool-space-files/spaces/s1/it's(1)*!.md")?.headers).toEqual({ "content-type": "text/markdown", [CONTENT_TYPE_META]: "text/markdown" });
  expect(fake.objects.get("apps/one/tool-space-files/plain")?.headers).toEqual({});
  expect(fake.requests[0]).toEqual({ method: "PUT", path: `/${FAKE.bucket}/apps/one/tool-space-files/spaces/s1/it%27s%281%29%2A%21.md`, status: 200 });
  await stop();
  await stopServer();
});

test("a value with no content type does not take the store's default", async () => {
  const fake = behindFetch(FAKE);
  const { storage, stop } = await started({ region: FAKE.region, bucket: FAKE.bucket });
  await storage.namespace("ns").put("k", new Uint8Array([1]));
  expect((await storage.namespace("ns").get("k"))?.contentType).toBeUndefined();
  expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /ns/k", "GET /ns/k"]);
  await stop();
});

test("a wrong secret key is refused by S3, and the error says so without the key", async () => {
  behindFetch(FAKE);
  const { storage, stop } = await started({ region: FAKE.region, bucket: FAKE.bucket }, { ...KEYS, S3_SECRET_ACCESS_KEY: "not-the-key" });
  const error = await storage.namespace("ns").put("k", new Uint8Array([1])).catch((thrown: unknown) => thrown as Error);
  expect(error?.message).toBe('storage-blob-s3: S3 refused the put of "k" (HTTP 403 SignatureDoesNotMatch)');
  expect(error?.message).not.toContain("not-the-key");
  await stop();
});

test("what S3 refuses is an error naming its status and code, for every call", async () => {
  const fake = behindFetch(FAKE);
  const { storage, stop } = await started({ region: FAKE.region, bucket: FAKE.bucket });
  const store = storage.namespace("ns");
  fake.failNext(4, 503, "SlowDown");
  await expect(store.put("k", new Uint8Array([1]))).rejects.toThrow('S3 refused the put of "k" (HTTP 503 SlowDown)');
  await expect(store.get("k")).rejects.toThrow('S3 refused the get of "k" (HTTP 503 SlowDown)');
  await expect(store.delete("k")).rejects.toThrow('S3 refused the delete of "k" (HTTP 503 SlowDown)');
  await expect(store.list("")).rejects.toThrow('S3 refused the list of "" (HTTP 503 SlowDown)');
  await stop();
});

test("a request that takes longer than timeoutMs is cancelled", async () => {
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const { storage, stop } = await started({ region: FAKE.region, bucket: FAKE.bucket, timeoutMs: 50 });
  await expect(storage.namespace("ns").get("k")).rejects.toThrow("storage-blob-s3: GET took longer than 50 ms");
  await stop();
});

test("a refused key or value never reaches the bucket", async () => {
  const fake = behindFetch(FAKE);
  const { storage, stop } = await started({ region: FAKE.region, bucket: FAKE.bucket });
  const store = storage.namespace("ns");
  await expect(store.put("../k", new Uint8Array([1]))).rejects.toThrow("storage.blob");
  await expect(store.put("k", new Uint8Array(storage.maxBytes + 1))).rejects.toThrow("storage.blob");
  await expect(store.put("k", new Uint8Array([1]), { contentType: "a\nb" })).rejects.toThrow("storage.blob");
  expect(fake.requests).toEqual([]);
  await stop();
});

test("used after stop it says so", async () => {
  behindFetch(FAKE);
  const { storage, stop } = await started({ region: FAKE.region, bucket: FAKE.bucket });
  await stop();
  await expect(storage.namespace("ns").get("k")).rejects.toThrow("storage-blob-s3: storage.blob used while the app is not running");
});

test("it refuses to start without its secrets, naming them, or with an endpoint that is not one", async () => {
  expect(await startFailure({ bucket: "b" }, { S3_SECRET_ACCESS_KEY: SECRET_KEY })).toBe("storage-blob-s3: the secret S3_ACCESS_KEY_ID is not set");
  expect(await startFailure({ bucket: "b", secretAccessKeySecret: "R2_SECRET" })).toBe("storage-blob-s3: the secret R2_SECRET is not set");
  expect(await startFailure({ bucket: "../b" })).toBe("storage-blob-s3: the bucket \"../b\" is not a bucket's name (letters, digits, . _ -)");
  expect(await startFailure({ bucket: "b", endpoint: "not a url" })).toBe('storage-blob-s3: the endpoint "not a url" is not a URL');
  expect(await startFailure({ bucket: "b", endpoint: "ftp://example.com" })).toBe("storage-blob-s3: the endpoint ftp://example.com/ is not http or https");
  expect(await startFailure({ bucket: "b", endpoint: "https://key:secret@example.com" })).toContain("has a query, a fragment or credentials");
});

test("a prefix that is not a path of keys' characters is refused when the app is defined", async () => {
  await expect((async () => defineApp({ components: [secrets(KEYS), storageBlobS3], config: { "storage-blob-s3": { bucket: "b", prefix: "a//b" } }, logger: silentLogger }).create())()).rejects.toThrow(
    'storage-blob-s3: the prefix "a//b" is not a path',
  );
});

const real = {
  endpoint: process.env.PIKIT_S3_TEST_ENDPOINT,
  bucket: process.env.PIKIT_S3_TEST_BUCKET,
  region: process.env.PIKIT_S3_TEST_REGION ?? "us-east-1",
  accessKeyId: process.env.PIKIT_S3_TEST_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.PIKIT_S3_TEST_SECRET_ACCESS_KEY ?? "",
};
// Opt-in: a real S3-compatible store (MinIO, rustfs, R2, AWS), each case under a prefix of its own, emptied after.
for (const c of createBlobConformance(() => {
  const prefix = `pikit-conformance/${crypto.randomUUID()}`;
  const config = { endpoint: real.endpoint, region: real.region, bucket: real.bucket, prefix };
  return {
    components: [secrets({ S3_ACCESS_KEY_ID: real.accessKeyId, S3_SECRET_ACCESS_KEY: real.secretAccessKey }), storageBlobS3],
    config: { "storage-blob-s3": config },
    async dispose() {
      const { storage, stop } = await started(config, { S3_ACCESS_KEY_ID: real.accessKeyId, S3_SECRET_ACCESS_KEY: real.secretAccessKey });
      for (const name of ["conformance", "other", "a", "ab", "a.b-c_d", "x".repeat(100)]) {
        const store = storage.namespace(name);
        for (let page = await store.list(""); ; page = await store.list("", { cursor: page.cursor as string })) {
          await Promise.all(page.entries.map((entry) => store.delete(entry.key)));
          if (page.cursor === undefined) break;
        }
      }
      await stop();
    },
  };
})) {
  test.skipIf(real.endpoint === undefined || real.bucket === undefined)(`storage-blob-s3 on ${real.endpoint ?? "a real store"} ${c.group}: ${c.name}`, () => c.run(), 300_000);
}
