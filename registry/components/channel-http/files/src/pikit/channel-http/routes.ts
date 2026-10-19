/**
 * channel-http's routes, the same in each App that serves them (the server's one App, or the Worker's
 * on Cloudflare): `http.authenticate`, then the request read and checked, then the backend
 * (`backend.ts`), which answers as HTTP (`Reply`). Where the backend is (in process, or the
 * conversation's object through `actor.mailbox`) is the caller's choice.
 *
 *   POST /v1/messages                              { conversationId, text, messageId? }
 *   GET  /v1/conversations/:id/messages/:messageId  the outcome of a message, later
 *   POST /v1/conversations/:id/reset
 *
 * A request id is made here (`messageId`, else a new UUID), before anything reaches the
 * conversation: every answer to a POST that may have admitted the message names it.
 */

import { type AppContext, Halt, type Pikit } from "@pikit/core";
import { type InboundMessage, type JsonValue } from "@pikit/contracts";
import { bearerToken, type Digest, matches } from "./auth.ts";
import type { HttpBackend, Reply } from "./backend.ts";
import { CONVERSATION_ID, MESSAGE_ID, readMessageBody } from "./body.ts";

export const CHANNEL = "http";

declare module "@pikit/core" {
  interface AppPipelines {
    /**
     * Authenticates a request to this channel. A stage acts only on its own `channel` and leaves a
     * rejection alone. A request is authenticated only when a stage says so: no verdict is a
     * rejection. On Cloudflare it runs in the Worker's App, where the request is.
     */
    "http.authenticate": {
      channel: string;
      request: Request;
      verdict?: { kind: "authenticated"; actor: InboundMessage["actor"] } | { kind: "rejected"; reason: string };
    };
  }
}

/** The conversation key of a client's conversation id. */
export const conversationKey = (conversationId: string): string => `${CHANNEL}:${conversationId}`;

const json = (status: number, body: Record<string, JsonValue>): Response => Response.json(body, { status });
const UNAUTHORIZED = (): Response =>
  Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="pikit"' } });
const respond = (reply: Reply): Response => json(reply.status, reply.body);

/** A path segment, decoded; `""` (never a valid id) when its escapes are malformed (`%E0`): a 400, not a 500. */
function segment(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return "";
  }
}

export interface RouteOptions {
  /** The token's digest while the component runs; `undefined` refuses every request. */
  token: () => Digest | undefined;
  /** Where messages go, once a request is authenticated and read. */
  backend: () => HttpBackend;
}

/** Registers this channel's stage of `http.authenticate` and its three routes. Call in `setup`. */
export function provideRoutes(pikit: Pikit, options: RouteOptions): void {
  // This channel's authentication: it acts on its own requests and leaves a rejection alone.
  pikit.pipeline(
    "http.authenticate",
    async (value) => {
      if (value.channel !== CHANNEL || value.verdict?.kind === "rejected") return value;
      const presented = bearerToken(value.request.headers.get("authorization"));
      const token = options.token();
      if (presented === undefined || token === undefined) return { ...value, verdict: { kind: "rejected", reason: "missing bearer token" } };
      return (await matches(presented, token))
        ? { ...value, verdict: { kind: "authenticated", actor: { id: CHANNEL } } }
        : { ...value, verdict: { kind: "rejected", reason: "wrong bearer token" } };
    },
    { id: "channel-http-bearer", priority: 100 },
  );

  /** Who sent `request`, if `http.authenticate` says it is authenticated. */
  const authenticated = async (request: Request, ctx: AppContext): Promise<InboundMessage["actor"] | undefined> => {
    const checked = await ctx.run("http.authenticate", { channel: CHANNEL, request });
    return !(checked instanceof Halt) && checked.verdict?.kind === "authenticated" ? checked.verdict.actor : undefined;
  };

  pikit.provideKeyed("http.route", "POST /v1/messages", async (request, ctx) => {
    const actor = await authenticated(request, ctx);
    if (actor === undefined) return UNAUTHORIZED();
    const read = await readMessageBody(request);
    if ("problem" in read) return json(400, { error: "invalid_request", message: read.problem });
    const { conversationId, text, messageId } = read.body;
    const requestId = messageId ?? crypto.randomUUID();
    return respond(await options.backend().message({ conversationId, text, requestId, actor: { id: actor.id } }, ctx));
  });

  pikit.provideKeyed("http.route", "GET /v1/conversations/:id/messages/:messageId", async (request, ctx) => {
    if ((await authenticated(request, ctx)) === undefined) return UNAUTHORIZED();
    const [, , , id = "", , message = ""] = new URL(request.url).pathname.split("/");
    const conversationId = segment(id);
    const requestId = segment(message);
    if (!new RegExp(CONVERSATION_ID).test(conversationId) || !new RegExp(MESSAGE_ID).test(requestId)) {
      return json(400, { error: "invalid_request", message: "the conversation id or the message id is not valid" });
    }
    return respond(await options.backend().status({ conversationId, requestId }, ctx));
  });

  pikit.provideKeyed("http.route", "POST /v1/conversations/:id/reset", async (request, ctx) => {
    if ((await authenticated(request, ctx)) === undefined) return UNAUTHORIZED();
    const conversationId = segment(new URL(request.url).pathname.split("/")[3]);
    if (!new RegExp(CONVERSATION_ID).test(conversationId)) {
      return json(400, { error: "invalid_request", message: "the conversation id is not valid" });
    }
    return respond(await options.backend().reset({ conversationId }, ctx));
  });
}
