/**
 * The admin API (admin-api, `/admin/api/*`), from the browser. Its JSON is typed in `admin-api.ts`, an
 * identical copy of admin-api's own `api.ts` (`src/pikit/admin-api/api.ts`): change both together.
 *
 * The operator's token is kept in this browser's localStorage and sent as a bearer token with every
 * call. A browser's `EventSource` cannot send it, so live events are read with `fetch`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, ApiEvent } from "./admin-api.ts";

export type * from "./admin-api.ts";

const TOKEN_KEY = "pikit.admin-token";
const API = "/admin/api";

export const token = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (value: string): void => localStorage.setItem(TOKEN_KEY, value),
  clear: (): void => localStorage.removeItem(TOKEN_KEY),
};

/** An answer that is not a success: its status and the API's error. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly body: ApiError;
  constructor(status: number, body: ApiError) {
    super(body.message ?? body.error);
    this.status = status;
    this.body = body;
  }
}

/** Listeners told when the API refuses the token (401): the app asks for it again. */
const unauthorized = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorized.add(listener);
  return () => unauthorized.delete(listener);
}

function headers(extra?: HeadersInit): Headers {
  const all = new Headers(extra);
  const value = token.get();
  if (value !== null) all.set("authorization", `Bearer ${value}`);
  return all;
}

async function failure(response: Response): Promise<ApiFailure> {
  if (response.status === 401) for (const listener of unauthorized) listener();
  const body = (await response.json().catch(() => ({ error: `http_${response.status}` }))) as ApiError;
  return new ApiFailure(response.status, body);
}

/** `GET` (or `init`'s method) of `path` under /admin/api, as JSON. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: headers(init.headers) });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

/** `POST` of `body` (JSON) to `path` under /admin/api. */
export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/**
 * Follows `path`'s server-sent events until `signal` aborts or the stream ends: each `data:` line is
 * one event. Resolves when the stream ends; rejects when it cannot start.
 */
export async function follow(path: string, onEvent: (event: ApiEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${API}${path}`, { headers: headers({ accept: "text/event-stream" }), signal });
  if (!response.ok || response.body === null) throw await failure(response);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data !== "" && !frame.startsWith("event: error")) onEvent(JSON.parse(data) as ApiEvent);
        end = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export interface Loaded<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload(): void;
}

/** `GET path`, again on `reload()`, and every `everyMs` when given. `null` loads nothing. */
export function useApi<T>(path: string | null, everyMs?: number): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(path !== null);
  const [round, setRound] = useState(0);
  const current = useRef(path);
  current.current = path;

  useEffect(() => {
    if (path === null) return;
    let live = true;
    setLoading(true);
    api<T>(path)
      .then((value) => live && current.current === path && (setData(value), setError(undefined)))
      .catch((thrown: unknown) => live && setError(thrown instanceof Error ? thrown : new Error(String(thrown))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, round]);

  useEffect(() => {
    if (path === null || everyMs === undefined) return;
    const timer = setInterval(() => setRound((n) => n + 1), everyMs);
    return () => clearInterval(timer);
  }, [path, everyMs]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { data, error, loading, reload };
}
