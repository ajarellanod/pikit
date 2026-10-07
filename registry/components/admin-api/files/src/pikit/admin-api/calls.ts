/**
 * The Worker's calls to the objects, on Cloudflare (`actor.mailbox.call`, answered with
 * `actor.inbox.answer` in each object's App), and what each object answers with: its own
 * conversations, read and acted on through the local backend (`backend.ts`), with its own ids. The
 * Worker (`remote.ts`) qualifies them.
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `admin-api.app` | — | `ApiApp`: this App's composition, secrets redacted |
 * | `admin-api.conversation` | `{ conversationId }` | `ApiConversation` |
 * | `admin-api.transcript` | `{ conversationId, limit?, cursor? }` | `ApiPage<ApiTranscriptEntry>` |
 * | `admin-api.snapshot` | `{ conversationId }` | `ApiEvent`: the first event of its live events |
 * | `admin-api.usage` | `{ conversationId }` | `ApiUsage` |
 * | `admin-api.message` | `{ conversationId, text, requestId }` | `{ requestId, admission }`: the operator's follow-up |
 * | `admin-api.start` | `{ agent, text, requestId }`, to the object of a `dashboard:` key | `ApiStartResponse`: the dashboard's own conversation |
 * | `admin-api.abort` | `{ conversationId }` | `{ conversationId }` |
 * | `admin-api.reset` | `{ conversationId }` | `ApiResetResponse` |
 * | `admin-api.list` | `{ limit, cursor? }` | `IndexPage` (the index object's) |
 *
 * And one message (`send`, `actor.inbox.handle`): `admin-api.seen` `{ entries: [{ key,
 * conversationId, agent, at }] }`, to the index.
 *
 * A refusal is an `ActorCallError` (`not_found`, `no_agent`, `not_current`, `invalid_cursor`,
 * `invalid_request`, `unknown_agent`), whose code crosses the call.
 */

import { type ActorInbox, ActorCallError, type JsonValue, type PageRequest } from "@pikit/contracts";
import { type AdminBackend, refusal } from "./backend.ts";
import type { ConversationIndex, IndexedConversation } from "./conversation-index.ts";

export const CALL = {
  app: "admin-api.app",
  conversation: "admin-api.conversation",
  transcript: "admin-api.transcript",
  snapshot: "admin-api.snapshot",
  usage: "admin-api.usage",
  message: "admin-api.message",
  start: "admin-api.start",
  abort: "admin-api.abort",
  reset: "admin-api.reset",
  list: "admin-api.list",
} as const;

/** The message each conversation's object sends the index. */
export const SEEN = "admin-api.seen";

/** The largest page of `admin-api.list`, and of a transcript read through a call. */
export const LIST_MAX = 500;
/** Entries of one `seen` at most. */
const SEEN_MAX = 100;

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

const seenOf = (message: JsonValue): IndexedConversation[] => {
  const entries = fieldsOf(message).entries;
  if (!Array.isArray(entries) || entries.length > SEEN_MAX) throw new ActorCallError("invalid_request", `admin-api: "entries" is a list of at most ${SEEN_MAX}`);
  return entries.map((entry) => {
    const at = fieldsOf(entry).at;
    if (typeof at !== "number" || !Number.isFinite(at)) throw new ActorCallError("invalid_request", 'admin-api: "at" is epoch milliseconds');
    return { key: text(entry, "key"), conversationId: text(entry, "conversationId"), agent: text(entry, "agent"), at };
  });
};

const json = (value: unknown): JsonValue => value as JsonValue;

/**
 * Registers the object's answers to the Worker's calls over `backendOf(key)` (this object's own, `key`
 * its key), and the index's (`index`: used only in the index object, but every object can answer).
 * Call it in `start`.
 */
export function answerCalls(inbox: ActorInbox, backendOf: (key: string) => AdminBackend, index: ConversationIndex): void {
  const id = (message: JsonValue) => text(message, "conversationId");

  inbox.answer(CALL.app, async (key, _message, ctx) => json(await backendOf(key).app(ctx)));
  inbox.answer(CALL.conversation, async (key, message, ctx) => json(await backendOf(key).conversation(id(message), ctx)));
  inbox.answer(CALL.transcript, async (key, message, ctx) => json(await backendOf(key).transcript(id(message), pageOf(message), ctx)));
  inbox.answer(CALL.snapshot, async (key, message, ctx) => json(await backendOf(key).snapshot(id(message), ctx)));
  inbox.answer(CALL.usage, async (key, message, ctx) => json(await backendOf(key).usage(id(message), ctx)));
  inbox.answer(CALL.message, async (key, message, ctx) => {
    const sent = await backendOf(key).send(id(message), { text: text(message, "text"), requestId: text(message, "requestId") }, ctx);
    return { requestId: sent.requestId, admission: sent.admission };
  });
  inbox.answer(CALL.start, async (key, message, ctx) =>
    json(await backendOf(key).start({ key, agent: text(message, "agent"), text: text(message, "text"), requestId: text(message, "requestId") }, ctx)),
  );
  inbox.answer(CALL.abort, async (key, message, ctx) => ({ conversationId: (await backendOf(key).abort(id(message), ctx)).conversationId }));
  inbox.answer(CALL.reset, async (key, message, ctx) => json(await backendOf(key).reset(id(message), ctx)));

  inbox.handle(SEEN, async (_key, message) => index.seen(seenOf(message)));
  inbox.answer(CALL.list, async (_key, message) => {
    const page = pageOf(message);
    return json(await index.list({ limit: page.limit ?? 50, ...(page.cursor !== undefined && { cursor: page.cursor }) }));
  });
}
