/**
 * A fake S3 for storage-blob-s3's tests: one bucket in memory, `PUT`, `GET`, `DELETE` of objects,
 * `ListObjectsV2`, and multipart uploads (create, upload a part, complete, abort; a part but the last
 * under 5 MiB refused as S3 refuses it, the parts' ETags checked at completion), path-style (`/<bucket>/<key>`) or virtual-hosted (`<bucket>.<host>/<key>`). It
 * checks every request's Signature Version 4 as S3 does, with its own canonical request (the path
 * decoded and encoded again, the query sorted, the signed headers as received), the payload's hash
 * against the body, the clock within 15 minutes, and the session token when it has one: a request it
 * cannot verify is refused (403) and changes nothing.
 *
 * Web APIs only (`Request`, `Response`, `crypto.subtle`), so the workerd lane serves it from the
 * isolate's `fetch` and `bun test` from `Bun.serve`.
 */

export interface FakeS3Options {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** The most keys a page of `ListObjectsV2` holds, whatever `max-keys` asks (S3 may give fewer). */
  pageSize?: number;
}

export interface FakeObject {
  bytes: Uint8Array;
  /** Headers kept with it: `content-type` and every `x-amz-meta-*`. */
  headers: Record<string, string>;
}

export interface FakeS3 {
  /** Answers one request, as S3 would. */
  handle(request: Request): Promise<Response>;
  /** The bucket's objects, by their full key. */
  readonly objects: Map<string, FakeObject>;
  /** Every request it answered: method, the path and query as received, the status. */
  readonly requests: { method: string; path: string; status: number }[];
  /** Answers the next `count` requests with `status` and S3's error `code`, before checking anything. */
  failNext(count: number, status: number, code: string): void;
  /** The multipart uploads begun and neither completed nor aborted, by upload id. */
  readonly uploads: Map<string, FakeUpload>;
  /** Answers the next completion of an upload with 200 and an error in its body, as S3 may. */
  failCompletion(code: string): void;
}

export interface FakeUpload {
  key: string;
  headers: Record<string, string>;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

/** S3's smallest part, but the last. */
const MIN_PART = 5 * 1024 * 1024;

const encoder = new TextEncoder();

export function createFakeS3(options: FakeS3Options): FakeS3 {
  const objects = new Map<string, FakeObject>();
  const requests: FakeS3["requests"] = [];
  const uploads = new Map<string, FakeUpload>();
  let failures: { count: number; status: number; code: string } | undefined;
  let completionFailure: string | undefined;

  const answer = async (request: Request): Promise<Response> => {
    if (failures !== undefined && failures.count > 0) {
      failures.count--;
      return error(failures.status, failures.code);
    }
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;
    const body = new Uint8Array(await request.arrayBuffer());
    const problem = await signatureProblem(request, url, host, body, options);
    if (problem !== undefined) return error(403, problem);

    // Virtual-hosted: the bucket is the host's first label; path-style: the path's first segment.
    let path = url.pathname;
    if (!host.startsWith(`${options.bucket}.`)) {
      const [, bucket = "", ...rest] = path.split("/");
      if (decodeURIComponent(bucket) !== options.bucket) return error(404, "NoSuchBucket");
      path = `/${rest.join("/")}`;
    }
    const key = path
      .slice(1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");

    if (key === "") {
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") return list(url.searchParams);
      return error(405, "MethodNotAllowed");
    }
    const uploadId = url.searchParams.get("uploadId");
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = crypto.randomUUID();
      uploads.set(id, { key, headers: keptHeaders(request), parts: new Map() });
      return xmlAnswer(`<InitiateMultipartUploadResult><Bucket>${escapeXml(options.bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (uploadId !== null) {
      const upload = uploads.get(uploadId);
      if (upload === undefined || upload.key !== key) return error(404, "NoSuchUpload");
      if (request.method === "PUT") {
        const number = Number(url.searchParams.get("partNumber"));
        if (!Number.isInteger(number) || number < 1 || number > 10_000) return error(400, "InvalidArgument");
        const etag = `"${hex(await crypto.subtle.digest("SHA-256", body)).slice(0, 32)}"`;
        upload.parts.set(number, { bytes: body, etag });
        return new Response(null, { status: 200, headers: { etag } });
      }
      if (request.method === "DELETE") {
        uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST") {
        if (completionFailure !== undefined) {
          const code = completionFailure;
          completionFailure = undefined;
          return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`, { status: 200 });
        }
        const listed = [...new TextDecoder().decode(body).matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/g)].map(([, n, etag]) => ({ number: Number(n), etag: unescapeXml(etag as string) }));
        if (listed.length === 0) return error(400, "MalformedXML");
        const chunks: Uint8Array[] = [];
        for (const [i, { number, etag }] of listed.entries()) {
          const part = upload.parts.get(number);
          if (i > 0 && number <= (listed[i - 1] as { number: number }).number) return error(400, "InvalidPartOrder");
          if (part === undefined || part.etag !== etag) return error(400, "InvalidPart");
          if (i < listed.length - 1 && part.bytes.byteLength < MIN_PART) return error(400, "EntityTooSmall");
          chunks.push(part.bytes);
        }
        const whole = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
        let at = 0;
        for (const chunk of chunks) {
          whole.set(chunk, at);
          at += chunk.byteLength;
        }
        objects.set(key, { bytes: whole, headers: upload.headers });
        uploads.delete(uploadId);
        return xmlAnswer(`<CompleteMultipartUploadResult><Bucket>${escapeXml(options.bucket)}</Bucket><Key>${escapeXml(key)}</Key><ETag>"${listed.length}"</ETag></CompleteMultipartUploadResult>`);
      }
      return error(405, "MethodNotAllowed");
    }
    switch (request.method) {
      case "PUT": {
        objects.set(key, { bytes: body, headers: keptHeaders(request) });
        return new Response(null, { status: 200, headers: { etag: `"${body.byteLength}"` } });
      }
      case "GET": {
        const object = objects.get(key);
        if (object === undefined) return error(404, "NoSuchKey");
        return new Response(object.bytes.slice(), { status: 200, headers: { "content-type": "binary/octet-stream", ...object.headers, "content-length": String(object.bytes.byteLength) } });
      }
      case "DELETE":
        objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return error(405, "MethodNotAllowed");
    }
  };

  const list = (params: URLSearchParams): Response => {
    const prefix = params.get("prefix") ?? "";
    const maxKeys = Math.min(Number(params.get("max-keys") ?? "1000"), 1000, options.pageSize ?? 1000);
    const token = params.get("continuation-token");
    const after = token === null ? (params.get("start-after") ?? "") : atob(token);
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && key > after).sort(byUtf8);
    const page = keys.slice(0, maxKeys);
    const truncated = keys.length > page.length;
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${escapeXml(options.bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>`,
      `<IsTruncated>${truncated}</IsTruncated>`,
      ...(token === null ? [] : [`<ContinuationToken>${escapeXml(token)}</ContinuationToken>`]),
      ...(truncated ? [`<NextContinuationToken>${escapeXml(btoa(page[page.length - 1] as string))}</NextContinuationToken>`] : []),
      ...page.map((key) => `<Contents><Key>${escapeXml(key)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>${(objects.get(key) as FakeObject).bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`),
      "</ListBucketResult>",
    ].join("");
    return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
  };

  return {
    objects,
    requests,
    uploads,
    failCompletion(code) {
      completionFailure = code;
    },
    failNext(count, status, code) {
      failures = { count, status, code };
    },
    async handle(request) {
      const response = await answer(request);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, status: response.status });
      return response;
    },
  };
}

/** S3's order: the keys' UTF-8 bytes; code-unit order for the ASCII keys it is given. */
const byUtf8 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The headers S3 keeps with an object: `content-type` and every `x-amz-meta-*`. */
function keptHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers) if (name === "content-type" || name.startsWith("x-amz-meta-")) headers[name] = value;
  return headers;
}

function xmlAnswer(xml: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, { status: 200, headers: { "content-type": "application/xml" } });
}

function unescapeXml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function error(status: number, code: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`, { status, headers: { "content-type": "application/xml" } });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const AUTHORIZATION = /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([^/,\s]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/;

/** Why S3 would refuse `request`'s signature (its error code), or `undefined` when it holds. */
async function signatureProblem(request: Request, url: URL, host: string, body: Uint8Array, options: FakeS3Options): Promise<string | undefined> {
  const match = AUTHORIZATION.exec(request.headers.get("authorization") ?? "");
  if (match === null) return "AccessDenied";
  const [, accessKeyId, day, region, signedHeaders, signature] = match as unknown as [string, string, string, string, string, string];
  if (accessKeyId !== options.accessKeyId) return "InvalidAccessKeyId";
  if (region !== options.region) return "AuthorizationHeaderMalformed";
  const amzDate = request.headers.get("x-amz-date") ?? "";
  const when = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (when === null || amzDate.slice(0, 8) !== day) return "AccessDenied";
  const time = Date.UTC(Number(when[1]), Number(when[2]) - 1, Number(when[3]), Number(when[4]), Number(when[5]), Number(when[6]));
  if (Math.abs(Date.now() - time) > 15 * 60 * 1000) return "RequestTimeTooSkewed";
  const names = signedHeaders.split(";");
  for (const required of ["host", "x-amz-date", "x-amz-content-sha256"]) if (!names.includes(required)) return "AccessDenied";
  if (options.sessionToken !== undefined && (request.headers.get("x-amz-security-token") !== options.sessionToken || !names.includes("x-amz-security-token"))) return "InvalidToken";
  const payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
  if (payloadHash !== hex(await crypto.subtle.digest("SHA-256", new Uint8Array(body)))) return "XAmzContentSHA256Mismatch";

  const canonicalRequest = [
    request.method,
    url.pathname
      .split("/")
      .map((segment) => encode3986(decodeURIComponent(segment)))
      .join("/"),
    [...url.searchParams]
      .map(([name, value]) => [encode3986(name), encode3986(value)] as const)
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("&"),
    names.map((name) => `${name}:${(name === "host" ? host : (request.headers.get(name) ?? "")).trim().replace(/\s+/g, " ")}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)))].join("\n");
  let key: ArrayBuffer = new Uint8Array(encoder.encode(`AWS4${options.secretAccessKey}`)).buffer;
  for (const part of [day, region, "s3", "aws4_request"]) key = await hmac(key, part);
  return hex(await hmac(key, stringToSign)) === signature ? undefined : "SignatureDoesNotMatch";
}

function encode3986(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmac(key: ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, new Uint8Array(encoder.encode(text)));
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
