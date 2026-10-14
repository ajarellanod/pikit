// Owner: transport. Markdown as Google Chat draws it (features/channel-google-chat.md "Answers").
/**
 * - `splitAnswer`: an answer's markdown in pieces of `PIECE_CHARS` characters at most, cut on a
 *   paragraph, else a line, else a space; never inside a table or a code block (one longer than a piece
 *   is a piece of its own, cut further by `chatMessageOf`'s byte guard). Never empty for a non-empty text.
 * - `chatMessageOf`: a piece's markdown as a Chat message: its text in Google Chat's format (`*bold*`,
 *   `_italic_`, `~strike~`, `` `code` ``, `<url|label>` links, `•` lists, headings as bold lines), its
 *   tables and code blocks as `cardsV2` (a card each, in order, monospace), and markdown images with a
 *   public `https` URL as image cards. A message whose JSON would pass `MESSAGE_BYTES` is refused here
 *   (an `Error`) so `splitAnswer`'s pieces are cut to fit before.
 * - `chatTextOf`: the text alone, for a preview (placeholder.ts): tables and code as plain monospace.
 */

import type { CardWithId } from "./event.ts";

/** A piece's characters at most: a size that works in practice (Google documents only the bytes). */
export const PIECE_CHARS = 4096;
/** Google's limit on a message as a whole (its text and cards), as JSON. */
export const MESSAGE_BYTES = 32_000;

/** `markdown` in pieces (above). */
export function splitAnswer(markdown: string, limit: number = PIECE_CHARS): string[] {
  void markdown;
  void limit;
  throw new Error("not implemented: transport (format.ts splitAnswer)");
}

/** A piece's markdown as a Chat message's `text` and `cardsV2` (above). */
export function chatMessageOf(markdown: string): { text: string; cardsV2: CardWithId[] } {
  void markdown;
  throw new Error("not implemented: transport (format.ts chatMessageOf)");
}

/** `markdown` as Chat text only, for a preview. */
export function chatTextOf(markdown: string): string {
  void markdown;
  throw new Error("not implemented: transport (format.ts chatTextOf)");
}
