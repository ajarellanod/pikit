/**
 * Parts: what an answer carries besides its markdown text, for a channel to draw its platform's way (a
 * question as buttons, a form). Not a field per platform feature, and not an opaque `blocks: unknown`
 * (features/rich-content.md):
 *
 * - **A kind of part is declared by the component that introduces it**, by declaration merging on
 *   `AppMessageParts`, as events are on `AppEvents`. The core and the contracts declare none: without
 *   that component the kind does not exist.
 *
 *     declare module "@pikit/contracts" {
 *       interface AppMessageParts {
 *         question: { id: string; title: string; fields: QuestionField[] };
 *       }
 *     }
 *
 * - **Every part carries a `fallback`**: the text a reader is given where the part is not drawn.
 * - **A transport draws the kinds it lists** (`ChannelTransport.draws`). Every other part is folded
 *   into the message's text as its fallback, before the text is split; the drawn parts go with the
 *   message's last piece (`OutboundPiece.parts`). So a message never needs a channel that supports it,
 *   and no flag says which channels do. `messagePieces` is the one place that does it: answer delivery
 *   (`startAnswerDelivery`, both paths) and every `outbound.queue` cut a message with it, and a channel
 *   that answers in its response (channel-http) folds with `foldParts`.
 *
 * What a platform draws from markdown (tables, code, images) is its transport's, not a part. Parts are
 * for what another component produces and every channel must draw or fold.
 */

import type { ChannelTransport } from "./outbound.ts";

/**
 * The kinds of part, by `type`, each with its own fields (besides `type` and `fallback`): declared by
 * the component that introduces one.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface AppMessageParts {}

/** One part of a message: its kind (`type`), the text it folds into (`fallback`), and its kind's fields. */
export type MessagePart = {
  [K in keyof AppMessageParts]: { type: K; fallback: string } & AppMessageParts[K];
}[keyof AppMessageParts];

/** A message before a transport cuts it: its markdown text and its parts, in order. */
export interface MessageContent {
  text: string;
  parts?: readonly MessagePart[];
}

/** One piece of a message as `messagePieces` cuts it: a piece of text, and on the last one the parts its transport draws. */
export interface MessagePiece {
  text: string;
  /** Only on the last piece, and only when the transport draws some of the message's parts. */
  parts?: readonly MessagePart[];
}

/**
 * `content` for a transport that draws the kinds `draws`: every other part folded into the text as its
 * fallback, after the text and in order, each a paragraph of its own (an empty one adds nothing); the
 * parts it draws kept, in order.
 */
export function foldParts(content: MessageContent, draws: readonly string[] = []): { text: string; parts: MessagePart[] } {
  const drawn: MessagePart[] = [];
  const paragraphs = content.text.trim() === "" ? [] : [content.text];
  for (const part of content.parts ?? []) {
    // Read as any kind: with no kind declared, `MessagePart` is `never`.
    const { type, fallback } = part as { type: string; fallback: string };
    if (draws.includes(type)) drawn.push(part);
    else if (fallback.trim() !== "") paragraphs.push(fallback);
  }
  return { text: paragraphs.join("\n\n"), parts: drawn };
}

/**
 * `content` as `transport` sends it: the parts it does not draw folded into the text (`foldParts`), the
 * text split (`transport.split`), and the parts it draws on the last piece. A message of drawn parts and
 * no text is one piece of empty text with them; one with nothing to say is no piece.
 */
export function messagePieces(transport: Pick<ChannelTransport, "split" | "draws">, content: MessageContent): MessagePiece[] {
  const { text, parts } = foldParts(content, transport.draws);
  const pieces: MessagePiece[] = text === "" ? [] : transport.split(text).map((piece) => ({ text: piece }));
  if (parts.length === 0) return pieces;
  const last = pieces.pop() ?? { text: "" };
  return [...pieces, { ...last, parts }];
}
