// Owner: admission. A message's files, read before admission (features/channel-google-chat.md "Attachments in").
/**
 * - Chat media (`attachmentDataRef.resourceName`) downloaded with `api.downloadMedia`, bounded by
 *   `ATTACHMENT_LIMITS` (how many per message, bytes each, bytes in all). Each download asks for no
 *   more than what is left of every bound that applies to it, so nothing past a bound is read.
 * - Images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) become `InboundMessage.images`
 *   (base64 `AgentImage`s), within `imageBytes` in all (1 MB: Cloudflare's bound on
 *   `AgentRequest.images`, the same on both targets).
 * - Text files (`text/*`, JSON, CSV) are appended to the message's text, each under its file name in a
 *   fence, within `textChars` in all (cut past it, and said).
 * - Any other file is kept (`files`) to be written to the conversation's workspace (`writeFiles`, in
 *   `beforeDispatch` once the conversation is known): `attachments/<message id>/<file name>`, the
 *   message's own id (the last part of its name) and a safe file name, so a message Google delivers
 *   again writes the same files. The text names its path. With neither `workspace` nor `execution`
 *   (`canWrite` false), or past a bound, it is named as not read, with why, and not downloaded.
 * - A Drive file (`driveDataRef`) is named as not read: "attach the file itself".
 *
 * Nothing here sends to the space; a download that fails is named as not read (logged), never a
 * reason to refuse the message. A failure to write a file is (`writeFiles` rejects): Google delivers
 * the message again.
 */

import type { AppContext } from "@pikit/core";
import type { AgentImage, ConversationRef } from "@pikit/contracts";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { toChord } from "@pikit/pi-adapter";
import type { ChatAttachment, ChatMessage } from "./event.ts";
import { type AdmissionDeps, type ChatApi, ChatApiError } from "./types.ts";

/** The bounds of what one message brings in: values. */
export const ATTACHMENT_LIMITS = {
  perMessage: 10,
  bytesEach: 10 * 1024 * 1024,
  bytesTotal: 25 * 1024 * 1024,
  imageBytes: 1024 * 1024,
  textChars: 50_000,
} as const;

export type AttachmentLimits = { [K in keyof typeof ATTACHMENT_LIMITS]: number };

/** Where a message's other files go in the workspace: `attachments/<message id>/`. */
export const ATTACHMENTS_DIR = "attachments";

/** A file to write to the workspace before dispatch. */
export interface PendingFile {
  /** `attachments/<message id>/<file name>`. */
  path: string;
  bytes: Uint8Array;
  contentType: string | undefined;
}

/** What a message's attachments give. */
export interface ReadAttachments {
  images: AgentImage[];
  /** Appended to the message's text: text files, and a line per file named (written, or not read and why). Empty when there is none. */
  text: string;
  /** Written by `writeFiles` once the conversation is known. */
  files: PendingFile[];
}

export interface ReadOptions {
  api: ChatApi;
  /** A workspace or `execution` is installed: other files are written there. */
  canWrite: boolean;
  /** The bounds; `ATTACHMENT_LIMITS` by default. */
  limits?: AttachmentLimits;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** `contentType` without its parameters, lowercase. */
const baseType = (contentType: string | undefined): string => (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
const isImage = (type: string): boolean => IMAGE_TYPES.has(type);
const isText = (type: string): boolean => type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/csv";

/** `bytes` in words: `512 bytes`, `12 KB`, `3.4 MB`. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * `name` as one safe path segment: letters, digits, `.`, `-`, `_` and spaces kept, anything else `_`,
 * no leading dot, at most 100 characters (its extension kept); `fallback` when nothing is left.
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

/** The message's own id, a path segment: the last part of its name (`spaces/AAA/messages/<id>`). */
export function messageIdOf(message: ChatMessage): string {
  return safeName(message.name?.split("/").at(-1), "message");
}

/** `bytes` as base64, without `Buffer` (a Worker may not have it). */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** A fence that `text` cannot close: one backtick more than its longest run, at least three. */
const fenceFor = (text: string): string => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

/** Why a download failed, in words. */
function downloadProblem(error: unknown): string {
  if (error instanceof ChatApiError && error.status === 413) return "too large";
  if (error instanceof ChatApiError && error.status === 0) return "it could not be downloaded in time";
  if (error instanceof ChatApiError && (error.status === 403 || error.status === 404)) return "the app may not download it";
  return "it could not be downloaded";
}

/** `message`'s attachments, downloaded and sorted (above). */
export async function readAttachments(message: ChatMessage, options: ReadOptions, ctx: AppContext, signal: AbortSignal): Promise<ReadAttachments> {
  const limits = options.limits ?? ATTACHMENT_LIMITS;
  const attachments = message.attachment ?? [];
  const images: AgentImage[] = [];
  const files: PendingFile[] = [];
  const lines: string[] = [];
  const texts: string[] = [];
  const directory = `${ATTACHMENTS_DIR}/${messageIdOf(message)}`;
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

  for (const [index, attachment] of attachments.entries()) {
    const name = attachment.contentName?.trim() || `file ${index + 1}`;
    if (index >= limits.perMessage) {
      notRead(name, `only the first ${limits.perMessage} files of a message are read`);
      continue;
    }
    if (isDrive(attachment)) {
      notRead(name, "a Google Drive file, which the app cannot open: attach the file itself");
      continue;
    }
    const resource = attachment.attachmentDataRef?.resourceName;
    if (resource === undefined || resource === "") {
      notRead(name, "Google gave nothing to download");
      continue;
    }
    const declared = baseType(attachment.contentType);
    if (!isImage(declared) && !isText(declared) && !options.canWrite) {
      notRead(name, "no workspace is installed to keep files in");
      continue;
    }
    if (isText(declared) && textCharsUsed >= limits.textChars) {
      notRead(name, `past the ${limits.textChars} characters of text files a message may bring`);
      continue;
    }
    const left = limits.bytesTotal - bytesUsed;
    const imageLeft = limits.imageBytes - imageBytesUsed;
    const most = Math.min(limits.bytesEach, left, isImage(declared) ? imageLeft : Number.POSITIVE_INFINITY);
    if (most <= 0) {
      notRead(name, isImage(declared) && imageLeft <= 0 ? `past the ${sizeOf(limits.imageBytes)} of images a message may bring` : `past the ${sizeOf(limits.bytesTotal)} a message may bring`);
      continue;
    }

    let downloaded: { bytes: Uint8Array; contentType: string | undefined };
    try {
      downloaded = await options.api.downloadMedia(resource, most, signal);
    } catch (error) {
      const problem = downloadProblem(error);
      if (problem === "too large") {
        notRead(
          name,
          most === limits.bytesEach
            ? `larger than the ${sizeOf(limits.bytesEach)} a file may be`
            : isImage(declared) && most === imageLeft
              ? `past the ${sizeOf(limits.imageBytes)} of images a message may bring`
              : `past what is left of the ${sizeOf(limits.bytesTotal)} a message may bring`,
        );
      } else {
        ctx.logger.warn("channel-google-chat: a message's file could not be downloaded; it is named as not read", { message: message.name, attachment: attachment.name, error: error instanceof Error ? error.message : String(error) });
        notRead(name, problem);
      }
      continue;
    }
    const { bytes } = downloaded;
    // The bytes' own type when Google says one, else the attachment's.
    const actual = baseType(downloaded.contentType);
    const type = actual !== "" && actual !== "application/octet-stream" ? actual : declared;
    bytesUsed += bytes.byteLength;

    if (isImage(type)) {
      if (imageBytesUsed + bytes.byteLength > limits.imageBytes) {
        notRead(name, `past the ${sizeOf(limits.imageBytes)} of images a message may bring`);
        continue;
      }
      imageBytesUsed += bytes.byteLength;
      images.push({ mimeType: type, data: base64Of(bytes) });
      lines.push(`- ${name}: an image, shown to you`);
    } else if (isText(type)) {
      const content = new TextDecoder().decode(bytes);
      const room = limits.textChars - textCharsUsed;
      if (room <= 0) {
        notRead(name, `past the ${limits.textChars} characters of text files a message may bring`);
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
      notRead(name, "no workspace is installed to keep files in");
    }
  }

  if (lines.length === 0) return { images, files, text: "" };
  return { images, files, text: [`Files attached to this message:\n${lines.join("\n")}`, ...texts].join("\n\n") };
}

const isDrive = (attachment: ChatAttachment): boolean => attachment.driveDataRef !== undefined || attachment.source === "DRIVE_FILE";

/**
 * Writes `files` to `conversation`'s workspace (`deps.workspace.resolve(conversation)`'s env, else
 * `deps.execution`), each under its path. Rejects when one cannot be written (or there is nowhere to
 * write it): the message is then not dispatched, and Google delivers it again.
 */
export async function writeFiles(files: readonly PendingFile[], conversation: ConversationRef, deps: Pick<AdmissionDeps, "workspace" | "execution">, ctx: AppContext): Promise<void> {
  if (files.length === 0) return;
  const env: ExecutionEnv | undefined = deps.workspace !== undefined ? (await deps.workspace.resolve(conversation, ctx)).env : deps.execution;
  if (env === undefined) throw new Error("channel-google-chat: a message's files have nowhere to be written (neither workspace nor execution is installed)");
  const chord = toChord(ctx);
  for (const file of files) {
    const directory = file.path.slice(0, file.path.lastIndexOf("/"));
    const made = await env.createDir(directory, { recursive: true }, chord);
    if (!made.ok) throw new Error(`channel-google-chat: the directory ${directory} could not be made in the workspace: ${made.error.message}`, { cause: made.error });
    const written = await env.writeFile(file.path, file.bytes, chord);
    if (!written.ok) throw new Error(`channel-google-chat: ${file.path} could not be written to the workspace: ${written.error.message}`, { cause: written.error });
  }
  ctx.logger.info("channel-google-chat: a message's files written to its conversation's workspace", { conversation: conversation.key, files: files.length });
}
