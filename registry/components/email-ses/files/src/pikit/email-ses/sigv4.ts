/**
 * AWS Signature Version 4 over Web Crypto (`crypto.subtle`: HMAC-SHA256 and SHA-256), so it runs on a
 * server and in a Worker with no AWS SDK. Header signing only (an `Authorization` header), for
 * services other than S3 (their path is encoded twice). Checked against AWS's published test vectors
 * in `sigv4.test.ts`.
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */

/** An access key, and the session token of temporary credentials. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  url: string;
  /** Headers to send and sign (`content-type`…); `host` comes from `url`, never from here. */
  headers: Record<string, string>;
  body: string;
  region: string;
  /** The signing name of the service (`ses` for SES v2). */
  service: string;
  credentials: AwsCredentials;
  /** When it is signed: AWS refuses a signature more than 5 minutes off its clock. */
  date: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

/** The headers to send for `request`: its own, `x-amz-date`, `x-amz-security-token` with a session token, and `authorization`. */
export async function signAws4(request: SignableRequest): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const amzDate = request.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  headers["x-amz-date"] = amzDate;
  if (request.credentials.sessionToken !== undefined) headers["x-amz-security-token"] = request.credentials.sessionToken;

  const signed: Record<string, string> = { ...headers, host: url.host };
  const names = Object.keys(signed).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((name) => `${name}:${(signed[name] as string).trim().replace(/\s+/g, " ")}\n`).join(""),
    signedHeaders,
    hex(await sha256(request.body)),
  ].join("\n");
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, hex(await sha256(canonicalRequest))].join("\n");

  let key: ArrayBuffer = encode(`AWS4${request.credentials.secretAccessKey}`).buffer;
  for (const part of [day, request.region, request.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  headers.authorization = `${ALGORITHM} Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/** RFC 3986 encoding: everything but `A-Z a-z 0-9 - _ . ~`. */
function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The path as sent (already encoded once by `URL`), each segment encoded again: the rule for every service but S3. */
function canonicalPath(path: string): string {
  return path === "" ? "/" : path.split("/").map(uriEncode).join("/");
}

/** The query's parameters, encoded and sorted by name, then value. */
function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

// Copied: Workers' types say `encode` may answer a view of a shared buffer, which `crypto.subtle` does not take.
const encode = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encode(text));
}

async function hmac(key: ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encode(text));
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
