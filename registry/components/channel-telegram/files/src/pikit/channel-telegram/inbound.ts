/**
 * One Telegram update, from the bot's inbox to the agent:
 *
 * 1. Private chats only, for now; group messages are ignored (groups need the bot's privacy mode
 *    and mention rules, which come later). So a chat is one conversation, its own space: no
 *    `AdmitOptions.space` (and no forum topics).
 * 2. Who may talk: the Telegram user ids in `TELEGRAM_ALLOWED_USERS`. Anyone can find a bot, and an
 *    agent with tools must not answer strangers: an unknown user is told their id once, so the
 *    owner can add it, and nothing reaches the agent.
 * 3. Commands the channel answers itself: `/start` and `/help` explain, `/new` starts the
 *    conversation over (a reset: a new session, the old one kept: `conversations.registry`'s `reset`).
 *    Then the App's commands (`agent.command`) the `commands` config allows (`InboundDeps.commands`):
 *    `/name args`, or `/name@this_bot args` (its own username cut; another bot's is no command), is
 *    admitted with them (`AdmitOptions.commands`): routed like any message (a sender denied runs
 *    nothing), run in the chat's conversation with its sender, never dispatched, and its outcome
 *    (`commandReply`) is said in the chat. Other `/words` go to the agent as text. A command Telegram
 *    delivers again (a crash before its offset was confirmed) is recognised by its message id (the
 *    last command handled in the chat, kept in `storage.kv`) and not run twice.
 * 4. Everything else takes the inbound path every channel takes (`admitInbound`: `inbound.normalize`,
 *    `route.resolve`, the conversation `<instance>:<chat id>`, `dispatch`), and the sender is told what
 *    happened when the agent will not answer. The request id is `<instance>:<chat id>:<message id>`: a
 *    message Telegram delivers twice is one request. The instance is the bot's account (`account.ts`):
 *    `telegram`, or `telegram:<name>`.
 *
 * With polling there is no HTTP request to authenticate: the updates come from Telegram's own API,
 * over TLS, with the bot's token. What is left to check is the sender, which step 2 does.
 */

import { type AppContext } from "@pikit/core";
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
import type { TelegramUpdate, TelegramUser } from "./api.ts";
import { conversationKeyOf } from "./account.ts";
import { rememberChat } from "./party.ts";
import type { Replies } from "./replies.ts";

export interface InboundDeps {
  /** The bot's channel instance: `telegram`, or `telegram:<account>`. */
  instance: string;
  bot: TelegramUser;
  allowed: ReadonlySet<number>;
  delivery: Replies;
  conversations: ConversationRegistry;
  runtime: AgentRuntime;
  /** The App's commands its users may type (`agent.command`, cut by the `commands` config: `allowedCommands`). */
  commands: CommandLookup;
  /** The channel's namespace of `storage.kv`: the last command handled in each chat, and who each chat is with (`party.ts`). */
  store: KeyValueStore;
  /** A context of the channel's own, never `start`'s. */
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

/** What the sender of a message that kept failing is told before it is skipped (`poller.ts`). */
export const NOT_TAKEN = "Sorry, I could not take your message. Please send it again in a few minutes.";

/** Where the last command handled in a chat is kept: its message id. */
export const commandSeenKey = (conversation: string): string => `command:${conversation}`;

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

  // Who the chat is with, for the dashboard: kept from what this message says (party.ts).
  await rememberChat(deps.store, conversationKeyOf(deps.instance, chatId), message, ctx);

  const text = message.text ?? message.caption;
  if (text === undefined || text.trim() === "") {
    await delivery.send(chatId, "I can only read text messages for now.");
    return;
  }

  const command = commandOf(text, deps.bot);
  if (command === "start" || command === "help" || command === "new") {
    const key = conversationKeyOf(deps.instance, chatId);
    const seenKey = commandSeenKey(key);
    const last = await deps.store.get<number>(seenKey);
    if (last !== undefined && message.message_id <= last) return;
    if (command === "new") {
      const reset = await deps.conversations.reset(key, undefined, ctx);
      await delivery.send(chatId, reset === undefined ? "This is already a new conversation." : "Started a new conversation.");
    } else {
      await delivery.send(chatId, command === "start" ? `Hi${from.first_name ? ` ${from.first_name}` : ""}! ${HELP}` : HELP);
    }
    await deps.store.set(seenKey, message.message_id);
    return;
  }

  const key = conversationKeyOf(deps.instance, chatId);
  const typed = typedCommand(text, deps.bot, deps.commands);
  if (typed !== undefined) {
    // Ran already (Telegram delivers it again): run never twice.
    const last = await deps.store.get<number>(commandSeenKey(key));
    if (last !== undefined && message.message_id <= last) return;
  }

  const inbound: InboundMessage = {
    id: `${deps.instance}:${chatId}:${message.message_id}`,
    channel: deps.instance,
    conversationId: String(chatId),
    actor: { id: String(from.id) },
    text: typed ?? text,
  };
  const outcome = await admitInbound(ctx, inbound, { conversations: deps.conversations, runtime: deps.runtime, key, ...(typed !== undefined && { commands: deps.commands }) });
  switch (outcome.kind) {
    case "command":
      // Kept before the reply: a crash after it ran never runs it again (the reply may be lost).
      await deps.store.set(commandSeenKey(key), message.message_id);
      if (outcome.outcome.kind === "failed") ctx.logger.info("channel-telegram: a command typed in the chat failed", { chat: chatId, command: outcome.name, error: outcome.outcome.message });
      await delivery.send(chatId, commandReply(outcome.name, outcome.outcome));
      return;
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

/** Tells the sender of an update that kept failing that it was not taken: only an allowed user's private message. */
export async function tellNotTaken(update: TelegramUpdate, deps: InboundDeps): Promise<void> {
  const message = update.message;
  if (message === undefined || message.chat.type !== "private" || message.from === undefined || !deps.allowed.has(message.from.id)) return;
  await deps.delivery.send(message.chat.id, NOT_TAKEN);
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
 * `/name@another_bot` is no command.
 */
function typedCommand(text: string, bot: TelegramUser, commands: CommandLookup): string | undefined {
  const addressed = /^\s*\/([^\s@]+)@([A-Za-z0-9_]+)(?=\s|$)/.exec(text);
  if (addressed !== null && addressed[2]?.toLowerCase() !== bot.username?.toLowerCase()) return undefined;
  const command = appCommandOf(addressed === null ? text : `/${addressed[1]}${text.slice(addressed[0].length)}`, commands);
  if (command === undefined) return undefined;
  return command.args === "" ? `/${command.name}` : `/${command.name} ${command.args}`;
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
