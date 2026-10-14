/**
 * The chat API's routes (`api.ts` says what each answers), written once over a backend (`backend.ts`)
 * and the accounts (`accounts/types.ts`): both halves of the component register them (`index.ts`,
 * `worker.ts`).
 *
 * - **A session first.** Every `/chat/api/*` route but `GET /chat/api/config` and better-auth's own
 *   (`/chat/api/auth/*`, forwarded to the accounts as they come) asks the accounts for the session's
 *   user: none, `401`, nothing read.
 * - **The key is the session's.** A route names a conversation by the chat id in its path only, and the
 *   key is `keyOf(user, chat id)`, built in one place (`refOf`): another user's chat id names no
 *   conversation of theirs, and is `404` as one that never existed.
 * - **A change needs the page's header** (`x-pikit-chat: 1`, `CHAT_CLIENT_HEADER`): `400` without, so a
 *   page of another site cannot make a signed-in browser send, rename, delete or stop anything.
 * - **Bodies are bounded**: a message at most its images in base64, its text and some room (`413`
 *   before more is read); its images checked (`imagesProblem`: number and types `400`, size `413`).
 * - **A refusal is its status**: `not_found` `404`, `invalid_request` and `invalid_cursor` `400`,
 *   `too_large` `413`, `denied` `403` (the router refused it), `rejected` `422` (a stage stopped it),
 *   `no_route` `500`. Anything else (the runtime could not take the message for a while, an object
 *   that did not answer) is `503 unavailable`, logged: the page sends the same request again.
 * - **Logs** carry the user's id, the chat id and the request id, never a message's text or images.
 * - **Live events** are server-sent events over a plain streaming response, a comment every
 *   `heartbeatMs`; the stream ends when the client goes away, the events end, or the server stops.
 * - Under `/chat/api/`, a path no route serves is a JSON `404`, never the page.
 */

import type { AppContext, Pikit } from "@pikit/core";
import { ActorCallError, type HttpRoute } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { AccountUser, Accounts } from "./accounts/types.ts";
import {
  CHAT_CLIENT_HEADER,
  type ChatAbortResponse,
  type ChatConfig,
  type ChatConversation,
  type ChatError,
  type ChatEvent,
  type ChatMe,
  type ChatMessage,
  type ChatPage,
  type ChatSendResponse,
  type ChatSignInMethod,
  type ChatStartResponse,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TEXT,
  TITLE_MAX,
} from "./api.ts";
import { type Assets, BASE } from "./assets.ts";
import type { ChatBackend, ChatRef, NewMessage } from "./backend.ts";
import { chatIdFor, imagesProblem, isChatId, keyOf, newChatId, REQUEST_ID, requestIdOf } from "./chat.ts";
import { type ChannelWebConfig, providerName, type SignUpSettings } from "./config.ts";

export const API = "/chat/api";

/** The largest page a client may ask for, and the default. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
/** The largest body a message can be: its images in base64, its text, and room for the rest. */
export const MAX_BODY = MAX_IMAGES * Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + MAX_TEXT * 6 + 64 * 1024;
/** The largest body of any other change (a title). */
const MAX_SMALL_BODY = 16 * 1024;

const Image = Type.Object({ mimeType: Type.String({ maxLength: 100 }), data: Type.String() }, { additionalProperties: false });
const SendBody = Type.Object(
  {
    text: Type.String({ maxLength: MAX_TEXT }),
    images: Type.Optional(Type.Array(Image)),
    requestId: Type.Optional(Type.String({ pattern: REQUEST_ID.source })),
  },
  { additionalProperties: false },
);
const RenameBody = Type.Object({ title: Type.String({ minLength: 1, maxLength: TITLE_MAX * 4 }) }, { additionalProperties: false });

/** The status of each refusal a backend throws; any other is `503`. */
const STATUS: Record<string, number> = {
  not_found: 404,
  invalid_request: 400,
  invalid_cursor: 400,
  too_large: 413,
  denied: 403,
  rejected: 422,
  no_route: 500,
};

const json = <T>(status: number, body: T, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
export const failure = (status: number, error: string, message?: string): Response =>
  json<ChatError>(status, { error, ...(message !== undefined && message !== "" && { message }) });

/** A refusal to answer with its status (thrown by a handler). */
class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The `:id` of `/chat/api/conversations/:id/…`: a chat id, or `404`. */
function chatIdOf(request: Request): string {
  const id = new URL(request.url).pathname.split("/")[4] ?? "";
  if (!isChatId(id)) throw new Refused(404, "not_found", "no such conversation");
  return id;
}

/** The conversation `user` names with `chatId`: the only place a route makes a key. */
const refOf = (user: AccountUser, chatId: string): ChatRef => ({ userId: user.id, chatId, key: keyOf(user.id, chatId) });

/** `?limit&cursor`, checked. */
function pageOf(request: Request): { limit: number; cursor?: string } {
  const params = new URL(request.url).searchParams;
  const limit = params.get("limit");
  let value = DEFAULT_LIMIT;
  if (limit !== null) {
    value = Number(limit);
    if (!/^[0-9]+$/.test(limit) || value < 1 || value > MAX_LIMIT) throw new Refused(400, "invalid_request", `limit is an integer from 1 to ${MAX_LIMIT}`);
  }
  const cursor = params.get("cursor");
  return { limit: value, ...(cursor !== null && { cursor }) };
}

/** The body, read up to `max` bytes (`413` past it, before more is read), as JSON. */
async function bodyOf(request: Request, max: number): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > max) throw new Refused(413, "too_large", `a body is at most ${Math.round(max / 1024)} KB`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new Refused(413, "too_large", `a body is at most ${Math.round(max / 1024)} KB`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Refused(400, "invalid_request", "the body is not JSON");
  }
}

/** `value` against `schema`, or `400` with the first problem. */
function checked<S extends typeof SendBody | typeof RenameBody>(schema: S, value: unknown): Static<S> {
  if (Value.Check(schema, value)) return value as Static<S>;
  const [first] = Value.Errors(schema, value);
  throw new Refused(400, "invalid_request", `${first?.instancePath || "the body"}: ${first?.message ?? "is invalid"}`);
}

/** A message from the request's body, checked: something written or attached, images the API takes. */
async function messageOf(request: Request, target: string): Promise<Omit<NewMessage, "requestId"> & { requestId?: string }> {
  const body = checked(SendBody, await bodyOf(request, MAX_BODY));
  const images = body.images ?? [];
  if (body.text.trim() === "" && images.length === 0) throw new Refused(400, "invalid_request", "/text: write something, or attach an image");
  const wrong = imagesProblem(images, target);
  if (wrong !== undefined) throw new Refused(wrong.status, wrong.status === 413 ? "too_large" : "invalid_request", `/images: ${wrong.message}`);
  return { text: body.text, ...(images.length > 0 && { images }), ...(body.requestId !== undefined && { requestId: body.requestId }) };
}

/**
 * `events` as server-sent events, a comment every `heartbeatMs`; cancelling the response stops them.
 * Events that fail end the stream with an `error` event (logged, never its details).
 */
function eventStream(events: AsyncIterable<ChatEvent>, heartbeatMs: number, ctx: AppContext): Response {
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
        if (ctx.abortSignal?.aborted === true) {
          try {
            controller.close();
          } catch {
            // Cancelled already.
          }
          return;
        }
        ctx.logger.warn("channel-web: a conversation's live events stopped", { error: error instanceof Error ? error.message : String(error) });
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "watch_failed" } satisfies ChatError)}\n\n`));
        controller.close();
      }
    },
    async cancel() {
      finish();
      await iterator.return?.();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

export interface RouteOptions {
  /** Read in a handler, never in setup. */
  accounts(): Accounts;
  backend(): ChatBackend;
  config: ChannelWebConfig;
  /** Who may sign up now: the live setting, else the config's. */
  signUp(ctx: AppContext): Promise<SignUpSettings>;
  /** Where the conversations are, for the image limits and `ChatConfig.target`: `server`, or `durable` (Cloudflare). */
  limits(): "server" | "durable";
  /** Whether the App sends email (`email.send` installed where the accounts are). */
  email(): boolean;
  assets: Assets;
}

/** The sign-in methods the page offers, from the config (a link by email only when the App sends email). */
export function methodsOf(config: ChannelWebConfig, email: boolean): ChatSignInMethod[] {
  return [
    ...(config.signIn.password ? [{ kind: "password" } as const] : []),
    ...(config.signIn.magicLink && email ? [{ kind: "magic-link" } as const] : []),
    ...config.signIn.social.map((id) => ({ kind: "social" as const, id, name: providerName(id) })),
    ...config.signIn.oidc.map(({ id, name }) => ({ kind: "oidc" as const, id, name })),
  ];
}

/** Registers every chat route of the App `pikit` sets up, and the page's files. */
export function provideRoutes(pikit: Pikit, options: RouteOptions): void {
  /** A route whose refusals and failures are its JSON answer. */
  const answering =
    (key: string, handler: HttpRoute): HttpRoute =>
    async (request, ctx) => {
      try {
        return await handler(request, ctx);
      } catch (error) {
        if (error instanceof Refused) return failure(error.status, error.code, error.message);
        if (error instanceof ActorCallError) {
          const status = STATUS[error.code];
          if (status !== undefined) return failure(status, error.code, error.message);
        }
        ctx.logger.warn("channel-web: a request could not be served; the page may send it again", {
          route: key,
          ...(error instanceof ActorCallError && { code: error.code }),
          error: error instanceof Error ? error.message : String(error),
        });
        return failure(503, "unavailable", "the assistant could not take this now: try again in a moment");
      }
    };

  /** A route for a signed-in user: `401` without one; a change also needs the page's header. */
  const user = (key: string, handler: (request: Request, ctx: AppContext, user: AccountUser) => Promise<Response>): void => {
    const changes = !key.startsWith("GET ");
    pikit.provideKeyed(
      "http.route",
      key,
      answering(key, async (request, ctx) => {
        if (changes && request.headers.get(CHAT_CLIENT_HEADER) !== "1") return failure(400, "invalid_request", `send the header ${CHAT_CLIENT_HEADER}: 1`);
        const found = await options.accounts().user(request, ctx);
        if (found === undefined) return failure(401, "unauthorized");
        return handler(request, ctx, found);
      }),
    );
  };
  const backend = () => options.backend();

  pikit.provideKeyed(
    "http.route",
    `GET ${API}/config`,
    answering(`GET ${API}/config`, async (_request, ctx) => {
      const email = options.email();
      return json<ChatConfig>(200, { name: options.config.name, target: options.limits(), methods: methodsOf(options.config, email), signUp: (await options.signUp(ctx)).mode, email });
    }),
  );

  // better-auth's own: sign in and out, OAuth callbacks, links, sessions. Its answer as it made it.
  for (const method of ["GET", "POST"]) {
    const key = `${method} ${API}/auth/*`;
    pikit.provideKeyed("http.route", key, answering(key, (request, ctx) => options.accounts().handle(request, ctx)));
  }

  user(`GET ${API}/me`, async (_request, ctx, me) => {
    const { id, name, email, image } = me;
    return json<ChatMe>(200, { user: { id, name, email, ...(image !== undefined && { image }) }, methods: await options.accounts().methods(id, ctx) });
  });

  user(`GET ${API}/conversations`, async (request, ctx, me) => json<ChatPage<ChatConversation>>(200, await backend().list(me.id, pageOf(request), ctx)));

  user(`POST ${API}/conversations`, async (request, ctx, me) => {
    const { requestId: given, ...message } = await messageOf(request, options.limits());
    // The page's request id names the conversation too: a retry reaches the same one.
    const chatId = given === undefined ? newChatId() : await chatIdFor(me.id, given);
    const requestId = requestIdOf(given);
    const started = await backend().start(refOf(me, chatId), { ...message, requestId }, ctx);
    ctx.logger.info("channel-web: a user started a conversation", { user: me.id, chat: chatId, requestId, admission: started.admission, ...facts(message) });
    return json<ChatStartResponse>(201, { id: chatId, ...started });
  });

  user(`GET ${API}/conversations/:id`, async (request, ctx, me) => json<ChatConversation>(200, await backend().conversation(refOf(me, chatIdOf(request)), ctx)));

  user(`PATCH ${API}/conversations/:id`, async (request, ctx, me) => {
    const chatId = chatIdOf(request);
    const title = checked(RenameBody, await bodyOf(request, MAX_SMALL_BODY)).title.replace(/\s+/g, " ").trim();
    if (title === "" || title.length > TITLE_MAX) throw new Refused(400, "invalid_request", `/title: 1 to ${TITLE_MAX} characters`);
    const renamed = await backend().rename(refOf(me, chatId), title, ctx);
    ctx.logger.info("channel-web: a user renamed a conversation", { user: me.id, chat: chatId });
    return json<ChatConversation>(200, renamed);
  });

  user(`DELETE ${API}/conversations/:id`, async (request, ctx, me) => {
    const chatId = chatIdOf(request);
    await backend().hide(refOf(me, chatId), ctx);
    ctx.logger.info("channel-web: a user deleted a conversation from their list", { user: me.id, chat: chatId });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });

  user(`GET ${API}/conversations/:id/messages`, async (request, ctx, me) =>
    json<ChatPage<ChatMessage>>(200, await backend().messages(refOf(me, chatIdOf(request)), pageOf(request), ctx)),
  );

  user(`POST ${API}/conversations/:id/messages`, async (request, ctx, me) => {
    const chatId = chatIdOf(request);
    const { requestId: given, ...message } = await messageOf(request, options.limits());
    const requestId = requestIdOf(given);
    const sent = await backend().send(refOf(me, chatId), { ...message, requestId }, ctx);
    ctx.logger.info("channel-web: a user sent a message", { user: me.id, chat: chatId, requestId, admission: sent.admission, ...facts(message) });
    return json<ChatSendResponse>(202, sent);
  });

  user(`GET ${API}/conversations/:id/events`, async (request, ctx, me) => eventStream(await backend().live(refOf(me, chatIdOf(request)), ctx), heartbeatOf(options), ctx));

  user(`POST ${API}/conversations/:id/abort`, async (request, ctx, me) => {
    const chatId = chatIdOf(request);
    await backend().abort(refOf(me, chatId), ctx);
    ctx.logger.info("channel-web: a user stopped a run", { user: me.id, chat: chatId });
    return json<ChatAbortResponse>(200, { id: chatId });
  });

  // Under /chat/api/ a path no route above serves is the API's 404, never the page.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    pikit.provideKeyed("http.route", `${method} ${API}/*`, async () => failure(404, "not_found"));
  }

  pikit.provideKeyed("http.route", `GET ${BASE}/*`, (request) => options.assets.serve(new URL(request.url).pathname));
}

const heartbeatOf = (options: RouteOptions): number => options.config.heartbeatMs;

/** What the log says of a message besides its text: how many images. */
const facts = (message: { images?: unknown[] | undefined }) => (message.images !== undefined && message.images.length > 0 ? { images: message.images.length } : {});
