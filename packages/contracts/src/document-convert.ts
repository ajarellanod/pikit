/**
 * `document.convert`: a document's text, as Markdown, from its bytes (features/projects.md, "The
 * contracts"): a PDF, an Office or OpenDocument file, HTML, XML, CSV. What lets a project's document be
 * made from an uploaded file, and a saved file's text be searched.
 *
 *   const convert = pikit.useOptional("document.convert");
 *   const converted = convert.has() && convert.get().accepts(type) ? await convert.get().convert({ bytes, type, name }, ctx) : undefined;
 *
 * Optional for its users: absent, only text is read (`isTextType`: `text/*`, JSON, Markdown, CSV, XML),
 * decoded as UTF-8 by the user itself (`textOf`).
 *
 * What every provider guarantees:
 * - **`accepts(type)` is what it reads**: the media types it converts, compared without parameters and
 *   case (`application/pdf; x=y` is `application/pdf`). `convert` of a type it does not accept resolves
 *   `undefined` and reads nothing.
 * - **`convert` answers Markdown text**, at most `CONVERT_TEXT_MAX` characters (cut at a line, with a
 *   final line saying it was cut), never empty: a document with no text (a scan with no text layer) is
 *   `ConvertError` `empty`.
 * - **Bounded**: bytes past `maxBytes` (at least `CONVERT_MIN_MAX_BYTES`) are `too_large`, before
 *   anything is sent anywhere; `ctx` bounds the wait (`unavailable` when cancelled or timed out).
 * - **Every rejection is a `ConvertError`** by `code`: `invalid` (not bytes, not a media type),
 *   `too_large`, `empty`, `failed` (the file is damaged, encrypted, or the converter refused it: retrying
 *   changes nothing), `unavailable` (the service, a timeout: retry later). Its message never holds the
 *   document's text or its name.
 * - **Nothing is kept**: the provider stores neither the bytes nor the text; the caller keeps what it
 *   needs. Images are not offered (reading one costs a model's call).
 *
 * Users: projects-sql's and channel-web's document routes (a document from a file), tool-space-files
 * (a saved file's text, for `project_search`). Provider: convert-workers-ai (Workers AI's `toMarkdown`,
 * `durable`). A server provider (a sandbox's `pdftotext`) comes with a user. One provider:
 * `experimental`.
 */

import type { AppContext } from "@pikit/core";

/** The longest text `convert` answers, in characters (a project's document holds at most this). */
export const CONVERT_TEXT_MAX = 500_000;
/** The least `maxBytes` a provider accepts: a saved file's largest (tool-space-files' default). */
export const CONVERT_MIN_MAX_BYTES = 25 * 1024 * 1024;

/** What to convert. */
export type ConvertInput = {
  bytes: Uint8Array;
  /** Its media type, as uploaded or saved (`application/pdf`). */
  type: string;
  /** Its file name, a hint for the converter (`brief.docx`); never in an error. */
  name?: string;
};

/** Why `convert` rejected: see the header. */
export type ConvertErrorCode = "invalid" | "too_large" | "empty" | "failed" | "unavailable";

export class ConvertError extends Error {
  readonly code: ConvertErrorCode;
  constructor(code: ConvertErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConvertError";
    this.code = code;
  }
}

/** The `document.convert` capability. */
export interface DocumentConverter {
  /** The largest input it converts, in bytes: at least `CONVERT_MIN_MAX_BYTES`. */
  readonly maxBytes: number;
  /** Whether it converts documents of media type `type` (parameters and case ignored). */
  accepts(type: string): boolean;
  /** `input`'s text as Markdown; `undefined` for a type it does not accept. Rejects with `ConvertError`. */
  convert(input: ConvertInput, ctx: AppContext): Promise<{ text: string } | undefined>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "document.convert": DocumentConverter;
  }
}

/** A media type without its parameters, lower case: `Text/HTML; charset=utf-8` is `text/html`; `""` when it is not one. */
export function mediaTypeOf(type: string): string {
  const bare = (type.split(";")[0] ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(bare) ? bare : "";
}

/** The media types read as text with no converter, besides every `text/*`. */
export const TEXT_TYPES: readonly string[] = ["application/json", "application/xml", "application/x-ndjson", "application/yaml", "application/x-yaml"];

/** Whether `type` is read as text with no converter: `text/*` (Markdown, CSV, HTML included), JSON, XML, YAML. */
export function isTextType(type: string): boolean {
  const bare = mediaTypeOf(type);
  return bare.startsWith("text/") || TEXT_TYPES.includes(bare) || bare.endsWith("+json") || bare.endsWith("+xml");
}

/** `bytes` as text when they are valid UTF-8 with no NUL, else `undefined` (a binary file). */
export function textOf(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes(String.fromCharCode(0)) ? undefined : text;
  } catch {
    return undefined;
  }
}

/** `text` cut to `max` characters at a line, with a final line saying it was cut; unchanged when it fits. */
export function cutText(text: string, max = CONVERT_TEXT_MAX): string {
  if (text.length <= max) return text;
  const note = "\n\n[cut: the document is longer]";
  const room = text.slice(0, Math.max(0, max - note.length));
  const atLine = room.lastIndexOf("\n");
  return `${atLine > room.length / 2 ? room.slice(0, atLine) : room}${note}`;
}
