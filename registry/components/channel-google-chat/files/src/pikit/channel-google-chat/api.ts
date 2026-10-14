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
 */

import type { DeliveryError } from "@pikit/contracts";
import type { AccessTokens, ChatApi } from "./types.ts";

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
  void options;
  const missing = async (): Promise<never> => {
    throw new Error("not implemented: transport (api.ts createChatApi)");
  };
  return { createMessage: missing, updateMessage: missing, deleteMessage: missing, getMessage: missing, getSpace: missing, downloadMedia: missing };
}

/**
 * `error` (a `ChatApiError`, or anything) as a `DeliveryError`: 429 `rate_limited` (its
 * `retryAfterMs`); a network error, a timeout and 5xx `transient` (`maybeSent` kept); 400, 403 and 404
 * `permanent` (the app removed, the space gone, a message refused); anything else `transient`. Its
 * message is Google's words, never a message's text.
 */
export function deliveryErrorOf(error: unknown): DeliveryError {
  void error;
  throw new Error("not implemented: transport (api.ts deliveryErrorOf)");
}
