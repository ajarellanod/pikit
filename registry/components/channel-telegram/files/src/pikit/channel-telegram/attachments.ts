/**
 * A message's files, read before admission: its document (a file sent as a file) and its photo. The
 * protocol is `@pikit/pi-adapter`'s (`collectAttachments`, `writeAttachments`): a photo, and an image
 * sent as a file, is shown to the model (`InboundMessage.images`, 1 MB in all, Cloudflare's bound on
 * `AgentRequest.images`, the same on both targets); a text file is put in the message's text; any
 * other file is written to the conversation's workspace, `attachments/<message id>/<safe file name>`
 * (a message Telegram delivers again writes the same file), and the text names its path. Without
 * `workspace` or `execution` it is named as not read. The caption is the message's text.
 *
 * Each file is downloaded through the Bot API (`getFile`, then its URL on the channel's `apiBase`),
 * bounded by `ATTACHMENT_LIMITS` (10 MB a file, under the Bot API's 20 MB; 25 MB a message). Of a
 * photo's sizes, the largest Telegram says fits the images' bound. A download that fails is named as
 * not read; a write that fails rejects, and the message is not dispatched.
 *
 * The same file in channel-telegram and channel-telegram-webhook (`twins.test.ts`): what differs is
 * passed in (`label`, the signal).
 */

import type { AppContext } from "@pikit/core";
import { type AttachmentSource, AttachmentTooLarge, type CollectedAttachments, collectAttachments, readBounded } from "@pikit/pi-adapter";
import { type TelegramApi, TelegramError, type TelegramMessage } from "./api.ts";

/** The bounds of what one message brings in. */
export const ATTACHMENT_LIMITS = {
  perMessage: 10,
  bytesEach: 10 * 1024 * 1024,
  bytesTotal: 25 * 1024 * 1024,
  imageBytes: 1024 * 1024,
  textChars: 50_000,
} as const;

/** What a message without files (or a command) brings. */
export const NO_FILES: CollectedAttachments = { images: [], text: "", files: [] };

/** Whether `message` brings a file or a photo. */
export const hasFiles = (message: TelegramMessage): boolean => message.document !== undefined || (message.photo?.length ?? 0) > 0;

/** A file of the message, downloaded through `api`: its declared size checked first, then its body bounded. */
function sourceOf(api: TelegramApi, name: string, contentType: string | undefined, fileId: string, size: number | undefined): AttachmentSource {
  return {
    name,
    contentType,
    async download(most, signal) {
      if (size !== undefined && size > most) throw new AttachmentTooLarge();
      try {
        return { bytes: await readBounded(await api.downloadFile(fileId, signal), most), contentType };
      } catch (error) {
        if (error instanceof AttachmentTooLarge || error instanceof TelegramError) throw error;
        // A body cut midway: its error may quote the URL, which holds the token.
        throw new TelegramError("file", 0, error instanceof Error ? error.name : "download failed");
      }
    },
  };
}

/** `message`'s files, downloaded and sorted (`collectAttachments`). */
export function readFiles(message: TelegramMessage, options: { api: TelegramApi; canWrite: boolean; label: string }, ctx: AppContext, signal: AbortSignal): Promise<CollectedAttachments> {
  const sources: AttachmentSource[] = [];
  const { document, photo } = message;
  if (document !== undefined) sources.push(sourceOf(options.api, document.file_name ?? "", document.mime_type, document.file_id, document.file_size));
  if (photo !== undefined && photo.length > 0) {
    const sizes = [...photo].sort((a, b) => a.width * a.height - b.width * b.height);
    const size = sizes.filter((each) => each.file_size !== undefined && each.file_size <= ATTACHMENT_LIMITS.imageBytes).at(-1) ?? (sizes[0] as (typeof sizes)[number]);
    sources.push(sourceOf(options.api, "photo.jpg", "image/jpeg", size.file_id, size.file_size));
  }
  return collectAttachments(sources, { messageId: String(message.message_id), limits: ATTACHMENT_LIMITS, canWrite: options.canWrite, label: options.label }, ctx, signal);
}
