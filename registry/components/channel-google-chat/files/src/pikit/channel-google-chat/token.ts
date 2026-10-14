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
 * Tests: `fake-google-chat.test-support.ts`'s `createIdTokens` signs tokens with a test key pair and
 * serves its JWKs.
 */

import type { Clock } from "@pikit/core";
import type { IdTokenVerifier, Jwks } from "./types.ts";

/** The issuers Google's ID tokens carry. */
export const ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

export interface JwksOptions {
  /** `Config.jwksUrl`. */
  url: string;
  clock: Clock;
  /** A value, for tests; the global `fetch` by default. */
  fetch?: typeof fetch;
}

/**
 * Google's keys at `options.url`: fetched on first use (never at start: a start makes no request),
 * imported as RS256 `CryptoKey`s (`crypto.subtle.importKey("jwk", …, { name: "RSASSA-PKCS1-v1_5",
 * hash: "SHA-256" }, false, ["verify"])`), kept until their `max-age`, fetched again for an unknown
 * `kid` at most once a minute. A failed fetch rejects (`key`), and the route answers 500 (Google
 * retries), never 401.
 */
export function createJwks(options: JwksOptions): Jwks {
  void options;
  return {
    key: async () => {
      throw new Error("not implemented: ingress (token.ts createJwks)");
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

/** Checks a request's bearer token as the header says; one per instance (its audience and email), sharing one `Jwks`. */
export function createIdTokenVerifier(options: VerifierOptions): IdTokenVerifier {
  void options;
  return {
    verify: async () => {
      throw new Error("not implemented: ingress (token.ts createIdTokenVerifier)");
    },
  };
}
