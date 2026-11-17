/**
 * The chat API's routes (`api.ts` says what each answers), written once over a backend (`backend.ts`)
 * and the accounts (`accounts/types.ts`): both halves of the component register them (`index.ts`,
 * `worker.ts`).
 *
 * - **A session first.** Every `/chat/api/*` route but `GET /chat/api/config` and better-auth's own
 *   (`/chat/api/auth/*`, forwarded to the accounts as they come) asks the accounts for the session's
 *   user: none, `401`, nothing read. The cookies the accounts renewed on the way (better-auth's cookie
 *   cache, when the session was read from the database) go back with the route's answer.
 * - **The key is the session's.** A route names a conversation by the chat id in its path only, and the
 *   key is `keyOf(user, chat id)`, built in one place (`refOf`): another user's chat id names no
 *   conversation of theirs, and is `404` as one that never existed.
 * - **Projects are the project store's** (`projects`, optional: `project-routes.ts`): `?project=` and a
 *   new chat's `project` name only one the user is a member of (`404` otherwise, checked before any chat
 *   is made in it), and a message in a project's chat goes only while its author is a member and its
 *   agent one the project allows (`403`): `RouteOptions.projects` decides, here before anything else.
 * - **A change needs the page's header** (`x-pikit-chat: 1`, `CHAT_CLIENT_HEADER`): `400` without, so a
 *   page of another site cannot make a signed-in browser send, rename, archive, delete or stop anything.
 * - **Bodies are bounded**: a message at most what its images and files in base64 and its text need on
 *   this target (`maxBodyOf`: `413` before more is read); its images checked (`imagesProblem`: number
 *   and types `400`, size `413`), and its files (`filesProblem`: number, names `400`, size `413`).
 * - **A user's messages are rated** (`messagesPerMinute`, every conversation together): one too many
 *   is `429 rate_limited` with `retry-after`, before its body is read (`RouteOptions.rate`).
 * - **Images are read one at a time** (`GET .../messages/:messageId/images/:n`), never inline in the
 *   transcript: the conversation's owner only, its own type, `nosniff`, cached privately (an image never
 *   changes).
 * - **What users see is the operator's policy** (`ChatConfig.visibility`, read at each request): every
 *   transcript entry and live event passes through `visibility.ts` here, the one place, on both targets.
 *   A conversation's `agent` is said only when it is one users may pick (`ChatConfig.agents`).
 * - **An agent picked** for a new conversation is one of `ChatConfig.agents`, or `400`. The one Routing
 *   would choose for the user's new chat (`routed.ts`, a dry run: nothing dispatched or made) is
 *   `ChatMe.suggestedAgent` when it is one of them: the page's picker starts on it.
 * - **A refusal is its status**: `not_found` `404`, `invalid_request` and `invalid_cursor` `400`,
 *   `too_large` `413`, `denied` `403` (the router refused it), `rejected` `422` (a stage stopped it),
 *   `no_route` `500`. Anything else (the runtime could not take the message for a while, an object
 *   that did not answer) is `503 unavailable`, logged: the page sends the same request again.
 * - **Logs** carry the user's id, the chat id and the request id, never a message's text, images or files.
 * - **Live events** are server-sent events over a plain streaming response, a comment every
 *   `heartbeatMs`; the stream ends when the client goes away, the events end, or the server stops.
 * - Under `/chat/api/`, a path no route serves is a JSON `404`, never the page.
 */

import type { AppContext, Pikit } from "@pikit/core";
import { ActorCallError, type HttpRoute } from "@pikit/contracts";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import type { AccountUser, Accounts } from "./accounts/types.ts";
import {
  CHAT_CLIENT_HEADER,
  type ChatAbortResponse,
  type ChatAgent,
  type ChatCommand,
  type ChatConfig,
  type ChatConversation,
  type ChatError,
  type ChatEvent,
  type ChatMe,
  type ChatPage,
  type ChatSendResponse,
  type ChatSignInMethod,
  type ChatStartResponse,
  type ChatTranscriptEntry,
  IMAGE_TYPES,
  MAX_DURABLE_IMAGE_BYTES,
  MAX_FILES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TEXT,
  NO_PROJECT,
  SEARCH_MAX,
  TITLE_MAX,
} from "./api.ts";
import { type Assets, BASE } from "./assets.ts";
import type { ChatBackend, ChatRef, NewMessage } from "./backend.ts";
import { chatIdFor, filesBytesOf, filesProblem, imagesProblem, isChatId, isProjectId, keyOf, newChatId, REQUEST_ID, requestIdOf } from "./chat.ts";
import { type ChannelWebConfig, providerName, type SignUpSettings, type VisibilitySettings } from "./config.ts";
import { routedAgent } from "./routed.ts";
import type { ProjectAccess } from "./project-routes.ts";
import { createEventProjector, projectEntry } from "./visibility.ts";

export const API = "/chat/api";

/** The largest page a client may ask for, and the default. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;
/** One image's JSON besides its data: `{"mimeType":"…","data":""},`, its type at most 100 characters, each escaped (6 bytes). */
const IMAGE_JSON = '{"mimeType":"","data":""},'.length + 100 * 6;
/** One file's JSON besides its data: `{"name":"…","mimeType":"…","data":""},`, its name at most 255 characters and its type 100, each escaped (6 bytes). */
const FILE_JSON = '{"name":"","mimeType":"","data":""},'.length + 355 * 6;
/** A message's JSON besides its text, images and files (its request id is ASCII), and 1 KiB of whitespace. */
const MESSAGE_JSON = '{"text":"","images":[],"files":[],"requestId":""}'.length + 122 + 1024;

/**
 * The largest body a message can be on `target`: its images in base64 (`MAX_IMAGES` of
 * `MAX_IMAGE_BYTES`; on `durable` `MAX_DURABLE_IMAGE_BYTES` in all), its files in base64
 * (`filesBytesOf(target)` in all, each padded), its text with every character escaped (`\u0000`, 6
 * bytes), and the JSON around them.
 */
export function maxBodyOf(target: string): number {
  const images = target === "durable" ? base64Length(MAX_DURABLE_IMAGE_BYTES + 2 * MAX_IMAGES) : MAX_IMAGES * base64Length(MAX_IMAGE_BYTES);
  const files = base64Length(filesBytesOf(target) + 2 * MAX_FILES);
  return images + MAX_IMAGES * IMAGE_JSON + files + MAX_FILES * FILE_JSON + MAX_TEXT * 6 + MESSAGE_JSON;
}
/** The largest body of any other change (a title). */
const MAX_SMALL_BODY = 16 * 1024;

const Image = Type.Object({ mimeType: Type.String({ maxLength: 100 }), data: Type.String() }, { additionalProperties: false });
const File = Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), mimeType: Type.Optional(Type.String({ maxLength: 100 })), data: Type.String() }, { additionalProperties: false });
const SendBody = Type.Object(
  {
    text: Type.String({ maxLength: MAX_TEXT }),
    images: Type.Optional(Type.Array(Image)),
    files: Type.Optional(Type.Array(File)),
    requestId: Type.Optional(Type.String({ pattern: REQUEST_ID.source })),
  },
  { additionalProperties: false },
);
const StartBody = Type.Object(
  { ...SendBody.properties, agent: Type.Optional(Type.String({ maxLength: 64 })), project: Type.Optional(Type.String({ maxLength: 64 })) },
  { additionalProperties: false },
);
const RenameBody = Type.Object({ title: Type.String({ minLength: 1, maxLength: TITLE_MAX * 4 }) }, { additionalProperties: false });

/**
 * The status of each refusal a backend or a store throws (an `ActorCallError`, or a store's own error:
 * `ProjectError`, `SpaceFilesError`, `ConvertError`, memory's, `ChangeInputError`, by their `code`);
 * any other is `503`.
 */
const STATUS: Record<string, number> = {
  not_found: 404,
  invalid_request: 400,
  invalid_cursor: 400,
  too_large: 413,
  denied: 403,
  rejected: 422,
  no_route: 500,
  not_empty: 409,
  // The stores' (projects, space.files, memory, document.convert): the store decides, the route says it.
  forbidden: 403,
  conflict: 409,
  space_taken: 409,
  gone: 410,
  invalid: 400,
  refused: 400,
  limit: 400,
  empty: 422,
  failed: 422,
  unsupported: 415,
};
/** The errors whose `code` is a refusal to answer with (`STATUS`), wherever they come from. */
const REFUSALS = new Set(["ActorCallError", "ProjectError", "SpaceFilesError", "ConvertError", "ChangeInputError"]);
/** `error`'s code, when it is a refusal `STATUS` knows. */
export function refusalOf(error: unknown): { status: number; code: string; message: string } | undefined {
  if (!(error instanceof Error) || (!REFUSALS.has(error.name) && !(error instanceof ActorCallError))) return undefined;
  const code = (error as { code?: unknown }).code;
  // A converter's `failed` is the file's (damaged, encrypted); an actor's is the call's: 503.
  if (code === "failed" && error.name !== "ConvertError") return undefined;
  const status = typeof code === "string" ? STATUS[code] : undefined;
  return status === undefined ? undefined : { status, code: code as string, message: error.message };
}

export const json = <T>(status: number, body: T, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
export const failure = (status: number, error: string, message?: string): Response =>
  json<ChatError>(status, { error, ...(message !== undefined && message !== "" && { message }) });

/** `response` with `cookies` (`set-cookie` values) added. */
function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** A refusal to answer with its status (thrown by a handler). */
export class Refused extends Error {
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
export function pageOf(request: Request): { limit: number; cursor?: string } {
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

/** The body's bytes, read up to `max` (`413` past it, before more is read). */
export async function bytesOf(request: Request, max: number): Promise<Uint8Array> {
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
  return bytes;
}

/** The body, read up to `max` bytes (`413` past it, before more is read), as JSON. */
export async function bodyOf(request: Request, max: number): Promise<unknown> {
  const bytes = await bytesOf(request, max);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Refused(400, "invalid_request", "the body is not JSON");
  }
}

/** `value` against `schema`, or `400` with the first problem. */
export function checked<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (Value.Check(schema, value)) return value as Static<S>;
  const [first] = Value.Errors(schema, value);
  throw new Refused(400, "invalid_request", `${first?.instancePath || "the body"}: ${first?.message ?? "is invalid"}`);
}

/** A message from the request's body, checked: something written or attached, images the API takes; a first one may name an agent. */
async function messageOf(request: Request, target: string, first = false): Promise<Omit<NewMessage, "requestId"> & { requestId?: string; agent?: string; project?: string }> {
  const body: Static<typeof StartBody> = checked(first ? StartBody : SendBody, await bodyOf(request, maxBodyOf(target)));
  const images = body.images ?? [];
  const files = body.files ?? [];
  if (body.text.trim() === "" && images.length === 0 && files.length === 0) throw new Refused(400, "invalid_request", "/text: write something, or attach an image or a file");
  const wrong = imagesProblem(images, target);
  if (wrong !== undefined) throw new Refused(wrong.status, wrong.status === 413 ? "too_large" : "invalid_request", `/images: ${wrong.message}`);
  const wrongFiles = filesProblem(files, target);
  if (wrongFiles !== undefined) throw new Refused(wrongFiles.status, wrongFiles.status === 413 ? "too_large" : "invalid_request", `/files: ${wrongFiles.message}`);
  return {
    text: body.text,
    ...(images.length > 0 && { images }),
    ...(files.length > 0 && { files }),
    ...(body.requestId !== undefined && { requestId: body.requestId }),
    ...(body.agent !== undefined && { agent: body.agent }),
    ...(body.project !== undefined && { project: body.project }),
  };
}

/**
 * `events` cut by `visibility` (`visibility.ts`): what users may see of each, in order; ops that do not
 * apply end it with their error, `events` released. Not a generator:
 * its `return` reaches `events` at once, also while a `next` waits (a generator would queue it behind
 * that `next`, and a stream that is idle would never close: on Cloudflare the object's stays open).
 */
function projected(events: AsyncIterable<ChatEvent>, visibility: VisibilitySettings): AsyncIterable<ChatEvent> {
  return {
    [Symbol.asyncIterator]() {
      const project = createEventProjector(visibility);
      const inner = events[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<ChatEvent>> {
          for (;;) {
            const read = await inner.next();
            if (read.done === true) return read;
            let shown: ChatEvent | undefined;
            try {
              shown = project(read.value);
            } catch (error) {
              await inner.return?.().catch(() => {});
              throw error;
            }
            if (shown !== undefined) return { done: false, value: shown };
          }
        },
        async return(): Promise<IteratorResult<ChatEvent>> {
          await inner.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** A conversation as `config` lets users see it: its agent only when it is one they may pick. */
export function shownConversation<C extends ChatConversation>(conversation: C, config: ChatConfig): C {
  const { agent, ...rest } = conversation;
  return agent !== undefined && config.agents.some((each) => each.name === agent) ? conversation : (rest as C);
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
  /**
   * What `GET /chat/api/config` answers, as the App where the accounts are makes it (`chatConfigOf`):
   * on a server this App; on Cloudflare the accounts actor's, which the Worker asks (kept
   * `CONFIG_CACHE_MS`). Its `visibility` cuts every transcript and live event, its `agents` the agent
   * a new conversation may be made with: read at each request.
   */
  chatConfig(ctx: AppContext): Promise<ChatConfig>;
  /** Where the conversations are, for the image limits: `server`, or `durable` (Cloudflare). */
  limits(): "server" | "durable";
  /**
   * One message of `userId` counted (`messagesPerMinute`): `undefined` when it may go, else the
   * seconds until one may. On a server the App's own count; on Cloudflare the accounts actor's.
   */
  rate(userId: string, ctx: AppContext): Promise<number | undefined>;
  /**
   * The agent Routing would choose for a new chat of `userId` (`routed.ts`), or `undefined`. Default: this
   * App's own `route.resolve` (a server); the Worker asks the accounts actor, whose App has the routers.
   */
  routed?(userId: string, ctx: AppContext): Promise<string | undefined>;
  assets: Assets;
  /** What the project store lets (`project-routes.ts`); absent when there is none: a project named is `404`. */
  projects?: ProjectAccess;
}

/** The values an operator changes live (`settings`), else the config's. */
export type LiveSettings = { signUp: SignUpSettings; visibility: VisibilitySettings; agents: string[] };

/**
 * The page's config, made where the accounts are: their sign-in methods (`config` is that App's), who
 * may sign up now, what users see and the agents they may pick (`settings`, the live settings, the
 * agents among them that are agents now: `agents`), the commands users may type (each one's `agents` cut
 * to those they may pick), and whether that App sends email (`email.send` there).
 */
export async function chatConfigOf(
  options: {
    config: ChannelWebConfig;
    target: "server" | "durable";
    settings(ctx: AppContext): Promise<LiveSettings>;
    agents(names: readonly string[], ctx: AppContext): Promise<ChatAgent[]>;
    /** The commands users may type in a chat (`ChatConfig.commands`). */
    commands(): ChatCommand[];
    email: boolean;
    /** Whether that App keeps a message's files (`ChatConfig.files`). */
    files: boolean;
  },
  ctx: AppContext,
): Promise<ChatConfig> {
  const { config, target, email } = options;
  const live = await options.settings(ctx);
  const { thinking, tools, context } = live.visibility;
  const agents = await options.agents(live.agents, ctx);
  // A command's agents as users may see them: only the ones they may pick (as `shownConversation`).
  const offered = new Set(agents.map((each) => each.name));
  return {
    name: config.name,
    target,
    methods: methodsOf(config, email),
    signUp: live.signUp.mode,
    email,
    files: options.files,
    visibility: { thinking, tools, context },
    agents,
    commands: options.commands().map((command) => (command.agents === undefined ? command : { ...command, agents: command.agents.filter((agent) => offered.has(agent)) })),
  };
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

/** A route whose refusals and failures are its JSON answer. */
export const answering =
  (key: string, handler: HttpRoute): HttpRoute =>
  async (request, ctx) => {
    try {
      return await handler(request, ctx);
    } catch (error) {
      if (error instanceof Refused) return failure(error.status, error.code, error.message);
      const refused = refusalOf(error);
      if (refused !== undefined) return failure(refused.status, refused.code, refused.message);
      ctx.logger.warn("channel-web: a request could not be served; the page may send it again", {
        route: key,
        ...(error instanceof ActorCallError && { code: error.code }),
        error: error instanceof Error ? error.message : String(error),
      });
      return failure(503, "unavailable", "the assistant could not take this now: try again in a moment");
    }
  };

/** Registers a route for a signed-in user: `401` without one; a change also needs the page's header. */
export type UserRoute = (key: string, handler: (request: Request, ctx: AppContext, user: AccountUser) => Promise<Response>) => void;

/** The `UserRoute` of the App `pikit` sets up, over its accounts. */
export function userRoutes(pikit: Pikit, accounts: () => Accounts): UserRoute {
  return (key, handler) => {
    const changes = !key.startsWith("GET ");
    pikit.provideKeyed(
      "http.route",
      key,
      answering(key, async (request, ctx) => {
        if (changes && request.headers.get(CHAT_CLIENT_HEADER) !== "1") return failure(400, "invalid_request", `send the header ${CHAT_CLIENT_HEADER}: 1`);
        const session = await accounts().user(request, ctx);
        if (session === undefined) return failure(401, "unauthorized");
        return withCookies(await handler(request, ctx, session.user), session.cookies);
      }),
    );
  };
}

/** Registers every chat route of the App `pikit` sets up, and the page's files. */
export function provideRoutes(pikit: Pikit, options: RouteOptions): void {
  const user = userRoutes(pikit, () => options.accounts());
  const backend = () => options.backend();

  pikit.provideKeyed(
    "http.route",
    `GET ${API}/config`,
    answering(`GET ${API}/config`, async (_request, ctx) => {
      const config = await options.chatConfig(ctx);
      // Whether there are projects is this App's: its routes are where the project store is used.
      const features = options.projects?.features();
      return json<ChatConfig>(200, features === undefined ? config : { ...config, projects: features });
    }),
  );

  // better-auth's own: sign in and out, OAuth callbacks, links, sessions. Its answer as it made it.
  for (const method of ["GET", "POST"]) {
    const key = `${method} ${API}/auth/*`;
    pikit.provideKeyed("http.route", key, answering(key, (request, ctx) => options.accounts().handle(request, ctx)));
  }

  /**
   * The agent Routing would choose for `userId`'s new chat, when it is one users may pick now; else
   * `undefined`, also when it cannot be said (logged: `/me` answers without it).
   */
  const suggestedAgent = async (userId: string, ctx: AppContext): Promise<string | undefined> => {
    try {
      const { agents } = await options.chatConfig(ctx);
      if (agents.length === 0) return undefined;
      const agent = await (options.routed ?? routedAgent)(userId, ctx);
      return agent !== undefined && agents.some((each) => each.name === agent) ? agent : undefined;
    } catch (error) {
      ctx.logger.warn("channel-web: the agent Routing would choose for a new chat could not be read; the page picks the first offered", {
        user: userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  user(`GET ${API}/me`, async (_request, ctx, me) => {
    const { id, name, email, image } = me;
    const [methods, suggested] = await Promise.all([options.accounts().methods(id, ctx), suggestedAgent(id, ctx)]);
    return json<ChatMe>(200, { user: { id, name, email, ...(image !== undefined && { image }) }, methods, ...(suggested !== undefined && { suggestedAgent: suggested }) });
  });

  user(`GET ${API}/conversations`, async (request, ctx, me) => {
    const params = new URL(request.url).searchParams;
    const archived = params.get("archived");
    if (archived !== null && archived !== "1" && archived !== "0") throw new Refused(400, "invalid_request", "archived is 1 or 0");
    const q = params.get("q")?.trim() ?? "";
    if (q.length > SEARCH_MAX) throw new Refused(400, "invalid_request", `q is at most ${SEARCH_MAX} characters`);
    // A project's own, or (`none`) those of no project; one that is no project id is no project of theirs.
    const given = params.get("project");
    if (given !== null && given !== NO_PROJECT && !isProjectId(given)) throw new Refused(404, "not_found", "no such project");
    const project = given === null ? undefined : given === NO_PROJECT ? "" : given;
    // Only a project the user is a member of (the store says): any other is no project, 404.
    if (project !== undefined && project !== "") await projectsOf(options).listing(me, project, ctx);
    const listed = await backend().list(me.id, { ...pageOf(request), archived: archived === "1", ...(q !== "" && { q }), ...(project !== undefined && { project }) }, ctx);
    // The policy only when there is an agent to say or not.
    if (!listed.items.some((each) => each.agent !== undefined)) return json<ChatPage<ChatConversation>>(200, listed);
    const config = await options.chatConfig(ctx);
    return json<ChatPage<ChatConversation>>(200, { ...listed, items: listed.items.map((each) => shownConversation(each, config)) });
  });

  /** `429` when `me` sent too many messages this minute; `undefined` when this one may go. */
  const limited = async (me: AccountUser, ctx: AppContext): Promise<Response | undefined> => {
    const retryAfter = await options.rate(me.id, ctx);
    if (retryAfter === undefined) return undefined;
    ctx.logger.info("channel-web: a user sent too many messages", { user: me.id, retryAfter });
    return json<ChatError>(429, { error: "rate_limited", message: `too many messages: send again in ${retryAfter} s` }, { "retry-after": String(retryAfter) });
  };

  user(`POST ${API}/conversations`, async (request, ctx, me) => {
    const refused = await limited(me, ctx);
    if (refused !== undefined) return refused;
    const { requestId: given, agent, project, ...message } = await messageOf(request, options.limits(), true);
    // Only an agent the operator lets users pick; the routing still allows or denies the message.
    if (agent !== undefined && !(await options.chatConfig(ctx)).agents.some((each) => each.name === agent)) {
      throw new Refused(400, "invalid_request", "/agent: not an assistant you may pick");
    }
    // Only a project the user is a member of (another is no project, 404), not archived (403), with an
    // agent it allows (400): its space is the project's, never one the page names.
    let made: { agent?: string; space?: string } = agent === undefined ? {} : { agent };
    if (project !== undefined) {
      if (!isProjectId(project)) throw new Refused(404, "not_found", "no such project");
      made = await projectsOf(options).starting(me, project, agent, ctx);
    }
    // The page's request id names the conversation too: a retry reaches the same one.
    const chatId = given === undefined ? newChatId() : await chatIdFor(me.id, given);
    const requestId = requestIdOf(given);
    const started = await backend().start(
      refOf(me, chatId),
      { ...message, requestId, ...(made.agent !== undefined && { agent: made.agent }), ...(project !== undefined && made.space !== undefined && { project, space: made.space }) },
      ctx,
    );
    ctx.logger.info("channel-web: a user started a conversation", {
      user: me.id,
      chat: chatId,
      requestId,
      admission: started.admission,
      ...(made.agent !== undefined && { agent: made.agent }),
      ...(project !== undefined && { project }),
      ...commandFacts(started),
      ...facts(message),
    });
    return json<ChatStartResponse>(201, { id: chatId, ...started });
  });

  /** A conversation as the user may see it (its agent only when one they may pick). */
  const shown = async (conversation: ChatConversation, ctx: AppContext): Promise<ChatConversation> => shownConversation(conversation, await options.chatConfig(ctx));

  user(`GET ${API}/conversations/:id`, async (request, ctx, me) => json<ChatConversation>(200, await shown(await backend().conversation(refOf(me, chatIdOf(request)), ctx), ctx)));

  user(`PATCH ${API}/conversations/:id`, async (request, ctx, me) => {
    const chatId = chatIdOf(request);
    const title = checked(RenameBody, await bodyOf(request, MAX_SMALL_BODY)).title.replace(/\s+/g, " ").trim();
    if (title === "" || title.length > TITLE_MAX) throw new Refused(400, "invalid_request", `/title: 1 to ${TITLE_MAX} characters`);
    const renamed = await backend().rename(refOf(me, chatId), title, ctx);
    ctx.logger.info("channel-web: a user renamed a conversation", { user: me.id, chat: chatId });
    return json<ChatConversation>(200, await shown(renamed, ctx));
  });

  for (const [action, archived] of [
    ["archive", true],
    ["unarchive", false],
  ] as const) {
    user(`POST ${API}/conversations/:id/${action}`, async (request, ctx, me) => {
      const chatId = chatIdOf(request);
      const changed = await backend().archive(refOf(me, chatId), archived, ctx);
      ctx.logger.info(`channel-web: a user ${archived ? "archived a conversation" : "put a conversation back in their list"}`, { user: me.id, chat: chatId });
      return json<ChatConversation>(200, await shown(changed, ctx));
    });
  }

  user(`DELETE ${API}/conversations/:id`, async (request, ctx, me) => {
    const chatId = chatIdOf(request);
    await backend().hide(refOf(me, chatId), ctx);
    ctx.logger.info("channel-web: a user deleted a conversation from their list", { user: me.id, chat: chatId });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });

  user(`GET ${API}/conversations/:id/transcript`, async (request, ctx, me) => {
    const read = await backend().transcript(refOf(me, chatIdOf(request)), pageOf(request), ctx);
    const { visibility } = await options.chatConfig(ctx);
    const items = read.items.flatMap((entry) => projectEntry(entry, visibility) ?? []);
    return json<ChatPage<ChatTranscriptEntry>>(200, { items, ...(read.next !== undefined && { next: read.next }) });
  });

  user(`GET ${API}/conversations/:id/messages/:messageId/images/:n`, async (request, ctx, me) => {
    const chatId = chatIdOf(request);
    const [, , , , , , rawId = "", , rawIndex = ""] = new URL(request.url).pathname.split("/");
    let messageId = "";
    try {
      messageId = decodeURIComponent(rawId);
    } catch {
      // Below.
    }
    const index = Number(rawIndex);
    if (!REQUEST_ID.test(messageId) || !/^[0-9]$/.test(rawIndex) || index >= MAX_IMAGES) throw new Refused(404, "not_found", "no such image");
    const image = await backend().image(refOf(me, chatId), messageId, index, ctx);
    const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "content-type": IMAGE_TYPES.includes(image.mimeType) ? image.mimeType : "application/octet-stream",
        "content-length": String(bytes.byteLength),
        // An image of a message never changes; the session's only.
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });

  user(`POST ${API}/conversations/:id/messages`, async (request, ctx, me) => {
    const refused = await limited(me, ctx);
    if (refused !== undefined) return refused;
    const chatId = chatIdOf(request);
    const { requestId: given, ...message } = await messageOf(request, options.limits());
    const requestId = requestIdOf(given);
    // In a project's chat, only while its author is a member and its agent one the project allows (403).
    if (options.projects !== undefined) {
      const conversation = await backend().conversation(refOf(me, chatId), ctx);
      if (conversation.project !== undefined) await options.projects.posting(me, conversation, ctx);
    }
    const sent = await backend().send(refOf(me, chatId), { ...message, requestId }, ctx);
    ctx.logger.info("channel-web: a user sent a message", { user: me.id, chat: chatId, requestId, admission: sent.admission, ...commandFacts(sent), ...facts(message) });
    return json<ChatSendResponse>(202, sent);
  });

  user(`GET ${API}/conversations/:id/events`, async (request, ctx, me) => {
    const ref = refOf(me, chatIdOf(request));
    // The policy first: no stream is opened that could not be cut by it.
    const { visibility } = await options.chatConfig(ctx);
    return eventStream(projected(await backend().live(ref, ctx), visibility), heartbeatOf(options), ctx);
  });

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

/** The project access, or: no project store, so every project named is no project (`404`). */
function projectsOf(options: RouteOptions): ProjectAccess {
  if (options.projects !== undefined) return options.projects;
  const none = (): never => {
    throw new Refused(404, "not_found", "no such project");
  };
  return { features: () => undefined, starting: none, posting: async () => {}, listing: none, userRemoved: async () => {} };
}

/** What the log says of a command typed: its name and what came of it, never its arguments or note. */
const commandFacts = (sent: ChatSendResponse) => (sent.command === undefined ? {} : { command: sent.command.name, outcome: sent.command.outcome });

/** What the log says of a message besides its text: how many images and files. */
const facts = (message: { images?: unknown[] | undefined; files?: unknown[] | undefined }) => ({
  ...(message.images !== undefined && message.images.length > 0 && { images: message.images.length }),
  ...(message.files !== undefined && message.files.length > 0 && { files: message.files.length }),
});
