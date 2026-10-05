/**
 * The Worker's calls to the objects, on Cloudflare (`actor.mailbox.call`, answered with
 * `actor.inbox.answer` in each object's App), and what each object answers with: its own
 * conversations, read and acted on through the local backend (`backend.ts`), with its own ids. The
 * Worker (`remote.ts`) qualifies them.
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `admin-api.app` | — | `ApiApp`: this App's composition |
 * | `admin-api.conversations` | — | `ApiConversation[]`: every conversation of this object (its current one and those a reset left behind) |
 * | `admin-api.conversation` | `{ conversationId }` | `ApiConversation` |
 * | `admin-api.transcript` | `{ conversationId, limit?, cursor? }` | `ApiPage<ApiTranscriptEntry>` |
 * | `admin-api.snapshot` | `{ conversationId }` | `ApiEvent`: the first event of its live events |
 * | `admin-api.usage` | `{ conversationId }` | `ApiUsage` |
 * | `admin-api.message` | `{ conversationId, text, requestId, whenBusy }` | `{ requestId, admission }` |
 * | `admin-api.abort` | `{ conversationId }` | `{ conversationId }` |
 * | `admin-api.reset` | `{ conversationId }` | `ApiResetResponse` |
 * | `admin-api.list` | `{ limit, cursor? }` | `IndexPage` (the index object's) |
 *
 * And one message (`send`, `actor.inbox.handle`): `admin-api.seen` `{ key, agent, at }`, to the index.
 *
 * A refusal is an `ActorCallError` (`not_found`, `no_agent`, `not_current`, `invalid_cursor`,
 * `invalid_request`), whose code crosses the call.
 */

import { type ActorInbox, ActorCallError, type JsonValue, type PageRequest } from "@pikit/contracts";
import { type AdminBackend, refusal } from "./backend.ts";
import type { ConversationIndex, IndexedKey } from "./conversation-index.ts";

export const CALL = {
  app: "admin-api.app",
  conversations: "admin-api.conversations",
  conversation: "admin-api.conversation",
  transcript: "admin-api.transcript",
  snapshot: "admin-api.snapshot",
  usage: "admin-api.usage",
  message: "admin-api.message",
  abort: "admin-api.abort",
  reset: "admin-api.reset",
  list: "admin-api.list",
} as const;

/** The message each conversation's object sends the index. */
export const SEEN = "admin-api.seen";

/** The largest page of `admin-api.list`, and of an object's conversations read at once. */
export const LIST_MAX = 500;
/** An object's conversations are read this many pages at most: its current one and the resets'. */
const OBJECT_PAGES = 20;

type Fields = Record<string, unknown>;

const fieldsOf = (message: JsonValue): Fields => (typeof message === "object" && message !== null && !Array.isArray(message) ? (message as Fields) : {});

const text = (message: JsonValue, field: string): string => {
  const value = fieldsOf(message)[field];
  if (typeof value !== "string" || value === "") throw refusal("invalid_request", `admin-api: "${field}" is a non-empty string`);
  return value;
};

const pageOf = (message: JsonValue): PageRequest => {
  const { limit, cursor } = fieldsOf(message);
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_MAX)) {
    throw refusal("invalid_request", `admin-api: "limit" is an integer from 1 to ${LIST_MAX}`);
  }
  if (cursor !== undefined && typeof cursor !== "string") throw refusal("invalid_request", 'admin-api: "cursor" is a string');
  return { ...(limit !== undefined && { limit }), ...(cursor !== undefined && { cursor }) };
};

const seenOf = (message: JsonValue): IndexedKey => {
  const at = fieldsOf(message).at;
  if (typeof at !== "number" || !Number.isFinite(at)) throw new ActorCallError("invalid_request", 'admin-api: "at" is epoch milliseconds');
  return { key: text(message, "key"), agent: text(message, "agent"), at };
};

const json = (value: unknown): JsonValue => value as JsonValue;

/**
 * Registers the object's answers to the Worker's calls over `backend` (this object's own), and the
 * index's (`index`: used only in the index object, but every object can answer). Call it in `start`.
 */
export function answerCalls(inbox: ActorInbox, backend: AdminBackend, index: ConversationIndex): void {
  const id = (message: JsonValue) => text(message, "conversationId");

  inbox.answer(CALL.app, async (_key, _message, ctx) => json(await backend.app(ctx)));
  inbox.answer(CALL.conversations, async (_key, _message, ctx) => {
    const all: unknown[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < OBJECT_PAGES; pages++) {
      const page = await backend.conversations({ limit: LIST_MAX, ...(cursor !== undefined && { cursor }) }, ctx);
      all.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    return json(all);
  });
  inbox.answer(CALL.conversation, async (_key, message, ctx) => json(await backend.conversation(id(message), ctx)));
  inbox.answer(CALL.transcript, async (_key, message, ctx) => json(await backend.transcript(id(message), pageOf(message), ctx)));
  inbox.answer(CALL.snapshot, async (_key, message, ctx) => json(await backend.snapshot(id(message), ctx)));
  inbox.answer(CALL.usage, async (_key, message, ctx) => json(await backend.usage(id(message), ctx)));
  inbox.answer(CALL.message, async (_key, message, ctx) => {
    const whenBusy = fieldsOf(message).whenBusy;
    if (whenBusy !== "steer" && whenBusy !== "followUp") throw refusal("invalid_request", 'admin-api: "whenBusy" is "steer" or "followUp"');
    const sent = await backend.send(id(message), { text: text(message, "text"), requestId: text(message, "requestId"), whenBusy }, ctx);
    return { requestId: sent.requestId, admission: sent.admission };
  });
  inbox.answer(CALL.abort, async (_key, message, ctx) => ({ conversationId: (await backend.abort(id(message), ctx)).conversationId }));
  inbox.answer(CALL.reset, async (_key, message, ctx) => json(await backend.reset(id(message), ctx)));

  inbox.handle(SEEN, async (_key, message) => index.seen(seenOf(message)));
  inbox.answer(CALL.list, async (_key, message) => {
    const page = pageOf(message);
    return json(await index.list({ limit: page.limit ?? 50, ...(page.cursor !== undefined && { cursor: page.cursor }) }));
  });
}
