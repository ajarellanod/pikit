// Owner: ingress. Google's ID token checked with WebCrypto (features/channel-google-chat.md "Ingress").
/**
 * Every event's `Authorization: Bearer <token>` is an OpenID Connect ID token Google signed (RS256)
 * for the app. Checked here, with WebCrypto only (no `google-auth-library`: it does not run in a
 * Worker), before anything else reads the request:
 *
 * - the signature, against the JWKs at `jwksUrl` (the `jwks_uri` of Google's discovery document,
 *   `https://www.googleapis.com/oauth2/v3/certs`), by the header's `kid`, `alg` RS256 only, the keys
 *   kept as their `Cache-Control: max-age` says and fetched again for a `kid` they lack (at most once
 *   a minute: a forged `kid` must not make every request fetch);
 * - `iss` is `https://accounts.google.com` or `accounts.google.com`;
 * - `aud` is the endpoint URL exactly as configured (`Credentials.audience`);
 * - `email` is the add-on's service account (`Credentials.tokenEmail`,
 *   `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`) and `email_verified` true;
 * - `exp` has not passed on `clock` (a skew of a minute at most, a value), `iat` not in the future.
 *
 * A refusal says why (`Verification.reason`, logged by the route, which answers 401 and never says it).
 * A reason never holds the token. Tests: `fake-google-chat.test-support.ts`'s `createIdTokens` signs
 * tokens with a test key pair and serves its JWKs.
 */

import type { Clock } from "@pikit/core";
import type { IdTokenClaims, IdTokenVerifier, Jwks, Verification } from "./types.ts";

/** The issuers Google's ID tokens carry. */
export const ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];
/** How far, in ms, the clocks of Google and this host may disagree on `exp` and `iat`. */
export const CLOCK_SKEW_MS = 60_000;
/** Google's keys are fetched again for an unknown `kid` at most this often (ms), and kept at least this long. */
export const REFETCH_MS = 60_000;
/** While Google's keys cannot be fetched, the keys kept are used this long (ms) past their expiry. */
export const JWKS_GRACE_MS = 3_600_000;
/** The deadline, in ms, of a fetch of Google's keys. */
export const JWKS_TIMEOUT_MS = 10_000;
/** A longer `Authorization` header is no ID token of Google's. */
const MAX_TOKEN_LENGTH = 8_192;

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export interface JwksOptions {
  /** `Config.jwksUrl`. */
  url: string;
  clock: Clock;
  /** A value, for tests; the global `fetch` by default. */
  fetch?: typeof fetch;
  /** How long, in ms, the keys kept are used past their expiry while the fetch fails: `JWKS_GRACE_MS` by default. */
  graceMs?: number;
}

/** `work`, or a rejection with `signal`'s reason once it is aborted (`work` goes on for whoever else waits). */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** `max-age` of a `Cache-Control` header, in ms, or `undefined`. */
function maxAgeOf(header: string | null): number | undefined {
  const match = /(?:^|[,\s])max-age\s*=\s*"?(\d+)"?/i.exec(header ?? "");
  return match === null ? undefined : Number(match[1]) * 1000;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Google's keys at `options.url`: fetched on first use (never at start: a start makes no request),
 * imported as RS256 `CryptoKey`s (`crypto.subtle.importKey("jwk", …, { name: "RSASSA-PKCS1-v1_5",
 * hash: "SHA-256" }, false, ["verify"])`), kept until their `max-age` (a minute at least, also without
 * one), fetched again for an unknown `kid` at most once a minute. Concurrent callers share one fetch.
 * **A failed fetch** is not tried again for a minute (`REFETCH_MS`): meanwhile, and while it keeps
 * failing, the keys kept are used up to `JWKS_GRACE_MS` past their expiry (`graceMs`, a value). With
 * no key usable, `key` rejects with the fetch's failure, and the route answers 500 (Google retries),
 * never 401.
 */
export function createJwks(options: JwksOptions): Jwks {
  const { url, clock } = options;
  const fetcher: typeof fetch = options.fetch ?? (((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init)) as typeof fetch);
  let cache: { keys: Map<string, CryptoKey>; expires: number } | undefined;
  let pending: Promise<void> | undefined;
  /** When the last fetch began: an unknown `kid` fetches again only `REFETCH_MS` after it. */
  let lastFetch = Number.NEGATIVE_INFINITY;
  /** The last fetch's failure, until one succeeds: no fetch again before `REFETCH_MS` after it began. */
  let failure: unknown;
  const graceMs = options.graceMs ?? JWKS_GRACE_MS;

  const load = async (): Promise<void> => {
    let response: Response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`channel-google-chat: Google's signing keys (${url}) could not be fetched: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!response.ok) throw new Error(`channel-google-chat: Google's signing keys (${url}) answered ${response.status}`);
    const body = (await response.json().catch(() => undefined)) as unknown;
    const listed = isObject(body) && Array.isArray(body.keys) ? body.keys : [];
    const keys = new Map<string, CryptoKey>();
    for (const jwk of listed) {
      if (!isObject(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      if ((jwk.alg !== undefined && jwk.alg !== "RS256") || (jwk.use !== undefined && jwk.use !== "sig")) continue;
      try {
        keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, RS256, false, ["verify"]));
      } catch {
        // A key WebCrypto cannot read signs nothing this channel checks.
      }
    }
    if (keys.size === 0) throw new Error(`channel-google-chat: Google's signing keys (${url}) hold no RS256 key`);
    cache = { keys, expires: clock.now() + Math.max(maxAgeOf(response.headers.get("cache-control")) ?? 0, REFETCH_MS) };
  };

  const refresh = (signal: AbortSignal | undefined): Promise<void> => {
    if (pending === undefined) {
      lastFetch = clock.now();
      pending = load()
        .then(
          () => {
            failure = undefined;
          },
          (error: unknown) => {
            failure = error;
            throw error;
          },
        )
        .finally(() => {
          pending = undefined;
        });
      // Whoever waits sees the failure; a fetch nobody waits for any more (all aborted) is not unhandled.
      pending.catch(() => {});
    }
    return abortable(pending, signal);
  };

  return {
    async key(kid, signal) {
      const now = clock.now();
      const due = pending !== undefined || now - lastFetch >= REFETCH_MS;
      if (cache === undefined || now >= cache.expires) {
        // Expired: fetched again, at most once a minute after a failure; the keys kept serve a while meanwhile.
        const usable = cache !== undefined && now < cache.expires + graceMs;
        if (failure === undefined || due) {
          try {
            await refresh(signal);
          } catch (error) {
            if (!usable || signal?.aborted === true) throw error;
          }
        } else if (!usable) throw failure;
      } else if (!cache.keys.has(kid) && due) await refresh(signal);
      return cache?.keys.get(kid);
    },
  };
}

export interface VerifierOptions {
  jwks: Jwks;
  /** `Credentials.audience`. */
  audience: string;
  /** `Credentials.tokenEmail`. */
  email: string;
  clock: Clock;
}

/** `part` (base64url, no padding) as bytes, or `undefined` when it is not base64url. */
function base64url(part: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) return undefined;
  try {
    const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (part.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** `part` as a JSON object, or `undefined`. */
function jsonPart(part: string): Record<string, unknown> | undefined {
  const bytes = base64url(part);
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const refused = (reason: string): Verification => ({ ok: false, reason });

/** Checks a request's bearer token as the header says; one per instance (its audience and email), sharing one `Jwks`. */
export function createIdTokenVerifier(options: VerifierOptions): IdTokenVerifier {
  const { jwks, audience, email, clock } = options;
  const encoder = new TextEncoder();
  return {
    async verify(authorization, signal) {
      if (authorization === null) return refused("no Authorization header");
      const match = /^Bearer +(\S+)$/i.exec(authorization.trim());
      if (match === null) return refused("the Authorization header is not a bearer token");
      const token = match[1] ?? "";
      if (token.length > MAX_TOKEN_LENGTH) return refused("the token is too long to be an ID token");
      const parts = token.split(".");
      if (parts.length !== 3) return refused("the token is not a JWT (three parts)");
      const [headerPart = "", claimsPart = "", signaturePart = ""] = parts;
      const header = jsonPart(headerPart);
      const claims = jsonPart(claimsPart);
      const signature = base64url(signaturePart);
      if (header === undefined || claims === undefined || signature === undefined) return refused("the token is not a JWT (its parts are not base64url JSON)");
      if (header.alg !== "RS256") return refused(`the token's alg is ${JSON.stringify(header.alg)}, not RS256`);
      if (typeof header.kid !== "string" || header.kid === "") return refused("the token's header names no key (kid)");

      // Rejects when Google's keys cannot be fetched: the route answers 500, and Google retries.
      const key = await jwks.key(header.kid, signal);
      if (key === undefined) return refused(`the token is signed by a key Google does not publish (kid ${JSON.stringify(header.kid)})`);
      if (!(await crypto.subtle.verify(RS256, key, signature, encoder.encode(`${headerPart}.${claimsPart}`)))) return refused("the token's signature is not Google's");

      const { iss, aud, email: tokenEmail, email_verified: verified, exp, iat, sub } = claims;
      if (typeof iss !== "string" || !ISSUERS.includes(iss)) return refused(`the token's issuer is ${JSON.stringify(iss)}, not Google's`);
      if (aud !== audience) return refused(`the token's audience is ${JSON.stringify(aud)}, not the endpoint URL ${JSON.stringify(audience)}`);
      if (tokenEmail !== email) return refused(`the token's email is ${JSON.stringify(tokenEmail)}, not the add-on's service account ${email}`);
      if (verified !== true) return refused("the token's email is not verified");
      if (typeof exp !== "number" || !Number.isFinite(exp)) return refused("the token has no expiry (exp)");
      const now = clock.now();
      if (now > exp * 1000 + CLOCK_SKEW_MS) return refused("the token has expired");
      if (iat !== undefined && (typeof iat !== "number" || iat * 1000 > now + CLOCK_SKEW_MS)) return refused("the token is issued in the future (iat)");

      const checked: IdTokenClaims = { iss, aud: audience, email, email_verified: true, exp, ...(typeof iat === "number" && { iat }), ...(typeof sub === "string" && { sub }) };
      return { ok: true, claims: checked };
    },
  };
}
