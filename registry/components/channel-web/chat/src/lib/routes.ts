/**
 * What a hash route says, apart from the browser (`location.ts` follows the address): its path and
 * query, which screen state it keys, and what a link that sets a password carries. Pure: no React, no
 * `window` (scripts/chat.test.ts checks it).
 */

export interface Route {
  /** `/c/abc`, never empty. */
  path: string;
  query: URLSearchParams;
}

/** `#/sign-in?x=1` (or without its `#`) as a route; `/` when it names no path. */
export function parseRoute(value: string): Route {
  const raw = value.replace(/^#/, "");
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  return { path: path === "" ? "/" : path, query: new URLSearchParams(at === -1 ? "" : raw.slice(at + 1)) };
}

/**
 * The key of a signed-out screen at `route`: another route is another screen, its state anew (a "Check
 * your email" shown at `#/` is gone at `#/sign-in`, though both show the sign-in).
 */
export function screenKey(route: Route): string {
  const query = route.query.toString();
  return query === "" ? route.path : `${route.path}?${query}`;
}

/**
 * The Settings section `#/settings/<id>` opens (`#/settings` alone: the first, `profile`); `undefined`
 * for any other route. Settings is a modal over the page, not a page: the route only opens it.
 */
export function settingsSectionOf(path: string): string | undefined {
  const match = /^\/settings(?:\/([a-z-]+))?\/?$/.exec(path);
  return match === null ? undefined : (match[1] ?? "profile");
}

/** The user's projects, as cards (`screens/projects.tsx`). */
export const PROJECTS_PATH = "/projects";

/** A project's page: its chats. */
export const projectPath = (id: string): string => `${PROJECTS_PATH}/${encodeURIComponent(id)}`;

/** The project a project's page (`/projects/<id>`) is about; `undefined` for any other path. */
export function projectIdOf(path: string): string | undefined {
  const match = /^\/projects\/([^/]+)\/?$/.exec(path);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return undefined;
  }
}

/** New chat, with an assistant chosen and in a project when given. */
export function newChatPath({ agent, project }: { agent?: string | undefined; project?: string | undefined } = {}): string {
  const params = new URLSearchParams();
  if (agent !== undefined) params.set("agent", agent);
  if (project !== undefined) params.set("project", project);
  const query = params.toString();
  return query === "" ? "/" : `/?${query}`;
}

/** What a link that sets a password carries (channel-web's `setPasswordLink`): its token, why, and whose account. */
export interface SetPasswordLink {
  token: string | null;
  kind: "invite" | "welcome" | "reset";
  /** The account's email, when the link names it: shown read-only, and signed in with right after. */
  email?: string;
}

export function setPasswordOf(query: URLSearchParams): SetPasswordLink {
  const email = query.get("email")?.trim() ?? "";
  const kind = query.get("invite") === "1" ? "invite" : query.get("welcome") === "1" ? "welcome" : "reset";
  return { token: query.get("token"), kind, ...(email !== "" && { email }) };
}
