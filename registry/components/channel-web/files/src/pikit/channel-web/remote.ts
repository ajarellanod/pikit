/**
 * The Worker's backend, on Cloudflare: each conversation lives in the Durable Object of its key
 * (`web:<user>:<chat>`), which the Worker reaches only by `actor.mailbox` (`calls.ts`); the users'
 * list is the accounts actor's index (`ACCOUNTS_KEY`), one call, no call per conversation.
 *
 * - **Live events are streamed**: the object's `channel-web.live` stream, one RPC, as on a server. The
 *   object stays in memory while it is open; a stream cut by an eviction or a deploy ends, and the page
 *   reconnects.
 * - **A message's images** are at most `MAX_DURABLE_IMAGE_BYTES` in all (`413`), checked by the route
 *   before any call (the object checks again): a message is one Durable Object row.
 */

import type { AppContext } from "@pikit/core";
import type { ActorMailbox, JsonValue } from "@pikit/contracts";
import type { ChatConversation, ChatEvent, ChatMessage, ChatPage, ChatSendResponse } from "./api.ts";
import type { ChatBackend, ChatRef, NewMessage } from "./backend.ts";
import { ACCOUNTS_KEY, CALL, LIVE } from "./calls.ts";

export function createRemoteBackend(mailbox: () => ActorMailbox): ChatBackend {
  const call = async <T>(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<T> => (await mailbox().call(key, type, message, ctx)) as T;
  const named = ({ userId, chatId }: ChatRef) => ({ userId, chatId });
  const sendable = (ref: ChatRef, message: NewMessage): JsonValue => ({ ...named(ref), ...message }) as unknown as JsonValue;

  return {
    list: (userId, page, ctx) => call<ChatPage<ChatConversation>>(ACCOUNTS_KEY, CALL.list, { userId, ...page }, ctx),
    start: (ref, message, ctx) => call<ChatSendResponse>(ref.key, CALL.start, sendable(ref, message), ctx),
    send: (ref, message, ctx) => call<ChatSendResponse>(ref.key, CALL.send, sendable(ref, message), ctx),
    conversation: (ref, ctx) => call<ChatConversation>(ref.key, CALL.conversation, named(ref), ctx),
    rename: (ref, title, ctx) => call<ChatConversation>(ref.key, CALL.rename, { ...named(ref), title }, ctx),
    async hide(ref, ctx) {
      await call<JsonValue>(ref.key, CALL.hide, named(ref), ctx);
    },
    messages: (ref, page, ctx) => call<ChatPage<ChatMessage>>(ref.key, CALL.messages, { ...named(ref), ...page }, ctx),
    // Refused before the stream starts: an unknown conversation is a 404, not an empty stream.
    live: async (ref, ctx) => (await mailbox().stream(ref.key, LIVE, named(ref), ctx)) as AsyncIterable<ChatEvent>,
    async abort(ref, ctx) {
      await call<JsonValue>(ref.key, CALL.abort, named(ref), ctx);
    },
    async forget(userId, ctx) {
      await call<JsonValue>(ACCOUNTS_KEY, CALL.forget, { userId }, ctx);
    },
  };
}
