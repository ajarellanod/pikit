/**
 * What channel-http does with a request once its route authenticated and read it, answered as HTTP
 * (`Reply`: a status and a JSON body). Two backends, one contract:
 *
 * - **local** (`createLocalBackend`): where the conversation is (the server's App, or the conversation's
 *   Durable Object). A message takes the inbound path (`admitInbound`) and waits for its run's end,
 *   up to `replyTimeoutMs`; a message's outcome is read from `agent.submissions`; a reset is the
 *   registry's.
 * - **remote** (`createRemoteBackend`): an App whose conversations are other actors (the Worker's, or
 *   a Durable Object's routes for another key). Each request is one `actor.mailbox.call` to the
 *   conversation `http:<conversationId>`, whose App answers it with its local backend
 *   (`answerCalls`). A message's call lasts as long as its wait: the wait is inside that RPC's event,
 *   which keeps the object running (a promise left after an event would die with it).
 *
 * The calls, answered in the conversation's App (`actor.inbox.answer`), each with a `Reply`:
 *
 * | Type | Message |
 * |---|---|
 * | `channel-http.message` | `{ conversationId, text, requestId, actor: { id } }` |
 * | `channel-http.status` | `{ conversationId, requestId }` |
 * | `channel-http.reset` | `{ conversationId }` |
 *
 * Each message is checked again on arrival (it crossed an RPC), and must name the conversation of
 * the key it was sent to (`invalid_request` otherwise): an actor answers only for itself.
 */

import type { AppContext } from "@pikit/core";
import {
  ActorCallError,
  type ActorInbox,
  type ActorMailbox,
  admitInbound,
  type AgentRuntime,
  type AgentSubmissions,
  type ConversationRegistry,
  foldParts,
  type InboundMessage,
  isDashboardRequest,
  type JsonValue,
  type RunSettlement,
} from "@pikit/contracts";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { CONVERSATION_ID, MESSAGE_ID } from "./body.ts";
import type { Replies } from "./replies.ts";
import { CHANNEL, conversationKey } from "./routes.ts";

/** What a route answers: a status and a JSON body. It crosses an RPC as it is. */
export type Reply = { status: number; body: { [field: string]: JsonValue } };

/** A message, authenticated and read by its route. */
export type HttpMessage = { conversationId: string; text: string; requestId: string; actor: { id: string } };
/** A message's outcome, asked for. */
export type HttpStatus = { conversationId: string; requestId: string };
/** A conversation to start over. */
export type HttpReset = { conversationId: string };

export interface HttpBackend {
  message(message: HttpMessage, ctx: AppContext): Promise<Reply>;
  status(request: HttpStatus, ctx: AppContext): Promise<Reply>;
  reset(request: HttpReset, ctx: AppContext): Promise<Reply>;
}

export const CALL = {
  message: "channel-http.message",
  status: "channel-http.status",
  reset: "channel-http.reset",
} as const;

const reply = (status: number, body: Reply["body"]): Reply => ({ status, body });

/** What a run's end means for one of its messages, as HTTP: the POST's answer, and the GET's. */
export function outcome(requestId: string, run: Pick<RunSettlement, "kind" | "text" | "parts" | "error">): Reply {
  // Its parts as their fallbacks, after its text: HTTP draws none.
  if (run.kind === "completed") return reply(200, { requestId, text: foldParts({ text: run.text ?? "", ...(run.parts !== undefined && { parts: run.parts }) }).text });
  if (run.kind === "aborted") return reply(409, { requestId, error: "aborted" });
  return reply(502, { requestId, error: run.error?.code ?? "failed" });
}

export interface LocalDeps {
  conversations: () => ConversationRegistry;
  runtime: () => AgentRuntime;
  /** Optional: with it, a message's outcome can be read later (GET), and a repeated POST answers it. */
  submissions: () => AgentSubmissions | undefined;
  /** The POSTs waiting for their answer, which the runtime's events answer. */
  replies: Replies;
  replyTimeoutMs: number;
}

/** The backend where the conversation is. `ctx` bounds a message's wait: cancelled, it answers `202`. */
export function createLocalBackend(deps: LocalDeps): HttpBackend {
  return {
    async message({ conversationId, text, requestId, actor }, ctx) {
      const message: InboundMessage = { id: requestId, channel: CHANNEL, conversationId, actor, text };
      // The answer may come before dispatch returns: wait for it from right before dispatch.
      let waiter: ReturnType<Replies["expect"]> | undefined;
      const inbound = await admitInbound(ctx, message, {
        conversations: deps.conversations(),
        runtime: deps.runtime(),
        key: conversationKey(conversationId),
        beforeDispatch: (conversation) => {
          // Called again when the key moved to a new conversation (its agent gone): the last one counts.
          waiter?.cancel();
          waiter = deps.replies.expect(conversation.conversationId, requestId);
        },
      }).catch((error: unknown) => {
        waiter?.cancel();
        throw error;
      });
      if (inbound.kind !== "admitted") waiter?.cancel();
      switch (inbound.kind) {
        case "halted":
          return reply(inbound.pipeline === "inbound.normalize" ? 422 : 403, { requestId, error: "rejected", message: inbound.reason });
        case "denied":
          return reply(403, { requestId, error: "denied", ...(inbound.reason !== undefined && { message: inbound.reason }) });
        case "no_route":
          return reply(500, { requestId, error: "no_route" });
        case "duplicate": {
          // The client sent it again (a retry after a timeout): what became of it, when it is known.
          const known = await deps.submissions()?.get(inbound.conversation, requestId, ctx);
          if (known === undefined) return reply(409, { requestId, error: "duplicate" });
          return known.kind === "pending" ? reply(202, { requestId }) : outcome(requestId, known.run);
        }
        case "admitted":
          break;
      }
      if (waiter === undefined) throw new Error("channel-http: admitted without waiting for the answer");

      // Admitted: the message is durable in its conversation, whatever the wait gives.
      const answer = await waiter.wait(deps.replyTimeoutMs, ctx.abortSignal);
      if (answer.kind !== "answered") return reply(202, { requestId });
      return outcome(requestId, answer.result);
    },

    async status({ conversationId, requestId }, ctx) {
      const record = deps.submissions();
      if (record === undefined) {
        return reply(501, { error: "not_supported", message: "this app keeps no record of messages' outcomes; install a runtime that provides agent.submissions (runtime-pi)" });
      }
      const conversation = await deps.conversations().get(conversationKey(conversationId), ctx);
      const known = conversation === undefined ? undefined : await record.get(conversation, requestId, ctx);
      if (known === undefined) return reply(404, { requestId, error: "not_found" });
      return known.kind === "pending" ? reply(202, { requestId }) : outcome(requestId, known.run);
    },

    async reset({ conversationId }, ctx) {
      const reset = await deps.conversations().reset(conversationKey(conversationId), undefined, ctx);
      if (reset === undefined) return reply(404, { error: "not_found" });
      return reply(200, { conversationId, previousRuntimeConversationId: reset.previousConversationId, runtimeConversationId: reset.newConversationId });
    },
  };
}

/**
 * The backend of an App whose conversations are other actors: each request is a call to its
 * conversation's actor. An actor that cannot be reached (`unreachable`: a deploy reset its object
 * mid-call) is `503 unavailable`, with the request id: the message may have been admitted, so the
 * client reads it with GET, or sends it again with the same `messageId`. Any other failure throws (the
 * server's `500`), as the local backend's do.
 */
export function createRemoteBackend(mailbox: () => ActorMailbox): HttpBackend {
  const ask = async (conversationId: string, type: string, message: JsonValue, unavailable: Reply["body"], ctx: AppContext): Promise<Reply> => {
    let answer: JsonValue;
    try {
      answer = await mailbox().call(conversationKey(conversationId), type, message, ctx);
    } catch (error) {
      if (error instanceof ActorCallError && error.code === "unreachable") {
        ctx.logger.warn("channel-http: the conversation's actor could not be reached", { conversation: conversationKey(conversationId), type, error: error.message });
        return reply(503, { ...unavailable, error: "unavailable" });
      }
      throw error;
    }
    if (!Value.Check(ReplySchema, answer)) throw new Error(`channel-http: the conversation's actor answered ${type} with something that is not a reply`);
    // A JSON copy (the call made it one), checked: its body's fields are JSON.
    return answer as Reply;
  };
  return {
    message: (message, ctx) => ask(message.conversationId, CALL.message, message, { requestId: message.requestId }, ctx),
    status: (request, ctx) => ask(request.conversationId, CALL.status, request, { requestId: request.requestId }, ctx),
    reset: (request, ctx) => ask(request.conversationId, CALL.reset, request, {}, ctx),
  };
}

const ReplySchema = Type.Object({ status: Type.Integer({ minimum: 200, maximum: 599 }), body: Type.Record(Type.String(), Type.Unknown()) });

const MessageCall = Type.Object(
  {
    conversationId: Type.String({ pattern: CONVERSATION_ID }),
    text: Type.String({ minLength: 1 }),
    requestId: Type.String({ pattern: MESSAGE_ID }),
    actor: Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
const StatusCall = Type.Object({ conversationId: Type.String({ pattern: CONVERSATION_ID }), requestId: Type.String({ pattern: MESSAGE_ID }) }, { additionalProperties: false });
const ResetCall = Type.Object({ conversationId: Type.String({ pattern: CONVERSATION_ID }) }, { additionalProperties: false });

/** `message`, checked against `schema` and against the actor's own `key`, or an `invalid_request` refusal. */
function checked<S extends TSchema>(schema: S, type: string, key: string, message: JsonValue): Static<S> & { conversationId: string } {
  if (!Value.Check(schema, message)) {
    const [first] = Value.Errors(schema, message);
    throw new ActorCallError("invalid_request", `channel-http: a ${type} call is not valid: ${first?.instancePath || "the message"} ${first?.message ?? "is invalid"}`);
  }
  const value = message as Static<S> & { conversationId: string };
  if (conversationKey(value.conversationId) !== key) throw new ActorCallError("invalid_request", `channel-http: a ${type} call names another conversation than this actor's (${key})`);
  return value;
}

/** Registers the answers of the calls above over `backend` (this App's local one). Call in `start`. */
export function answerCalls(inbox: ActorInbox, backend: HttpBackend): void {
  inbox.answer(CALL.message, async (key, message, ctx) => {
    const value = checked(MessageCall, CALL.message, key, message);
    // The operator's ids are reserved (`admitInbound` refuses them); the route refused it already.
    if (isDashboardRequest(value.requestId)) throw new ActorCallError("invalid_request", "channel-http: a message's id never starts with the dashboard's prefix");
    return await backend.message(value, ctx);
  });
  inbox.answer(CALL.status, async (key, message, ctx) => await backend.status(checked(StatusCall, CALL.status, key, message), ctx));
  inbox.answer(CALL.reset, async (key, message, ctx) => await backend.reset(checked(ResetCall, CALL.reset, key, message), ctx));
}
