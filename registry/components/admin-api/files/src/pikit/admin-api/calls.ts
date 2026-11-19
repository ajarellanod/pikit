/**
 * The Worker's calls to the objects, on Cloudflare (`actor.mailbox.call`, answered with
 * `actor.inbox.answer` in each object's App), and its one stream (`actor.mailbox.stream`, answered
 * with `answerStream`), and what each object answers with: its own conversations, read and acted on
 * through the local host (`host.ts`), with its own ids. The Worker (`backend.ts`) names them `<key>~<id>`.
 * The list, the titles and the states are not here: the Worker asks the directory for them.
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `admin-api.app` | — | `ApiApp`: this App's composition, secrets redacted |
 * | `admin-api.agents` | — | `ApiAgents`: this App's agents |
 * | `admin-api.conversation` | `{ conversationId }` | `ApiConversation`, as the runtime has it (no title, state or hidden: the directory's) |
 * | `admin-api.transcript` | `{ conversationId, limit?, cursor? }` | `ApiPage<ApiTranscriptEntry>`, fewer entries than `limit` when they would not fit in an answer (`ANSWER_CHARS`) |
 * | `admin-api.usage` | `{ conversationId }` | `ApiUsage` |
 * | `admin-api.message` | `{ conversationId, text, requestId, attachments?, webSearch?, operator? }` | `{ requestId, admission }`: the operator's follow-up |
 * | `admin-api.start` | `{ agent, text, requestId, attachments?, webSearch?, operator? }`, to the object of a `dashboard:` key | `ApiStartResponse`: the dashboard's own conversation |
 * | `admin-api.abort` | `{ conversationId }` | `{}` |
 * | `admin-api.reset` | `{ conversationId }` | `ApiResetResponse` |
 * | `admin-api.commands` | — | `ApiCommands`: this App's slash commands |
 * | `admin-api.command` | `{ conversationId, name, args }` | `ApiCommandResponse`: the command run in the conversation |
 *
 * And one stream: `admin-api.live` `{ conversationId }`, the conversation's live events (`ApiEvent`s,
 * its whole live state first), refused `not_found` before the first; it ends when the Worker closes it.
 *
 * A refusal is an `ActorCallError` (`not_found`, `no_agent`, `not_current`, `invalid_cursor`,
 * `invalid_request`, `unknown_agent`, `too_large`, `unknown_command`, `command_failed`), whose code
 * crosses the call.
 *
 * **Sizes.** A call carries at most 32 MiB each way (Workers RPC). A message's images are at most
 * `MAX_DURABLE_IMAGE_BYTES` there (the Worker checks, `remote.ts`; the object again), and a transcript
 * page that holds images is answered shorter until it fits in `ANSWER_CHARS`: its `next` reads on.
 */

import type { ActorInbox, JsonValue, PageRequest } from "@pikit/contracts";
import { type ApiAttachment, attachmentsProblem } from "./api.ts";
import { type ConversationHost, type HostRef, type Message, refusal } from "./host.ts";

export const CALL = {
  app: "admin-api.app",
  agents: "admin-api.agents",
  conversation: "admin-api.conversation",
  transcript: "admin-api.transcript",
  usage: "admin-api.usage",
  message: "admin-api.message",
  start: "admin-api.start",
  abort: "admin-api.abort",
  reset: "admin-api.reset",
  commands: "admin-api.commands",
  command: "admin-api.command",
} as const;

/** The stream of a conversation's live events. */
export const LIVE = "admin-api.live";

/** The largest transcript page read through a call. */
export const LIST_MAX = 500;
/** The longest answer a transcript call makes, in JSON characters: well under what a call carries (32 MiB). */
export const ANSWER_CHARS = 16 * 1024 * 1024;

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

const json = (value: unknown): JsonValue => value as JsonValue;

/** The message of a `message` or `start` call: its text and request id, its images checked again (the object's own limit), whether it asks for a web search, its operator. */
function messageOf(message: JsonValue): Message {
  const fields = fieldsOf(message);
  const written = fields.text;
  if (typeof written !== "string") throw refusal("invalid_request", 'admin-api: "text" is a string');
  const { attachments, webSearch, operator } = fields;
  if (attachments !== undefined && !(Array.isArray(attachments) && attachments.every((each) => typeof fieldsOf(each).data === "string" && typeof fieldsOf(each).mimeType === "string"))) {
    throw refusal("invalid_request", 'admin-api: "attachments" is a list of images');
  }
  const images = (attachments ?? []) as ApiAttachment[];
  const wrong = attachmentsProblem(images, "durable");
  if (wrong !== undefined) throw refusal(wrong.status === 413 ? "too_large" : "invalid_request", `admin-api: ${wrong.message}`);
  if (webSearch !== undefined && typeof webSearch !== "boolean") throw refusal("invalid_request", 'admin-api: "webSearch" is a boolean');
  if (operator !== undefined && (typeof operator !== "string" || operator === "")) throw refusal("invalid_request", 'admin-api: "operator" is a non-empty string');
  return { text: written, requestId: text(message, "requestId"), ...(images.length > 0 && { attachments: images }), ...(webSearch === true && { webSearch }), ...(operator !== undefined && { operator }) };
}

/** Registers the object's answers to the Worker's calls over `host`, this object's own (its conversations are all of the call's key). Call it in `start`. */
export function answerCalls(inbox: ActorInbox, host: ConversationHost): void {
  const ref = (key: string, message: JsonValue): HostRef => ({ key, conversationId: text(message, "conversationId") });

  inbox.answer(CALL.app, async (_key, _message, ctx) => json(await host.app(ctx)));
  inbox.answer(CALL.agents, async (_key, _message, ctx) => json(await host.agents(ctx)));
  inbox.answer(CALL.conversation, async (key, message, ctx) => json(await host.conversation(ref(key, message), ctx)));
  // A page too long for an answer (images inline) is read again, half as long, until it fits.
  inbox.answer(CALL.transcript, async (key, message, ctx) => {
    const page = pageOf(message);
    let limit = page.limit ?? 50;
    for (;;) {
      const read = await host.transcript(ref(key, message), { ...page, limit }, ctx);
      if (limit === 1 || JSON.stringify(read).length <= ANSWER_CHARS) return json(read);
      limit = Math.max(1, Math.floor(limit / 2));
    }
  });
  inbox.answer(CALL.usage, async (key, message, ctx) => json(await host.usage(ref(key, message), ctx)));
  inbox.answer(CALL.message, async (key, message, ctx) => json(await host.send(ref(key, message), messageOf(message), ctx)));
  inbox.answer(CALL.start, async (key, message, ctx) => json(await host.start({ key, agent: text(message, "agent"), ...messageOf(message) }, ctx)));
  inbox.answer(CALL.abort, async (key, message, ctx) => (await host.abort(ref(key, message), ctx), {}));
  inbox.answer(CALL.reset, async (key, message, ctx) => json(await host.reset(ref(key, message), ctx)));
  inbox.answer(CALL.commands, async (_key, _message, ctx) => json(await host.commands(ctx)));
  inbox.answer(CALL.command, async (key, message, ctx) => {
    const { args } = fieldsOf(message);
    if (args !== undefined && typeof args !== "string") throw refusal("invalid_request", 'admin-api: "args" is a string');
    return json(await host.command(ref(key, message), text(message, "name"), args ?? "", ctx));
  });

  inbox.answerStream(LIVE, async (key, message, ctx) => (await host.live(ref(key, message), ctx)) as AsyncIterable<JsonValue>);
}
