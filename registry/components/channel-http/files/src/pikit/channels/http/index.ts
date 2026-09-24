/**
 * channel-http: talk to an agent over HTTP (SPEC §5, §15 scenario 1).
 *
 *   POST /v1/messages                    { conversationId, text, messageId? }
 *   POST /v1/conversations/:id/reset
 *
 * Both need `Authorization: Bearer <PIKIT_HTTP_TOKEN>`, read from `secrets` at start.
 *
 * A message goes through the inbound path of SPEC §5:
 * 1. `inbound.authenticate`: this channel's stage checks the bearer token.
 * 2. `inbound.normalize`: the body becomes an `InboundMessage`.
 * 3. `route.resolve`: a router picks the agent.
 * 4. `conversations.registry`: the conversation `http:<conversationId>` and its session.
 * 5. `agent.runtime.dispatch`: Pi takes the message. An idle conversation starts a run. A busy one
 *    steers the run in progress, and that run answers this message too.
 *
 * The POST then waits for the answer, up to `replyTimeoutMs`:
 * - `200 { requestId, text }`: the run answered it.
 * - `202 { requestId }`: no answer in time, or the server is stopping. The answer still lands in
 *   the conversation's session; nothing is lost.
 * - `409 { requestId, error: "duplicate" }`: this `messageId` is already in the conversation. It
 *   does not run again, and its answer went to the POST that sent it first.
 * - `502 { requestId, error }`: the run failed. `409 { error: "aborted" }`: it was stopped.
 *
 * Delivery `[decision]` for M1: the answer is returned in the HTTP response, not sent through
 * `outbound.prepare` and `channel.transport`, which arrive in M2 with `durable-outbox`. The channel
 * listens to `agent.settled` / `agent.failed` itself and answers every POST waiting for one of the
 * run's `requestIds`. The map of waiting POSTs is a cache: the answer is in the session anyway.
 * Guarantee: a message accepted by `dispatch` (any answer but 4xx/5xx before it) is in the session
 * and will be answered there, at least once.
 *
 * Targets: `server` and `cloudflare` (fetch handlers and Web Crypto only).
 */

import { type Admission, type AgentResult, type AppContext, defineComponent, Halt, type InboundMessage } from "@pikit/core";
import Type from "typebox";
import { bearerToken, type Digest, digest, matches, MIN_TOKEN_LENGTH, TOKEN_SECRET } from "./auth.ts";
import { CONVERSATION_ID, readMessageBody } from "./body.ts";
import { Replies } from "./replies.ts";

export const CHANNEL = "http";

const Config = Type.Object({
  /** How long a POST waits for the agent's answer before `202`. */
  replyTimeoutMs: Type.Integer({ minimum: 1, default: 120_000 }),
});

/** The conversation key of a client's conversation id. */
export const conversationKey = (conversationId: string): string => `${CHANNEL}:${conversationId}`;

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const UNAUTHORIZED = (): Response =>
  Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="pikit"' } });

export default defineComponent({
  name: "channel-http",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const conversations = pikit.use("conversations.registry");
    const runtime = pikit.use("agent.runtime");
    const replies = new Replies();
    /** The token's digest, from start to stop. No token, no requests. */
    let token: Digest | undefined;

    // This channel's authentication: it acts on its own requests and leaves a rejection alone.
    pikit.pipeline(
      "inbound.authenticate",
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

    /** Who sent `request`, if `inbound.authenticate` says it is authenticated. */
    const authenticated = async (request: Request, ctx: AppContext): Promise<InboundMessage["actor"] | undefined> => {
      const checked = await ctx.run("inbound.authenticate", { channel: CHANNEL, request });
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
      const normalized = await ctx.run("inbound.normalize", message);
      if (normalized instanceof Halt) return json(422, { requestId, error: "rejected", message: normalized.reason });
      if (normalized.id !== requestId || normalized.channel !== CHANNEL || normalized.conversationId !== conversationId) {
        throw new Error("channel-http: an inbound.normalize stage changed the message's id, channel or conversation");
      }

      const routed = await ctx.run("route.resolve", { message: normalized });
      if (routed instanceof Halt) return json(403, { requestId, error: "rejected", message: routed.reason });
      const decision = routed.decision;
      if (decision === undefined) {
        ctx.logger.error("channel-http: no route.resolve stage decided; install a router", { requestId });
        return json(500, { requestId, error: "no_route" });
      }
      if (decision.access === "deny") return json(403, { requestId, error: "denied", ...(decision.reason !== undefined && { message: decision.reason }) });

      const conversation = await conversations.get().resolve(conversationKey(conversationId), decision.agent, ctx);
      const waiter = replies.expect(conversation.sessionId, requestId);
      let admission: Admission;
      try {
        admission = await runtime.get().dispatch({ requestId, conversation, prompt: normalized.text }, ctx);
      } catch (error) {
        waiter.cancel();
        throw error;
      }
      if (admission.kind === "duplicate") {
        waiter.cancel();
        return json(409, { requestId, error: "duplicate" });
      }

      const outcome = await waiter.wait(config.replyTimeoutMs, ctx.abortSignal);
      if (outcome.kind !== "answered") return json(202, { requestId });
      const { result } = outcome;
      if (result.kind === "completed") return json(200, { requestId, text: result.text ?? "" });
      if (result.kind === "aborted") return json(409, { requestId, error: "aborted" });
      return json(502, { requestId, error: result.error?.code ?? "failed" });
    });

    pikit.provideKeyed("http.route", "POST /v1/conversations/:id/reset", async (request, ctx) => {
      if ((await authenticated(request, ctx)) === undefined) return UNAUTHORIZED();
      const conversationId = decodeURIComponent(new URL(request.url).pathname.split("/")[3] ?? "");
      if (!new RegExp(CONVERSATION_ID).test(conversationId)) {
        return json(400, { error: "invalid_request", message: "the conversation id is not valid" });
      }
      const reset = await conversations.get().reset(conversationKey(conversationId), ctx);
      if (reset === undefined) return json(404, { error: "not_found" });
      return json(200, { conversationId, previousSessionId: reset.previousSessionId, sessionId: reset.newSessionId });
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
