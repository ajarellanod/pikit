/**
 * Where the accounts' links land on the chat page (`src/chat/`, a hash router under `/chat/`), and
 * better-auth's own routes they go through. The page builds these routes; nothing else names them.
 *
 * | Link | Lands on | What the page does |
 * |---|---|---|
 * | invitation (operator's, emailed or copied) | `/chat/#/set-password?token=…&invite=1` | asks a password (or offers the providers), `POST /chat/api/auth/reset-password` `{ token, newPassword }`, then signs in with it |
 * | password reset (operator's, or "forgot password") | `/chat/#/set-password?token=…` | the same, worded as a reset |
 * | a self-made account's confirmation (its email's verification) | `/chat/#/set-password?token=…&welcome=1` | the same, worded as the account's first password: setting it verifies the email (`onPasswordReset`) |
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

/** Why a link sets a password: the page words it so. */
export type SetPasswordKind = "invite" | "reset" | "welcome";

/** The link that sets a password with `token`, on `origin` (`https://bot.example.com`, no trailing `/`). */
export function setPasswordLink(origin: string, token: string, kind: SetPasswordKind): string {
  return `${origin.replace(/\/+$/, "")}${CHAT_LINKS.setPassword}?token=${encodeURIComponent(token)}${kind === "reset" ? "" : `&${kind}=1`}`;
}

/** Whether `url`'s host is this machine (`localhost`, `127.0.0.1`, `[::1]`, any port). */
export function isLoopback(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The origin a link (an email's, an OAuth redirect URI, an operator's invitation) is made under, for a
 * request to `url`: `publicUrl` (`PIKIT_PUBLIC_URL`) when set; else the request's own origin when its
 * host is trusted: on Cloudflare (`trustHost`) the Worker's, which Cloudflare routes by and a client
 * cannot make another's; on a server only a loopback host, since a client writes the `Host` header.
 * `undefined`: no link may be made for this request (`400`).
 */
export function linkOrigin(url: string, publicUrl: string | undefined, trustHost: boolean): string | undefined {
  if (publicUrl !== undefined) return publicUrl;
  return trustHost || isLoopback(url) ? new URL(url).origin : undefined;
}

/** What a request whose links would be made under an untrusted host is answered. */
export const PUBLIC_URL_REQUIRED = {
  error: "public_url_required",
  message: "This App serves the chat only at localhost until PIKIT_PUBLIC_URL names its public address.",
} as const;

/** `PIKIT_PUBLIC_URL`'s value as an origin (`https://bot.example.com`), or a start-up error naming it. */
export function publicUrlOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const url = URL.canParse(trimmed) ? new URL(trimmed) : undefined;
  if (url === undefined || !/^https?:$/.test(url.protocol) || url.pathname.replace(/\/+$/, "") !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("channel-web: PIKIT_PUBLIC_URL is an origin, http(s)://host[:port] with no path (https://chat.example.com)");
  }
  return url.origin;
}
