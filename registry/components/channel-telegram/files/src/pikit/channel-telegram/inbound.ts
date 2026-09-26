/**
 * One Telegram update, from the bot's inbox to the agent (SPEC §5):
 *
 * 1. Private chats only, for now; group messages are ignored (groups need the bot's privacy mode
 *    and mention rules, which come later).
 * 2. Who may talk: the Telegram user ids in `TELEGRAM_ALLOWED_USERS`. Anyone can find a bot, and an
 *    agent with tools must not answer strangers: an unknown user is told their id once, so the
 *    owner can add it, and nothing reaches the agent.
 * 3. Commands the channel answers itself: `/start` and `/help` explain, `/new` starts the
 *    conversation over (a reset: a new session, the old one kept, SPEC §7.6). Other commands go to
 *    the agent as text.
 * 4. Everything else takes the inbound path every channel takes (`admitInbound`: `inbound.normalize`,
 *    `route.resolve`, the conversation `telegram:<chat id>`, `dispatch`), and the sender is told what
 *    happened when the agent will not answer. The request id is `telegram:<chat id>:<message id>`: a
 *    message Telegram delivers twice is one request.
 *
 * With polling there is no HTTP request to authenticate: the updates come from Telegram's own API,
 * over TLS, with the bot's token. What is left to check is the sender, which step 2 does.
 */

import { type AgentRuntime, type AppContext, admitInbound, type ConversationRegistry, type InboundMessage } from "@pikit/core";
import type { TelegramMessage, TelegramUpdate, TelegramUser } from "./api.ts";
import type { Delivery } from "./replies.ts";

export const CHANNEL = "telegram";

/** The conversation of a Telegram chat. */
export const conversationKey = (chatId: number): string => `${CHANNEL}:${chatId}`;

/** The chat of a conversation this channel made, or `undefined` for another channel's. */
export function chatOf(conversationKey: string): number | undefined {
  const match = /^telegram:(-?\d+)$/.exec(conversationKey);
  return match === null ? undefined : Number(match[1]);
}

export interface InboundDeps {
  bot: TelegramUser;
  allowed: ReadonlySet<number>;
  delivery: Delivery;
  conversations: ConversationRegistry;
  runtime: AgentRuntime;
  /** A context of the channel's own, never `start`'s (SPEC §4.7). */
  ctx: AppContext;
  /** Users already told they are not allowed, so a stranger's spam gets one answer. */
  refused: Set<number>;
}

const HELP = [
  "Send me a message and I'll answer.",
  "",
  "/new: start a new conversation (I forget this one)",
  "/help: this message",
].join("\n");

export async function handleUpdate(update: TelegramUpdate, deps: InboundDeps): Promise<void> {
  const message = update.message;
  if (message === undefined || message.chat.type !== "private") return;
  const from = message.from;
  if (from === undefined || from.is_bot) return;
  const chatId = message.chat.id;
  const { ctx, delivery } = deps;

  if (!deps.allowed.has(from.id)) {
    ctx.logger.warn("channel-telegram: a message from a user who is not allowed", { user: from.id });
    if (!deps.refused.has(from.id)) {
      deps.refused.add(from.id);
      await delivery.send(
        chatId,
        `This bot is private. Your Telegram user id is ${from.id}: its owner can let you in by adding it to TELEGRAM_ALLOWED_USERS.`,
      );
    }
    return;
  }

  const text = message.text ?? message.caption;
  if (text === undefined || text.trim() === "") {
    await delivery.send(chatId, "I can only read text messages for now.");
    return;
  }

  const command = commandOf(text, deps.bot);
  if (command === "start" || command === "help") {
    await delivery.send(chatId, command === "start" ? `Hi${from.first_name ? ` ${from.first_name}` : ""}! ${HELP}` : HELP);
    return;
  }
  if (command === "new") {
    const reset = await deps.conversations.reset(conversationKey(chatId), ctx);
    await delivery.send(chatId, reset === undefined ? "This is already a new conversation." : "Started a new conversation.");
    return;
  }

  const inbound: InboundMessage = {
    id: `${CHANNEL}:${chatId}:${message.message_id}`,
    channel: CHANNEL,
    conversationId: String(chatId),
    actor: { id: String(from.id) },
    text,
    raw: message satisfies TelegramMessage,
    receivedAt: ctx.clock.now(),
  };
  const outcome = await admitInbound(ctx, inbound, { conversations: deps.conversations, runtime: deps.runtime, key: conversationKey(chatId) });
  switch (outcome.kind) {
    case "admitted":
      // A new run shows "typing…" from `agent.started`; a message joining a run already shows it.
      delivery.typingStarted(chatId);
      return;
    case "duplicate":
      return;
    case "halted":
      await delivery.send(chatId, "I can't take that message.");
      return;
    case "denied":
      await delivery.send(chatId, "Sorry, I can't answer that here.");
      return;
    case "no_route":
      await delivery.send(chatId, "This bot is not set up to answer yet.");
      return;
  }
}

/** `/new` or `/new@this_bot` → `new`; a command for another bot, or no command, → `undefined`. */
function commandOf(text: string, bot: TelegramUser): string | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text.trim());
  if (match === null) return undefined;
  const [, name = "", target] = match;
  if (target !== undefined && target.toLowerCase() !== bot.username?.toLowerCase()) return undefined;
  const command = name.toLowerCase();
  return command === "reset" ? "new" : command;
}
