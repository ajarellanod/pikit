/**
 * `admin.auth`: whether an HTTP request is an operator's. Every admin API route (admin-api's, a
 * component's own, SPEC §5) asks it before answering, and answers `401` when it says no (the
 * dashboard's built files hold no data and are served without it: a browser's navigation sends no
 * header):
 *
 *   const operator = await auth.get().verify(request, ctx);
 *   if (operator === undefined) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
 *
 * A provider decides how an operator proves it (a bearer token from `secrets` in `admin-auth-token`,
 * an SSO header, Cloudflare Access later); routes never know. What every provider guarantees:
 * - **Closed by default.** No credential, or a wrong one, is `undefined`, never an operator. A
 *   provider that could verify nobody (its secret is not set) fails the app's start, loudly, rather
 *   than lock every operator out or let everyone in.
 * - **Nothing leaks.** The credential never appears in the operator, a log line or an error, and
 *   `verify` never throws for a bad credential.
 * - **No state.** It reads the request's headers and answers; it never consumes the body, so the
 *   route still reads it.
 *
 * **Browser sessions** (`sessions`, optional). A browser keeps no credential a script could read: the
 * dashboard posts the credential once (admin-api's `POST /admin/api/session`), and the provider answers
 * a session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` over https, expiring), which `verify`
 * then takes as the operator. A request authenticated by that cookie whose method changes something
 * (not `GET`, `HEAD`, `OPTIONS`) must also carry `ADMIN_CLIENT_HEADER`, which a page of another site
 * cannot send without the server's consent (CORS): with `SameSite=Strict`, that is the CSRF defence.
 * A provider without `sessions` is sent the credential with every request.
 */

import type { AppContext } from "@pikit/core";

/**
 * The header every request of the dashboard carries (`x-pikit-admin: 1`): a request a session cookie
 * authenticates must have it to change anything.
 */
export const ADMIN_CLIENT_HEADER = "x-pikit-admin";

/** Who an operator is, as the provider knows it. */
export interface Operator {
  /** A stable name for logs and audit (`operator`, an email): never the credential. */
  id: string;
}

/** A browser's session: a signed, expiring cookie in exchange for the operator's credential. */
export interface AdminSessions {
  /**
   * A session for the operator whose credential `request` carries (never a session's cookie: only the
   * credential opens one): the operator and the `Set-Cookie` header value, or `undefined` when the
   * request is not an operator's. The cookie holds no credential.
   */
  open(request: Request, ctx: AppContext): Promise<{ operator: Operator; cookie: string } | undefined>;
  /** The `Set-Cookie` header value that ends `request`'s browser session. */
  close(request: Request): string;
}

export interface AdminAuth {
  /** The operator who sent `request`, or `undefined` when it is not an operator's. */
  verify(request: Request, ctx: AppContext): Promise<Operator | undefined>;
  /** Browser sessions, when the provider has them. */
  readonly sessions?: AdminSessions;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "admin.auth": AdminAuth;
  }
}
