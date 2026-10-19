/**
 * Who a conversation is with, for the dashboard (the channel's stage of `conversation.describe`): what the
 * bot already received, never asked of Telegram. Each message an allowed user sends keeps what it says
 * of its chat (`rememberChat`: the person's names and username in a private chat, a group's title) in
 * the channel's namespace of `storage.kv`, under `party:<conversation key>`, written only when it
 * changed. The describer reads it back; a chat it has no record of (one from before) is described by
 * its key: its chat id, a direct message when the id is positive (Telegram's groups are negative).
 *
 * The same file in channel-telegram and channel-telegram-webhook (twins.test.ts): change one, copy it
 * to the other.
 */

import type { AppContext } from "@pikit/core";
import type { ConversationDescriber, ConversationParty, KeyValueStore } from "@pikit/contracts";
import { type Account, chatIn } from "./account.ts";
import type { TelegramMessage } from "./api.ts";

/** What a chat's latest message said of it. */
export type SeenChat = {
  /** Telegram's chat type: `private`, `group`, `supergroup`, `channel`. */
  type: string;
  /** A group's title. */
  title?: string;
  /** In a private chat, the person's. */
  username?: string;
  firstName?: string;
  lastName?: string;
};

/** Where what a chat's messages said of it is kept. */
export const partyKey = (conversationKey: string): string => `party:${conversationKey}`;

/** The longest name kept (Telegram's are at most 64 characters; a title 128). */
const KEPT = 256;
const kept = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value.slice(0, KEPT));

/** What `message` says of its chat. */
export function seenChatOf(message: TelegramMessage): SeenChat {
  const { chat, from } = message;
  const title = kept(chat.title);
  if (chat.type !== "private" || from === undefined) return { type: chat.type, ...(title !== undefined && { title }) };
  const username = kept(from.username);
  const firstName = kept(from.first_name);
  const lastName = kept(from.last_name);
  return { type: chat.type, ...(username !== undefined && { username }), ...(firstName !== undefined && { firstName }), ...(lastName !== undefined && { lastName }) };
}

const same = (a: SeenChat | undefined, b: SeenChat): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * Keeps what `message` says of its chat, the conversation `key`, when it changed. Never throws: a
 * failure is logged, and the message goes on (the next one keeps it).
 */
export async function rememberChat(store: KeyValueStore, key: string, message: TelegramMessage, ctx: AppContext): Promise<void> {
  try {
    const seen = seenChatOf(message);
    if (!same(await store.get<SeenChat>(partyKey(key)), seen)) await store.set(partyKey(key), seen);
  } catch (error) {
    ctx.logger.warn("telegram: who a chat is with was not kept; its next message keeps it", { conversation: key, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Who the chat `chatId` of `account`'s bot is, from what its messages said (`seen`, when any). */
export function partyOf(account: Account, chatId: number, seen: SeenChat | undefined): ConversationParty {
  const type = seen?.type ?? (chatId > 0 ? "private" : "group");
  const person = [seen?.firstName, seen?.lastName].filter((each) => each !== undefined).join(" ");
  const username = seen?.username === undefined ? undefined : `@${seen.username}`;
  const name = type === "private" ? (person !== "" ? person : username) : seen?.title;
  const detail = type === "private" ? (person !== "" && username !== undefined ? `${username}, direct message` : "Direct message") : type === "channel" ? "Channel" : "Group";
  return {
    ...(name !== undefined && { name }),
    detail,
    ids: [{ label: "Chat id", value: String(chatId) }, ...(account.name === undefined ? [] : [{ label: "Account", value: account.name }])],
    ...(account.name !== undefined && { instance: account.name }),
  };
}

/** The describer of the conversations of `accounts`' bots, over the channel's namespace of `storage.kv` (`store`). */
export function createDescriber(accounts: readonly Account[], store: () => KeyValueStore): ConversationDescriber {
  return {
    async describe(key, ctx) {
      for (const account of accounts) {
        const chatId = chatIn(account.instance, key);
        if (chatId === undefined) continue;
        // A record that cannot be read: described by the key.
        const seen = await store()
          .get<SeenChat>(partyKey(key))
          .catch((error: unknown) => {
            ctx.logger.warn("telegram: who a chat is with could not be read", { conversation: key, error: error instanceof Error ? error.message : String(error) });
            return undefined;
          });
        return partyOf(account, chatId, seen);
      }
      return undefined;
    },
  };
}
