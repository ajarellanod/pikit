/**
 * channel-http: talk to an agent over HTTP (samples/http's scenario-1.test.ts).
 *
 *   POST /v1/messages                              { conversationId, text, messageId? }
 *   GET  /v1/conversations/:id/messages/:messageId  the outcome of a message, later
 *   POST /v1/conversations/:id/reset
 *
 * All need `Authorization: Bearer <PIKIT_HTTP_TOKEN>`, read from `secrets` at start.
 *
 * A message goes through the inbound path (@pikit/contracts' inbound.ts):
 * 1. `http.authenticate`: this channel's stage checks the bearer token. The pipeline is this
 *    component's own (declared below): how a sender proves who it is depends on the platform, so it
 *    is not a shared contract. A project extension adds a stage to it, as to any pipeline.
 * 2. The body becomes an `InboundMessage`, and `admitInbound` takes it the way every channel does:
 *    `inbound.normalize`, `route.resolve` (a router picks the agent), the conversation
 *    `http:<conversationId>`, and `agent.runtime.dispatch`: Pi takes the message. An idle
 *    conversation starts a run. A busy one steers the run in progress, and that run answers this
 *    message too. A message a stage stops gets `422` (a policy in `inbound.normalize`) or `403`
 *    (`route.resolve`, or the router's deny); no router installed is `500 no_route`.
 *
 * The POST then waits for the answer, up to `replyTimeoutMs`:
 * - `200 { requestId, text }`: the run answered it.
 * - `202 { requestId }`: no answer in time, or the server is stopping. The answer still lands in
 *   the conversation's session; nothing is lost.
 * - `502 { requestId, error }`: the run failed. `409 { error: "aborted" }`: it was stopped.
 *   `502 { requestId, error: "abandoned" }`: the runtime gave up on it (its agent or session is gone,
 *   or it waited too long): it was never answered and never will be; send it again.
 * - A `messageId` already in the conversation does not run again. With `agent.submissions` installed
 *   (runtime-pi provides it), the POST answers with its outcome, as above (`202` while it is still
 *   running). Without it, `409 { requestId, error: "duplicate" }`: its answer went to the POST that
 *   sent it first.
 *
 * `GET /v1/conversations/:id/messages/:messageId`, with `agent.submissions` installed: what became of
 * a message, as its POST would have answered (`200` / `202` / `502` / `409 aborted`), or `404` when
 * the conversation's current session has no such message (never sent, or sent before a reset).
 * Without it: `501`, since nothing keeps the outcome of a message outside its session.
 *
 * Delivery `[decision]`: the answer is returned in the HTTP response, not queued in `outbound.queue`
 * (`outbound-durable`) and sent by a `ChannelTransport`, as a chat channel's is. The channel
 * listens to `agent.settled` / `agent.failed` itself and answers every POST waiting for one of the
 * run's `requestIds`. The map of waiting POSTs is a cache: the answer is in the session anyway, and
 * in `agent.submissions` when installed.
 * Guarantee: a message accepted by `dispatch` (any answer but 4xx/5xx before it) is in the session
 * and will be answered there, at least once.
 *
 * Targets: `server` and `durable` (fetch handlers and Web Crypto only).
 */

import { type AppContext, defineComponent, Halt } from "@pikit/core";
import { admitInbound, type AgentResult, type InboundMessage, type RunSettlement } from "@pikit/contracts";
import Type from "typebox";
import { bearerToken, type Digest, digest, matches, MIN_TOKEN_LENGTH, TOKEN_SECRET } from "./auth.ts";
import { CONVERSATION_ID, MESSAGE_ID, readMessageBody } from "./body.ts";
import { Replies } from "./replies.ts";

export const CHANNEL = "http";

declare module "@pikit/core" {
  interface AppPipelines {
    /**
     * Authenticates a request to this channel. A stage acts only on its own `channel` and leaves a
     * rejection alone. A request is authenticated only when a stage says so: no verdict is a
     * rejection.
     */
    "http.authenticate": {
      channel: string;
      request: Request;
      verdict?: { kind: "authenticated"; actor: InboundMessage["actor"] } | { kind: "rejected"; reason: string };
    };
  }
}

const Config = Type.Object({
  /** How long a POST waits for the agent's answer before `202`. */
  replyTimeoutMs: Type.Integer({ minimum: 1, default: 120_000 }),
});

/** The conversation key of a client's conversation id. */
export const conversationKey = (conversationId: string): string => `${CHANNEL}:${conversationId}`;

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const UNAUTHORIZED = (): Response =>
  Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="pikit"' } });

/** A path segment, decoded; `""` (never a valid id) when its escapes are malformed (`%E0`): a 400, not a 500. */
function segment(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return "";
  }
}

/** What a run's end means for one of its messages, as HTTP: the POST's answer, and the GET's. */
function outcome(requestId: string, run: Pick<RunSettlement, "kind" | "text" | "error">): Response {
  if (run.kind === "completed") return json(200, { requestId, text: run.text ?? "" });
  if (run.kind === "aborted") return json(409, { requestId, error: "aborted" });
  return json(502, { requestId, error: run.error?.code ?? "failed" });
}

export default defineComponent({
  name: "channel-http",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const conversations = pikit.use("conversations.registry");
    const runtime = pikit.use("agent.runtime");
    // Optional: with it, a message's outcome can be read later (GET), and a repeated POST answers it.
    const submissions = pikit.useOptional("agent.submissions");
    const replies = new Replies();
    /** The token's digest, from start to stop. No token, no requests. */
    let token: Digest | undefined;

    // This channel's authentication: it acts on its own requests and leaves a rejection alone.
    pikit.pipeline(
      "http.authenticate",
      async (value) => {
        if (value.channel !== CHANNEL || value.verdict?.kind === "rejected") return value;
        const presented = bearerToken(value.request.headers.get("authorization"));
        if (presented === undefined || token === undefined) return { ...value, verdict: { kind: "rejected", reason: "missing bearer token" } };
        return (await matches(presented, token))
          ? { ...value, verdict: { kind: "authenticated", actor: { id: CHANNEL } } }
          : { ...value, verdict: { kind: "rejected", reason: "wrong bearer token" } };
      },
      { id: "channel-http-bearer", priority: 100 },
    );

    // Answers come from the runtime's events, for runs whoever started them.
    const deliver = (result: AgentResult): void => replies.answer(result);
    pikit.on("agent.settled", deliver);
    pikit.on("agent.failed", deliver);

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

      const message: InboundMessage = {
        id: requestId,
        channel: CHANNEL,
        conversationId,
        actor,
        text,
        raw: read.body,
        receivedAt: ctx.clock.now(),
      };
      // The answer may come before dispatch returns: wait for it from right before dispatch.
      let waiter: ReturnType<Replies["expect"]> | undefined;
      const inbound = await admitInbound(ctx, message, {
        conversations: conversations.get(),
        runtime: runtime.get(),
        key: conversationKey(conversationId),
        beforeDispatch: (conversation) => {
          waiter = replies.expect(conversation.conversationId, requestId);
        },
      }).catch((error: unknown) => {
        waiter?.cancel();
        throw error;
      });
      if (inbound.kind !== "admitted") waiter?.cancel();
      switch (inbound.kind) {
        case "halted":
          return json(inbound.pipeline === "inbound.normalize" ? 422 : 403, { requestId, error: "rejected", message: inbound.reason });
        case "denied":
          return json(403, { requestId, error: "denied", ...(inbound.reason !== undefined && { message: inbound.reason }) });
        case "no_route":
          return json(500, { requestId, error: "no_route" });
        case "duplicate": {
          // The client sent it again (a retry after a timeout): what became of it, when it is known.
          const known = await submissions.get()?.get(inbound.conversation, requestId, ctx);
          if (known === undefined) return json(409, { requestId, error: "duplicate" });
          return known.kind === "pending" ? json(202, { requestId }) : outcome(requestId, known.run);
        }
        case "admitted":
          break;
      }
      if (waiter === undefined) throw new Error("channel-http: admitted without waiting for the answer");

      const answer = await waiter.wait(config.replyTimeoutMs, ctx.abortSignal);
      if (answer.kind !== "answered") return json(202, { requestId });
      return outcome(requestId, answer.result);
    });

    pikit.provideKeyed("http.route", "GET /v1/conversations/:id/messages/:messageId", async (request, ctx) => {
      if ((await authenticated(request, ctx)) === undefined) return UNAUTHORIZED();
      const record = submissions.get();
      if (record === undefined) {
        return json(501, { error: "not_supported", message: "this app keeps no record of messages' outcomes; install a runtime that provides agent.submissions (runtime-pi)" });
      }
      const [, , , id = "", , message = ""] = new URL(request.url).pathname.split("/");
      const conversationId = segment(id);
      const requestId = segment(message);
      if (!new RegExp(CONVERSATION_ID).test(conversationId) || !new RegExp(MESSAGE_ID).test(requestId)) {
        return json(400, { error: "invalid_request", message: "the conversation id or the message id is not valid" });
      }
      const conversation = await conversations.get().get(conversationKey(conversationId), ctx);
      const known = conversation === undefined ? undefined : await record.get(conversation, requestId, ctx);
      if (known === undefined) return json(404, { requestId, error: "not_found" });
      return known.kind === "pending" ? json(202, { requestId }) : outcome(requestId, known.run);
    });

    pikit.provideKeyed("http.route", "POST /v1/conversations/:id/reset", async (request, ctx) => {
      if ((await authenticated(request, ctx)) === undefined) return UNAUTHORIZED();
      const conversationId = segment(new URL(request.url).pathname.split("/")[3]);
      if (!new RegExp(CONVERSATION_ID).test(conversationId)) {
        return json(400, { error: "invalid_request", message: "the conversation id is not valid" });
      }
      const reset = await conversations.get().reset(conversationKey(conversationId), ctx);
      if (reset === undefined) return json(404, { error: "not_found" });
      return json(200, { conversationId, previousRuntimeConversationId: reset.previousConversationId, runtimeConversationId: reset.newConversationId });
    });

    return {
      async start() {
        // Fail at start: a channel that would refuse every request is a broken deployment.
        const value = await secrets.get().get(TOKEN_SECRET);
        if (value === undefined) throw new Error(`channel-http: the secret ${TOKEN_SECRET} is not set`);
        if (value.length < MIN_TOKEN_LENGTH) throw new Error(`channel-http: the secret ${TOKEN_SECRET} is shorter than ${MIN_TOKEN_LENGTH} characters`);
        token = await digest(value);
      },
      stop() {
        token = undefined;
      },
    };
  },
});
