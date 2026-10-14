// Owner: admission. A quoted message as the reply's context (features/channel-google-chat.md "Quoted messages").
/**
 * A message that quotes another (`quotedMessageMetadata.name`) has it read (`api.getMessage`) and put
 * before its text as a markdown quote (`> `), with its sender's name, bounded (`QUOTE_CHARS`). A quote
 * the app cannot read (a `ChatApiError`: not shared with the app, deleted, a timeout) is named as
 * unread, never a reason to refuse the message.
 */

import type { ChatMessage } from "./event.ts";
import type { ChatApi } from "./types.ts";

/** The most characters of a quoted message given to the agent. */
export const QUOTE_CHARS = 2_000;

/** `text` as a markdown quote, every line under `> `. */
export const quoted = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** `text` cut to `max` characters (never inside a surrogate pair), with `…` when cut. */
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** The quote to put before `message`'s text, or `undefined` when it quotes nothing. */
export async function quoteOf(message: ChatMessage, api: ChatApi, signal: AbortSignal): Promise<string | undefined> {
  const name = message.quotedMessageMetadata?.name;
  if (name === undefined || name === "") return undefined;
  let found: ChatMessage;
  try {
    found = await api.getMessage(name, signal);
  } catch {
    return "(This replies to a message the app could not read.)";
  }
  const who = found.sender?.displayName?.trim() || (found.sender?.type === "BOT" ? "The app" : "Someone");
  const text = (found.text ?? found.argumentText ?? "").trim();
  const files = found.attachment?.length ?? 0;
  const body = text !== "" ? bounded(text, QUOTE_CHARS) : files > 0 ? `(${files === 1 ? "a file" : `${files} files`}, no text)` : "(no text)";
  return `${who} wrote, quoted in this reply:\n${quoted(body)}`;
}
