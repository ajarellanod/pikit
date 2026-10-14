/**
 * The operator's routes over the chat's users (`admin-api.ts` says what each answers), behind
 * `admin.auth`: the operator lists, invites, bans, unbans, resets a password and removes. Without an
 * `admin.auth` installed, every one is `404`, as if absent (a component's routes are registered in
 * setup, before it knows what is installed).
 *
 * - Every action is logged with the operator's id and the user's id, never an email's body, a link or
 *   a token. A link is answered once, to the operator who asked.
 * - A link's origin is `PIKIT_PUBLIC_URL` when set, else the request's when its host is trusted
 *   (`linkOrigin`: on a server a loopback host only, on Cloudflare the Worker's): else `400
 *   public_url_required`, before anything is made, so no link goes out under a host a client wrote.
 * - Removing a user removes their sessions and accounts (the accounts), and their conversations leave
 *   the users' list (`ChatBackend.forget`); the runtime keeps the conversations.
 */

import type { AppContext, Handle, Pikit } from "@pikit/core";
import type { AdminAuth, Operator } from "@pikit/contracts";
import type { Accounts } from "./accounts/types.ts";
import type { AdminChatInvitation, AdminChatLink, AdminChatUsersPage, AdminChatUserState } from "./admin-api.ts";
import type { ChatBackend } from "./backend.ts";
import { PUBLIC_URL_REQUIRED } from "./accounts/links.ts";
import { failure } from "./routes.ts";

export const ADMIN = "/admin/api/channel-web";

const MAX_LIMIT = 100;
const MAX_BODY = 8 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The status of each refusal of the accounts; any other failure is `503`. */
const STATUS: Record<string, number> = { not_found: 404, exists: 409, invalid_request: 400, invalid_cursor: 400 };

const json = <T>(status: number, body: T): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AdminRouteOptions {
  auth: Handle<AdminAuth | undefined>;
  accounts(): Accounts;
  backend(): ChatBackend;
  /** The origin links are made under (`linkOrigin`); `undefined` when the request's host is not trusted. */
  origin(request: Request): string | undefined;
}

/** The `:id` of `/admin/api/channel-web/users/:id/…`. */
function userIdOf(request: Request): string {
  const raw = new URL(request.url).pathname.split("/")[5] ?? "";
  let id = "";
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Below.
  }
  if (id === "" || id.length > 200) throw new Refused(404, "not_found", "no such user");
  return id;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new Refused(413, "too_large", "the body is too large");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Refused(413, "too_large", "the body is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refused(400, "invalid_request", "the body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Refused(400, "invalid_request", "the body is a JSON object");
  return body as Record<string, unknown>;
}

export function provideAdminRoutes(pikit: Pikit, options: AdminRouteOptions): void {
  const admin = (key: string, handler: (request: Request, ctx: AppContext, operator: Operator) => Promise<Response>): void => {
    pikit.provideKeyed("http.route", key, async (request, ctx) => {
      const auth = options.auth.get();
      if (auth === undefined) return failure(404, "not_found");
      const operator = await auth.verify(request, ctx);
      if (operator === undefined) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="pikit"', "cache-control": "no-store" } });
      try {
        return await handler(request, ctx, operator);
      } catch (error) {
        if (error instanceof Refused) return failure(error.status, error.code, error.message);
        const code = (error as { code?: unknown } | null)?.code;
        const status = typeof code === "string" ? STATUS[code] : undefined;
        if (status !== undefined) return failure(status, code as string, error instanceof Error ? error.message : undefined);
        ctx.logger.warn("channel-web: an operator's action on the chat's users failed", { route: key, operator: operator.id, error: error instanceof Error ? error.message : String(error) });
        return failure(503, "unavailable", "the accounts could not be reached: try again in a moment");
      }
    });
  };
  const accounts = () => options.accounts();
  const originOf = (request: Request): string => {
    const origin = options.origin(request);
    if (origin === undefined) throw new Refused(400, PUBLIC_URL_REQUIRED.error, PUBLIC_URL_REQUIRED.message);
    return origin;
  };

  admin(`GET ${ADMIN}/users`, async (request, ctx) => {
    const params = new URL(request.url).searchParams;
    const raw = params.get("limit");
    const limit = raw === null ? 50 : Number(raw);
    if (raw !== null && (!/^[0-9]+$/.test(raw) || limit < 1 || limit > MAX_LIMIT)) throw new Refused(400, "invalid_request", `limit is an integer from 1 to ${MAX_LIMIT}`);
    const cursor = params.get("cursor");
    const page = await accounts().list({ limit, ...(cursor !== null && { cursor }) }, ctx);
    return json<AdminChatUsersPage>(200, page);
  });

  admin(`POST ${ADMIN}/invitations`, async (request, ctx, operator) => {
    const body = await bodyOf(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254) throw new Refused(400, "invalid_request", "/email: an email address");
    if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 120)) throw new Refused(400, "invalid_request", "/name: at most 120 characters");
    const name = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : undefined;
    const invited = await accounts().invite({ email, ...(name !== undefined && { name }) }, originOf(request), ctx);
    ctx.logger.info("channel-web: an operator invited a user", { operator: operator.id, user: invited.userId, emailed: invited.emailed });
    return json<AdminChatInvitation>(201, { userId: invited.userId, link: invited.link, expiresAt: invited.expiresAt, emailed: invited.emailed });
  });

  for (const [action, banned] of [
    ["ban", true],
    ["unban", false],
  ] as const) {
    admin(`POST ${ADMIN}/users/:id/${action}`, async (request, ctx, operator) => {
      const id = userIdOf(request);
      await accounts().ban(id, banned, ctx);
      ctx.logger.info(`channel-web: an operator ${banned ? "banned" : "unbanned"} a user`, { operator: operator.id, user: id });
      return json<AdminChatUserState>(200, { id, banned });
    });
  }

  admin(`POST ${ADMIN}/users/:id/password-reset`, async (request, ctx, operator) => {
    const id = userIdOf(request);
    const link = await accounts().resetLink(id, originOf(request), ctx);
    ctx.logger.info("channel-web: an operator made a password reset link", { operator: operator.id, user: id, emailed: link.emailed });
    return json<AdminChatLink>(200, { link: link.link, expiresAt: link.expiresAt, emailed: link.emailed });
  });

  admin(`DELETE ${ADMIN}/users/:id`, async (request, ctx, operator) => {
    const id = userIdOf(request);
    await accounts().remove(id, ctx);
    await options.backend().forget(id, ctx);
    ctx.logger.info("channel-web: an operator removed a user", { operator: operator.id, user: id });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}
