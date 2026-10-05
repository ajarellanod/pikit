/**
 * admin-api: the operator's HTTP API (SPEC §5), what the dashboard reads and does, and the dashboard's
 * built files. The routes and their JSON are in `api.ts`.
 *
 * - **Every API answer asks `admin.auth`** first: no operator, `401`. The dashboard's files hold no
 *   data and are served to anyone (`assets.ts`): a browser's navigation sends no header.
 * - **It reads contracts, never internals:** the composition from `APP_DESCRIPTION` (K13), the runtime
 *   from `agent.observe`. Nothing it reads changes anything.
 * - **Every action goes through the contract that owns it:** a message through `agent.runtime`'s
 *   `dispatch` (a steer by default), an abort through its `abort`, a reset through
 *   `conversations.registry`'s `reset`. Each is logged with the operator's id and the conversation,
 *   never the message's text.
 * - **Delivery, when an `outbound.queue` is installed:** the pieces not delivered yet (`pending`) and
 *   those that settled (`receipts`, read after a cursor), as the queue keeps them; never their text.
 * - **Only a conversation's current one is talked to.** A message, an abort or a reset to a
 *   conversation a reset left behind is `409 not_current`: its key points elsewhere, and the answer
 *   would reach the chat from a conversation it no longer shows.
 * - **A message from the dashboard is part of the conversation.** Its run's answer goes where the
 *   conversation's other answers go (the chat of its channel), as any message's does.
 * - **Live events are server-sent events** over a plain streaming response, so any host serves them.
 *   A comment every `heartbeatMs` keeps idle connections open. The stream ends when the client goes
 *   away or the server stops. A browser's `EventSource` cannot send the token: the dashboard reads
 *   the stream with `fetch`.
 *
 * Targets: `server` (the files are read from disk; on Cloudflare the Worker's App has no
 * `agent.observe`, features/cloudflare-conversation-index.md).
 */

import { APP_DESCRIPTION, type AppContext, defineComponent } from "@pikit/core";
import type { ConversationRef, HttpRoute, ObservedConversation, ObservedEvent, Operator, PageRequest } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { ApiAbortResponse, ApiApp, ApiConversation, ApiError, ApiPage, ApiPendingPiece, ApiReceipt, ApiReceiptsPage, ApiResetResponse, ApiSendResponse, ApiTranscriptEntry } from "./api.ts";
import { BASE, createAssets } from "./assets.ts";

const Config = Type.Object({
  /** The dashboard's built files, from the working directory. */
  assets: Type.String({ minLength: 1, default: "src/dashboard/dist" }),
  /** How often an idle event stream gets a comment, so that nothing between closes it. */
  heartbeatMs: Type.Integer({ minimum: 1000, default: 15_000 }),
});

/** A request id: what `ApiSendRequest.requestId` may be. */
const REQUEST_ID = "^[A-Za-z0-9._~:-]{1,128}$";
/** The largest page a client may ask for. */
const MAX_LIMIT = 500;
/** The longest message an operator may send, in characters. */
const MAX_TEXT = 32_000;

const SendBody = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    requestId: Type.Optional(Type.String({ pattern: REQUEST_ID })),
    whenBusy: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
  },
  { additionalProperties: false },
);
type SendBody = Static<typeof SendBody>;

const json = <T>(status: number, body: T): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const failure = (status: number, error: string, message?: string): Response =>
  json<ApiError>(status, { error, ...(message !== undefined && { message }) });
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

async function readSend(request: Request): Promise<{ body: SendBody } | { problem: string }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { problem: "the body is not JSON" };
  }
  if (Value.Check(SendBody, parsed)) return { body: parsed };
  const [first] = Value.Errors(SendBody, parsed);
  return { problem: `${first?.instancePath || "the body"}: ${first?.message ?? "is invalid"}` };
}

/**
 * `events` as server-sent events, a comment every `heartbeatMs`; cancelling the response stops them.
 * A watch that fails ends the stream with an `error` event (logged, never its details).
 */
function eventStream(events: AsyncIterable<ObservedEvent>, heartbeatMs: number, ctx: AppContext): Response {
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

export default defineComponent({
  name: "admin-api",
  config: Config,
  setup(pikit, config) {
    const auth = pikit.use("admin.auth");
    const observe = pikit.use("agent.observe");
    const runtime = pikit.use("agent.runtime");
    const conversations = pikit.use("conversations.registry");
    // Delivery: shown when an outbound queue is installed.
    const queue = pikit.useOptional("outbound.queue");
    const assets = createAssets(config.assets);

    /** An API route: answers only an operator. */
    const api = (key: string, handler: (request: Request, ctx: AppContext, operator: Operator) => Promise<Response>): void => {
      const route: HttpRoute = async (request, ctx) => {
        const operator = await auth.get().verify(request, ctx);
        if (operator === undefined) return UNAUTHORIZED();
        return handler(request, ctx, operator);
      };
      pikit.provideKeyed("http.route", key, route);
    };

    /** The conversation and whether its key points to it now. */
    const described = async (conversation: ObservedConversation, ctx: AppContext): Promise<ApiConversation> => {
      if (conversation.key === undefined) return conversation as ApiConversation;
      const now = await conversations.get().get(conversation.key, ctx);
      return { ...(conversation as ApiConversation), current: now?.conversationId === conversation.conversationId };
    };

    /**
     * The conversation `:id` names, as a `ConversationRef` an action can take, or the answer saying
     * why not: unknown (`404`), no message yet (`409 no_agent`), left behind by a reset (`409 not_current`).
     */
    const actionable = async (request: Request, ctx: AppContext): Promise<ConversationRef | Response> => {
      const id = conversationIdOf(request);
      const found = id === "" ? undefined : await observe.get().conversation(id, ctx);
      if (found === undefined) return failure(404, "not_found");
      if (found.key === undefined || found.agent === undefined) return failure(409, "no_agent", "no message has reached this conversation yet: it has no agent to talk to");
      const now = await conversations.get().get(found.key, ctx);
      if (now?.conversationId !== found.conversationId) return failure(409, "not_current", "a reset left this conversation behind: its key points to another one");
      return { key: found.key, agent: found.agent, conversationId: found.conversationId };
    };

    /** A page read with the client's cursor: an observer refuses a cursor it did not give. */
    const paged = async <T>(page: PageRequest, read: () => Promise<T>): Promise<T | Response> => {
      if (page.cursor === undefined) return read();
      try {
        return await read();
      } catch {
        return failure(400, "invalid_cursor", "the cursor is not one this API gave");
      }
    };

    api("GET /admin/api/app", async (_request, ctx) => json<ApiApp>(200, ctx.value(APP_DESCRIPTION) as ApiApp));

    api("GET /admin/api/conversations", async (request, ctx) => {
      const page = pageOf(request);
      if ("problem" in page) return failure(400, "invalid_request", page.problem);
      const result = await paged(page, () => observe.get().conversations(page, ctx));
      if (result instanceof Response) return result;
      const items = await Promise.all(result.items.map((each) => described(each, ctx)));
      return json<ApiPage<ApiConversation>>(200, { items, ...(result.next !== undefined && { next: result.next }) });
    });

    api("GET /admin/api/conversations/:id", async (request, ctx) => {
      const id = conversationIdOf(request);
      const found = id === "" ? undefined : await observe.get().conversation(id, ctx);
      if (found === undefined) return failure(404, "not_found");
      return json<ApiConversation>(200, await described(found, ctx));
    });

    api("GET /admin/api/conversations/:id/transcript", async (request, ctx) => {
      const id = conversationIdOf(request);
      const page = pageOf(request);
      if ("problem" in page) return failure(400, "invalid_request", page.problem);
      const result = id === "" ? undefined : await paged(page, () => observe.get().transcript(id, page, ctx));
      if (result instanceof Response) return result;
      if (result === undefined) return failure(404, "not_found");
      return json<ApiPage<ApiTranscriptEntry>>(200, result as ApiPage<ApiTranscriptEntry>);
    });

    api("GET /admin/api/conversations/:id/events", async (request, ctx) => {
      const id = conversationIdOf(request);
      // `watch` rejects an unknown conversation only once read: ask first, so it is a 404.
      if (id === "" || (await observe.get().conversation(id, ctx)) === undefined) return failure(404, "not_found");
      return eventStream(observe.get().watch(id, ctx), config.heartbeatMs, ctx);
    });

    api("POST /admin/api/conversations/:id/messages", async (request, ctx, operator) => {
      const read = await readSend(request);
      if ("problem" in read) return failure(400, "invalid_request", read.problem);
      const conversation = await actionable(request, ctx);
      if (conversation instanceof Response) return conversation;
      const requestId = read.body.requestId ?? `admin:${crypto.randomUUID()}`;
      const admission = await runtime.get().dispatch({ requestId, conversation, prompt: read.body.text, whenBusy: read.body.whenBusy ?? "steer" }, ctx);
      ctx.logger.info("admin-api: an operator sent a message", { operator: operator.id, conversation: conversation.key, requestId, admission: admission.kind });
      return json<ApiSendResponse>(202, { requestId, admission: admission.kind });
    });

    api("POST /admin/api/conversations/:id/abort", async (request, ctx, operator) => {
      const conversation = await actionable(request, ctx);
      if (conversation instanceof Response) return conversation;
      await runtime.get().abort(conversation, ctx);
      ctx.logger.info("admin-api: an operator aborted a run", { operator: operator.id, conversation: conversation.key });
      return json<ApiAbortResponse>(200, { conversationId: conversation.conversationId });
    });

    api("POST /admin/api/conversations/:id/reset", async (request, ctx, operator) => {
      const conversation = await actionable(request, ctx);
      if (conversation instanceof Response) return conversation;
      const reset = await conversations.get().reset(conversation.key, ctx);
      if (reset === undefined) return failure(404, "not_found");
      ctx.logger.info("admin-api: an operator reset a conversation", { operator: operator.id, conversation: conversation.key });
      return json<ApiResetResponse>(200, { key: conversation.key, previousConversationId: reset.previousConversationId, conversationId: reset.newConversationId });
    });

    const NO_QUEUE = () => failure(404, "not_installed", "no outbound.queue is installed: answers go straight to their platform, with nothing to show here");

    api("GET /admin/api/delivery/pending", async (request) => {
      const outbound = queue.get();
      if (outbound === undefined) return NO_QUEUE();
      const page = pageOf(request);
      if ("problem" in page) return failure(400, "invalid_request", page.problem);
      const result = await paged(page, () => outbound.pending(page));
      if (result instanceof Response) return result;
      return json<ApiPage<ApiPendingPiece>>(200, result as ApiPage<ApiPendingPiece>);
    });

    api("GET /admin/api/delivery/receipts", async (request) => {
      const outbound = queue.get();
      if (outbound === undefined) return NO_QUEUE();
      const params = new URL(request.url).searchParams;
      const after = params.get("after") ?? undefined;
      const page = pageOf(request);
      if ("problem" in page) return failure(400, "invalid_request", page.problem);
      const read = await paged({ ...(after !== undefined && { cursor: after }) }, () => outbound.receipts.read(after, page.limit ?? 100));
      if (read instanceof Response) return read;
      const items = read.items.map(({ cursor, fact }) => ({ cursor, ...fact }) as ApiReceipt);
      const next = items.at(-1)?.cursor ?? after;
      return json<ApiReceiptsPage>(200, { items, gap: read.gap, ...(next !== undefined && { next }) });
    });

    // Under /admin/api/ a path no route above serves is the API's 404, never the dashboard's page.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) api(`${method} /admin/api/*`, async () => failure(404, "not_found"));

    pikit.provideKeyed("http.route", `GET ${BASE}/*`, (request) => assets.serve(new URL(request.url).pathname));

    return {
      async start(ctx) {
        if (await assets.built()) ctx.logger.info("admin-api: the dashboard is served at /admin/", { assets: assets.root });
        else ctx.logger.info("admin-api: no dashboard is built; the API alone is served at /admin/api/", { assets: assets.root });
      },
    };
  },
});
