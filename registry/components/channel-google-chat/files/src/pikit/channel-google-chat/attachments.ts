// Owner: admission. A message's files, read before admission (features/channel-google-chat.md "Attachments in").
/**
 * The protocol is `@pikit/pi-adapter`'s (`collectAttachments`, `writeAttachments`: bounds, images to
 * the model, text files in the text, other files written to the conversation's workspace under
 * `attachments/<message id>/<safe file name>`, the text naming each path or why a file was not read).
 * This is Google Chat's part:
 *
 * - Chat media (`attachmentDataRef.resourceName`) downloaded with `api.downloadMedia`, bounded by
 *   `ATTACHMENT_LIMITS` (the policy: how many per message, bytes each, bytes in all, 1 MB of images,
 *   Cloudflare's bound on `AgentRequest.images`, the same on both targets; characters of text).
 * - The message's own id (the last part of its name) is its directory, so a message Google delivers
 *   again writes the same files.
 * - A Drive file (`driveDataRef`) is named as not read: "attach the file itself"; an attachment with
 *   nothing to download, too. A download's failure is said in Google's words (`downloadProblem`).
 *
 * Nothing here sends to the space; a download that fails is named as not read (logged), never a
 * reason to refuse the message. A failure to write a file is (`writeFiles` rejects): Google delivers
 * the message again.
 */

import type { AppContext } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import { type AttachmentSource, AttachmentTooLarge, type CollectedAttachments, collectAttachments, type PendingFile, writeAttachments } from "@pikit/pi-adapter";
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

/** What a message's attachments give (`collectAttachments`). */
export type ReadAttachments = CollectedAttachments;

export interface ReadOptions {
  api: ChatApi;
  /** A workspace or `execution` is installed: other files are written there. */
  canWrite: boolean;
  /** The bounds; `ATTACHMENT_LIMITS` by default. */
  limits?: AttachmentLimits;
}

/** Why a download failed, in words. */
function downloadProblem(error: unknown): string {
  if (error instanceof ChatApiError && error.status === 0) return "it could not be downloaded in time";
  if (error instanceof ChatApiError && (error.status === 403 || error.status === 404)) return "the app may not download it";
  return "it could not be downloaded";
}

const isDrive = (attachment: ChatAttachment): boolean => attachment.driveDataRef !== undefined || attachment.source === "DRIVE_FILE";

/** One attachment as the shared protocol takes it. */
function sourceOf(attachment: ChatAttachment, api: ChatApi): AttachmentSource {
  const resource = attachment.attachmentDataRef?.resourceName;
  const unreadable = isDrive(attachment) ? "a Google Drive file, which the app cannot open: attach the file itself" : resource === undefined || resource === "" ? "Google gave nothing to download" : undefined;
  return {
    name: attachment.contentName ?? "",
    contentType: attachment.contentType,
    ...(unreadable !== undefined && { unreadable }),
    download: (most, signal) =>
      api.downloadMedia(resource ?? "", most, signal).catch((error: unknown) => {
        throw error instanceof ChatApiError && error.status === 413 ? new AttachmentTooLarge(error.message) : error;
      }),
  };
}

/** `message`'s attachments, downloaded and sorted (`collectAttachments`). */
export function readAttachments(message: ChatMessage, options: ReadOptions, ctx: AppContext, signal: AbortSignal): Promise<ReadAttachments> {
  const sources = (message.attachment ?? []).map((attachment) => sourceOf(attachment, options.api));
  return collectAttachments(
    sources,
    { messageId: message.name?.split("/").at(-1) ?? "", limits: options.limits ?? ATTACHMENT_LIMITS, canWrite: options.canWrite, problemOf: downloadProblem, label: "channel-google-chat" },
    ctx,
    signal,
  );
}

/**
 * Writes `files` to `conversation`'s workspace (`deps.workspace`, else `deps.execution`). Rejects when
 * one cannot be written (or there is nowhere to write it): the message is then not dispatched, and
 * Google delivers it again.
 */
export function writeFiles(files: readonly PendingFile[], conversation: ConversationRef, deps: Pick<AdmissionDeps, "workspace" | "execution">, ctx: AppContext): Promise<void> {
  return writeAttachments(files, conversation, deps, ctx, "channel-google-chat");
}
