/**
 * The Worker's host, on Cloudflare: each conversation lives in the Durable Object of its key, which
 * the Worker reaches only by `actor.mailbox.call` (JSON in, JSON out, no stream). Every read and action
 * on a conversation is one call to that object (`calls.ts`), which answers with its own ids; the list,
 * the titles and the states are the directory's, which the Worker asks itself (`backend.ts`).
 *
 * - **Live events are streamed**: `live` opens the object's `admin-api.live` stream (one RPC,
 *   `actor.mailbox.stream`), which yields its conversation's events as they happen, as on a server:
 *   the answer as it is written. The object stays in memory while the stream is open, which is while
 *   the dashboard follows the conversation (its tab active, `live.ts`); a stream cut by an eviction or
 *   a deploy ends, and the dashboard reconnects.
 * - **The composition**, **the agents** and **the slash commands** are an object's App's (`APP_KEY`'s:
 *   every object runs the same App), where the agents run. A command runs in its conversation's object,
 *   as the other actions do.
 * - **A message's images** are at most `MAX_DURABLE_IMAGE_BYTES` in all (`413 too_large`), checked
 *   before the call: the object stores the message in one Durable Object row (2 MB at most).
 */

import type { AppContext } from "@pikit/core";
import type { ActorMailbox, JsonValue } from "@pikit/contracts";
import {
  type ApiAgents,
  type ApiApp,
  type ApiCommandResponse,
  type ApiCommands,
  type ApiConversation,
  type ApiEvent,
  type ApiPage,
  type ApiResetResponse,
  type ApiSendResponse,
  type ApiStartResponse,
  type ApiTranscriptEntry,
  type ApiUsage,
  attachmentsProblem,
} from "./api.ts";
import { CALL, LIVE } from "./calls.ts";
import { type ConversationHost, type Message, refusal } from "./host.ts";

/** Conversations read in one page of the list: one call each, besides the directory's. */
export const CONVERSATIONS_PER_PAGE = 20;

/** The object the Worker asks for the App's composition, agents and commands: any runs the same App; this one holds no conversation. */
export const APP_KEY = "admin-api:app";

export function createRemoteHost(mailbox: () => ActorMailbox): ConversationHost {
  const call = async <T>(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<T> => (await mailbox().call(key, type, message, ctx)) as T;

  /** `message` as a call carries it, its images within what an object stores. */
  const sendable = (message: Message): JsonValue => {
    const wrong = attachmentsProblem(message.attachments ?? [], "durable");
    if (wrong !== undefined) throw refusal(wrong.status === 413 ? "too_large" : "invalid_request", wrong.message);
    return message as unknown as JsonValue;
  };

  return {
    app: (ctx) => call<ApiApp>(APP_KEY, CALL.app, null, ctx),

    agents: (ctx) => call<ApiAgents>(APP_KEY, CALL.agents, null, ctx),

    commands: (ctx) => call<ApiCommands>(APP_KEY, CALL.commands, null, ctx),

    conversation: ({ key, conversationId }, ctx) => call<ApiConversation>(key, CALL.conversation, { conversationId }, ctx),

    transcript: ({ key, conversationId }, page, ctx) => call<ApiPage<ApiTranscriptEntry>>(key, CALL.transcript, { conversationId, ...page }, ctx),

    // Refused before the stream starts: an unknown conversation is a 404, not an empty stream.
    live: async ({ key, conversationId }, ctx) => (await mailbox().stream(key, LIVE, { conversationId }, ctx)) as AsyncIterable<ApiEvent>,

    usage: ({ key, conversationId }, ctx) => call<ApiUsage>(key, CALL.usage, { conversationId }, ctx),

    send: ({ key, conversationId }, message, ctx) => call<ApiSendResponse>(key, CALL.message, { conversationId, ...(sendable(message) as object) } as JsonValue, ctx),

    abort: async ({ key, conversationId }, ctx) => void (await call<JsonValue>(key, CALL.abort, { conversationId }, ctx)),

    reset: ({ key, conversationId }, ctx) => call<ApiResetResponse>(key, CALL.reset, { conversationId }, ctx),

    async command({ key, conversationId }, name, args, ctx) {
      const answer = await call<ApiCommandResponse>(key, CALL.command, { conversationId, name, args }, ctx);
      return typeof answer.text === "string" ? { text: answer.text } : {};
    },

    start: ({ key, agent, ...rest }, ctx) => call<ApiStartResponse>(key, CALL.start, { agent, ...(sendable(rest) as object) } as JsonValue, ctx),
  };
}
