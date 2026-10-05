/**
 * admin-api's routes (`api.ts` says what each answers), written once over a backend (`backend.ts`):
 * a server's contracts, or on Cloudflare the Worker's calls to the objects. Both halves of the
 * component register them (`index.ts`, `worker.ts`).
 *
 * - Every `/admin/api/*` answer asks `admin.auth` first: no operator, `401`, nothing read. But the
 *   session's: `POST /admin/api/session` gives a browser a session cookie for the credential it posts
 *   once (`admin.auth`'s `sessions`), `DELETE` clears it. Both need the client's header
 *   (`ADMIN_CLIENT_HEADER`), so a page of another site cannot sign a browser in or out.
 * - What an operator writes (`backend.ts`): a message is a follow-up whose request id starts with
 *   `dashboard:`, and a new conversation is the dashboard's own, `dashboard:<uuid>`.
 * - A backend's refusal (`ActorCallError`) is its status: `not_found` `404`; `no_agent`, `not_current`
 *   `409`; `invalid_cursor`, `invalid_request` `400`. Any other code (an object that could not be
 *   reached, a call that failed) is `503 unavailable`, logged.
 * - Each action is logged with the operator's id and the conversation's key, never the message's text.
 * - Live events are server-sent events over a plain streaming response, a comment every
 *   `heartbeatMs`; the stream ends when the client goes away, the backend's events end, or the server
 *   stops. A browser's `EventSource` cannot send the token: the dashboard reads it with `fetch`.
 */

import type { AppContext, Handle, Pikit } from "@pikit/core";
import {
  ADMIN_CLIENT_HEADER,
  ActorCallError,
  type AdminAuth,
  DASHBOARD_REQUEST_PREFIX,
  type HttpRoute,
  type Operator,
  type OutboundQueue,
  type PageRequest,
} from "@pikit/contracts";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import {
  type ApiAbortResponse,
  type ApiApp,
  type ApiConversation,
  type ApiError,
  type ApiEvent,
  type ApiPage,
  type ApiPendingPiece,
  type ApiReceipt,
  type ApiReceiptsPage,
  type ApiResetResponse,
  type ApiSendResponse,
  type ApiSession,
  type ApiStartResponse,
  type ApiTranscriptEntry,
  DASHBOARD_KEY_PREFIX,
} from "./api.ts";
import { type Assets, BASE } from "./assets.ts";
import type { AdminBackend } from "./backend.ts";

/** A request id: what `ApiSendRequest.requestId` may be, the dashboard's (`dashboard:…`). */
const REQUEST_ID = `^${DASHBOARD_REQUEST_PREFIX}[A-Za-z0-9._~:-]{1,118}$`;
/** The largest page a client may ask for. */
const MAX_LIMIT = 500;
/** The longest message an operator may send, in characters. */
const MAX_TEXT = 32_000;

const SendBody = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    requestId: Type.Optional(Type.String({ pattern: REQUEST_ID })),
  },
  { additionalProperties: false },
);
const StartBody = Type.Object(
  {
    agent: Type.String({ minLength: 1, maxLength: 200 }),
    text: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    requestId: Type.Optional(Type.String({ pattern: REQUEST_ID })),
  },
  { additionalProperties: false },
);

/** The status of each refusal a backend throws; any other is `503`. */
const STATUS: Record<string, number> = { not_found: 404, no_agent: 409, not_current: 409, invalid_cursor: 400, invalid_request: 400, unknown_agent: 400 };

const json = <T>(status: number, body: T): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const failure = (status: number, error: string, message?: string): Response =>
  json<ApiError>(status, { error, ...(message !== undefined && message !== "" && { message }) });
const UNAUTHORIZED = (): Response =>
  Response.json({ error: "unauthorized" } satisfies ApiError, { status: 401, headers: { "www-authenticate": 'Bearer realm="pikit"', "cache-control": "no-store" } });

/** The `:id` of `/admin/api/conversations/:id/…`, decoded; `""` when malformed. */
function conversationIdOf(request: Request): string {
  const raw = new URL(request.url).pathname.split("/")[4] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** `?limit&cursor`, or what is wrong with them. */
function pageOf(request: Request): PageRequest | { problem: string } {
  const params = new URL(request.url).searchParams;
  const page: PageRequest = {};
  const limit = params.get("limit");
  if (limit !== null) {
    const value = Number(limit);
    if (!/^[0-9]+$/.test(limit) || value < 1 || value > MAX_LIMIT) return { problem: `limit is an integer from 1 to ${MAX_LIMIT}` };
    page.limit = value;
  }
  const cursor = params.get("cursor");
  if (cursor !== null) page.cursor = cursor;
  return page;
}

/** `request`'s JSON body, checked against `schema`, or what is wrong with it. */
async function readBody<S extends typeof SendBody | typeof StartBody>(request: Request, schema: S): Promise<{ body: Static<S> } | { problem: string }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { problem: "the body is not JSON" };
  }
  if (Value.Check(schema, parsed)) return { body: parsed as Static<S> };
  const [first] = Value.Errors(schema, parsed);
  return { problem: `${first?.instancePath || "the body"}: ${first?.message ?? "is invalid"}` };
}

/** The request id of an operator's message: the client's, or a new one. */
const requestIdOf = (given: string | undefined): string => given ?? `${DASHBOARD_REQUEST_PREFIX}${crypto.randomUUID()}`;

/**
 * `events` as server-sent events, a comment every `heartbeatMs`; cancelling the response stops them.
 * Events that fail end the stream with an `error` event (logged, never its details).
 */
function eventStream(events: AsyncIterable<ApiEvent>, heartbeatMs: number, ctx: AppContext): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const finish = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          finish();
        }
      }, heartbeatMs);
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done === true) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) {
        finish();
        ctx.logger.warn("admin-api: a conversation's live events stopped", { error: error instanceof Error ? error.message : String(error) });
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "watch_failed" } satisfies ApiError)}\n\n`));
        controller.close();
      }
    },
    async cancel() {
      finish();
      await iterator.return?.();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

export interface RouteOptions {
  auth: Handle<AdminAuth>;
  /** Read in a handler, never in setup. */
  backend(): AdminBackend;
  /** The outbound queue delivery is read from; `undefined` when none is installed here. */
  queue(): OutboundQueue | undefined;
  /** What `/admin/api/delivery/*` says without a queue. */
  noQueue: string;
  heartbeatMs: number;
  assets: Assets;
}

/** Registers every admin route of the App `pikit` sets up, and the dashboard's files. */
export function provideRoutes(pikit: Pikit, options: RouteOptions): void {
  /** An API route: answers only an operator; a backend's refusal is its status. */
  const api = (key: string, handler: (request: Request, ctx: AppContext, operator: Operator) => Promise<Response>): void => {
    const route: HttpRoute = async (request, ctx) => {
      const operator = await options.auth.get().verify(request, ctx);
      if (operator === undefined) return UNAUTHORIZED();
      try {
        return await handler(request, ctx, operator);
      } catch (error) {
        if (!(error instanceof ActorCallError)) throw error;
        const status = STATUS[error.code];
        if (status !== undefined) return failure(status, error.code, error.message);
        ctx.logger.warn("admin-api: a conversation's object did not answer", { route: key, code: error.code, error: error.message });
        return failure(503, "unavailable", error.message);
      }
    };
    pikit.provideKeyed("http.route", key, route);
  };
  const backend = () => options.backend();

  // A browser's session: the credential once, then a cookie (`admin.auth`'s `sessions`).
  const session = (key: string, handler: HttpRoute): void => {
    pikit.provideKeyed("http.route", key, async (request, ctx) => {
      if (request.headers.get(ADMIN_CLIENT_HEADER) === null) return failure(400, "invalid_request", `send the header ${ADMIN_CLIENT_HEADER}: 1`);
      return handler(request, ctx);
    });
  };
  session("POST /admin/api/session", async (request, ctx) => {
    const sessions = options.auth.get().sessions;
    if (sessions === undefined) return failure(404, "not_installed", "this admin.auth has no browser sessions: send the credential with every call");
    const opened = await sessions.open(request, ctx);
    if (opened === undefined) return UNAUTHORIZED();
    ctx.logger.info("admin-api: an operator signed in", { operator: opened.operator.id });
    return Response.json({ operator: opened.operator.id } satisfies ApiSession, { headers: { "set-cookie": opened.cookie, "cache-control": "no-store" } });
  });
  session("DELETE /admin/api/session", async (request) => {
    const sessions = options.auth.get().sessions;
    return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...(sessions !== undefined && { "set-cookie": sessions.close(request) }) } });
  });

  api("GET /admin/api/app", async (_request, ctx) => json<ApiApp>(200, await backend().app(ctx)));

  api("GET /admin/api/conversations", async (request, ctx) => {
    const page = pageOf(request);
    if ("problem" in page) return failure(400, "invalid_request", page.problem);
    return json<ApiPage<ApiConversation>>(200, await backend().conversations(page, ctx));
  });

  api("GET /admin/api/conversations/:id", async (request, ctx) => json<ApiConversation>(200, await backend().conversation(conversationIdOf(request), ctx)));

  api("GET /admin/api/conversations/:id/transcript", async (request, ctx) => {
    const page = pageOf(request);
    if ("problem" in page) return failure(400, "invalid_request", page.problem);
    return json<ApiPage<ApiTranscriptEntry>>(200, await backend().transcript(conversationIdOf(request), page, ctx));
  });

  api("GET /admin/api/conversations/:id/events", async (request, ctx) => eventStream(await backend().live(conversationIdOf(request), ctx), options.heartbeatMs, ctx));

  api("POST /admin/api/conversations", async (request, ctx, operator) => {
    const read = await readBody(request, StartBody);
    if ("problem" in read) return failure(400, "invalid_request", read.problem);
    const requestId = requestIdOf(read.body.requestId);
    const key = `${DASHBOARD_KEY_PREFIX}${crypto.randomUUID()}`;
    const started = await backend().start({ key, agent: read.body.agent, text: read.body.text, requestId }, ctx);
    ctx.logger.info("admin-api: an operator started a conversation", { operator: operator.id, conversation: key, agent: read.body.agent, requestId });
    return json<ApiStartResponse>(201, started);
  });

  api("POST /admin/api/conversations/:id/messages", async (request, ctx, operator) => {
    const read = await readBody(request, SendBody);
    if ("problem" in read) return failure(400, "invalid_request", read.problem);
    const requestId = requestIdOf(read.body.requestId);
    const sent = await backend().send(conversationIdOf(request), { text: read.body.text, requestId }, ctx);
    ctx.logger.info("admin-api: an operator sent a message", { operator: operator.id, conversation: sent.key, requestId, admission: sent.admission });
    return json<ApiSendResponse>(202, { requestId: sent.requestId, admission: sent.admission });
  });

  api("POST /admin/api/conversations/:id/abort", async (request, ctx, operator) => {
    const aborted = await backend().abort(conversationIdOf(request), ctx);
    ctx.logger.info("admin-api: an operator aborted a run", { operator: operator.id, conversation: aborted.key });
    return json<ApiAbortResponse>(200, { conversationId: aborted.conversationId });
  });

  api("POST /admin/api/conversations/:id/reset", async (request, ctx, operator) => {
    const reset = await backend().reset(conversationIdOf(request), ctx);
    ctx.logger.info("admin-api: an operator reset a conversation", { operator: operator.id, conversation: reset.key });
    return json<ApiResetResponse>(200, reset);
  });

  /** A page read with the client's cursor: a queue refuses a cursor it did not give. */
  const paged = async <T>(cursor: string | undefined, read: () => Promise<T>): Promise<T | Response> => {
    if (cursor === undefined) return read();
    try {
      return await read();
    } catch {
      return failure(400, "invalid_cursor", "the cursor is not one this API gave");
    }
  };

  api("GET /admin/api/delivery/pending", async (request) => {
    const outbound = options.queue();
    if (outbound === undefined) return failure(404, "not_installed", options.noQueue);
    const page = pageOf(request);
    if ("problem" in page) return failure(400, "invalid_request", page.problem);
    const result = await paged(page.cursor, () => outbound.pending(page));
    if (result instanceof Response) return result;
    return json<ApiPage<ApiPendingPiece>>(200, result as ApiPage<ApiPendingPiece>);
  });

  api("GET /admin/api/delivery/receipts", async (request) => {
    const outbound = options.queue();
    if (outbound === undefined) return failure(404, "not_installed", options.noQueue);
    const after = new URL(request.url).searchParams.get("after") ?? undefined;
    const page = pageOf(request);
    if ("problem" in page) return failure(400, "invalid_request", page.problem);
    const read = await paged(after, () => outbound.receipts.read(after, page.limit ?? 100));
    if (read instanceof Response) return read;
    const items = read.items.map(({ cursor, fact }) => ({ cursor, ...fact }) as ApiReceipt);
    const next = items.at(-1)?.cursor ?? after;
    return json<ApiReceiptsPage>(200, { items, gap: read.gap, ...(next !== undefined && { next }) });
  });

  // Under /admin/api/ a path no route above serves is the API's 404, never the dashboard's page.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) api(`${method} /admin/api/*`, async () => failure(404, "not_found"));

  pikit.provideKeyed("http.route", `GET ${BASE}/*`, (request) => options.assets.serve(new URL(request.url).pathname));
}
