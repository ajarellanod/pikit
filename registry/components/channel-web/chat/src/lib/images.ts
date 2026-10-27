/**
 * The images a message may carry (`chat-api.ts`: `IMAGE_TYPES`, `MAX_IMAGES` of `MAX_IMAGE_BYTES`, and
 * on Cloudflare `MAX_DURABLE_IMAGE_BYTES` in all) and its other files (`MAX_FILES` of `MAX_FILE_BYTES`,
 * `MAX_FILES_BYTES` in all, on Cloudflare `MAX_DURABLE_FILES_BYTES`), as the composer takes them and as
 * a message is checked before it is sent. The server checks them again. Pure (`scripts/chat.test.ts` reads it).
 */

import {
  type ChatFile,
  type ChatImage,
  IMAGE_TYPES,
  MAX_DURABLE_FILES_BYTES,
  MAX_DURABLE_IMAGE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FILES_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TEXT,
} from "./chat-api.ts";

/** What the composer (`PromptBar`'s `images`) takes, for an App on `target` (`ChatConfig.target`). */
export interface ImageLimits {
  types: readonly string[];
  count: number;
  bytes: number;
  totalBytes?: number;
}

export function imageLimits(target: string): ImageLimits {
  return { types: IMAGE_TYPES, count: MAX_IMAGES, bytes: MAX_IMAGE_BYTES, ...(target === "durable" && { totalBytes: MAX_DURABLE_IMAGE_BYTES }) };
}

/** What the composer (`PromptBar`'s `files`) takes, for an App on `target` that keeps files (`ChatConfig.files`). */
export function fileLimits(target: string): { count: number; bytes: number; totalBytes: number } {
  return { count: MAX_FILES, bytes: MAX_FILE_BYTES, totalBytes: target === "durable" ? MAX_DURABLE_FILES_BYTES : MAX_FILES_BYTES };
}

/** The bytes base64 `data` holds (standard, padded). */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const megabytes = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** Why a message of `text`, `images` and `files` cannot be sent to an App on `target`; `undefined` when it can. */
export function messageProblem(text: string, images: readonly ChatImage[], target: string, files: readonly ChatFile[] = []): string | undefined {
  const limits = imageLimits(target);
  if (text.trim() === "" && images.length === 0 && files.length === 0) return "Write something, or add an image or a file.";
  if (text.length > MAX_TEXT) return `A message is at most ${MAX_TEXT.toLocaleString("en")} characters (this one has ${text.length.toLocaleString("en")}).`;
  if (images.length > limits.count) return `At most ${limits.count} images a message.`;
  let total = 0;
  for (const [i, image] of images.entries()) {
    if (!limits.types.includes(image.mimeType)) return `Image ${i + 1} is not a PNG, JPEG, WebP or GIF image.`;
    const bytes = base64Bytes(image.data);
    if (bytes > limits.bytes) return `Image ${i + 1} is larger than ${megabytes(limits.bytes)}.`;
    total += bytes;
  }
  if (limits.totalBytes !== undefined && total > limits.totalBytes) return `The images of a message are at most ${megabytes(limits.totalBytes)} in all here.`;
  const kept = fileLimits(target);
  if (files.length > kept.count) return `At most ${kept.count} files a message.`;
  let filesTotal = 0;
  for (const file of files) {
    const bytes = base64Bytes(file.data);
    if (bytes > kept.bytes) return `${file.name} is larger than ${megabytes(kept.bytes)}.`;
    filesTotal += bytes;
  }
  if (filesTotal > kept.totalBytes) return `The files of a message are at most ${megabytes(kept.totalBytes)} in all here.`;
  return undefined;
}
