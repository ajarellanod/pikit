// Owner: transport. Markdown as Google Chat draws it (features/channel-google-chat.md "Answers").
/**
 * - `splitAnswer`: an answer's markdown in pieces of `PIECE_CHARS` characters at most, cut on a
 *   paragraph, else a line, else a space; never inside a table or a code block (one longer than a piece
 *   is a piece of its own). Then each piece whose message (`chatMessageOf`) would pass `MESSAGE_BYTES`
 *   is cut further, in halves: its blocks apart, then a code block's lines (each half fenced again), a
 *   table's rows (each half with its header), a paragraph's lines or characters. Never empty for a
 *   non-empty text.
 * - `chatMessageOf`: a piece's markdown as a Chat message. Its text in Google Chat's format: `*bold*`
 *   (`**` and `__`), `_italic_` (`*` and `_`), `~strike~` (`~~`), `` `code` ``, `<url|label>` links
 *   (bare URLs and `<url>` left for Chat to link), `•` for `-`/`*`/`+` items (numbered ones kept),
 *   headings as bold lines, `\` escapes resolved. Its tables and code blocks as `cardsV2`, a card each,
 *   in order: monospace (`<pre>`, a table's columns aligned, its cells plain), a code block's language
 *   as its section's header. Markdown images with a public `https` URL as image cards, in order (any
 *   other image is a link). Since Chat shows a message's cards after its text, the text after a card
 *   goes into that card (a `textParagraph` in card HTML: `<b>`, `<i>`, `<s>`, `<code>`, `<a href>`),
 *   so the reading order is kept. A message whose JSON would pass `MESSAGE_BYTES` is refused (an
 *   `Error`): `splitAnswer` cuts its pieces to fit before.
 * - `chatTextOf`: the text alone, for a preview (placeholder.ts): code and tables as Chat's monospace
 *   blocks, images as links.
 */

import type { CardWidget, CardWithId } from "./event.ts";

/** A piece's characters at most: a size that works in practice (Google documents only the bytes). */
export const PIECE_CHARS = 4096;
/** Google's limit on a message as a whole (its text and cards), as JSON. */
export const MESSAGE_BYTES = 32_000;

// ---------------------------------------------------------------------------------------------------
// Blocks

type Block =
  /** Lines of text: a paragraph, a list, headings, quotes. */
  | { kind: "text"; lines: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "table"; header: string[]; rows: string[][] };

/** A block and the markdown it was read from. */
type Unit = { block: Block; raw: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells (outer pipes dropped, `\|` kept as a pipe). */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

const isTableStart = (lines: readonly string[], at: number): boolean => {
  const head = lines[at] ?? "";
  const delimiter = lines[at + 1] ?? "";
  return head.includes("|") && delimiter.includes("|") && delimiter.includes("-") && DELIMITER.test(delimiter);
};

/** `markdown`'s blocks, in order; blank lines separate them. An unclosed fence runs to the end. */
function unitsOf(markdown: string): Unit[] {
  const lines = markdown.replace(/[\x00-\x06]/g, "").replace(/\r\n?/g, "\n").split("\n");
  const units: Unit[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length > 0) units.push({ block: { kind: "text", lines: text }, raw: text.join("\n") });
    text = [];
  };
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const marker = fence[1] ?? "```";
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      let end = at + 1;
      while (end < lines.length && !close.test(lines[end] ?? "")) end++;
      units.push({ block: { kind: "code", lang: fence[2] ?? "", code: lines.slice(at + 1, end).join("\n") }, raw: lines.slice(at, end + 1).join("\n") });
      at = end;
      continue;
    }
    if (isTableStart(lines, at)) {
      flush();
      let end = at + 2;
      while (end < lines.length && (lines[end] ?? "").includes("|") && (lines[end] ?? "").trim() !== "") end++;
      const rows = lines.slice(at + 2, end).map(cells);
      units.push({ block: { kind: "table", header: cells(line), rows }, raw: lines.slice(at, end).join("\n") });
      at = end - 1;
      continue;
    }
    if (line.trim() === "") flush();
    else text.push(line);
  }
  flush();
  return units;
}

// ---------------------------------------------------------------------------------------------------
// Inline markdown, in three dialects

/** Google Chat's text format, card HTML, or plain text (a table's cells). */
type Dialect = "chat" | "html" | "plain";

/** Markers for the spans inline formatting opens and closes, replaced last (control characters, dropped from the input). */
const B = ["\x01", "\x02"] as const;
const I = ["\x03", "\x04"] as const;
const S = ["\x05", "\x06"] as const;
const MARKS: Record<Dialect, Record<string, string>> = {
  chat: { "\x01": "*", "\x02": "*", "\x03": "_", "\x04": "_", "\x05": "~", "\x06": "~" },
  html: { "\x01": "<b>", "\x02": "</b>", "\x03": "<i>", "\x04": "</i>", "\x05": "<s>", "\x06": "</s>" },
  plain: { "\x01": "", "\x02": "", "\x03": "", "\x04": "", "\x05": "", "\x06": "" },
};

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string): string => escapeHtml(text).replace(/"/g, "&quot;");

/** An image found in the text: drawn as a card when its URL is public. */
interface Image {
  url: string;
  alt: string;
}

const isPublic = (url: string): boolean => /^https:\/\/[^\s/]+\.[^\s/]+/i.test(url);

/**
 * `text`'s inline markdown in `dialect`. Images with a public URL go to `images` (when given) and leave
 * the text; any other image is a link.
 */
function inline(text: string, dialect: Dialect, images?: Image[]): string {
  const slots: string[] = [];
  const slot = (value: string): string => `\x00${slots.push(value) - 1}\x00`;
  const link = (url: string, label: string): string => {
    if (dialect === "plain") return label === "" ? url : label;
    if (dialect === "html") return `<a href="${escapeAttribute(url)}">${label === "" ? escapeHtml(url) : label}</a>`;
    const safe = url.replace(/\|/g, "%7C").replace(/>/g, "%3E");
    return label === "" ? safe : `<${safe}|${label.replace(/[<>|]/g, "")}>`;
  };

  let out = text
    // Escapes: the character itself.
    .replace(/\\([!-/:-@[-`{-~])/g, (_all, char: string) => slot(dialect === "html" ? escapeHtml(char) : char))
    // Code spans, untouched inside.
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_all, _ticks, code: string) => {
      const inner = /^ .* $/.test(code) ? code.slice(1, -1) : code;
      return slot(dialect === "chat" ? `\`${inner}\`` : dialect === "html" ? `<code>${escapeHtml(inner)}</code>` : inner);
    })
    // Images.
    .replace(/!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_all, alt: string, url: string) => {
      if (images !== undefined && isPublic(url)) {
        images.push({ url, alt });
        return "";
      }
      const label = inline(alt, dialect);
      // A relative or local path means nothing in a chat: its words alone.
      return slot(/^https?:\/\//i.test(url) ? link(url, label) : label === "" ? url : label);
    })
    // Links, their label formatted.
    .replace(/\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_all, label: string, url: string) => slot(link(url, inline(label, dialect))))
    // Autolinks, and bare URLs kept whole (an `_` in one is not italic).
    .replace(/<(https?:\/\/[^\s<>]+)>/g, (_all, url: string) => slot(link(url, "")))
    .replace(/https?:\/\/[^\s<>]+[^\s<>.,;:!?'")\]]/g, (url) => slot(dialect === "html" ? link(url, "") : url))
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, `${B[0]}$1${B[1]}`)
    .replace(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, `${B[0]}$1${B[1]}`)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, `${S[0]}$1${S[1]}`)
    .replace(/(?<![*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, `${I[0]}$1${I[1]}`)
    .replace(/(?<![_\w])_(?=[^\s_])([^_]*?[^\s_])_(?![_\w])/g, `${I[0]}$1${I[1]}`);
  if (dialect === "html") out = escapeHtml(out);
  out = out.replace(/[\x01-\x06]/g, (mark) => MARKS[dialect][mark] ?? "");
  return out.replace(/\x00(\d+)\x00/g, (_all, index: string) => slots[Number(index)] ?? "");
}

/** A text block's lines in `dialect`: headings bold, `•` items, quotes kept; images to `images`. */
function textOf(lines: readonly string[], dialect: Dialect, images?: Image[]): string {
  const bold = (text: string) => (dialect === "html" ? `<b>${text}</b>` : dialect === "chat" ? `*${text}*` : text);
  const out: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = (lines[at] ?? "").replace(/\s+$/, "").replace(/\\$/, "");
    const next = lines[at + 1] ?? "";
    let match: RegExpExecArray | null;
    if (/^\s{0,3}(=+|-+)\s*$/.test(next) && line.trim() !== "" && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      out.push(bold(inline(line.trim(), dialect, images)));
      at++;
    } else if ((match = /^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/.exec(line)) !== null) {
      out.push(bold(inline(match[1] ?? "", dialect, images)));
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("──────────");
    } else if ((match = /^(\s*)[-*+]\s+(.*)$/.exec(line)) !== null) {
      out.push(`${match[1] ?? ""}• ${inline(match[2] ?? "", dialect, images).trim()}`);
    } else if ((match = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line)) !== null) {
      out.push(`${match[1] ?? ""}${match[2]}. ${inline(match[4] ?? "", dialect, images).trim()}`);
    } else if ((match = /^\s{0,3}>\s?(.*)$/.exec(line)) !== null) {
      out.push(`${dialect === "html" ? "&gt;" : ">"} ${inline(match[1] ?? "", dialect, images)}`);
    } else {
      out.push(inline(line, dialect, images).trim());
    }
  }
  // A line made only of images leaves nothing (a block's lines are never blank).
  return out.filter((line) => line.trim() !== "").join(dialect === "html" ? "<br>" : "\n");
}

/** A table as aligned monospace lines: its header, a rule, its rows; cells as plain text. */
function tableLines(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [header, ...rows].map((row) => row.map((cell) => inline(cell, "plain")));
  const columns = Math.max(...all.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(1, ...all.map((row) => [...(row[column] ?? "")].length)));
  const line = (row: readonly string[]) => widths.map((width, column) => (row[column] ?? "").padEnd(width + (row[column] ?? "").length - [...(row[column] ?? "")].length)).join(" | ").trimEnd();
  const [head = [], ...body] = all;
  return [line(head), widths.map((width) => "-".repeat(width)).join("-+-"), ...body.map(line)].join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Messages

/** A piece's markdown as a Chat message, unchecked. */
function render(markdown: string): { text: string; cardsV2: CardWithId[] } {
  const text: string[] = [];
  const cards: CardWithId[] = [];
  const card = (widget: CardWidget, header?: string): void => {
    cards.push({ cardId: `block-${cards.length + 1}`, card: { sections: [{ ...(header !== undefined && header !== "" && { header }), widgets: [widget] }] } });
  };
  const pre = (body: string): CardWidget => ({ textParagraph: { text: `<pre>${escapeHtml(body)}</pre>` } });
  for (const { block } of unitsOf(markdown)) {
    if (block.kind === "code") card(pre(block.code), block.lang);
    else if (block.kind === "table") card(pre(tableLines(block.header, block.rows)));
    else {
      const images: Image[] = [];
      const last = cards.at(-1);
      if (last === undefined) {
        const said = textOf(block.lines, "chat", images);
        if (said.trim() !== "") text.push(said);
      } else {
        // After a card, in it: Chat shows a message's cards after its text.
        const said = textOf(block.lines, "html", images);
        if (said.trim() !== "") last.card.sections?.[0]?.widgets.push({ textParagraph: { text: said } });
      }
      for (const image of images) card({ image: { imageUrl: image.url, altText: image.alt === "" ? "image" : image.alt } });
    }
  }
  return { text: text.join("\n\n"), cardsV2: cards };
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
/** A message's size as Google measures it against `MESSAGE_BYTES`: its JSON (text and cards), in UTF-8 bytes. */
export const messageBytes = (message: { text?: string; cardsV2?: readonly CardWithId[] }): number => utf8Bytes(JSON.stringify(message));
const bytesOf = (markdown: string): number => messageBytes(render(markdown));

/** A piece's markdown as a Chat message's `text` and `cardsV2` (above). Throws when its JSON passes `MESSAGE_BYTES`. */
export function chatMessageOf(markdown: string): { text: string; cardsV2: CardWithId[] } {
  const message = render(markdown);
  const bytes = messageBytes(message);
  if (bytes > MESSAGE_BYTES) throw new Error(`channel-google-chat: a message of ${bytes} bytes is more than Google takes (${MESSAGE_BYTES})`);
  return message;
}

/** `markdown` as Chat text only, for a preview: code and tables as monospace blocks, images as links. */
export function chatTextOf(markdown: string): string {
  return unitsOf(markdown)
    .map(({ block }) => {
      if (block.kind === "code") return `\`\`\`\n${block.code}\n\`\`\``;
      if (block.kind === "table") return `\`\`\`\n${tableLines(block.header, block.rows)}\n\`\`\``;
      return textOf(block.lines, "chat");
    })
    .filter((each) => each.trim() !== "")
    .join("\n\n");
}

// ---------------------------------------------------------------------------------------------------
// Pieces

/** Where to cut `text` at `limit` at most: a line, else a space, else `limit` (never inside a surrogate pair). */
function cutAt(text: string, limit: number): number {
  const line = text.lastIndexOf("\n", limit);
  if (line > 0) return line;
  const space = text.lastIndexOf(" ", limit);
  if (space > 0) return space;
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

/** `text` in parts of `limit` characters at most, on lines, else spaces. */
function cutText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const at = cutAt(rest, limit);
    const part = rest.slice(0, at).trimEnd();
    if (part !== "") parts.push(part);
    rest = rest.slice(at).replace(/^[ \n]/, "");
  }
  if (rest.trim() !== "") parts.push(rest);
  return parts;
}

/** A piece too large as a message, in two (each smaller). */
function halve(piece: string): string[] {
  const units = unitsOf(piece);
  if (units.length > 1) {
    const middle = Math.ceil(units.length / 2);
    return [units.slice(0, middle), units.slice(middle)].map((half) => half.map((unit) => unit.raw).join("\n\n"));
  }
  const unit = units[0];
  if (unit?.block.kind === "code") {
    const lines = unit.block.code.split("\n");
    const fence = (body: string) => `\`\`\`${unit.block.kind === "code" ? unit.block.lang : ""}\n${body}\n\`\`\``;
    if (lines.length > 1) {
      const middle = Math.ceil(lines.length / 2);
      return [fence(lines.slice(0, middle).join("\n")), fence(lines.slice(middle).join("\n"))];
    }
    const code = unit.block.code;
    return [fence(code.slice(0, Math.ceil(code.length / 2))), fence(code.slice(Math.ceil(code.length / 2)))];
  }
  if (unit?.block.kind === "table" && unit.block.rows.length > 1) {
    const [head = "", delimiter = "", ...rows] = unit.raw.split("\n");
    const middle = Math.ceil(rows.length / 2);
    return [rows.slice(0, middle), rows.slice(middle)].map((half) => [head, delimiter, ...half].join("\n"));
  }
  const raw = unit?.raw ?? piece;
  const at = cutAt(raw, Math.ceil(raw.length / 2));
  return [raw.slice(0, at), raw.slice(at)].filter((half) => half.trim() !== "");
}

/** `piece`, cut until each part's message fits in `MESSAGE_BYTES`. */
function fit(piece: string): string[] {
  if (bytesOf(piece) <= MESSAGE_BYTES) return [piece];
  const halves = halve(piece);
  // A part that cannot be cut further (it never happens: halves are smaller) is left to be refused.
  if (halves.length < 2) return halves;
  return halves.flatMap(fit);
}

/** `markdown` in pieces (above). */
export function splitAnswer(markdown: string, limit: number = PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current !== "") pieces.push(current);
    current = "";
  };
  for (const unit of unitsOf(markdown)) {
    const parts = unit.raw.length <= limit || unit.block.kind !== "text" ? [unit.raw] : cutText(unit.raw, limit);
    for (const part of parts) {
      if (current !== "" && current.length + 2 + part.length > limit) flush();
      current = current === "" ? part : `${current}\n\n${part}`;
    }
  }
  flush();
  if (pieces.length === 0) return markdown === "" ? [] : [markdown];
  return pieces.flatMap(fit);
}
