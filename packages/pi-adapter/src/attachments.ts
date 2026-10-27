/**
 * The files a chat message brings, for any channel: what it shows the model and what it writes to the
 * conversation's workspace. The channel lists the files (`AttachmentSource`: a name, a type, how to
 * download it) and chooses the bounds (`AttachmentLimits`, its policy); this is the protocol:
 *
 * - **Bounds** (`collectAttachments`): at most `perMessage` files, `bytesEach` each, `bytesTotal` in
 *   all. Each download is asked for no more than what is left of every bound that applies to it, so
 *   nothing past a bound is read; a file past one is named as not read, with which.
 * - **Images** (`image/png`, `jpeg`, `webp`, `gif`) become `images` (base64 `AgentImage`s, for
 *   `InboundMessage.images`) within `imageBytes` in all; **text files** (`text/*`, JSON, CSV) are
 *   appended to the text, each under its name in a fence, within `textChars` in all (cut past it, and
 *   said). A limit absent: such files are written like any other.
 * - **Any other file** is kept (`files`) to be written to the conversation's workspace
 *   (`writeAttachments`, in `AdmitOptions.beforeDispatch` once the conversation is known):
 *   `attachments/<message id>/<file name>`, both made safe (`safeName`: one path segment, never `..`
 *   or a NUL), two of one name numbered (`a.pdf`, `a-2.pdf`). The same message delivered again writes
 *   the same paths. The text names each path. With neither `workspace` nor `execution` (`canWrite`
 *   false) it is named as not read, and not downloaded.
 * - **A download that fails** is named as not read (logged), never a reason to refuse the message; a
 *   write that fails is (`writeAttachments` rejects): nothing is dispatched, and the platform delivers
 *   the message again.
 *
 * File bytes never travel in the message: the model reads a path in its text, and its tools read the
 * file (features/rich-content.md). Neutral: no Node, no Bun; it runs in a Durable Object.
 */

import type { AppContext } from "@pikit/core";
import type { AgentImage, ConversationRef } from "@pikit/contracts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { toChord } from "./context.ts";
import type { WorkspaceProvider } from "./types.ts";

/** The bounds of what one message brings in: the channel's policy. */
export interface AttachmentLimits {
  perMessage: number;
  bytesEach: number;
  bytesTotal: number;
  /** Images shown to the model, in all; absent: images are written as files. */
  imageBytes?: number;
  /** Characters of text files put in the message, in all; absent: text files are written as files. */
  textChars?: number;
}

/** Where a message's files go in the workspace: `attachments/<message id>/`. */
export const ATTACHMENTS_DIR = "attachments";

/** One file of a message, as its channel describes it. */
export interface AttachmentSource {
  /** Its name, as the sender gave it (`""`: `file <n>`). Shown, and made safe for its path. */
  name: string;
  /** The type the platform declares, if any. */
  contentType?: string | undefined;
  /** Why it cannot be read, said by the channel (a link to a file elsewhere): named, never downloaded. */
  unreadable?: string;
  /**
   * Its bytes, at most `most` (throw `AttachmentTooLarge` past it, without reading the rest), and the
   * type they came with. Any other rejection names it as not read (`CollectOptions.problemOf`).
   */
  download(most: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType?: string | undefined }>;
}

/** What a download throws when the file is larger than it was asked for. */
export class AttachmentTooLarge extends Error {
  constructor(message = "the file is larger than asked") {
    super(message);
    this.name = "AttachmentTooLarge";
  }
}

/** A file to write to the workspace before dispatch. */
export interface PendingFile {
  /** `attachments/<message id>/<file name>`. */
  path: string;
  bytes: Uint8Array;
  contentType: string | undefined;
}

/** What a message's files give. */
export interface CollectedAttachments {
  images: AgentImage[];
  /** For the message's text: a line per file (where it is, or why it was not read), then the text files. Empty when there is none. */
  text: string;
  /** Written by `writeAttachments` once the conversation is known. */
  files: PendingFile[];
}

export interface CollectOptions {
  /** The message's own id, the same at each delivery: its directory (made safe). */
  messageId: string;
  limits: AttachmentLimits;
  /** A `workspace` or `execution` is installed: files are written there. */
  canWrite: boolean;
  /** Why a download failed, in words; default "it could not be downloaded". */
  problemOf?(error: unknown): string;
  /** The channel, in its log lines: `channel-telegram`. */
  label: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** `contentType` without its parameters, lowercase. */
const baseType = (contentType: string | undefined): string => (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
const isImageType = (type: string): boolean => IMAGE_TYPES.has(type);
const isTextType = (type: string): boolean => type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/csv";

/** `bytes` in words: `512 bytes`, `12 KB`, `3.4 MB`. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * `name` as one safe path segment: letters, digits, `.`, `-`, `_` and spaces kept, anything else `_`
 * (`/`, `\`, NUL), no leading dot (so never `.` or `..`), at most 100 characters (its extension kept);
 * `fallback` when nothing is left.
 */
export function safeName(name: string | undefined, fallback = "file"): string {
  const cleaned = (name ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (cleaned === "" || /^_+$/.test(cleaned)) return fallback;
  if (cleaned.length <= 100) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, 100 - extension.length)}${extension}`;
}

/** `bytes` as base64, without `Buffer` (a Worker may not have it). */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** `response`'s body, at most `most` bytes: past it (said, or counted as it streams) `AttachmentTooLarge`, the rest never read. */
export async function readBounded(response: Response, most: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > most) {
    await response.body?.cancel().catch(() => {});
    throw new AttachmentTooLarge(`the file is larger than ${most} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > most) {
      await reader.cancel().catch(() => {});
      throw new AttachmentTooLarge(`the file is larger than ${most} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A fence that `text` cannot close: one backtick more than its longest run, at least three. */
const fenceFor = (text: string): string => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

/** `sources` downloaded and sorted (above), in order. */
export async function collectAttachments(sources: readonly AttachmentSource[], options: CollectOptions, ctx: AppContext, signal: AbortSignal): Promise<CollectedAttachments> {
  const { limits } = options;
  const inlineImages = limits.imageBytes !== undefined;
  const inlineText = limits.textChars !== undefined;
  const imageLimit = limits.imageBytes ?? 0;
  const textLimit = limits.textChars ?? 0;
  const isImage = (type: string): boolean => inlineImages && isImageType(type);
  const isText = (type: string): boolean => inlineText && isTextType(type);
  const images: AgentImage[] = [];
  const files: PendingFile[] = [];
  const lines: string[] = [];
  const texts: string[] = [];
  const directory = `${ATTACHMENTS_DIR}/${safeName(options.messageId, "message")}`;
  const names = new Set<string>();
  let bytesUsed = 0;
  let imageBytesUsed = 0;
  let textCharsUsed = 0;

  /** A unique safe name in the message's directory. */
  const pathFor = (name: string): string => {
    const safe = safeName(name);
    const dot = safe.lastIndexOf(".");
    const [stem, extension] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
    let candidate = safe;
    for (let n = 2; names.has(candidate); n += 1) candidate = `${stem}-${n}${extension}`;
    names.add(candidate);
    return `${directory}/${candidate}`;
  };
  const notRead = (name: string, why: string) => lines.push(`- ${name}: not read (${why})`);
  const noWorkspace = "no workspace is installed to keep files in";

  for (const [index, source] of sources.entries()) {
    const name = source.name.trim() || `file ${index + 1}`;
    if (index >= limits.perMessage) {
      notRead(name, `only the first ${limits.perMessage} files of a message are read`);
      continue;
    }
    if (source.unreadable !== undefined) {
      notRead(name, source.unreadable);
      continue;
    }
    const declared = baseType(source.contentType);
    if (!isImage(declared) && !isText(declared) && !options.canWrite) {
      notRead(name, noWorkspace);
      continue;
    }
    if (isText(declared) && textCharsUsed >= textLimit) {
      notRead(name, `past the ${textLimit} characters of text files a message may bring`);
      continue;
    }
    const left = limits.bytesTotal - bytesUsed;
    const imageLeft = imageLimit - imageBytesUsed;
    const most = Math.min(limits.bytesEach, left, isImage(declared) ? imageLeft : Number.POSITIVE_INFINITY);
    if (most <= 0) {
      notRead(name, isImage(declared) && imageLeft <= 0 ? `past the ${sizeOf(imageLimit)} of images a message may bring` : `past the ${sizeOf(limits.bytesTotal)} a message may bring`);
      continue;
    }

    let downloaded: { bytes: Uint8Array; contentType?: string | undefined };
    try {
      downloaded = await source.download(most, signal);
    } catch (error) {
      if (error instanceof AttachmentTooLarge) {
        notRead(
          name,
          most === limits.bytesEach
            ? `larger than the ${sizeOf(limits.bytesEach)} a file may be`
            : isImage(declared) && most === imageLeft
              ? `past the ${sizeOf(imageLimit)} of images a message may bring`
              : `past what is left of the ${sizeOf(limits.bytesTotal)} a message may bring`,
        );
      } else {
        ctx.logger.warn(`${options.label}: a message's file could not be downloaded; it is named as not read`, { message: options.messageId, file: name, error: error instanceof Error ? error.message : String(error) });
        notRead(name, options.problemOf?.(error) ?? "it could not be downloaded");
      }
      continue;
    }
    const { bytes } = downloaded;
    // The bytes' own type when the platform says one, else the declared one.
    const actual = baseType(downloaded.contentType);
    const type = actual !== "" && actual !== "application/octet-stream" ? actual : declared;
    bytesUsed += bytes.byteLength;

    if (isImage(type)) {
      if (imageBytesUsed + bytes.byteLength > imageLimit) {
        notRead(name, `past the ${sizeOf(imageLimit)} of images a message may bring`);
        continue;
      }
      imageBytesUsed += bytes.byteLength;
      images.push({ mimeType: type, data: base64Of(bytes) });
      lines.push(`- ${name}: an image, shown to you`);
    } else if (isText(type)) {
      const content = new TextDecoder().decode(bytes);
      const room = textLimit - textCharsUsed;
      if (room <= 0) {
        notRead(name, `past the ${textLimit} characters of text files a message may bring`);
        continue;
      }
      const cut = content.length > room;
      const kept = cut ? content.slice(0, room) : content;
      textCharsUsed += kept.length;
      const fence = fenceFor(kept);
      texts.push(`File ${name}${cut ? ` (its first ${room} characters of ${content.length})` : ""}:\n${fence}\n${kept}${kept.endsWith("\n") ? "" : "\n"}${fence}`);
      lines.push(`- ${name}: its text is below${cut ? ", cut" : ""}`);
    } else if (options.canWrite) {
      const path = pathFor(name);
      files.push({ path, bytes, contentType: type === "" ? undefined : type });
      lines.push(`- ${name} (${type === "" ? "a file" : type}, ${sizeOf(bytes.byteLength)}): saved in your workspace at ${path}`);
    } else {
      notRead(name, noWorkspace);
    }
  }

  if (lines.length === 0) return { images, files, text: "" };
  return { images, files, text: [`Files attached to this message:\n${lines.join("\n")}`, ...texts].join("\n\n") };
}

/** Where a channel writes a message's files: the conversation's workspace when installed, else `execution`. */
export interface AttachmentTargets {
  workspace: WorkspaceProvider | undefined;
  execution: ExecutionEnv | undefined;
}

/**
 * Writes `files` to `conversation`'s workspace (`targets.workspace.resolve(conversation)`'s env, else
 * `targets.execution`), each under its path. Rejects when one cannot be written (or there is nowhere
 * to write it): the message is then not dispatched, and the platform delivers it again.
 */
export async function writeAttachments(files: readonly PendingFile[], conversation: ConversationRef, targets: AttachmentTargets, ctx: AppContext, label: string): Promise<void> {
  if (files.length === 0) return;
  const env: ExecutionEnv | undefined = targets.workspace !== undefined ? (await targets.workspace.resolve(conversation, ctx)).env : targets.execution;
  if (env === undefined) throw new Error(`${label}: a message's files have nowhere to be written (neither workspace nor execution is installed)`);
  const chord = toChord(ctx);
  for (const file of files) {
    const directory = file.path.slice(0, file.path.lastIndexOf("/"));
    const made = await env.createDir(directory, { recursive: true }, chord);
    if (!made.ok) throw new Error(`${label}: the directory ${directory} could not be made in the workspace: ${made.error.message}`, { cause: made.error });
    const written = await env.writeFile(file.path, file.bytes, chord);
    if (!written.ok) throw new Error(`${label}: ${file.path} could not be written to the workspace: ${written.error.message}`, { cause: written.error });
  }
  ctx.logger.info(`${label}: a message's files written to its conversation's workspace`, { conversation: conversation.key, files: files.length });
}
