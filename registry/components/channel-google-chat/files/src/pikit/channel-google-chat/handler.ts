// Owner: admission. A message, an add or a removal, in the conversation's actor (features/channel-google-chat.md "Identity", "Access", "Attachments in", "Quoted messages").
/**
 * The same code on both targets: on a server the route calls it in process, on Cloudflare the
 * conversation's object calls it from `actor.inbox` (`google-chat.event`). index.ts wakes answer
 * delivery after an `admitted` or `duplicate`.
 *
 * - **A message** (`messagePayload`): from a space not in `Credentials.allowedSpaces`, refused (the
 *   route already told it: this is a guard), logged. A message from a bot, or with no name, is `done`
 *   with nothing admitted. Its text is the message's without the app's mention (`argumentText`, else
 *   `text` with the `USER_MENTION` annotations of bots removed).
 *   - `/new` (alone, after the mention, or as a slash command) resets the conversation
 *     (`conversations.reset(key, undefined, ctx)`) once per message id (`command:<message name>` in
 *     `storage.kv` keeps what it said), and says so in the thread.
 *   - Otherwise an `InboundMessage`: `id` the message's `name`, `channel` the instance,
 *     `conversationId` the space, `actor.id` the sender's `users/…`; its text the quoted message first
 *     (quote.ts), then the message's, after the sender's display name in a space or group chat (not in a
 *     DM), then what its files say (attachments.ts), its images as `images`. Quotes and downloads
 *     happen before admission, within `DOWNLOAD_DEADLINE_MS`. A message with nothing to say is `done`.
 *   - `admitInbound` with the key and `beforeDispatch(conversation)` (awaited, AdmitOptions): a whole
 *     chat records the answer's thread (`targets.remember(answerKey(conversation, message.id),
 *     thread)`: none in an unthreaded chat), and other files are written to the conversation's
 *     workspace (attachments.ts `writeFiles`). A write that fails rejects: Google sends it again.
 *   - Outcomes: `admitted` and `duplicate` returned; `halted`, `denied` and `no_route` told briefly
 *     in the thread (logged), `done`.
 * - **An add** (`addedToSpacePayload`): a welcome in an allowed space, the stranger text (its id for
 *   the operator) in another; `done`.
 * - **A removal** (`removedFromSpacePayload`): logged; `done` (answers still owed there fail
 *   `permanent` in the transport).
 *
 * **No inbound dedup**: Google may deliver an event again, and nothing the handler sends to the space
 * depends on a message being new. Each of its own replies is created under ids made from what it
 * answers (`replyIds`: a message's name, an add's time), so a repeat is the same message: Google
 * returns it (`requestId`) or refuses it (`ALREADY_EXISTS`, counted sent). A reply that fails is
 * logged, never a reason for Google to send the event again.
 *
 * Rejects when the message could not be admitted (a capability failed): Google sends it again, and
 * the runtime answers `duplicate` for one it already holds.
 */

import type { AppContext } from "@pikit/core";
import { admitInbound, answerKey, type InboundMessage, type InboundOutcome } from "@pikit/contracts";
import { readAttachments, writeFiles } from "./attachments.ts";
import { type AddOnEvent, type ChatMessage, type ChatSpace, type ChatUser, eventKind, spaceOf } from "./event.ts";
import { type Instance, NAME, parseConversationKey } from "./instance.ts";
import { createSpaceThreading, threadOf } from "./key.ts";
import { quoteOf } from "./quote.ts";
import { type AdmissionDeps, ChatApiError, type EventHandler, type HandledEvent } from "./types.ts";

/** How long, in ms, downloads and quotes may take before admission: under Google's 30 s with the route's hand-off. */
export const DOWNLOAD_DEADLINE_MS = 20_000;

/** Where what `/new` said for a message is kept: it resets once, whatever Google repeats. */
export const commandSeenKey = (message: string): string => `command:${message}`;

/** What the handler says itself. */
export const REPLIES = {
  reset: "Started a new conversation.",
  alreadyNew: "This is already a new conversation.",
  halted: "I can't take that message.",
  denied: "Sorry, I can't answer that here.",
  noRoute: "This app is not set up to answer yet.",
} as const;

/** What the app says when it is added to an allowed space. */
export function welcomeText(space: ChatSpace): string {
  return isDirect(space)
    ? "Hi! Send me a message and I'll answer. /new starts our conversation over."
    : "Hi! Mention me in a message and I'll answer in its thread. /new starts the conversation over.";
}

/** What a space that is not allowed is told: the app is not allowed there, and its id for the operator. */
export function strangerText(instance: Instance, space: string): string {
  return `I'm not allowed to answer in this chat yet. To allow it, the operator adds its id, ${space}, to ${instance.secrets.allowedSpaces}.`;
}

/** A DM with the app: no one else to tell apart. */
const isDirect = (space: ChatSpace): boolean => space.spaceType === "DIRECT_MESSAGE" || space.type === "DM" || space.singleUserBotDm === true;

/** `message`'s text without the app's mention: `argumentText`, else `text` without the mentions of bots. */
export function textOf(message: ChatMessage): string {
  if (message.argumentText !== undefined) return message.argumentText.trim();
  return withoutBotMentions(message).trim();
}

/** `message.text` with every `USER_MENTION` of a bot cut out (by its UTF-16 offsets). */
function withoutBotMentions(message: ChatMessage): string {
  let text = message.text ?? "";
  const mentions = (message.annotations ?? [])
    .filter((each) => each.type === "USER_MENTION" && each.userMention?.user?.type === "BOT" && each.startIndex !== undefined && each.length !== undefined)
    .sort((a, b) => (b.startIndex ?? 0) - (a.startIndex ?? 0));
  for (const mention of mentions) {
    const start = mention.startIndex ?? 0;
    text = `${text.slice(0, start)}${text.slice(start + (mention.length ?? 0))}`;
  }
  return text;
}

/** `/new` (or `/reset`), alone, after the mention: typed, or the app's slash command. */
export function isNewCommand(message: ChatMessage): boolean {
  return /^\/(new|reset)$/i.test(withoutBotMentions(message).trim()) || /^\/(new|reset)$/i.test(textOf(message));
}

/**
 * The ids of the handler's own reply to `seed` (a message's name and what the reply is): a `requestId`
 * (a UUID) and a `messageId` (`client-` and 56 hexadecimal characters), both from the seed's SHA-256,
 * as ids.ts makes a piece's. The same seed, the same message, however often Google repeats the event.
 */
export async function replyIds(seed: string): Promise<{ requestId: string; messageId: string }> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${NAME}:reply:${seed}`)));
  const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const uuid = hash.slice(0, 16);
  uuid[6] = ((uuid[6] ?? 0) & 0x0f) | 0x40;
  uuid[8] = ((uuid[8] ?? 0) & 0x3f) | 0x80;
  const u = hex(uuid);
  return { requestId: `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`, messageId: `client-${hex(hash).slice(0, 56)}` };
}

/** A signal aborted after `ms`, or with the caller's. */
function deadline(ms: number, caller: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The handler of one instance's events. */
export function createEventHandler(deps: AdmissionDeps): EventHandler {
  const { instance, credentials, api, store } = deps;
  const threading = createSpaceThreading(api, store);

  /** The handler's own reply, in `thread` (absent: the top of the chat), once per `seed`; a failure logged. */
  const reply = async (space: string, thread: string | undefined, text: string, seed: string, ctx: AppContext): Promise<void> => {
    try {
      const ids = await replyIds(seed);
      await api.createMessage(space, { text }, { ...(thread !== undefined && { thread }), ...ids }, ctx.abortSignal);
    } catch (error) {
      // A repeat of a reply already sent: the same message.
      if (error instanceof ChatApiError && (error.code === "ALREADY_EXISTS" || error.status === 409)) return;
      ctx.logger.error("channel-google-chat: a reply of the channel's own could not be sent", { space, error: errorText(error) });
    }
  };

  const onMessage = async (key: string, event: AddOnEvent, ctx: AppContext): Promise<HandledEvent> => {
    const message = event.chat.messagePayload?.message;
    const space = spaceOf(event);
    if (message === undefined || space === undefined) return "done";
    if (!credentials.allowedSpaces.has(space.name)) {
      ctx.logger.warn("channel-google-chat: a message from a space not allowed reached the handler; nothing admitted", { space: space.name });
      return "done";
    }
    const sender: ChatUser | undefined = message.sender ?? event.chat.user;
    const id = message.name;
    if (sender === undefined || sender.type === "BOT" || id === undefined || !sender.name.startsWith("users/")) return "done";
    const parts = parseConversationKey(key);
    if (parts === undefined || parts.instance !== instance.instance || parts.space !== space.name) {
      throw new Error(`channel-google-chat: the message ${id} came with the key "${key}", which is not a conversation of ${instance.instance} in ${space.name}`);
    }
    // Where the channel's own replies go: the message's thread, unless the chat has none.
    const thread = (await threading.threaded(space, ctx)) ? threadOf(message, space.name) : undefined;

    if (isNewCommand(message)) {
      const seen = commandSeenKey(id);
      let said = await store.get<string>(seen);
      if (said === undefined) {
        const reset = await deps.conversations.reset(key, undefined, ctx);
        said = reset === undefined ? REPLIES.alreadyNew : REPLIES.reset;
        await store.set(seen, said);
      }
      await reply(space.name, thread, said, `${id}:new`, ctx);
      return "done";
    }

    const signal = deadline(DOWNLOAD_DEADLINE_MS, ctx.abortSignal);
    const canWrite = deps.workspace !== undefined || deps.execution !== undefined;
    const [quote, attached] = await Promise.all([quoteOf(message, api, signal), readAttachments(message, { api, canWrite }, ctx, signal)]);
    const body = textOf(message);
    if (body === "" && quote === undefined && attached.text === "" && attached.images.length === 0) return "done";
    const who = sender.displayName?.trim() || sender.name;
    const said = isDirect(space) ? body : body === "" ? `${who}:` : `${who}: ${body}`;
    const text = [quote, said, attached.text].filter((piece): piece is string => piece !== undefined && piece !== "").join("\n\n");

    const inbound: InboundMessage = {
      id,
      channel: instance.instance,
      conversationId: space.name,
      actor: { id: sender.name },
      text,
      ...(attached.images.length > 0 && { images: attached.images }),
    };
    const outcome: InboundOutcome = await admitInbound(ctx, inbound, {
      conversations: deps.conversations,
      runtime: deps.runtime,
      key,
      beforeDispatch: async (conversation) => {
        // A whole chat's key does not say the thread: kept for the answer (none in an unthreaded chat).
        if (parts.thread === undefined) await deps.targets.remember(answerKey(conversation, id), thread);
        await writeFiles(attached.files, conversation, deps, ctx);
      },
    });
    switch (outcome.kind) {
      case "admitted":
      case "duplicate":
        return outcome.kind;
      case "halted":
        ctx.logger.info("channel-google-chat: a message was stopped before its agent", { message: id, pipeline: outcome.pipeline, stage: outcome.stage, reason: outcome.reason });
        await reply(space.name, thread, REPLIES.halted, `${id}:outcome`, ctx);
        return "done";
      case "denied":
        ctx.logger.info("channel-google-chat: a message was denied by the router", { message: id, ...(outcome.reason !== undefined && { reason: outcome.reason }) });
        await reply(space.name, thread, REPLIES.denied, `${id}:outcome`, ctx);
        return "done";
      case "no_route":
        await reply(space.name, thread, REPLIES.noRoute, `${id}:outcome`, ctx);
        return "done";
    }
  };

  return async (key, event, ctx) => {
    const kind = eventKind(event);
    if (kind === "message") return onMessage(key, event, ctx);
    const space = spaceOf(event);
    if (kind === "added" && space !== undefined) {
      const allowed = credentials.allowedSpaces.has(space.name);
      ctx.logger.info(allowed ? "channel-google-chat: the app was added to a space" : "channel-google-chat: the app was added to a space that is not allowed", { space: space.name });
      const text = allowed ? welcomeText(space) : strangerText(instance, space.name);
      await reply(space.name, undefined, text, `added:${space.name}:${event.chat.eventTime ?? ""}`, ctx);
      return "done";
    }
    if (kind === "removed" && space !== undefined) {
      ctx.logger.info("channel-google-chat: the app was removed from a space; answers still owed there will fail", { space: space.name });
      return "done";
    }
    ctx.logger.warn("channel-google-chat: an event the handler does not handle was dropped", { kind, ...(space !== undefined && { space: space.name }) });
    return "done";
  };
}
