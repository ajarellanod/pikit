// Owner: admission. A message's files, read before admission (features/channel-google-chat.md "Attachments in").
/**
 * - Chat media (`attachmentDataRef.resourceName`) downloaded with `api.downloadMedia`, bounded by
 *   `ATTACHMENT_LIMITS` (how many per message, bytes each, bytes in all).
 * - Images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) become `InboundMessage.images`
 *   (base64 `AgentImage`s), within `imageBytes` in all (1 MB: Cloudflare's bound on
 *   `AgentRequest.images`, the same on both targets).
 * - Text files (`text/*`, JSON, CSV) are appended to the message's text, bounded (`textChars`), each
 *   under its file name.
 * - Any other file is kept (`files`) to be written to the conversation's workspace (`writeFiles`,
 *   in `beforeDispatch`): `attachments/<message id>/<file name>` (a safe name), named in the text by its
 *   path. With neither `workspace` nor `execution`, or past a bound, it is named as not read, with why.
 * - A Drive file (`driveDataRef`) is named as not read: "attach the file itself".
 *
 * Nothing here sends to the space; a download that fails is named as not read (logged), never a
 * reason to refuse the message.
 */

import type { AppContext } from "@pikit/core";
import type { AgentImage, ConversationRef } from "@pikit/contracts";
import type { ChatMessage } from "./event.ts";
import type { AdmissionDeps, ChatApi } from "./types.ts";

/** The bounds of what one message brings in: values. */
export const ATTACHMENT_LIMITS = {
  perMessage: 10,
  bytesEach: 10 * 1024 * 1024,
  bytesTotal: 25 * 1024 * 1024,
  imageBytes: 1024 * 1024,
  textChars: 50_000,
} as const;

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
  /** Appended to the message's text: text files, and a line per file named (written, or not read and why). */
  text: string;
  /** Written by `writeFiles` once the conversation is known. */
  files: PendingFile[];
}

/** `message`'s attachments, downloaded and sorted (above). */
export async function readAttachments(message: ChatMessage, api: ChatApi, signal: AbortSignal): Promise<ReadAttachments> {
  void message;
  void api;
  void signal;
  throw new Error("not implemented: admission (attachments.ts readAttachments)");
}

/**
 * Writes `files` to `conversation`'s workspace (`deps.workspace.resolve(conversation)`'s env, else
 * `deps.execution`), each under its path; resolves with the lines that name what was written and what
 * could not be (with why), for the message's text.
 */
export async function writeFiles(files: readonly PendingFile[], conversation: ConversationRef, deps: Pick<AdmissionDeps, "workspace" | "execution">, ctx: AppContext): Promise<string[]> {
  void files;
  void conversation;
  void deps;
  void ctx;
  throw new Error("not implemented: admission (attachments.ts writeFiles)");
}
