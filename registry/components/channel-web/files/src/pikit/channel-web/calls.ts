/**
 * On Cloudflare: the Worker's calls to the objects (`actor.mailbox.call`, answered with
 * `actor.inbox.answer` in each object's App), its one stream, and the message each conversation's
 * object sends the users' index. Every object registers them all; each is used where it belongs.
 *
 * To a conversation's object (the key `web:<user>:<chat>`), answered by the local backend over its
 * store (`backend.ts`). Every message names `{ userId, chatId }`, and the object refuses one whose
 * `keyOf(userId, chatId)` is not its own key (`invalid_request`): an object answers only of itself.
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `channel-web.start` | `{ userId, chatId, text, images?, requestId }` | `ChatSendResponse`: the conversation made with its first message |
 * | `channel-web.send` | the same | `ChatSendResponse` |
 * | `channel-web.conversation` | `{ userId, chatId }` | `ChatConversation` |
 * | `channel-web.rename` | `{ userId, chatId, title }` | `ChatConversation` |
 * | `channel-web.hide` | `{ userId, chatId }` | `{}` |
 * | `channel-web.messages` | `{ userId, chatId, limit, cursor? }` | `ChatPage<ChatMessage>`, shorter than `limit` when it would not fit in an answer (`ANSWER_CHARS`) |
 * | `channel-web.abort` | `{ userId, chatId }` | `{}` |
 *
 * And one stream: `channel-web.live` `{ userId, chatId }`, the conversation's `ChatEvent`s, refused
 * `not_found` before the first; it ends when the Worker closes it.
 *
 * To the accounts actor (`ACCOUNTS_KEY`), whose `storage.sql` holds the users' index:
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `channel-web.list` | `{ userId, limit, cursor? }` | `ChatPage<ChatConversation>` |
 * | `channel-web.forget` | `{ userId }` | `{}`: the user's conversations leave the index |
 * | `channel-web.config` | `{}` | `ChatConfig`: the page's config as the accounts' App makes it (its methods, its live sign-up mode, whether it sends email) |
 *
 * And one message (`send`, `actor.inbox.handle`), from each conversation's object to the accounts
 * actor: `channel-web.seen` `{ rows: ConversationRow[] }`, each row's newest version.
 *
 * A refusal is an `ActorCallError` (`not_found`, `invalid_request`, `invalid_cursor`, `too_large`,
 * `denied`, `rejected`, `no_route`) whose code crosses the call.
 */

import type { AppContext } from "@pikit/core";
import { ActorCallError, type ActorInbox, type JsonValue } from "@pikit/contracts";
import type { ChatConfig, ChatImage } from "./api.ts";
import { type ChatBackend, type ChatRef, conversationOf, type NewMessage, refusal } from "./backend.ts";
import { isChatId, keyOf, REQUEST_ID } from "./chat.ts";
import type { ChatStore, ConversationRow } from "./store.ts";

/** The accounts actor: an object of the conversations' class, never a conversation. Its storage holds the accounts and the users' index. */
export const ACCOUNTS_KEY = "channel-web:accounts";

export const CALL = {
  start: "channel-web.start",
  send: "channel-web.send",
  conversation: "channel-web.conversation",
  rename: "channel-web.rename",
  hide: "channel-web.hide",
  messages: "channel-web.messages",
  abort: "channel-web.abort",
  list: "channel-web.list",
  forget: "channel-web.forget",
  config: "channel-web.config",
} as const;
export const LIVE = "channel-web.live";
export const SEEN = "channel-web.seen";

/** The largest page read through a call. */
export const PAGE_MAX = 100;
/** The longest answer a call makes, in JSON characters: well under what a call carries (32 MiB). */
export const ANSWER_CHARS = 16 * 1024 * 1024;
const SEEN_MAX = 100;

type Fields = Record<string, unknown>;
const fieldsOf = (message: JsonValue): Fields => (typeof message === "object" && message !== null && !Array.isArray(message) ? (message as Fields) : {});
const json = (value: unknown): JsonValue => value as JsonValue;

const text = (fields: Fields, field: string): string => {
  const value = fields[field];
  if (typeof value !== "string" || value === "") throw refusal("invalid_request", `channel-web: "${field}" is a non-empty string`);
  return value;
};

/** The conversation a message names, which must be the object's own (`key`). */
function refOf(key: string, message: JsonValue): ChatRef {
  const fields = fieldsOf(message);
  const userId = text(fields, "userId");
  const chatId = text(fields, "chatId");
  if (!isChatId(chatId) || keyOf(userId, chatId) !== key) throw refusal("invalid_request", "channel-web: the message names another conversation than this object's");
  return { userId, chatId, key };
}

function pageOf(message: JsonValue): { limit: number; cursor?: string } {
  const { limit, cursor } = fieldsOf(message);
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw refusal("invalid_request", `channel-web: "limit" is an integer from 1 to ${PAGE_MAX}`);
  if (cursor !== undefined && typeof cursor !== "string") throw refusal("invalid_request", 'channel-web: "cursor" is a string');
  return { limit, ...(cursor !== undefined && { cursor }) };
}

/** A user's message, checked again on arrival (the backend checks its images against this target's limits). */
function messageOf(message: JsonValue): NewMessage {
  const fields = fieldsOf(message);
  const written = fields.text;
  if (typeof written !== "string") throw refusal("invalid_request", 'channel-web: "text" is a string');
  const requestId = text(fields, "requestId");
  if (!REQUEST_ID.test(requestId)) throw refusal("invalid_request", 'channel-web: "requestId" is a request id of this channel');
  const { images } = fields;
  if (images !== undefined && !(Array.isArray(images) && images.every((each) => typeof fieldsOf(each).data === "string" && typeof fieldsOf(each).mimeType === "string"))) {
    throw refusal("invalid_request", 'channel-web: "images" is a list of images');
  }
  const list = ((images ?? []) as ChatImage[]).map(({ mimeType, data }) => ({ mimeType, data }));
  return { text: written, requestId, ...(list.length > 0 && { images: list }) };
}

const ROW_FIELDS = { key: "string", userId: "string", chatId: "string", title: "string", createdAt: "number", lastActivity: "number", hidden: "boolean", busy: "boolean", version: "number" } as const;

function rowsOf(message: JsonValue): ConversationRow[] {
  const rows = fieldsOf(message).rows;
  if (!Array.isArray(rows) || rows.length > SEEN_MAX) throw new ActorCallError("invalid_request", `channel-web: "rows" is a list of at most ${SEEN_MAX}`);
  return rows.map((row) => {
    const fields = fieldsOf(row);
    for (const [name, type] of Object.entries(ROW_FIELDS)) {
      if (typeof fields[name] !== type) throw new ActorCallError("invalid_request", `channel-web: a row's "${name}" is a ${type}`);
    }
    const checked = fields as ConversationRow;
    if (keyOf(checked.userId, checked.chatId) !== checked.key) throw new ActorCallError("invalid_request", "channel-web: a row's key is not its user's and chat's");
    return checked;
  });
}

/** Registers a conversation object's answers over `backend` (its own, local). Call it in `start`. */
export function answerConversationCalls(inbox: ActorInbox, backend: ChatBackend): void {
  inbox.answer(CALL.start, async (key, message, ctx) => json(await backend.start(refOf(key, message), messageOf(message), ctx)));
  inbox.answer(CALL.send, async (key, message, ctx) => json(await backend.send(refOf(key, message), messageOf(message), ctx)));
  inbox.answer(CALL.conversation, async (key, message, ctx) => json(await backend.conversation(refOf(key, message), ctx)));
  inbox.answer(CALL.rename, async (key, message, ctx) => json(await backend.rename(refOf(key, message), text(fieldsOf(message), "title"), ctx)));
  inbox.answer(CALL.hide, async (key, message, ctx) => {
    await backend.hide(refOf(key, message), ctx);
    return {};
  });
  // A page too long for an answer (images inline) is read again, half as long, until it fits.
  inbox.answer(CALL.messages, async (key, message, ctx) => {
    const ref = refOf(key, message);
    const page = pageOf(message);
    let limit = page.limit;
    for (;;) {
      const read = await backend.messages(ref, { ...page, limit }, ctx);
      if (limit === 1 || JSON.stringify(read).length <= ANSWER_CHARS) return json(read);
      limit = Math.max(1, Math.floor(limit / 2));
    }
  });
  inbox.answer(CALL.abort, async (key, message, ctx) => {
    await backend.abort(refOf(key, message), ctx);
    return {};
  });
  inbox.answerStream(LIVE, async (key, message, ctx) => (await backend.live(refOf(key, message), ctx)) as AsyncIterable<JsonValue>);
}

/**
 * Registers the users' index's answers over `store`, and the page's config made by `config` (used in
 * the accounts actor, whose App sends the accounts' email). Call it in `start`.
 */
export function answerIndexCalls(inbox: ActorInbox, store: ChatStore, config: (ctx: AppContext) => Promise<ChatConfig>): void {
  inbox.answer(CALL.config, async (_key, _message, ctx) => json(await config(ctx)));
  inbox.handle(SEEN, async (_key, message) => store.seen(rowsOf(message)));
  inbox.answer(CALL.list, async (_key, message) => {
    const listed = await store.list(text(fieldsOf(message), "userId"), pageOf(message));
    return json({ items: listed.items.map((row) => conversationOf(row)), ...(listed.next !== undefined && { next: listed.next }) });
  });
  inbox.answer(CALL.forget, async (_key, message) => {
    await store.forget(text(fieldsOf(message), "userId"));
    return {};
  });
}
