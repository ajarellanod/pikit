/**
 * One update, in the actor that owns its conversation (the object's half, SPEC §4.1, C1). The Worker
 * already checked the secret, kept only private messages with text, and let through only the allowed
 * users (or `login.ts` found the chat logged in); this is the rest of what channel-telegram's
 * `inbound.ts` does:
 *
 * 1. Commands the channel answers itself: `/start` and `/help` explain, `/new` (or `/reset`) starts
 *    the conversation over (a reset: a new session, the old one kept), `/login` says the chat is in
 *    already (it may hold the password: it never reaches the agent). Then the App's commands
 *    (`agent.command`) the `commands` config allows (`InboxDeps.commands`): `/name args`, or
 *    `/name@this_bot args` (its own username cut; another bot's is no command), admitted with them
 *    (`AdmitOptions.commands`): routed like any message (a sender denied runs nothing), run in the
 *    chat's conversation with its sender, never dispatched, its outcome (`commandReply`) said in the
 *    chat. Other `/words` go to the agent as text. A command Telegram delivers again (its 200 was
 *    lost) is recognised by its message id (the last command handled in the chat) and not run twice.
 *    A private chat is one conversation, its own space: no `AdmitOptions.space` (the Worker keeps only
 *    private messages, so no group's forum topics).
 * 2. Everything else takes the inbound path every channel takes (`admitInbound`: `inbound.normalize`,
 *    `route.resolve`, the conversation `<instance>:<chat id>`, `dispatch`). The request id is
 *    `<instance>:<chat id>:<message id>`, as channel-telegram's: a message Telegram delivers twice is
 *    one request, and the runtime answers the second `duplicate`. When the agent will not answer, the
 *    chat is told why.
 *
 * It resolves once the message is durable in its conversation (`admitted` or `duplicate`), which is
 * when the Worker answers Telegram 200; the run and its answer come after, from the delivery wakeup
 * (`startAnswerDelivery`, `index.ts`). The channel's own short replies are sent here, once, best effort: a reply lost is
 * logged, never a reason for Telegram to deliver the update again.
 */

import type { AppContext } from "@pikit/core";
import {
  admitInbound,
  type AgentRuntime,
  type CommandLookup,
  type CommandOutcome,
  commandOf as appCommandOf,
  type ConversationRegistry,
  type InboundMessage,
  type KeyValueStore,
} from "@pikit/contracts";
import { conversationKeyOf } from "./account.ts";
import type { TelegramMessage } from "./api.ts";
import { type Bot, TELEGRAM_TIMEOUT_MS, within } from "./bot.ts";
import { rememberChat } from "./party.ts";
import { textOf } from "./update.ts";

export interface InboxDeps {
  bot: Bot;
  conversations: ConversationRegistry;
  runtime: AgentRuntime;
  /** The App's commands its users may type (`agent.command`, cut by the `commands` config: `allowedCommands`). */
  commands: CommandLookup;
  /** The channel's namespace of `storage.kv`: the last command handled in each chat, and who each chat is with (`party.ts`). */
  store: KeyValueStore;
}

/** What became of the update: `dispatched` when its conversation has it, and its answer is to come. */
export type InboxOutcome = "dispatched" | "answered";

/** The reply to a message with no text. */
export const NO_TEXT = "I can only read text messages for now.";

/** Where the last command handled in a chat is kept: its message id. */
export const commandSeenKey = (conversation: string): string => `command:${conversation}`;

const HELP = ["Send me a message and I'll answer.", "", "/new: start a new conversation (I forget this one)", "/help: this message"].join("\n");

export async function handleMessage(message: TelegramMessage, deps: InboxDeps, ctx: AppContext): Promise<InboxOutcome> {
  const { bot } = deps;
  const chatId = message.chat.id;
  const key = conversationKeyOf(bot.account.instance, chatId);
  const text = textOf(message);
  // The Worker sends only messages with text: one without is not this channel's to answer.
  if (text === undefined || message.from === undefined) throw new Error(`channel-telegram-webhook: message ${message.message_id} of ${key} has no text or no sender`);
  // Who the chat is with, for the dashboard: kept from what this message says (party.ts).
  await rememberChat(deps.store, key, message, ctx);

  const command = await commandOf(text, bot);
  if (command === "start" || command === "help" || command === "new" || command === "login") {
    const seenKey = commandSeenKey(key);
    const last = await deps.store.get<number>(seenKey);
    if (last !== undefined && message.message_id <= last) return "answered";
    if (command === "new") {
      const reset = await deps.conversations.reset(key, undefined, ctx);
      await reply(bot, chatId, reset === undefined ? "This is already a new conversation." : "Started a new conversation.", ctx);
    } else if (command === "login") {
      await reply(bot, chatId, "This chat can talk to me already.", ctx);
    } else {
      const name = message.from.first_name;
      await reply(bot, chatId, command === "start" ? `Hi${name ? ` ${name}` : ""}! ${HELP}` : HELP, ctx);
    }
    await deps.store.set(seenKey, message.message_id);
    return "answered";
  }

  const typed = await typedCommand(text, bot, deps.commands);
  if (typed !== undefined) {
    // Ran already (Telegram delivers it again): run never twice.
    const last = await deps.store.get<number>(commandSeenKey(key));
    if (last !== undefined && message.message_id <= last) return "answered";
  }

  const inbound: InboundMessage = {
    id: `${key}:${message.message_id}`,
    channel: bot.account.instance,
    conversationId: String(chatId),
    actor: { id: String(message.from.id) },
    text: typed ?? text,
  };
  const outcome = await admitInbound(ctx, inbound, { conversations: deps.conversations, runtime: deps.runtime, key, ...(typed !== undefined && { commands: deps.commands }) });
  switch (outcome.kind) {
    case "command":
      // Kept before the reply: a redelivery never runs it again (the reply is best effort).
      await deps.store.set(commandSeenKey(key), message.message_id);
      if (outcome.outcome.kind === "failed") ctx.logger.info("channel-telegram-webhook: a command typed in the chat failed", { chat: chatId, command: outcome.name, error: outcome.outcome.message });
      await reply(bot, chatId, commandReply(outcome.name, outcome.outcome), ctx);
      return "answered";
    case "admitted":
    case "duplicate":
      return "dispatched";
    case "halted":
      await reply(bot, chatId, "I can't take that message.", ctx);
      return "answered";
    case "denied":
      await reply(bot, chatId, "Sorry, I can't answer that here.", ctx);
      return "answered";
    case "no_route":
      await reply(bot, chatId, "This bot is not set up to answer yet.", ctx);
      return "answered";
  }
}

/** Sends the channel's own short reply once; a failure is logged, not thrown. */
export async function reply(bot: Bot, chatId: number, text: string, ctx: AppContext): Promise<void> {
  const conversationKey = conversationKeyOf(bot.account.instance, chatId);
  try {
    await within(TELEGRAM_TIMEOUT_MS, ctx.abortSignal, async (signal) => {
      for (const [index, piece] of bot.transport.split(text).entries()) {
        await bot.transport.send({ key: `reply:${chatId}:${index}`, conversationKey, text: piece, possibleDuplicate: false }, signal);
      }
    });
  } catch (error) {
    ctx.logger.error("channel-telegram-webhook: a reply could not be sent", { chat: chatId, error: String(error) });
  }
}

/** What the chat is told of a command it ran: its note, else that it was done; why it failed; or that there is none. */
export function commandReply(name: string, outcome: CommandOutcome): string {
  if (outcome.kind === "ran") return outcome.text ?? `/${name}: done.`;
  if (outcome.kind === "failed") return `/${name} failed: ${outcome.message}`;
  return `/${name} is not a command here.`;
}

/**
 * `text` as `/name args` when it names one of `commands` (`commandOf` of `@pikit/contracts`), or
 * `undefined`: `/name@this_bot args` (a group's or the menu's form) loses the bot's own username;
 * `/name@another_bot` is no command. The bot's username is asked (`getMe`) only when a command names one.
 */
async function typedCommand(text: string, bot: Bot, commands: CommandLookup): Promise<string | undefined> {
  const addressed = /^\s*\/([^\s@]+)@([A-Za-z0-9_]+)(?=\s|$)/.exec(text);
  if (addressed !== null && addressed[2]?.toLowerCase() !== (await bot.me()).username?.toLowerCase()) return undefined;
  const command = appCommandOf(addressed === null ? text : `/${addressed[1]}${text.slice(addressed[0].length)}`, commands);
  if (command === undefined) return undefined;
  return command.args === "" ? `/${command.name}` : `/${command.name} ${command.args}`;
}

/**
 * `/new` or `/new@this_bot` → `new`; `/reset` is `new`. A command for another bot, or no command, →
 * `undefined`. The bot's username is asked (`getMe`) only when a command names one.
 */
export async function commandOf(text: string, bot: Bot): Promise<string | undefined> {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text.trim());
  if (match === null) return undefined;
  const [, name = "", target] = match;
  if (target !== undefined && target.toLowerCase() !== (await bot.me()).username?.toLowerCase()) return undefined;
  const command = name.toLowerCase();
  return command === "reset" ? "new" : command;
}
