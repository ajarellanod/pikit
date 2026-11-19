/**
 * The channel's names and checks, each in one place: the conversation key (`keyOf`), chat ids,
 * request ids, a message's images and files. Titles are `conversations.directory`'s (one everywhere).
 *
 * **Keys.** A user's conversation is `web:<user id>:<chat id>`, the chat id a UUID the server made
 * (`isChatId`: no `:` in it, so a key names one user and one chat). Every route builds the key from the
 * session's user and the path's chat id with `keyOf`, and nothing else: a user can name no other
 * user's conversation, whatever chat id they send.
 */

import {
  type ChatFile,
  type ChatImage,
  CHAT_REQUEST_PREFIX,
  IMAGE_TYPES,
  MAX_DURABLE_FILES_BYTES,
  MAX_DURABLE_IMAGE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FILES_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
} from "./api.ts";

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

/** A project's id: 32 lowercase hex digits, never a chat id's shape (a space is never parsed as a key). */
const PROJECT_ID = /^[0-9a-f]{32}$/;
export const isProjectId = (id: string): boolean => PROJECT_ID.test(id);
/** A new project id. */
export const newProjectId = (): string => crypto.randomUUID().replace(/-/g, "");

/**
 * The space (`ConversationRef.space`) of `userId`'s project `projectId`: what its conversations share
 * (memory, instructions, files). Opaque to everyone else; its project id is not a chat id, so
 * `parseKey` never takes it for a key. A conversation of no project is in its user's (`personalSpace`).
 */
export function projectSpace(userId: string, projectId: string): string {
  if (userId === "" || !isProjectId(projectId)) throw new Error(`channel-web: no space for user "${userId}" and project "${projectId}"`);
  return `${KEY_PREFIX}${userId}:project:${projectId}`;
}

/**
 * The space of `userId`'s chats made in no project: their personal memory and saved files, shared by all
 * of them and by no one else. Not a key (`parseKey` finds no chat id in it) nor a project's space
 * (`projectOfSpace` answers none).
 */
export function personalSpace(userId: string): string {
  if (userId === "") throw new Error("channel-web: no personal space for an empty user");
  return `${KEY_PREFIX}${userId}`;
}

/**
 * The project a conversation's space (`ConversationRef.space`, the directory's `space`) names, or `""`
 * (none): a project's space is `project:<id>` (the project store's), or `web:<user>:project:<id>` for a
 * project this channel kept itself before (`projectSpace`). Only what the page shows: who may see the
 * conversation is the directory's to say, never this.
 */
export function projectOfSpace(space: string | undefined): string {
  const match = space === undefined ? null : /^(?:project:|web:.+:project:)([0-9a-f]{32})$/s.exec(space);
  return match?.[1] ?? "";
}

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
export const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

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

/** The most a message's files may be in all on `target`: on `durable` they cross to the object in one call. */
export const filesBytesOf = (target: string): number => (target === "durable" ? MAX_DURABLE_FILES_BYTES : MAX_FILES_BYTES);

/**
 * What is wrong with a message's files, or `undefined`: too many, a name empty or longer than 255
 * characters, or data not base64 (`400`); one larger than `MAX_FILE_BYTES`, or more than
 * `filesBytesOf(target)` in all (`413`).
 */
export function filesProblem(files: readonly ChatFile[], target: string): { status: 400 | 413; message: string } | undefined {
  if (files.length > MAX_FILES) return { status: 400, message: `at most ${MAX_FILES} files a message` };
  let total = 0;
  for (const [i, file] of files.entries()) {
    if (file.name.trim() === "" || file.name.length > 255) return { status: 400, message: `file ${i + 1}: a name is 1 to 255 characters` };
    if (file.data.length % 4 !== 0 || !BASE64.test(file.data)) return { status: 400, message: `file ${i + 1}: its data is not base64` };
    const bytes = base64Bytes(file.data);
    if (bytes > MAX_FILE_BYTES) return { status: 413, message: `file ${i + 1}: a file is at most ${MAX_FILE_BYTES / 1024 / 1024} MB` };
    total += bytes;
  }
  const most = filesBytesOf(target);
  if (total > most) return { status: 413, message: `the files of a message are at most ${most / 1024 / 1024} MB in all here` };
  return undefined;
}
