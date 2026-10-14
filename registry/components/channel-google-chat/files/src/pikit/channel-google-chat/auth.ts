// Owner: transport. The service account's access token (features/channel-google-chat.md "Answers", last point).
/**
 * The REST API is called as the app's service account: a JWT (RS256, signed with WebCrypto from the
 * JSON key's PKCS #8 `private_key`: `crypto.subtle.importKey("pkcs8", …, { name: "RSASSA-PKCS1-v1_5",
 * hash: "SHA-256" }, false, ["sign"])`) with `iss` the `client_email`, `scope` `CHAT_SCOPE`, `aud` the
 * key's `token_uri`, `iat` now and `exp` an hour later (on `clock`), `kid` the `private_key_id` when
 * there is one; exchanged at `token_uri` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`,
 * form-encoded) for an access token kept in memory until a minute before it expires. Concurrent
 * callers share one exchange. A refusal rejects with a `ChatApiError` with the endpoint's status and
 * words, `tokenRefused` (`invalid_grant`: the key is wrong, deleted or disabled; a private key that
 * cannot be read too): `transient` by `deliveryErrorOf`, so the answers wait and go once the secret
 * is fixed; no answer rejects with status 0. Neither the key, the assertion nor a token is ever in an error or a log. Nothing is fetched until a token is asked for (a start makes no request).
 */

import type { Clock } from "@pikit/core";
import type { ServiceAccount } from "./instance.ts";
import { type AccessTokens, ChatApiError } from "./types.ts";

/** The scope a Chat app's calls need. */
export const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

export interface AccessTokenOptions {
  clock: Clock;
  /** A value, for tests; the global `fetch` by default. */
  fetch?: typeof fetch;
}

/** A token is used until this long before it expires. */
const MARGIN_MS = 60_000;
/** How long, in ms, one exchange at the token endpoint may take. */
const EXCHANGE_TIMEOUT_MS = 15_000;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

/** The access tokens of `serviceAccount`. */
export function createAccessTokens(serviceAccount: ServiceAccount, options: AccessTokenOptions): AccessTokens {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  let kept: { token: string; expiresAt: number } | undefined;
  let exchanging: Promise<string> | undefined;
  let key: Promise<CryptoKey> | undefined;

  const signingKey = (): Promise<CryptoKey> => {
    key ??= importPrivateKey(serviceAccount.private_key).catch((error: unknown) => {
      key = undefined;
      throw new ChatApiError(400, "the service account's private_key is not a PKCS #8 RSA key", { tokenRefused: true, cause: error });
    });
    return key;
  };

  const exchange = async (): Promise<string> => {
    const seconds = Math.floor(options.clock.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", ...(serviceAccount.private_key_id !== undefined && { kid: serviceAccount.private_key_id }) };
    const claims = { iss: serviceAccount.client_email, scope: CHAT_SCOPE, aud: serviceAccount.token_uri, iat: seconds, exp: seconds + 3600 };
    const signing = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
    const signature = new Uint8Array(await crypto.subtle.sign(RS256, await signingKey(), encoder.encode(signing)));
    const assertion = `${signing}.${base64url(signature)}`;

    // A timer cleared once the exchange settles (a pending timer keeps a Durable Object awake).
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), EXCHANGE_TIMEOUT_MS);
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await fetcher(serviceAccount.token_uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: timeout.signal,
      });
      body = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    } catch (error) {
      const timedOut = timeout.signal.aborted;
      throw new ChatApiError(0, timedOut ? `the token endpoint did not answer within ${EXCHANGE_TIMEOUT_MS} ms` : "the token endpoint could not be reached", { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || typeof body.access_token !== "string") {
      // Google's words (`invalid_grant: Invalid JWT Signature.`), never the assertion or a token.
      const code = typeof body.error === "string" ? body.error : undefined;
      const words = [code, typeof body.error_description === "string" ? body.error_description : undefined].filter((each) => each !== undefined).join(": ");
      throw new ChatApiError(response.ok ? 502 : response.status, `the token endpoint refused the service account's key${words === "" ? ` (HTTP ${response.status})` : `: ${words}`}`, {
        ...(code !== undefined && { code }),
        tokenRefused: true,
        ...(response.status === 429 && { retryAfterMs: retryAfterMs(response.headers.get("retry-after"), options.clock.now()) ?? 1_000 }),
      });
    }
    const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in * 1000 : 3_600_000;
    kept = { token: body.access_token, expiresAt: options.clock.now() + lifetime };
    return body.access_token;
  };

  return {
    async token(signal) {
      if (kept !== undefined && options.clock.now() < kept.expiresAt - MARGIN_MS) return kept.token;
      // One exchange at a time, shared: a caller that gives up does not cut it for the others.
      const shared = (exchanging ??= exchange().finally(() => {
        exchanging = undefined;
      }));
      if (signal === undefined) return shared;
      if (signal.aborted) throw new ChatApiError(0, "the call was cut before a token was asked for", { cause: signal.reason });
      return new Promise<string>((resolve, reject) => {
        const cut = () => reject(new ChatApiError(0, "the call was cut while a token was asked for", { cause: signal.reason }));
        signal.addEventListener("abort", cut, { once: true });
        shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", cut));
      });
    },
  };
}

/** A PEM `PRIVATE KEY` (PKCS #8) as an RS256 signing key. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, RS256, false, ["sign"]);
}

/** `bytes` as base64url, no padding (no `Buffer`: it runs in a Worker). */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A `Retry-After` header (seconds, or an HTTP date) in ms from `now`; `undefined` when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
