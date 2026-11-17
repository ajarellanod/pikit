/**
 * The Worker's backend, on Cloudflare: each conversation lives in the Durable Object of its key
 * (`web:<user>:<chat>`), which the Worker reaches only by `actor.mailbox` (`calls.ts`); the users'
 * list and their projects are the accounts actor's index (`ACCOUNTS_KEY`), one call, no call per
 * conversation.
 *
 * - **Projects** are the project store's, which the Worker's App reaches itself (`project-routes.ts`); the
 *   index answers only what it keeps: a project's conversations, every member's, and how many, and the
 *   migration of the projects this channel kept itself (in the accounts actor, whose table they are).
 * - **Live events are streamed**: the object's `channel-web.live` stream, one RPC, as on a server. The
 *   object stays in memory while it is open; a stream cut by an eviction or a deploy ends, and the page
 *   reconnects.
 * - **A message's images** are at most `MAX_DURABLE_IMAGE_BYTES` in all (`413`), checked by the route
 *   before any call (the object checks again): a message is one Durable Object row.
 */

import type { AppContext } from "@pikit/core";
import type { ActorMailbox, JsonValue } from "@pikit/contracts";
import type { ChatConversation, ChatEvent, ChatImage, ChatPage, ChatSendResponse, ChatTranscriptEntry } from "./api.ts";
import type { ChatBackend, ChatRef, FirstMessage, ProjectConversation } from "./backend.ts";
import { ACCOUNTS_KEY, CALL, LIVE } from "./calls.ts";

export function createRemoteBackend(mailbox: () => ActorMailbox): ChatBackend {
  const call = async <T>(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<T> => (await mailbox().call(key, type, message, ctx)) as T;
  const named = ({ userId, chatId }: ChatRef) => ({ userId, chatId });
  const sendable = (ref: ChatRef, message: FirstMessage): JsonValue => ({ ...named(ref), ...message }) as unknown as JsonValue;

  return {
    list: (userId, { archived, ...query }, ctx) => call<ChatPage<ChatConversation>>(ACCOUNTS_KEY, CALL.list, { userId, ...query, ...(archived === true && { archived }) }, ctx),
    projectConversations: (id, page, ctx) => call<ChatPage<ProjectConversation>>(ACCOUNTS_KEY, CALL.projectConversations, { id, ...page }, ctx),
    projectConversation: (id, chatId, ctx) => call<{ userId: string }>(ACCOUNTS_KEY, CALL.projectConversation, { id, chatId }, ctx),
    projectChats: async (ids, ctx) => (await call<{ chats: Record<string, number> }>(ACCOUNTS_KEY, CALL.projectChats, { ids: [...ids] }, ctx)).chats,
    migrateProjects: async (ctx) => (await call<{ made: number }>(ACCOUNTS_KEY, CALL.migrateProjects, {}, ctx)).made,
    start: (ref, message, ctx) => call<ChatSendResponse>(ref.key, CALL.start, sendable(ref, message), ctx),
    send: (ref, message, ctx) => call<ChatSendResponse>(ref.key, CALL.send, sendable(ref, message), ctx),
    conversation: (ref, ctx) => call<ChatConversation>(ref.key, CALL.conversation, named(ref), ctx),
    rename: (ref, title, ctx) => call<ChatConversation>(ref.key, CALL.rename, { ...named(ref), title }, ctx),
    archive: (ref, archived, ctx) => call<ChatConversation>(ref.key, CALL.archive, { ...named(ref), archived }, ctx),
    async hide(ref, ctx) {
      await call<JsonValue>(ref.key, CALL.hide, named(ref), ctx);
    },
    transcript: (ref, page, ctx) => call<ChatPage<ChatTranscriptEntry>>(ref.key, CALL.transcript, { ...named(ref), ...page }, ctx),
    image: (ref, messageId, index, ctx) => call<ChatImage>(ref.key, CALL.image, { ...named(ref), messageId, index }, ctx),
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
