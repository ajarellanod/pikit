/**
 * A request to better-auth and its response as JSON, for `actor.mailbox.call`: on Cloudflare the
 * Worker forwards every `/chat/api/auth/*` request to the accounts actor (`channel-web:accounts`),
 * which answers with better-auth's response. Every `set-cookie` is kept (`getSetCookie()`): a
 * sign-in sets several, and folding them into one header would lose all but the first.
 *
 * Bodies are text, at most `MAX_AUTH_BODY` bytes each way: better-auth's requests are small JSON or
 * forms. A larger request is refused before it is read (413); an answer that is not JSON-shaped as
 * below is refused on arrival (`checkForwarded*`).
 */

import { AUTH_BASE_PATH } from "./links.ts";

/** The largest body forwarded, each way (64 KiB). */
export const MAX_AUTH_BODY = 64 * 1024;

export type ForwardedRequest = { method: string; url: string; headers: [string, string][]; body?: string };
export type ForwardedResponse = { status: number; headers: [string, string][]; body: string };

const METHODS = new Set(["GET", "POST", "HEAD", "OPTIONS"]);
/** Hop-by-hop headers and the ones a `Request` / `Response` sets itself. */
const DROPPED = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "host"]);

/** Thrown for a body over `MAX_AUTH_BODY`: answer 413. */
export class TooLarge extends Error {}

const encoder = new TextEncoder();
const tooLarge = (text: string): boolean => text.length > MAX_AUTH_BODY || encoder.encode(text).length > MAX_AUTH_BODY;

/** A request as JSON. Throws `TooLarge` for a body over the bound (checked by its length first). */
export async function forwardRequest(request: Request): Promise<ForwardedRequest> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_AUTH_BODY) throw new TooLarge("request body too large");
  const headers: [string, string][] = [];
  request.headers.forEach((value, name) => {
    if (!DROPPED.has(name)) headers.push([name, value]);
  });
  const forwarded: ForwardedRequest = { method: request.method, url: request.url, headers };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
    const body = await readBounded(request);
    if (body !== "") forwarded.body = body;
  }
  return forwarded;
}

/** Reads a body, stopping past the bound (a body without `content-length` is read only so far). */
async function readBounded(message: Request | Response): Promise<string> {
  const reader = message.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AUTH_BODY) {
      await reader.cancel();
      throw new TooLarge("body too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** The `Request` a forwarded request stands for, on the actor's side. */
export function requestOf(forwarded: ForwardedRequest): Request {
  const headers = new Headers();
  for (const [name, value] of forwarded.headers) headers.append(name, value);
  return new Request(forwarded.url, { method: forwarded.method, headers, ...(forwarded.body !== undefined && { body: forwarded.body }) });
}

/** A response as JSON, every `set-cookie` kept. Throws `TooLarge` for a body over the bound. */
export async function forwardResponse(response: Response): Promise<ForwardedResponse> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie" && !DROPPED.has(name)) headers.push([name, value]);
  });
  for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
  return { status: response.status, headers, body: await readBounded(response) };
}

/** The `Response` a forwarded response stands for, on the Worker's side. */
export function responseOf(forwarded: ForwardedResponse): Response {
  const headers = new Headers();
  for (const [name, value] of forwarded.headers) headers.append(name, value);
  const empty = forwarded.status === 204 || forwarded.status === 304 || (forwarded.status >= 300 && forwarded.status < 400 && forwarded.body === "");
  return new Response(empty ? null : forwarded.body, { status: forwarded.status, headers });
}

const isHeaders = (value: unknown): value is [string, string][] =>
  Array.isArray(value) &&
  value.length <= 200 &&
  value.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string");

/** A forwarded request, checked on arrival at the actor; `undefined` when it is not one. */
export function checkForwardedRequest(value: unknown): ForwardedRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { method, url, headers, body } = value as Record<string, unknown>;
  if (typeof method !== "string" || !METHODS.has(method)) return undefined;
  if (typeof url !== "string" || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || !parsed.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return undefined;
  if (!isHeaders(headers)) return undefined;
  if (body !== undefined && (typeof body !== "string" || tooLarge(body))) return undefined;
  return { method, url, headers, ...(body !== undefined && { body }) };
}

/** A forwarded response, checked on arrival at the Worker; `undefined` when it is not one. */
export function checkForwardedResponse(value: unknown): ForwardedResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { status, headers, body } = value as Record<string, unknown>;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return undefined;
  if (!isHeaders(headers) || typeof body !== "string" || tooLarge(body)) return undefined;
  return { status, headers, body };
}
