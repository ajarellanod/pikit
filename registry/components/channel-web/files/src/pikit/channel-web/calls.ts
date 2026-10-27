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
 * | `channel-web.start` | `{ userId, chatId, text, images?, requestId, agent?, project? }` | `ChatSendResponse`: the conversation made with its first message (with `agent`, the agent the user picked; with `project`, one of the user's projects, its space: the Worker checked both) |
 * | `channel-web.send` | the same | `ChatSendResponse` |
 * | `channel-web.conversation` | `{ userId, chatId }` | `ChatConversation` |
 * | `channel-web.rename` | `{ userId, chatId, title }` | `ChatConversation` |
 * | `channel-web.archive` | `{ userId, chatId, archived }` | `ChatConversation`: archived (`true`) or back in the list (`false`) |
 * | `channel-web.hide` | `{ userId, chatId }` | `{}` |
 * | `channel-web.transcript` | `{ userId, chatId, limit, cursor? }` | `ChatPage<ChatTranscriptEntry>`: every entry as stored, images by URL, at most `PAGE_JSON_MAX` of JSON (`store.ts`); the Worker cuts it by the policy |
 * | `channel-web.image` | `{ userId, chatId, messageId, index }` | `ChatImage`: one image's bytes (base64), at most 5 MB |
 * | `channel-web.abort` | `{ userId, chatId }` | `{}` |
 *
 * And one stream: `channel-web.live` `{ userId, chatId }`, the conversation's `ChatEvent`s (only the
 * user's runs, `live.ts`; the Worker cuts them by the policy), refused `not_found` before the first; it
 * ends when the Worker closes it.
 *
 * To the accounts actor (`ACCOUNTS_KEY`), whose `storage.sql` holds the users' index:
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `channel-web.list` | `{ userId, limit, cursor?, archived?, q?, project? }` | `ChatPage<ChatConversation>`: not archived, or with `archived: true` the archived ones; with `q`, those whose title holds it; with `project`, that project's (`""`: of none); `not_found` for a project not the user's |
 * | `channel-web.forget` | `{ userId }` | `{}`: the user's conversations and projects leave the index |
 * | `channel-web.projects` | `{ userId }` | `ChatPage<ChatProject>`: the user's projects |
 * | `channel-web.project` | `{ userId, id }` | `ChatProject`, or `not_found` (another user's too) |
 * | `channel-web.project.create` | `{ userId, name }` | `ChatProject` (`invalid_request` past `MAX_PROJECTS`) |
 * | `channel-web.project.rename` | `{ userId, id, name }` | `ChatProject`, or `not_found` |
 * | `channel-web.project.delete` | `{ userId, id }` | `{}`, or `not_found`, `not_empty` |
 * | `channel-web.config` | `{}` | `ChatConfig`: the page's config as the accounts' App makes it (its methods, its live settings: sign-up mode, visibility, the agents users may pick; whether it sends email) |
 * | `channel-web.rate` | `{ userId }` | `{ retryAfter? }`: one message of the user's counted (`messagesPerMinute`); `retryAfter` (seconds) when it is one too many |
 * | `channel-web.routed` | `{ userId }` | `{ agent? }`: the agent this App's `route.resolve` names for a new chat of the user, a dry run (`routed.ts`); absent when it denies or halts |
 *
 * And one message (`send`, `actor.inbox.handle`), from each conversation's object to the accounts
 * actor: `channel-web.seen` `{ rows: ConversationRow[] }`, each row's newest version.
 *
 * A refusal is an `ActorCallError` (`not_found`, `invalid_request`, `invalid_cursor`, `too_large`,
 * `denied`, `rejected`, `no_route`, `not_empty`) whose code crosses the call.
 */

import type { AppContext } from "@pikit/core";
import { ActorCallError, type ActorInbox, type JsonValue } from "@pikit/contracts";
import { type ChatConfig, type ChatImage, MAX_IMAGES, PROJECT_NAME_MAX, SEARCH_MAX } from "./api.ts";
import { type ChatBackend, type ChatRef, createIndex, type FirstMessage, type NewMessage, refusal } from "./backend.ts";
import { isChatId, isProjectId, keyOf, REQUEST_ID } from "./chat.ts";
import type { RateLimiter } from "./rate.ts";
import { routedAgent } from "./routed.ts";
import type { ChatStore, ConversationRow } from "./store.ts";

/** The accounts actor: an object of the conversations' class, never a conversation. Its storage holds the accounts and the users' index. */
export const ACCOUNTS_KEY = "channel-web:accounts";

export const CALL = {
  start: "channel-web.start",
  send: "channel-web.send",
  conversation: "channel-web.conversation",
  rename: "channel-web.rename",
  archive: "channel-web.archive",
  hide: "channel-web.hide",
  transcript: "channel-web.transcript",
  abort: "channel-web.abort",
  list: "channel-web.list",
  forget: "channel-web.forget",
  config: "channel-web.config",
  image: "channel-web.image",
  rate: "channel-web.rate",
  routed: "channel-web.routed",
  projects: "channel-web.projects",
  project: "channel-web.project",
  createProject: "channel-web.project.create",
  renameProject: "channel-web.project.rename",
  deleteProject: "channel-web.project.delete",
} as const;
export const LIVE = "channel-web.live";
export const SEEN = "channel-web.seen";

/** The largest page read through a call. */
export const PAGE_MAX = 100;
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

/** A project id, or `invalid_request`. */
function projectIdOf(value: unknown): string {
  if (typeof value !== "string" || !isProjectId(value)) throw refusal("invalid_request", 'channel-web: "project" is a project id');
  return value;
}

/** A conversation's first message, and the agent picked and its project, if any. */
function firstOf(message: JsonValue): FirstMessage {
  const { agent, project } = fieldsOf(message);
  if (agent !== undefined && (typeof agent !== "string" || agent === "")) throw refusal("invalid_request", 'channel-web: "agent" is an agent\'s name');
  return { ...messageOf(message), ...(typeof agent === "string" && { agent }), ...(project !== undefined && { project: projectIdOf(project) }) };
}

/** A project's name, as the route cleaned it. */
const projectNameOf = (fields: Fields): string => {
  const name = text(fields, "name");
  if (name.length > PROJECT_NAME_MAX) throw refusal("invalid_request", `channel-web: "name" is at most ${PROJECT_NAME_MAX} characters`);
  return name;
};

const ROW_FIELDS = { key: "string", userId: "string", chatId: "string", agent: "string", project: "string", title: "string", createdAt: "number", lastActivity: "number", hidden: "boolean", archived: "boolean", busy: "boolean", version: "number" } as const;

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
    if (checked.project !== "" && !isProjectId(checked.project)) throw new ActorCallError("invalid_request", "channel-web: a row's project is not a project id");
    return checked;
  });
}

/** Registers a conversation object's answers over `backend` (its own, local). Call it in `start`. */
export function answerConversationCalls(inbox: ActorInbox, backend: ChatBackend): void {
  inbox.answer(CALL.start, async (key, message, ctx) => json(await backend.start(refOf(key, message), firstOf(message), ctx)));
  inbox.answer(CALL.send, async (key, message, ctx) => json(await backend.send(refOf(key, message), messageOf(message), ctx)));
  inbox.answer(CALL.conversation, async (key, message, ctx) => json(await backend.conversation(refOf(key, message), ctx)));
  inbox.answer(CALL.rename, async (key, message, ctx) => json(await backend.rename(refOf(key, message), text(fieldsOf(message), "title"), ctx)));
  inbox.answer(CALL.archive, async (key, message, ctx) => {
    const { archived } = fieldsOf(message);
    if (typeof archived !== "boolean") throw refusal("invalid_request", 'channel-web: "archived" is a boolean');
    return json(await backend.archive(refOf(key, message), archived, ctx));
  });
  inbox.answer(CALL.hide, async (key, message, ctx) => {
    await backend.hide(refOf(key, message), ctx);
    return {};
  });
  // A page carries no image's bytes and at most PAGE_JSON_MAX of JSON (or one entry): well under what a call carries (32 MiB).
  inbox.answer(CALL.transcript, async (key, message, ctx) => json(await backend.transcript(refOf(key, message), pageOf(message), ctx)));
  inbox.answer(CALL.image, async (key, message, ctx) => {
    const { messageId, index } = fieldsOf(message);
    if (typeof messageId !== "string" || !REQUEST_ID.test(messageId)) throw refusal("invalid_request", 'channel-web: "messageId" is a user\'s message id');
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_IMAGES) throw refusal("invalid_request", `channel-web: "index" is an integer from 0 to ${MAX_IMAGES - 1}`);
    return json(await backend.image(refOf(key, message), messageId, index, ctx));
  });
  inbox.answer(CALL.abort, async (key, message, ctx) => {
    await backend.abort(refOf(key, message), ctx);
    return {};
  });
  inbox.answerStream(LIVE, async (key, message, ctx) => (await backend.live(refOf(key, message), ctx)) as AsyncIterable<JsonValue>);
}

/**
 * `inbox` whose handlers answer only in the accounts actor: on any other key a call is refused
 * (`no_handler`, as if absent) and a message dropped with an error, before the handler runs. Every
 * object registers the accounts' and the index's handlers (one class): only `ACCOUNTS_KEY` answers.
 */
export function accountsOnly(inbox: ActorInbox): Pick<ActorInbox, "answer" | "handle"> {
  const refuse = (key: string, type: string): ActorCallError => new ActorCallError("no_handler", `channel-web: only ${ACCOUNTS_KEY} answers ${type}, not ${key}`);
  return {
    answer: (type, handler) =>
      inbox.answer(type, (key, message, ctx) => {
        if (key !== ACCOUNTS_KEY) throw refuse(key, type);
        return handler(key, message, ctx);
      }),
    handle: (type, handler) =>
      inbox.handle(type, (key, message, ctx) => {
        if (key !== ACCOUNTS_KEY) throw refuse(key, type);
        return handler(key, message, ctx);
      }),
  };
}

/**
 * Registers the users' index's answers over `store`, the page's config made by `config` (used in the
 * accounts actor, whose App sends the accounts' email) and the users' message rate (`rate`), answered
 * only there (`accountsOnly`).
 * Call it in `start`.
 */
export function answerIndexCalls(calls: ActorInbox, store: ChatStore, config: (ctx: AppContext) => Promise<ChatConfig>, rate: RateLimiter): void {
  const inbox = accountsOnly(calls);
  inbox.answer(CALL.rate, async (_key, message, ctx) => {
    const retryAfter = rate.take(text(fieldsOf(message), "userId"), ctx.clock.now());
    return retryAfter === undefined ? {} : { retryAfter };
  });
  inbox.answer(CALL.config, async (_key, _message, ctx) => json(await config(ctx)));
  // This App's routers and settings: the Worker's App has none.
  inbox.answer(CALL.routed, async (_key, message, ctx) => {
    const agent = await routedAgent(text(fieldsOf(message), "userId"), ctx);
    return agent === undefined ? {} : { agent };
  });
  inbox.handle(SEEN, async (_key, message) => store.seen(rowsOf(message)));
  const index = createIndex(store);
  const userOf = (message: JsonValue): string => text(fieldsOf(message), "userId");
  inbox.answer(CALL.list, async (_key, message, ctx) => {
    const { archived, q, project } = fieldsOf(message);
    if (archived !== undefined && typeof archived !== "boolean") throw refusal("invalid_request", 'channel-web: "archived" is a boolean');
    if (q !== undefined && (typeof q !== "string" || q.length > SEARCH_MAX)) throw refusal("invalid_request", `channel-web: "q" is a string of at most ${SEARCH_MAX} characters`);
    const inProject = project === undefined ? undefined : project === "" ? "" : projectIdOf(project);
    const query = { ...pageOf(message), archived: archived === true, ...(typeof q === "string" && q !== "" && { q }), ...(inProject !== undefined && { project: inProject }) };
    return json(await index.list(userOf(message), query, ctx));
  });
  inbox.answer(CALL.projects, async (_key, message, ctx) => json(await index.projects(userOf(message), ctx)));
  inbox.answer(CALL.project, async (_key, message, ctx) => json(await index.project(userOf(message), projectIdOf(fieldsOf(message).id), ctx)));
  inbox.answer(CALL.createProject, async (_key, message, ctx) => json(await index.createProject(userOf(message), projectNameOf(fieldsOf(message)), ctx)));
  inbox.answer(CALL.renameProject, async (_key, message, ctx) => {
    const fields = fieldsOf(message);
    return json(await index.renameProject(userOf(message), projectIdOf(fields.id), projectNameOf(fields), ctx));
  });
  inbox.answer(CALL.deleteProject, async (_key, message, ctx) => {
    await index.deleteProject(userOf(message), projectIdOf(fieldsOf(message).id), ctx);
    return {};
  });
  inbox.answer(CALL.forget, async (_key, message) => {
    await store.forget(text(fieldsOf(message), "userId"));
    return {};
  });
}
