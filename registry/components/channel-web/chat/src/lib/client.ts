/**
 * The chat API (`/chat/api`, `chat-api.ts`) from the browser: `fetch` with the session's cookies
 * (`pikit_chat`, path `/chat/`, HttpOnly: no script reads them), the header `x-pikit-chat: 1` on every
 * request that changes something (a page of another site cannot send it), and every failure a
 * `ChatFailure` (`errors.ts`). better-auth's routes (`/chat/api/auth/*`) go through it too (`auth.ts`).
 *
 * A `401` from the chat API (not from a sign-in that failed) tells `onUnauthorized`'s listeners: the
 * page asks to sign in again. Live events are read with `fetch` (`follow`), never `EventSource`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "./activity.ts";
import { CHAT_CLIENT_HEADER, type ChatEvent } from "./chat-api.ts";
import { ChatFailure, failureOf } from "./errors.ts";
import { readSse } from "./sse.ts";

export const API = "/chat/api";

const unauthorized = new Set<() => void>();
/** `listener` is told when the session ended (a `401` of the chat API). */
export function onUnauthorized(listener: () => void): () => void {
  unauthorized.add(listener);
  return () => unauthorized.delete(listener);
}

async function failure(path: string, response: Response): Promise<ChatFailure> {
  if (response.status === 401 && !path.startsWith("/auth/")) for (const listener of unauthorized) listener();
  return failureOf(response.status, await response.json().catch(() => undefined));
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API}${path}`, { credentials: "same-origin", ...init });
  } catch (thrown) {
    if (init.signal?.aborted === true) throw thrown;
    throw new Error("The service cannot be reached: check your connection, then try again.");
  }
}

/** `method` of `path` under `/chat/api`, with `body` as JSON; the JSON answered (`undefined` for a `204`). */
export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (method !== "GET" && method !== "HEAD") headers.set(CHAT_CLIENT_HEADER, "1");
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await send(path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }), ...(signal !== undefined && { signal }) });
  if (!response.ok) throw await failure(path, response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

export const get = <T>(path: string, signal?: AbortSignal): Promise<T> => request<T>("GET", path, undefined, signal);
export const post = <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body ?? {});

/**
 * Follows `path`'s server-sent events until `signal` aborts or the stream ends, each `data:` a
 * `ChatEvent`. Resolves when the stream ends (an `error` event ends it too); rejects when it cannot start.
 */
export async function follow(path: string, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await send(path, { headers: { accept: "text/event-stream" }, signal });
  if (!response.ok || response.body === null) throw await failure(path, response);
  try {
    await readSse(response.body, (data) => onEvent(data as ChatEvent));
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
}

export interface Loaded<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload(): void;
}

/** `GET path`, again on `reload()`, and every `everyMs` when given while the person is here (`activity.ts`). `null` loads nothing. */
export function useGet<T>(path: string | null, everyMs?: number): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(path !== null);
  const [round, setRound] = useState(0);
  const current = useRef(path);
  current.current = path;

  useEffect(() => {
    if (path === null) return;
    const stop = new AbortController();
    setLoading(true);
    get<T>(path, stop.signal)
      .then((value) => current.current === path && (setData(value), setError(undefined)))
      .catch((thrown: unknown) => !stop.signal.aborted && setError(thrown instanceof Error ? thrown : new Error(String(thrown))))
      .finally(() => !stop.signal.aborted && setLoading(false));
    return () => stop.abort();
  }, [path, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  usePolling(reload, path === null ? undefined : everyMs);
  return { data, error, loading, reload };
}
