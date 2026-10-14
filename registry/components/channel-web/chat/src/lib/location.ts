/**
 * Where the page is: a hash route under `/chat/` (`/chat/#/c/<id>`), because the accounts' links land
 * on one (`#/set-password?token=…`) and the server serves `index.html` for `/chat/` alone just as well.
 *
 * | Route | Screen |
 * |---|---|
 * | `#/` | a new conversation |
 * | `#/c/<chat id>` | a conversation |
 * | `#/chats` | the conversations |
 * | `#/account` | the account |
 * | `#/sign-in`, `#/sign-up`, `#/forgot` | signing in |
 * | `#/set-password?token=…[&invite=1]` | an invitation's or a reset's landing |
 * | `#/verify?email=…` | "confirm your email" |
 *
 * better-auth puts `?error=<code>` in the address's query (before the `#`) when a sign-in by a provider
 * or a link failed: `takeLandingError` reads it once and takes it out of the address.
 */

import { useSyncExternalStore } from "react";

export interface Route {
  /** `/c/abc`, never empty. */
  path: string;
  query: URLSearchParams;
}

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};

/** The current hash, `#/` when there is none. */
const hash = (): string => (window.location.hash.length > 1 ? window.location.hash : "#/");

export function parseRoute(value: string): Route {
  const raw = value.replace(/^#/, "");
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  return { path: path === "" ? "/" : path, query: new URLSearchParams(at === -1 ? "" : raw.slice(at + 1)) };
}

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, hash));
}

/** Goes to `path` (`/c/abc`, `/sign-in?x=1`); `replace` leaves no step in the history. */
export function go(path: string, replace = false): void {
  const target = `#${path}`;
  if (replace) {
    window.history.replaceState(window.history.state, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else window.location.hash = target;
}

/** A conversation's route. */
export const chatPath = (id: string): string => `/c/${encodeURIComponent(id)}`;

/** The chat id of a conversation's route; `undefined` for any other. */
export function chatIdOf(path: string): string | undefined {
  const match = /^\/c\/([^/]+)$/.exec(path);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return undefined;
  }
}

/** The `?error=` better-auth left in the address (its query, else the hash's), taken out of it; read once. */
export function takeLandingError(): { code: string; description?: string } | undefined {
  const url = new URL(window.location.href);
  const route = parseRoute(url.hash);
  const code = url.searchParams.get("error") ?? route.query.get("error");
  if (code === null || code === "") return undefined;
  const description = url.searchParams.get("error_description") ?? route.query.get("error_description") ?? undefined;
  for (const name of ["error", "error_description"]) {
    url.searchParams.delete(name);
    route.query.delete(name);
  }
  const query = route.query.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}#${route.path}${query === "" ? "" : `?${query}`}`);
  return { code, ...(description !== undefined && description !== "" && { description }) };
}
