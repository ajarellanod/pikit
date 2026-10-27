# storage-blob-s3

`storage.blob` in an S3-compatible bucket: AWS S3, Cloudflare R2's S3 API, the bucket a celld fleet
already has, MinIO, rustfs. What components keep by key that is too large for a row of
`storage.sql` or a value of `storage.kv` (a space's saved files, a workspace's snapshot). Each
component opens the namespace named after it.

```sh
pikit add storage-blob-s3
pikit configure            # S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
```

It runs on both targets: plain `fetch`, each request signed with AWS Signature Version 4 over Web
Crypto (`sigv4.ts`, checked against AWS's published S3 examples). No AWS SDK, no Node API.

## What it guarantees

Everything the `storage.blob` contract promises (`createBlobConformance` passes):

- **Bytes in, the same bytes out**, with the content type they were put with. `get` and `put` copy.
- **Atomic replace**: a `put` is one `PutObject`; S3 replaces an object whole, and a later `GET` sees
  the new one.
- **Namespaces apart**: the value at `key` in namespace `name` is the object `<prefix><name>/<key>`.
  The `/` keeps `a` from seeing `ab`'s keys.
- **The content type as it was put**: sent as the object's `Content-Type` and kept as its metadata
  (`x-amz-meta-pikit-content-type`), which `get` reads back. A value put without one comes back
  without one, never with the store's default (`binary/octet-stream`).
- **`list`** is `ListObjectsV2` under the namespace's prefix, in S3's order (code-unit order for the
  contract's keys), its continuation token the cursor. A page may hold fewer keys than asked (the
  store decides), as the contract allows. An object under the prefix whose name is not a key of the
  contract (written by something else) is skipped.
- **Refused before any request**: a key, a value or a content type the contract refuses.
- **What fails is said**: any other answer than 2xx (or 404 on `get` / `delete`) rejects with S3's
  status and error code (`HTTP 403 SignatureDoesNotMatch`), never a key. A request longer than
  `timeoutMs` is cancelled. Nothing is retried here: the caller decides.

## Config

```ts
"storage-blob-s3": {
  endpoint: "https://<account>.r2.cloudflarestorage.com", // absent: AWS S3 in `region`
  region: "auto",                    // AWS's region; "auto" for R2; what MinIO or rustfs is set to (default us-east-1)
  bucket: "my-assistant",
  prefix: "pikit/",                  // every key under it, to share a bucket ("" by default)
  pathStyle: true,                   // <endpoint>/<bucket>/<key>; absent: path-style with an endpoint, virtual-hosted on AWS
  accessKeyIdSecret: "S3_ACCESS_KEY_ID",         // the NAMES of the secrets, never their values
  secretAccessKeySecret: "S3_SECRET_ACCESS_KEY",
  sessionTokenSecret: "S3_SESSION_TOKEN",        // read when set (temporary credentials)
  maxBytes: 26214400,                // the largest value, in bytes: at least 25 MiB (the default)
  timeoutMs: 60000,                  // one request, its body included
}
```

The keys are read through `secrets` at start (an environment variable on a server, a Worker secret on
Cloudflare); without them the app does not start, naming the secret. The credentials need
`GetObject`, `PutObject`, `DeleteObject` and `ListBucket` on the bucket (AWS answers a missing key with
403, not 404, to credentials that may not list).

- **R2**: `endpoint` `https://<account id>.r2.cloudflarestorage.com`, `region` `auto`, an R2 API
  token's access key id and secret.
- **A celld fleet's bucket**: the endpoint, region and bucket its nodes read (`S3_ENDPOINT`,
  `AWS_REGION`, `CELLD_BUCKET`), with a `prefix` of its own (`pikit/`) so nothing meets `deploy/`.
- **MinIO, rustfs**: `endpoint` `http://127.0.0.1:9000` (path-style), the region it is set to.

## Limits

- **Values whole, in memory**: one `PutObject` per value, no multipart upload, no streaming. On
  Cloudflare a Durable Object has 128 MB of memory: keep `maxBytes` at its default there.
- **No retries**, no checksum beyond the signed SHA-256 of the body S3 checks on `put`.
- **No probe at start**: a wrong bucket or key is found at the first call, with S3's error. (Starting
  makes no request, so a conversation's object starts without one.)

## Removing it

`pikit remove storage-blob-s3` refuses while a component requires `storage.blob`. The objects stay in
the bucket: they are your data.

## Tests

Copied with the component, they run in your project, with no network: the `storage.blob`
conformance suite twice against a fake S3 (`fake-s3.test-support.ts`: one bucket in memory that
checks every request's signature as S3 does, from what it received, the body's hash, the clock and
the session token), path-style over HTTP (`Bun.serve`), and virtual-hosted on AWS's endpoint behind
the global `fetch`, under a prefix, with a session token and pages of at most 3 keys; the lifecycle
suite; the signer against AWS's examples; the objects' names and metadata in the bucket; a wrong key,
S3's errors and timeouts; refused input never sent; the start failures. In the pikit repository the
suite also runs in workerd (`tests/workerd/test/storage-blob-s3.workerd.ts`).

An opt-in run against a real store, each case under a prefix of its own and emptied after: set
`PIKIT_S3_TEST_ENDPOINT`, `PIKIT_S3_TEST_BUCKET`, `PIKIT_S3_TEST_REGION`,
`PIKIT_S3_TEST_ACCESS_KEY_ID` and `PIKIT_S3_TEST_SECRET_ACCESS_KEY`, then `bun test`.
