/**
 * A conversation as the chat API serves it (`/chat/api/conversations/:id/…`, `chat-api.ts`), for the
 * shared view (`components/pikit/conversation.tsx`, features/completed/chat-parity.md): its transcript (entries
 * newest first, paged), its live events (a `snapshot` first, read with `fetch`: `client.ts`'s `follow`),
 * a message (text and images, checked before it goes: `images.ts`) and a stop.
 *
 * Pure: the requests go through the `ChatClient` given (`client.ts`'s in the page), so
 * `scripts/chat.test.ts` checks the URLs and bodies without a browser. Relative imports only, for the
 * same reason: `ChatSource` is the view's `ConversationSource` as this module needs it (the page passes
 * it as one: TypeScript checks they agree).
 */

import type { ChatEvent, ChatPage, ChatSendRequest, ChatSendResponse, ChatTranscriptEntry } from "./chat-api.ts";
import { messageProblem } from "./images.ts";
import type { LiveEvent, TranscriptPage } from "./transcript.ts";

/** The shared view's `ConversationSource`, over the chat API. */
export interface ChatSource {
  readonly id: string;
  transcript(page: { limit: number; cursor?: string }): Promise<TranscriptPage>;
  follow(onEvent: (event: LiveEvent) => void, signal: AbortSignal): Promise<void>;
  /** The composer's message: its text and images (never a web search: the chat has none). */
  send(message: { text: string; images: readonly { mimeType: string; data: string }[] }): Promise<ChatSendResponse>;
  abort(): Promise<void>;
}

/** What a source asks of the chat API: `client.ts`'s `get`, `post` and `follow`, paths under `/chat/api`. */
export interface ChatClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  follow(path: string, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void>;
}

/** A conversation's path under `/chat/api`. */
export const conversationPath = (id: string): string => `/conversations/${encodeURIComponent(id)}`;

/** A page of its transcript: the latest without `cursor`. */
export const transcriptPath = (id: string, { limit, cursor }: { limit: number; cursor?: string | undefined }): string =>
  `${conversationPath(id)}/transcript?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;

/**
 * The conversations, a page: the archived ones with `archived`, those whose title holds `q` with one,
 * those of a project with `project` (its id, or `NO_PROJECT`: those of none).
 */
export function conversationsPath({
  limit,
  cursor,
  archived = false,
  q = "",
  project,
}: { limit: number; cursor?: string | undefined; archived?: boolean; q?: string; project?: string | undefined }): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) params.set("cursor", cursor);
  if (archived) params.set("archived", "1");
  if (q.trim() !== "") params.set("q", q.trim());
  if (project !== undefined) params.set("project", project);
  return `/conversations?${params}`;
}

/** Conversation `id` over `client`, for the shared view; `target` is `ChatConfig.target` (the image limits). */
export function chatSource(id: string, client: ChatClient, target: string): ChatSource {
  const path = conversationPath(id);
  return {
    id,
    transcript: (page) => client.get<ChatPage<ChatTranscriptEntry>>(transcriptPath(id, page)),
    follow: (onEvent, signal) => client.follow(`${path}/events`, onEvent, signal),
    send: async ({ text, images }) => {
      const sent = images.map(({ mimeType, data }) => ({ mimeType, data }));
      const problem = messageProblem(text, sent, target);
      if (problem !== undefined) throw new Error(problem);
      const body: ChatSendRequest = { text, ...(sent.length > 0 && { images: sent }) };
      return client.post<ChatSendResponse>(`${path}/messages`, body);
    },
    abort: async () => {
      await client.post(`${path}/abort`);
    },
  };
}
