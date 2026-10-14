/**
 * The messages this page sent that the conversation does not show yet: each is in the thread at once,
 * where it goes, `sending` until the API took it, then `sent` until the messages read have it (a user's
 * message is named by its request id), or `failed` with why, to send again with the same request id
 * (the server runs a request id once: sending one again never answers twice).
 */

import { useSyncExternalStore } from "react";
import { CHAT_REQUEST_PREFIX, type ChatImage, type ChatSendResponse } from "./chat-api.ts";
import { post } from "./client.ts";

export interface Outgoing {
  requestId: string;
  text: string;
  images: ChatImage[];
  /** Epoch ms it was sent. */
  at: number;
  status: "sending" | "sent" | "failed";
  /** Why it failed. */
  error?: string;
  /** It waits for the run going (`admission: "queued"`). */
  queued?: boolean;
}

const EMPTY: Outgoing[] = [];
const byChat = new Map<string, Outgoing[]>();
const listeners = new Set<() => void>();

function set(chatId: string, items: Outgoing[]): void {
  if (items.length === 0) byChat.delete(chatId);
  else byChat.set(chatId, items);
  for (const listener of listeners) listener();
}

function update(chatId: string, requestId: string, change: Partial<Outgoing>): void {
  set(
    chatId,
    (byChat.get(chatId) ?? []).map((each) => (each.requestId === requestId ? { ...each, ...change } : each)),
  );
}

/** A request id of this page's: `web:` and a UUID. */
export const newRequestId = (): string => `${CHAT_REQUEST_PREFIX}${crypto.randomUUID()}`;

/** Puts a message the API already took in `chatId`'s thread (a new conversation's first). */
export function addSent(chatId: string, message: Pick<Outgoing, "requestId" | "text" | "images">, queued = false): void {
  set(chatId, [...(byChat.get(chatId) ?? []), { ...message, at: Date.now(), status: "sent", queued }]);
}

/** Sends a message to `chatId` (again, with its `requestId`, when it failed). */
export async function sendTo(chatId: string, message: Pick<Outgoing, "text" | "images"> & { requestId?: string }): Promise<void> {
  const requestId = message.requestId ?? newRequestId();
  const known = (byChat.get(chatId) ?? []).some((each) => each.requestId === requestId);
  if (known) update(chatId, requestId, { status: "sending", error: undefined, at: Date.now() });
  else set(chatId, [...(byChat.get(chatId) ?? []), { requestId, text: message.text, images: message.images, at: Date.now(), status: "sending" }]);
  try {
    const sent = await post<ChatSendResponse>(`/conversations/${encodeURIComponent(chatId)}/messages`, {
      text: message.text,
      ...(message.images.length > 0 && { images: message.images }),
      requestId,
    });
    update(chatId, requestId, { status: "sent", queued: sent.admission === "queued" });
  } catch (thrown) {
    update(chatId, requestId, { status: "failed", error: thrown instanceof Error ? thrown.message : String(thrown) });
  }
}

/** Forgets the ones of `chatId` the messages read have (`ids`), or one given up on. */
export function settle(chatId: string, ids: ReadonlySet<string>): void {
  const items = byChat.get(chatId);
  if (items !== undefined && items.some((each) => ids.has(each.requestId))) set(chatId, items.filter((each) => !ids.has(each.requestId)));
}

export function discard(chatId: string, requestId: string): void {
  set(
    chatId,
    (byChat.get(chatId) ?? []).filter((each) => each.requestId !== requestId),
  );
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** `chatId`'s messages sent from here not shown by its messages yet, oldest first. */
export function useOutbox(chatId: string): Outgoing[] {
  return useSyncExternalStore(subscribe, () => byChat.get(chatId) ?? EMPTY);
}
