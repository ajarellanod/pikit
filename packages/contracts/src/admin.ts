/**
 * `admin.auth`: whether an HTTP request is an operator's. Every admin route (the dashboard's API and
 * assets, a component's own view, SPEC §5) asks it before answering, and answers `401` when it says no:
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
 */

import type { AppContext } from "@pikit/core";

/** Who an operator is, as the provider knows it. */
export interface Operator {
  /** A stable name for logs and audit (`operator`, an email): never the credential. */
  id: string;
}

export interface AdminAuth {
  /** The operator who sent `request`, or `undefined` when it is not an operator's. */
  verify(request: Request, ctx: AppContext): Promise<Operator | undefined>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "admin.auth": AdminAuth;
  }
}
