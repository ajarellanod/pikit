// Owner: admission. A quoted message as the reply's context (features/channel-google-chat.md "Quoted messages").
/**
 * A message that quotes another (`quotedMessageMetadata.name`) has it read (`api.getMessage`) and put
 * before its text as a markdown quote (`> `), with its sender's name, bounded (`QUOTE_CHARS`). A quote
 * the app cannot read (a `ChatApiError`) is named as unread, never a reason to refuse the message.
 */

import type { ChatMessage } from "./event.ts";
import type { ChatApi } from "./types.ts";

/** The most characters of a quoted message given to the agent. */
export const QUOTE_CHARS = 2_000;

/** The quote to put before `message`'s text, or `undefined` when it quotes nothing. */
export async function quoteOf(message: ChatMessage, api: ChatApi, signal: AbortSignal): Promise<string | undefined> {
  void message;
  void api;
  void signal;
  throw new Error("not implemented: admission (quote.ts quoteOf)");
}
