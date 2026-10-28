/**
 * The operator's routes, each a call to the owner (`calls.ts`). Registered by both halves: the App's
 * own on a server (server-bun serves them, and the owner is the App itself), the Worker's on
 * Cloudflare (`worker.ts`; the owner is an object).
 *
 * | Route | What |
 * |---|---|
 * | `GET /admin/api/tool-mcp-oauth` | `{ servers: [{ server, url, loggedIn, expiresAt?, reason? }] }`: every server in config, no secret |
 * | `PUT /admin/api/tool-mcp-oauth/:server` | the body is a login (`{ url, clientInformation, tokens, tokensExpireAt?, discovery }`, what `pikit tool-mcp-oauth login` uploads) → the server's status |
 * | `DELETE /admin/api/tool-mcp-oauth/:server` | `{ deleted }`: a logout |
 *
 * Every route asks `admin.auth` first (without a provider, nobody: `401`). A server not in config, or
 * a login for another URL or of no known shape, is `400`. No route answers a token, and none is
 * logged: an operator can replace or delete a login, never read it back. An error is
 * `{ error, message? }`; an owner that cannot be reached is `503`, logged.
 */

import type { AppContext, Handle, Pikit } from "@pikit/core";
import { ActorCallError, type AdminAuth, type JsonValue } from "@pikit/contracts";
import { CALL, json, loginOf, REFUSAL, SERVER_NAME } from "./calls.ts";

export const ROUTE = "/admin/api/tool-mcp-oauth";
/** A login is a few kilobytes (the discovery metadata); anything much bigger is not one. */
const MAX_BODY = 64 * 1024;
const NO_STORE = { "cache-control": "no-store" };

const failure = (status: number, error: string, message?: string): Response =>
  Response.json({ error, ...(message !== undefined && { message }) }, { status, headers: status === 401 ? { ...NO_STORE, "www-authenticate": 'Bearer realm="pikit"' } : NO_STORE });

/** The server name at the end of the path, or `undefined` when it is not one. */
function serverOf(request: Request): string | undefined {
  const last = new URL(request.url).pathname.split("/").at(-1) ?? "";
  try {
    const server = decodeURIComponent(last);
    return SERVER_NAME.test(server) ? server : undefined;
  } catch {
    return undefined;
  }
}

export interface RouteOptions {
  auth: Handle<AdminAuth | undefined>;
  /** A call to the owner. */
  ask(type: string, message: JsonValue, ctx: AppContext): Promise<JsonValue>;
}

export function provideRoutes(pikit: Pikit, options: RouteOptions): void {
  const guarded =
    (work: (request: Request, ctx: AppContext) => Promise<Response>) =>
    async (request: Request, ctx: AppContext): Promise<Response> => {
      const verifier = options.auth.get();
      if (verifier === undefined || (await verifier.verify(request, ctx)) === undefined) return failure(401, "unauthorized");
      try {
        return await work(request, ctx);
      } catch (error) {
        if (error instanceof ActorCallError && error.code === REFUSAL.invalid) return failure(400, error.code, error.message);
        // The owner's messages and the mailbox's hold no secret.
        ctx.logger.error("tool-mcp-oauth: the owner could not be reached", { error: error instanceof Error ? error.message : String(error) });
        return failure(503, "unavailable", "The MCP logins cannot be reached now: try again");
      }
    };
  const named = (work: (server: string, request: Request, ctx: AppContext) => Promise<Response>) =>
    guarded(async (request, ctx) => {
      const server = serverOf(request);
      if (server === undefined) return failure(400, REFUSAL.invalid, 'The path ends with a server name (letters, digits, "_", "-")');
      return work(server, request, ctx);
    });

  pikit.provideKeyed(
    "http.route",
    `GET ${ROUTE}`,
    guarded(async (_request, ctx) => Response.json(await options.ask(CALL.list, null, ctx), { headers: NO_STORE })),
  );
  pikit.provideKeyed(
    "http.route",
    `PUT ${ROUTE}/:server`,
    named(async (server, request, ctx) => {
      const text = await request.text();
      if (text.length > MAX_BODY) return failure(400, REFUSAL.invalid, "The body is too large for a login");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return failure(400, REFUSAL.invalid, "The body is not JSON");
      }
      const login = loginOf(body);
      // Says what is wrong with the shape, never what the body held.
      if (login === undefined) return failure(400, REFUSAL.invalid, "The body is a login: { url, clientInformation: { client_id }, tokens: { access_token, token_type }, tokensExpireAt?, discovery: { authorizationServerUrl } }");
      return Response.json(await options.ask(CALL.put, { server, login: json(login) }, ctx), { headers: NO_STORE });
    }),
  );
  pikit.provideKeyed(
    "http.route",
    `DELETE ${ROUTE}/:server`,
    named(async (server, _request, ctx) => Response.json(await options.ask(CALL.delete, { server }, ctx), { headers: NO_STORE })),
  );
}
