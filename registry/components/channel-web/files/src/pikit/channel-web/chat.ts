/**
 * The channel's names and checks, each in one place: the conversation key (`keyOf`), chat ids,
 * request ids, a message's images, titles.
 *
 * **Keys.** A user's conversation is `web:<user id>:<chat id>`, the chat id a UUID the server made
 * (`isChatId`: no `:` in it, so a key names one user and one chat). Every route builds the key from the
 * session's user and the path's chat id with `keyOf`, and nothing else: a user can name no other
 * user's conversation, whatever chat id they send.
 */

import { type ChatImage, CHAT_REQUEST_PREFIX, IMAGE_TYPES, MAX_DURABLE_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES, TITLE_MAX } from "./api.ts";

/** The channel's name: `InboundMessage.channel`, and the sender's `channel` (`{ channel: "web", id: <user id> }`). */
export const CHANNEL = "web";
/** Every conversation key of the channel starts with it. */
export const KEY_PREFIX = "web:";

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A request id the page may choose: `web:` then 1 to 118 of `A-Z a-z 0-9 . _ ~ : -`. */
export const REQUEST_ID = /^web:[A-Za-z0-9._~:-]{1,118}$/;

/** Whether `id` is a chat id the server makes: a lowercase UUID. */
export const isChatId = (id: string): boolean => CHAT_ID.test(id);

/** The conversation key of `userId`'s chat `chatId`: the only way the channel names one. Throws on a chat id that is not one. */
export function keyOf(userId: string, chatId: string): string {
  if (userId === "" || !isChatId(chatId)) throw new Error(`channel-web: no conversation key for user "${userId}" and chat "${chatId}"`);
  return `${KEY_PREFIX}${userId}:${chatId}`;
}

/** The user and chat of a key of this channel, or `undefined` for any other key. */
export function parseKey(key: string): { userId: string; chatId: string } | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const at = key.lastIndexOf(":");
  const userId = key.slice(KEY_PREFIX.length, at);
  const chatId = key.slice(at + 1);
  return at > KEY_PREFIX.length && isChatId(chatId) ? { userId, chatId } : undefined;
}

/** A new chat id. */
export const newChatId = (): string => crypto.randomUUID();

/**
 * The chat id of a new conversation whose first message the page named (`requestId`): the same for the
 * same user and request id, so a retry of `POST /chat/api/conversations` reaches the same conversation
 * and is a duplicate there, not a second conversation. A UUID (version 8) of SHA-256.
 */
export async function chatIdFor(userId: string, requestId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}\n${requestId}`))).slice(0, 16);
  digest[6] = ((digest[6] as number) & 0x0f) | 0x80;
  digest[8] = ((digest[8] as number) & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Where the bytes of image `index` of message `messageId` (a user's: its request id) of chat `chatId` are. */
export const imagePath = (chatId: string, messageId: string, index: number): string =>
  `/chat/api/conversations/${chatId}/messages/${encodeURIComponent(messageId)}/images/${index}`;

/** The request id of a user's message: the page's own (checked by the route), or a new one. */
export const requestIdOf = (given: string | undefined): string => given ?? `${CHAT_REQUEST_PREFIX}${crypto.randomUUID()}`;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/**
 * What is wrong with a message's images, or `undefined`: too many, not one of `IMAGE_TYPES`, or not
 * base64 (`400`); one larger than `MAX_IMAGE_BYTES`, or on `target` `durable` more than
 * `MAX_DURABLE_IMAGE_BYTES` in all (`413`: a Durable Object row holds 2 MB).
 */
export function imagesProblem(images: readonly ChatImage[], target: string): { status: 400 | 413; message: string } | undefined {
  if (images.length > MAX_IMAGES) return { status: 400, message: `at most ${MAX_IMAGES} images a message` };
  let total = 0;
  for (const [i, image] of images.entries()) {
    if (!IMAGE_TYPES.includes(image.mimeType)) return { status: 400, message: `image ${i + 1}: an image is ${IMAGE_TYPES.join(", ")}` };
    if (image.data.length % 4 !== 0 || !BASE64.test(image.data)) return { status: 400, message: `image ${i + 1}: its data is not base64` };
    const bytes = base64Bytes(image.data);
    if (bytes > MAX_IMAGE_BYTES) return { status: 413, message: `image ${i + 1}: an image is at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
    total += bytes;
  }
  if (target === "durable" && total > MAX_DURABLE_IMAGE_BYTES) return { status: 413, message: `here the images of a message are at most ${MAX_DURABLE_IMAGE_BYTES / 1024 / 1024} MB in all` };
  return undefined;
}

const ELLIPSIS = String.fromCharCode(0x2026);

const chars = (...codes: number[]): string => String.fromCharCode(...codes);
/** Typographic quotes and brackets a title may be wrapped in: single and double curly quotes, guillemets, CJK corner brackets. */
const QUOTES = chars(0x2018, 0x2019, 0x201c, 0x201d, 0xab, 0xbb, 0x300c, 0x300d);
/** Labels a model may put before a title ("Title: ", "Titre - "), in a few languages: taken off. */
const TITLE_LABEL = new RegExp(`^(?:title|name|subject|topic|t${chars(0xed)}tulo|titulo|titre|titel|titolo|nombre|nom)(?:\\s*:\\s*|\\s+[-${chars(0x2013, 0x2014)}]\\s+)`, "i");
/** Quotes and markdown a title is wrapped in. */
const TITLE_WRAP = new RegExp(`^[\\s"'\`*_#>${QUOTES}-]+|[\\s"'\`*_${QUOTES}]+$`, "g");
/** What a title never ends with. */
const TRAILING = /[.,;:\s]+$/u;

/**
 * A conversation's title from a text (its first message, or a model's answer): its first line with
 * words, without a label ("Title:"), quotes or markdown around it, spaces collapsed, no `.`, `,`, `;` or
 * `:` at its end, its first letter a capital, at most `TITLE_MAX` characters (cut at a word, with an
 * ellipsis); `undefined` when nothing is left. The rules of admin-api's titles, so the dashboard, which
 * cleans what `/name` gives it the same way, lists a conversation by the same title as the chat.
 */
export function cleanTitle(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((each) => each.replace(TITLE_WRAP, "").replace(TITLE_LABEL, "").replace(TITLE_WRAP, "").replace(/\s+/g, " ").trim())
    .find((each) => /[\p{L}\p{N}]/u.test(each));
  if (line === undefined) return undefined;
  let title = line.replace(TRAILING, "");
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX - 1);
    const space = cut.lastIndexOf(" ");
    title = `${(space >= TITLE_MAX / 3 ? cut.slice(0, space) : cut).replace(TRAILING, "")}${ELLIPSIS}`;
  }
  return title === "" ? undefined : title.charAt(0).toLocaleUpperCase() + title.slice(1);
}

/** The title of a conversation started with `text`: the text's, else what it holds. */
export const firstTitle = (text: string, images: number): string => cleanTitle(text) ?? (images > 0 ? "Image" : "New conversation");
