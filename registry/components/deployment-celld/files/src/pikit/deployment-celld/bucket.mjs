/**
 * The fleet bucket, as much of it as a rollback needs: read an object with its ETag, and write one
 * only if it still has the ETag read (`If-Match`), so a rollback never undoes a deploy that landed
 * after it. celld has no rollback of its own (denoland/celld#181), but it keeps every deployment's
 * objects (`deploy/<worker>/<version>/`, immutable) and selects the fleet's with one small pointer,
 * `deploy/current.json`, which its nodes poll: "Changing this is a deploy; nodes converge to it"
 * (`DeployPointer`, crates/celld/protocol.rs). Rolling back is writing the previous pointer back.
 *
 * S3-compatible buckets only (`s3://`, or no scheme: AWS S3, R2, Tigris, rustfs, MinIO), signed with
 * AWS Signature Version 4 from the environment's keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_SESSION_TOKEN`); the bucket, endpoint and region are read as celld reads them (`CELLD_BUCKET`,
 * `S3_ENDPOINT`, `AWS_REGION`). An explicit endpoint is addressed path-style, AWS's own
 * virtual-hosted, as celld does. No instance role, no `gs://`, no `az://`: `bucketStore` says why
 * not, and a deploy then is not rolled back.
 *
 * Plain JavaScript with no dependency (Node's crypto), so a CI deploy (`deploy.mjs`) runs it too.
 */

import { createHash, createHmac } from "node:crypto";

/** `[s3://|gs://|az://]NAME[/PREFIX]`, as celld splits it: the prefix empty or slash-terminated. */
export function parseBucket(spec) {
  const text = spec.trim();
  const scheme = /^([a-z0-9]+):\/\//i.exec(text);
  const rest = scheme === null ? text : text.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const name = slash < 0 ? rest : rest.slice(0, slash);
  const prefix = (slash < 0 ? "" : rest.slice(slash + 1))
    .split("/")
    .filter((part) => part !== "")
    .map((part) => `${part}/`)
    .join("");
  return { scheme: scheme === null ? "s3" : scheme[1].toLowerCase(), name, prefix };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of a key's segments, as SigV4 canonicalizes an S3 path (`/` kept). */
function encodePath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * The headers of a SigV4-signed S3 request (`Authorization`, `x-amz-date`, `x-amz-content-sha256`,
 * and `x-amz-security-token` with a session token), every header of `headers` signed.
 */
export function signRequest({ method, url, headers = {}, body = "", region, credentials, date = new Date() }) {
  const target = new URL(url);
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()])),
    host: target.host,
    "x-amz-content-sha256": sha256(body),
    "x-amz-date": stamp,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
  };
  const names = Object.keys(all).sort();
  const query = [...target.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [method, encodePath(decodeURIComponent(target.pathname)), query, ...names.map((n) => `${n}:${all[n]}`), "", names.join(";"), all["x-amz-content-sha256"]].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = ["s3", "aws4_request"].reduce((k, part) => hmac(k, part), hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region));
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...sent } = all;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/**
 * An S3 client of the fleet bucket from `env` (celld's variables), or `{ unsupported: <why> }` when
 * pikit cannot sign for it. `fetch` defaults to the global one.
 */
export function bucketStore(env, fetcher = fetch) {
  const spec = env.CELLD_BUCKET;
  if (!spec) return { unsupported: "CELLD_BUCKET is not set" };
  const bucket = parseBucket(spec);
  if (bucket.scheme !== "s3") return { unsupported: `pikit restores a deployment only on an S3-compatible bucket, not ${bucket.scheme}://` };
  if (bucket.name === "") return { unsupported: `CELLD_BUCKET "${spec}" names no bucket` };
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return { unsupported: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set here (pikit signs its own requests and reads no instance role or ~/.aws profile)" };
  }
  const credentials = { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN || undefined };
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const endpoint = env.S3_ENDPOINT || env.AWS_ENDPOINT_URL || env.AWS_ENDPOINT || undefined;
  const objectUrl = (key) => {
    const path = encodePath(`${bucket.prefix}${key}`);
    if (endpoint === undefined) return `https://${bucket.name}.s3.${region}.amazonaws.com/${path}`;
    return `${endpoint.replace(/\/+$/, "")}/${encodePath(bucket.name)}/${path}`;
  };
  const request = async (method, key, { body = "", headers = {} } = {}) => {
    const url = objectUrl(key);
    const signed = signRequest({ method, url, headers, body, region, credentials });
    return await fetcher(url, { method, headers: signed, ...(method === "PUT" ? { body } : {}), signal: AbortSignal.timeout(30_000) });
  };
  return {
    bucket,
    /** The object at `key` (under the bucket's prefix) and its ETag; undefined when there is none. */
    async get(key) {
      const response = await request("GET", key);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`GET ${key}: HTTP ${response.status}${await errorCode(response)}`);
      return { body: await response.text(), etag: response.headers.get("etag") ?? undefined };
    },
    /** Writes `body` at `key` if it still has `etag`; resolves false when another write came first. */
    async replace(key, body, etag) {
      const response = await request("PUT", key, { body, headers: { "content-type": "application/json", "if-match": etag } });
      if (response.status === 412 || response.status === 409) return false;
      if (!response.ok) throw new Error(`PUT ${key}: HTTP ${response.status}${await errorCode(response)}`);
      return true;
    },
  };
}

/** S3's error `<Code>`, when its body has one: `: AccessDenied`. */
async function errorCode(response) {
  const text = await response.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  return code === undefined ? "" : `: ${code}`;
}
