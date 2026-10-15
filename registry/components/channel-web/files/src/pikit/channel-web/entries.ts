/**
 * A conversation's transcript entries (`ChatTranscriptEntry`, api.ts), made in one place for the
 * transcript route and the live view, so that one entry has one id and one form wherever it is read.
 *
 * - **A user's message**: its id is its request id; one pi-ai `user` message, its text then its images by
 *   URL (`imagePath`), never their bytes.
 * - **A run's message** (`runEntryId`): `<the run's request id>#<hash of the message>`. The run's request
 *   id is the one that started it (`AgentResult.requestId`, the first of its inputs live). The hash is of
 *   what makes the message itself (its role, its time, its tool call's id, its blocks' text and ids, by
 *   sorted keys), never of a representation: the live view hashes the message `message_end` announced,
 *   the store the same message in `AgentResult.messages` when the run settles, and both get one id. A
 *   view merging the transcript with the entries it heard live by id never shows one twice.
 * - **What a run wrote that users may see** (`runMessages`): every message but the runtime's user and
 *   system messages (the user's message as the agent read it, an operator's follow-up, a system prompt).
 */

import type { ChatTranscriptEntry } from "./api.ts";
import { imagePath } from "./chat.ts";

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {});

/** The messages of a run users may ever see: not the runtime's user messages, not a system prompt. */
export const runMessages = (messages: readonly unknown[]): unknown[] =>
  messages.filter((message) => {
    const role = fieldsOf(message).role;
    return role !== "user" && role !== "system" && role !== undefined;
  });

/** What makes a message itself, for its id: never its images' bytes or a field's order. */
function identityOf(message: unknown): unknown {
  const fields = fieldsOf(message);
  const content = Array.isArray(fields.content)
    ? fields.content.map((value) => {
        const block = fieldsOf(value);
        if (block.type === "text") return ["text", block.text];
        if (block.type === "thinking") return ["thinking", block.thinking];
        if (block.type === "toolCall") return ["toolCall", block.id, block.name];
        return [block.type];
      })
    : fields.content;
  return [fields.role, fields.timestamp ?? null, fields.toolCallId ?? null, content ?? null];
}

/** 53 bits of a string's hash (cyrb53), as 14 hex digits. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The id of a message a run wrote, the run named by the request that started it. */
export const runEntryId = (run: string, message: unknown): string => `${run}#${hash(JSON.stringify(identityOf(message)))}`;

/** A user's message as stored (`store.ts`): its images' types only. */
export type UserRow = { id: string; text: string; imageTypes?: string[]; at: number; state?: ChatTranscriptEntry["state"] };

/** A user's message as an entry of chat `chatId`. */
export function userEntryOf(chatId: string, row: UserRow): ChatTranscriptEntry {
  const content = [
    ...(row.text === "" ? [] : [{ type: "text", text: row.text }]),
    ...(row.imageTypes ?? []).map((mimeType, i) => ({ type: "image", url: imagePath(chatId, row.id, i), mimeType })),
  ];
  return { id: row.id, kind: "message", messages: [{ role: "user", content, timestamp: row.at }], ...(row.state !== undefined && { state: row.state }) };
}

/** An entry in a live event's form (pi-durable's `{ id, kind, model }`, as `message_end` carries it). */
export const liveEntryOf = (entry: ChatTranscriptEntry): { id: string; kind: string; model: unknown[] } => ({ id: entry.id, kind: entry.kind, model: entry.messages });
