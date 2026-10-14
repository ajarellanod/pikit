/**
 * Where the accounts' links land on the chat page (`src/chat/`, a hash router under `/chat/`), and
 * better-auth's own routes they go through. The page builds these routes; nothing else names them.
 *
 * | Link | Lands on | What the page does |
 * |---|---|---|
 * | invitation (operator's, emailed or copied) | `/chat/#/set-password?token=…&invite=1` | asks a password (or offers the providers), `POST /chat/api/auth/reset-password` `{ token, newPassword }`, then signs in with it |
 * | password reset (operator's, or "forgot password") | `/chat/#/set-password?token=…` | the same, worded as a reset |
 * | email verification (a self-made account) | `/chat/api/auth/verify-email?token=…&callbackURL=/chat/` | better-auth verifies, signs in and redirects to `/chat/` (`?error=…` when it fails) |
 * | magic link | `/chat/api/auth/magic-link/verify?token=…&callbackURL=…` | better-auth signs in and redirects to the page's `callbackURL` (`/chat/`); `errorCallbackURL` (`/chat/#/sign-in`) gets `?error=…` |
 * | OAuth / OIDC callback | `/chat/api/auth/callback/<provider>` | better-auth signs in and redirects to `callbackURL` (`/chat/`), or `errorCallbackURL` with `?error=<code>` (`SIGN_UP_NOT_ALLOWED`, `BANNED`, `account_not_linked`…) |
 *
 * better-auth adds `?error=` to the URL's query, before its `#`: the page reads `location.search`.
 * The page sends `callbackURL: CHAT_LINKS.home` and `errorCallbackURL: CHAT_LINKS.signIn` with
 * `POST /chat/api/auth/sign-in/social` (`{ provider }`, a built-in or an OIDC id alike) and
 * `POST /chat/api/auth/sign-in/magic-link` (`{ email }`).
 */

export const CHAT_LINKS = {
  /** The page, and where a sign-in lands. */
  home: "/chat/",
  /** The sign-in view: where a failed OAuth or magic link sign-in lands, with `?error=<code>`. */
  signIn: "/chat/#/sign-in",
  /** Sets a password with a `token` (`?token=…`, and `&invite=1` for an invitation). */
  setPassword: "/chat/#/set-password",
} as const;

/** better-auth's routes, under `/chat/api/auth`. */
export const AUTH_BASE_PATH = "/chat/api/auth";

/** The link that sets a password with `token`, on `origin` (`https://bot.example.com`, no trailing `/`). */
export function setPasswordLink(origin: string, token: string, invite: boolean): string {
  return `${origin.replace(/\/+$/, "")}${CHAT_LINKS.setPassword}?token=${encodeURIComponent(token)}${invite ? "&invite=1" : ""}`;
}
