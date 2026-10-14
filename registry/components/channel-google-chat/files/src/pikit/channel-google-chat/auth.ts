// Owner: transport. The service account's access token (features/channel-google-chat.md "Answers", last point).
/**
 * The REST API is called as the app's service account: a JWT (RS256, signed with WebCrypto from the
 * JSON key's PKCS #8 `private_key`: `crypto.subtle.importKey("pkcs8", …, { name: "RSASSA-PKCS1-v1_5",
 * hash: "SHA-256" }, false, ["sign"])`) with `iss` the `client_email`, `scope` `CHAT_SCOPE`, `aud` the
 * key's `token_uri`, `iat` now and `exp` an hour later (on `clock`), `kid` the `private_key_id` when
 * there is one; exchanged at `token_uri` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`,
 * form-encoded) for an access token kept in memory until a minute before it expires. Concurrent
 * callers share one exchange. A refusal rejects with a `ChatApiError` (`permanent` for a 400/401: the
 * key is wrong). Nothing is fetched until a token is asked for (a start makes no request).
 */

import type { Clock } from "@pikit/core";
import type { ServiceAccount } from "./instance.ts";
import type { AccessTokens } from "./types.ts";

/** The scope a Chat app's calls need. */
export const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

export interface AccessTokenOptions {
  clock: Clock;
  /** A value, for tests; the global `fetch` by default. */
  fetch?: typeof fetch;
}

/** The access tokens of `serviceAccount`. */
export function createAccessTokens(serviceAccount: ServiceAccount, options: AccessTokenOptions): AccessTokens {
  void serviceAccount;
  void options;
  return {
    token: async () => {
      throw new Error("not implemented: transport (auth.ts createAccessTokens)");
    },
  };
}
