/**
 * The Worker's cheap session check (Cloudflare): the user from better-auth's signed cookie cache
 * (`session_data`, `getCookieCache`), without a call to the accounts actor. `undefined` when the
 * cache is missing, expired, tampered with, or not the session's (its token is not the signed
 * `session_token` cookie's, as better-auth's own `getSession` checks): the caller then asks the
 * accounts actor, which reads the database and refreshes the cache.
 *
 * It imports only `better-auth/cookies`, never the better-auth instance: the Worker's bundle stays
 * small. A ban or a removal takes effect within the cache's lifetime (`sessionCacheSeconds`).
 */

import { getCookieCache } from "better-auth/cookies";
import type { AccountUser } from "./types.ts";

/** better-auth's cookie name prefix and the one on https (`local.ts`' `COOKIE_PREFIX`). */
const COOKIE_PREFIX = "pikit_chat";
const SECURE = "__Secure-";

/** Whether the request's cookies are the `__Secure-` ones: on https, or `publicUrl`'s scheme. */
const isSecure = (request: Request, publicUrl: string | undefined): boolean => new URL(publicUrl ?? request.url).protocol === "https:";

function cookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** A better-call signed cookie's value (`value.base64(HMAC-SHA256(secret, value))`), or `undefined`. */
async function signedValue(signed: string, secret: string): Promise<string | undefined> {
  const dot = signed.lastIndexOf(".");
  if (dot < 1) return undefined;
  const value = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return undefined;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return (await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(value))) ? value : undefined;
}

/**
 * The user of `request`'s session from its cookie cache, or `undefined` (ask the accounts actor).
 * `secret` is `CHANNEL_WEB_AUTH_SECRET`; `publicUrl` is `PIKIT_PUBLIC_URL` when set.
 */
export async function cachedUser(request: Request, secret: string, publicUrl?: string): Promise<AccountUser | undefined> {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  const prefix = `${isSecure(request, publicUrl) ? SECURE : ""}${COOKIE_PREFIX}`;
  const signedToken = cookie(header, `${prefix}.session_token`);
  if (signedToken === undefined) return undefined;
  const token = await signedValue(signedToken, secret);
  if (token === undefined) return undefined;
  let payload: Awaited<ReturnType<typeof getCookieCache>>;
  try {
    payload = await getCookieCache(request, { cookiePrefix: COOKIE_PREFIX, isSecure: isSecure(request, publicUrl), secret });
  } catch {
    return undefined;
  }
  if (payload === null || payload.session.token !== token) return undefined;
  const user = payload.user as typeof payload.user & { banned?: boolean | null };
  if (user.banned === true) return undefined;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    ...(typeof user.image === "string" && user.image !== "" && { image: user.image }),
  };
}
