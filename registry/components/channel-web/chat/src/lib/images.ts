/**
 * The images a message may carry (`chat-api.ts`: `IMAGE_TYPES`, `MAX_IMAGES` of `MAX_IMAGE_BYTES`, and
 * on Cloudflare `MAX_DURABLE_IMAGE_BYTES` in all), as the composer takes them and as a message is
 * checked before it is sent. The server checks them again. Pure (`scripts/chat.test.ts` reads it).
 */

import { type ChatImage, type ChatImageRef, IMAGE_TYPES, MAX_DURABLE_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TEXT } from "./chat-api.ts";

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

/** The bytes base64 `data` holds (standard, padded). */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const megabytes = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** Why a message of `text` and `images` cannot be sent to an App on `target`; `undefined` when it can. */
export function messageProblem(text: string, images: readonly ChatImage[], target: string): string | undefined {
  const limits = imageLimits(target);
  if (text.trim() === "" && images.length === 0) return "Write something, or add an image.";
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
  return undefined;
}

/** A stored message's images (`ChatMessage.images`, by URL) as a message takes them again: read with the session, base64. */
export async function imagesOf(refs: readonly ChatImageRef[]): Promise<ChatImage[]> {
  return Promise.all(
    refs.map(async (ref) => {
      const response = await fetch(ref.url, { credentials: "same-origin" });
      if (!response.ok) throw new Error("An image of that message could not be read again.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return { mimeType: ref.mimeType, data: btoa(binary) };
    }),
  );
}
