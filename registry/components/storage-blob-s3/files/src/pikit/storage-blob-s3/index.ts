/**
 * storage-blob-s3: `storage.blob` (@pikit/contracts' blob.ts) in an S3-compatible bucket: AWS S3,
 * Cloudflare R2's S3 API, the bucket a celld fleet already has, MinIO, rustfs.
 *
 * - **Plain `fetch`, signed with Signature Version 4** over Web Crypto (`sigv4.ts`, checked against
 *   AWS's examples): no AWS SDK, no Node API, so the same file runs on a server and in a Durable
 *   Object. The keys are read through `secrets` at start, by the names the config gives
 *   (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, the optional `S3_SESSION_TOKEN`); only signatures
 *   made with them are sent.
 * - **A namespace is a key prefix**: the value at `key` in the namespace `name` is the object
 *   `<prefix><name>/<key>`, `prefix` from the config (`""`, or a path ending in `/`). The `/` after
 *   the name keeps a namespace from seeing one whose name starts with its own.
 * - **`put` is one `PutObject`**: S3 replaces an object whole, and a later `GET` sees it. The content
 *   type is sent as the object's `Content-Type` and kept as its metadata (`x-amz-meta-pikit-content-type`),
 *   which `get` reads back: the store's own default (`binary/octet-stream`) is never taken for one that
 *   was put.
 * - **`get` of a missing key** is S3's 404 (`NoSuchKey`). The credentials need `s3:ListBucket` too: AWS
 *   answers a missing key with 403 to a key that may not list.
 * - **`list` is `ListObjectsV2`** under the namespace's prefix, in S3's order (the keys' UTF-8 bytes,
 *   code-unit order for the contract's ASCII keys), its continuation token the cursor. A page may hold
 *   fewer keys than asked, as the contract allows; an object under the prefix that is not a key of the
 *   contract (written by something else) is skipped.
 * - **What fails is said**: an answer other than 2xx (or 404 on `get` / `delete`) rejects with S3's
 *   status and error code, a request that takes longer than `timeoutMs` is cancelled. Nothing is
 *   retried here: the caller decides. A key, a value or a content type the contract refuses is refused
 *   before any request.
 * - Values are sent and read whole, in memory (`maxBytes`, 25 MiB by default): one `PutObject`, no
 *   multipart upload, no streaming.
 *
 * Targets: `server` and `durable`: it uses only `secrets`, `fetch` and Web Crypto.
 */

import { defineComponent } from "@pikit/core";
import {
  BLOB_MIN_MAX_BYTES,
  type BlobEntry,
  type BlobStorage,
  type BlobStore,
  blobKeyProblem,
  blobListLimit,
  checkBlobKey,
  checkBlobNamespace,
  checkBlobPut,
} from "@pikit/contracts";
import Type from "typebox";
import { type AwsCredentials, sha256Hex, signS3, uriEncode } from "./sigv4.ts";

export { type AwsCredentials, type S3SignableRequest, sha256Hex, signS3, uriEncode } from "./sigv4.ts";

/** The metadata header the content type is kept in. */
export const CONTENT_TYPE_META = "x-amz-meta-pikit-content-type";

const Config = Type.Object({
  /** The store's endpoint (`https://<account>.r2.cloudflarestorage.com`, `http://127.0.0.1:9000`); absent, AWS S3's in `region`. */
  endpoint: Type.Optional(Type.String({ minLength: 1 })),
  /** The region signatures are made for: AWS's (`eu-west-1`), `auto` for R2, what MinIO or rustfs is set to. */
  region: Type.String({ minLength: 1, default: "us-east-1" }),
  /** The bucket. */
  bucket: Type.String({ minLength: 1 }),
  /** A prefix for every key in the bucket (`pikit/` to share it); `""` for none. */
  prefix: Type.String({ default: "" }),
  /** The bucket in the path (`<endpoint>/<bucket>/<key>`), not in the host. Absent: path-style with an `endpoint`, virtual-hosted on AWS. */
  pathStyle: Type.Optional(Type.Boolean()),
  /** The name of the secret holding the access key id, not the key: config is never a secret. */
  accessKeyIdSecret: Type.String({ minLength: 1, default: "S3_ACCESS_KEY_ID" }),
  /** The name of the secret holding the secret access key. */
  secretAccessKeySecret: Type.String({ minLength: 1, default: "S3_SECRET_ACCESS_KEY" }),
  /** The name of the secret holding a session token (temporary credentials), read when it is set. */
  sessionTokenSecret: Type.String({ minLength: 1, default: "S3_SESSION_TOKEN" }),
  /** The largest value it keeps, in bytes: at least 25 MiB. Values are held whole in memory. */
  maxBytes: Type.Integer({ minimum: BLOB_MIN_MAX_BYTES, default: BLOB_MIN_MAX_BYTES }),
  /** How long one request may take, its body included, in milliseconds. */
  timeoutMs: Type.Integer({ minimum: 1, default: 60_000 }),
});

/** Where and as whom it talks to the bucket, from start to stop. */
interface Bucket {
  /** The URL of the object `key` (a full key, prefix and namespace included), or of the bucket with none. */
  url(key?: string): string;
  region: string;
  credentials: AwsCredentials;
}

/** What a prefix in the config may be: the contract's key, slashes at its ends trimmed. */
function normalizedPrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  const problem = blobKeyProblem(trimmed);
  if (problem !== undefined || trimmed.length > 300) throw new Error(`storage-blob-s3: the prefix ${JSON.stringify(prefix)} is not a path of keys' characters of at most 300 (${problem ?? "too long"})`);
  return `${trimmed}/`;
}

export default defineComponent({
  name: "storage-blob-s3",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const prefix = normalizedPrefix(config.prefix);
    let bucket: Bucket | undefined;
    const live = (): Bucket => {
      if (bucket === undefined) throw new Error("storage-blob-s3: storage.blob used while the app is not running");
      return bucket;
    };

    /** Sends a signed request; the response's body is read by `read` before the timeout is cleared. */
    const send = async <T>(method: string, url: string, read: (response: Response) => Promise<T>, init: { body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {}): Promise<T> => {
      const target = live();
      const body = init.body ?? new Uint8Array(0);
      const headers = await signS3({ method, url, headers: init.headers ?? {}, payloadHash: await sha256Hex(body), region: target.region, credentials: target.credentials, date: new Date() });
      // A timer cleared once the answer came, not `AbortSignal.timeout`: a pending timer keeps a Durable Object from being evicted.
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
      try {
        const response = await fetch(url, { method, headers, ...(method === "PUT" && { body }), signal: timeout.signal });
        return await read(response);
      } catch (error) {
        if (timeout.signal.aborted) throw new Error(`storage-blob-s3: ${method} took longer than ${config.timeoutMs} ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    const refused = async (response: Response, what: string): Promise<Error> => {
      const text = await response.text().catch(() => "");
      const code = /<Code>([^<]{1,100})<\/Code>/.exec(text)?.[1];
      return new Error(`storage-blob-s3: S3 refused ${what} (HTTP ${response.status}${code === undefined ? "" : ` ${code}`})`);
    };

    const store = (name: string): BlobStore => {
      const base = `${prefix}${name}/`;
      return {
        async put(key, bytes, options) {
          const contentType = options?.contentType;
          checkBlobPut(key, bytes, contentType, config.maxBytes);
          // A copy before anything is awaited: the caller may change its array.
          const body = new Uint8Array(bytes);
          const headers: Record<string, string> = contentType === undefined ? {} : { "content-type": contentType, [CONTENT_TYPE_META]: contentType };
          await send("PUT", live().url(`${base}${key}`), async (response) => {
            if (!response.ok) throw await refused(response, `the put of ${JSON.stringify(key)}`);
            await response.body?.cancel();
          }, { body, headers });
        },

        async get(key) {
          checkBlobKey(key);
          return await send("GET", live().url(`${base}${key}`), async (response) => {
            if (response.status === 404) {
              await response.body?.cancel();
              return undefined;
            }
            if (!response.ok) throw await refused(response, `the get of ${JSON.stringify(key)}`);
            const contentType = response.headers.get(CONTENT_TYPE_META) ?? undefined;
            return { bytes: new Uint8Array(await response.arrayBuffer()), ...(contentType !== undefined && { contentType }) };
          });
        },

        async delete(key) {
          checkBlobKey(key);
          await send("DELETE", live().url(`${base}${key}`), async (response) => {
            if (!response.ok && response.status !== 404) throw await refused(response, `the delete of ${JSON.stringify(key)}`);
            await response.body?.cancel();
          });
        },

        async list(listPrefix, options) {
          const limit = blobListLimit(options?.limit);
          if (typeof listPrefix !== "string") throw new TypeError("storage-blob-s3: a list's prefix is a string");
          const params = new URLSearchParams({ "list-type": "2", prefix: `${base}${listPrefix}`, "max-keys": String(limit) });
          if (options?.cursor !== undefined) params.set("continuation-token", options.cursor);
          // `URLSearchParams` writes a space as `+`, which a store may read as a plus: `%20` is unambiguous.
          const xml = await send("GET", `${live().url()}?${params.toString().replace(/\+/g, "%20")}`, async (response) => {
            if (!response.ok) throw await refused(response, `the list of ${JSON.stringify(listPrefix)}`);
            return await response.text();
          });
          const entries: BlobEntry[] = [];
          for (const [, contents] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
            const full = xmlText(contents as string, "Key");
            const size = Number(xmlText(contents as string, "Size"));
            if (full === undefined || !full.startsWith(base) || !Number.isSafeInteger(size)) continue;
            const key = full.slice(base.length);
            if (blobKeyProblem(key) === undefined) entries.push({ key, size });
          }
          const cursor = xmlText(xml, "IsTruncated") === "true" ? xmlText(xml, "NextContinuationToken") : undefined;
          return { entries, ...(cursor !== undefined && cursor !== "" && { cursor }) };
        },
      };
    };

    const storage: BlobStorage = {
      maxBytes: config.maxBytes,
      namespace(name) {
        checkBlobNamespace(name);
        return store(name);
      },
    };
    pikit.provide("storage.blob", storage);

    return {
      async start() {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.bucket)) throw new Error(`storage-blob-s3: the bucket ${JSON.stringify(config.bucket)} is not a bucket's name (letters, digits, . _ -)`);
        const read = async (name: string): Promise<string | undefined> => {
          const value = (await secrets.get().get(name))?.trim();
          return value === undefined || value === "" ? undefined : value;
        };
        const accessKeyId = await read(config.accessKeyIdSecret);
        if (accessKeyId === undefined) throw new Error(`storage-blob-s3: the secret ${config.accessKeyIdSecret} is not set`);
        const secretAccessKey = await read(config.secretAccessKeySecret);
        if (secretAccessKey === undefined) throw new Error(`storage-blob-s3: the secret ${config.secretAccessKeySecret} is not set`);
        const sessionToken = await read(config.sessionTokenSecret);
        let endpoint: URL;
        try {
          endpoint = new URL(config.endpoint ?? `https://s3.${config.region}.amazonaws.com`);
        } catch {
          throw new Error(`storage-blob-s3: the endpoint ${JSON.stringify(config.endpoint)} is not a URL`);
        }
        if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error(`storage-blob-s3: the endpoint ${endpoint.href} is not http or https`);
        if (endpoint.search !== "" || endpoint.hash !== "" || endpoint.username !== "" || endpoint.password !== "") throw new Error(`storage-blob-s3: the endpoint ${endpoint.origin} has a query, a fragment or credentials: give its origin and path only`);
        const pathStyle = config.pathStyle ?? config.endpoint !== undefined;
        const root = endpoint.pathname.replace(/\/+$/, "");
        const objectPath = (key: string | undefined) => (key === undefined ? "" : `/${key.split("/").map(uriEncode).join("/")}`);
        bucket = {
          url: pathStyle
            ? (key) => `${endpoint.origin}${root}/${uriEncode(config.bucket)}${objectPath(key)}`
            : (key) => `${endpoint.protocol}//${config.bucket}.${endpoint.host}${root}${objectPath(key) || "/"}`,
          region: config.region,
          credentials: { accessKeyId, secretAccessKey, ...(sessionToken !== undefined && { sessionToken }) },
        };
      },
      stop() {
        bucket = undefined;
      },
    };
  },
});

/** The text of the first `<tag>` in `xml`, its entities decoded. */
function xmlText(xml: string, tag: string): string | undefined {
  const text = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
  return text?.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[entity] as string;
  });
}
