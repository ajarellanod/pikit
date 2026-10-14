// Owner: transport. The Chat REST client and the classification of its failures (features/channel-google-chat.md "Answers").
/**
 * `ChatApi` over `fetch`, at `apiBase` (`https://chat.googleapis.com`), as the service account
 * (`AccessTokens`, `Authorization: Bearer`):
 *
 *   createMessage   POST   /v1/<space>/messages?requestId=&messageId=&messageReplyOption=REPLY_MESSAGE_OR_FAIL (with a thread)
 *   updateMessage   PATCH  /v1/<name>?updateMask=<fields>
 *   deleteMessage   DELETE /v1/<name>
 *   getMessage      GET    /v1/<name>
 *   getSpace        GET    /v1/<space>
 *   downloadMedia   GET    /v1/media/<resourceName>?alt=media (bounded: read up to `maxBytes`, then cancelled)
 *
 * Every call has a timeout (`CALL_TIMEOUT_MS`, a value) and the caller's signal. Every failure rejects
 * with a `ChatApiError` (types.ts): the status, Google's `error.status` and `error.message`, a 429's
 * `Retry-After`, and `maybeSent` for a timeout or a connection cut after the request left.
 * `deliveryErrorOf` turns one into the `DeliveryError` answer delivery reads.
 * Nothing here logs: a URL holds no secret, but a body may hold a message's text.
 */

import { DeliveryError } from "@pikit/contracts";
import { retryAfterMs } from "./auth.ts";
import type { ChatMessage, ChatSpace } from "./event.ts";
import { type AccessTokens, type ChatApi, ChatApiError } from "./types.ts";

/** How long, in ms, one call to Google may take. */
export const CALL_TIMEOUT_MS = 15_000;

export interface ChatApiOptions {
  /** `Config.apiBase`. */
  apiBase: string;
  tokens: AccessTokens;
  /** A value, for tests; the global `fetch` by default. */
  fetch?: typeof fetch;
}

/** The Chat API as the service account whose tokens are `options.tokens`. Makes no request until called. */
export function createChatApi(options: ChatApiOptions): ChatApi {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const base = `${options.apiBase.replace(/\/+$/, "")}/v1/`;
  /** A resource's name in a URL: each segment escaped, its slashes kept. */
  const path = (name: string): string => name.split("/").map(encodeURIComponent).join("/");

  /**
   * One call: `read` of its response once it is 2xx, else a `ChatApiError`. The timeout covers the
   * answer's body too.
   */
  const call = async <T>(
    method: string,
    resource: string,
    query: Record<string, string | undefined>,
    body: unknown,
    signal: AbortSignal | undefined,
    read: (response: Response) => Promise<T>,
  ): Promise<T> => {
    const token = await options.tokens.token(signal).catch((error: unknown) => {
      throw error instanceof ChatApiError ? error : new ChatApiError(0, "no access token", { cause: error });
    });
    const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
    // A timer cleared once the call settles, not `AbortSignal.timeout` (a pending timer keeps a Durable Object awake).
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), CALL_TIMEOUT_MS);
    const cut = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
    const label = `${method} ${resource}`;
    /** No answer, or one cut short: it left, so it may have reached Google; a refused connection did not. */
    const unanswered = (error: unknown): ChatApiError => {
      if (timeout.signal.aborted) return new ChatApiError(0, `${label}: no answer within ${CALL_TIMEOUT_MS} ms`, { maybeSent: true, cause: error });
      if (signal?.aborted) return new ChatApiError(0, `${label}: cut`, { maybeSent: true, cause: error });
      return new ChatApiError(0, `${label}: network error (${error instanceof Error ? error.name : "unknown"})`, { cause: error });
    };
    try {
      let response: Response;
      try {
        response = await fetcher(`${base}${resource}${search === "" ? "" : `?${search}`}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json; charset=utf-8" }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: cut,
        });
      } catch (error) {
        throw unanswered(error);
      }
      if (!response.ok) {
        const answer = (await response.json().catch(() => undefined)) as { error?: { message?: unknown; status?: unknown } } | undefined;
        const code = typeof answer?.error?.status === "string" ? answer.error.status : undefined;
        const words = typeof answer?.error?.message === "string" ? answer.error.message : `HTTP ${response.status}`;
        const wait = response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), Date.now()) : undefined;
        throw new ChatApiError(response.status, `${label}: ${response.status}${code === undefined ? "" : ` ${code}`} ${words}`, {
          ...(code !== undefined && { code }),
          ...(wait !== undefined && { retryAfterMs: wait }),
        });
      }
      try {
        return await read(response);
      } catch (error) {
        if (error instanceof ChatApiError) throw error;
        if (cut.aborted) throw unanswered(error);
        throw new ChatApiError(response.status, `${label}: Google's answer could not be read`, { maybeSent: true, cause: error });
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  return {
    async createMessage(space, message, { thread, requestId, messageId }, signal) {
      const resource = `${path(space)}/messages`;
      const query = { requestId, messageId, messageReplyOption: thread === undefined ? undefined : "REPLY_MESSAGE_OR_FAIL" };
      const body = thread === undefined ? message : { ...message, thread: { name: thread } };
      return call("POST", resource, query, body, signal, json<ChatMessage>);
    },
    async updateMessage(name, message, fields, signal) {
      // A field in the mask and absent from `message` is cleared.
      const body: Record<string, unknown> = {};
      for (const field of fields) body[field] = message[field] ?? (field === "cardsV2" ? [] : "");
      return call("PATCH", path(name), { updateMask: fields.join(",") }, body, signal, json<ChatMessage>);
    },
    async deleteMessage(name, signal) {
      await call("DELETE", path(name), {}, undefined, signal, async (response) => void (await response.body?.cancel()));
    },
    async getMessage(name, signal) {
      return call("GET", path(name), {}, undefined, signal, json<ChatMessage>);
    },
    async getSpace(name, signal) {
      return call("GET", path(name), {}, undefined, signal, json<ChatSpace>);
    },
    async downloadMedia(resourceName, maxBytes, signal) {
      return call("GET", `media/${path(resourceName)}`, { alt: "media" }, undefined, signal, async (response) => {
        const tooLarge = () => new ChatApiError(413, `media.download: the file is larger than ${maxBytes} bytes`);
        const declared = Number(response.headers.get("content-length") ?? Number.NaN);
        if (Number.isFinite(declared) && declared > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw tooLarge();
        }
        // Counted as it streams: past `maxBytes`, the rest is never read.
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();
        while (reader !== undefined) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw tooLarge();
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.byteLength;
        }
        return { bytes, contentType: response.headers.get("content-type") ?? undefined };
      });
    },
  };
}

/**
 * `error` (a `ChatApiError`, or anything) as a `DeliveryError`: 429 `rate_limited` (its
 * `retryAfterMs`); **the token endpoint's refusal** (`tokenRefused`: `invalid_grant`, a key that
 * cannot be read) `transient`, its message saying the key is to fix: a misconfigured secret is the
 * app's, not the answer's, so the answers wait (logged at every failure, as an error from the 3rd)
 * and go once it is fixed (through `outbound-durable`, within its 24 hours); a network error, a
 * timeout and 5xx `transient` (`maybeSent` kept); 400, 401, 403 and 404 from the Chat API
 * `permanent` (a message refused; a token Google refused, which it gave a minute before at least, so
 * not an old one; the app removed; the space gone: retrying fails the same way); anything else
 * `transient`. Its message is Google's words, never a message's text or a key.
 */
export function deliveryErrorOf(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  if (!(error instanceof ChatApiError)) return new DeliveryError("transient", error instanceof Error ? error.message : String(error), { cause: error });
  const options = { maybeSent: error.maybeSent, cause: error };
  if (error.status === 429) return new DeliveryError("rate_limited", error.message, { ...options, ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }) });
  if (error.tokenRefused) return new DeliveryError("transient", `${error.message} (fix the service account's key in the secrets: the answers waiting go once it works)`, options);
  if ([400, 401, 403, 404].includes(error.status)) return new DeliveryError("permanent", error.message, options);
  return new DeliveryError("transient", error.message, options);
}
