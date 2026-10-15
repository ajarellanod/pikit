/**
 * The accounts: better-auth 1.7.7's own routes under `/chat/api/auth`, called with plain `fetch`
 * (`client.ts`), no client library: each is one JSON request, and the page needs a dozen of them.
 * Where its links land (channel-web's `accounts/links.ts`, `CHAT_LINKS`):
 *
 * - a sign-in by a provider or a magic link comes back to `/chat/` (`callbackURL`), or to the sign-in
 *   view with `?error=<code>` (`errorCallbackURL`), the code in the address's query, before its `#`;
 * - linking a provider comes back to Settings' connected accounts (`#/settings/accounts`), likewise;
 * - an invitation, a reset and a new account's confirmation land on `#/set-password?token=…&email=…`
 *   (`&invite=1` for an invitation, `&welcome=1` for a confirmation).
 */

import { post, request } from "./client.ts";

/** Where a sign-in lands, and where one that failed does (with `?error=`). */
export const HOME = "/chat/";
export const SIGN_IN = "/chat/#/sign-in";
export const CONNECTED_ACCOUNTS = "/chat/#/settings/accounts";
export const SET_PASSWORD = "/chat/#/set-password";

const auth = <T>(path: string, body?: unknown): Promise<T> => post<T>(`/auth${path}`, body);

/** Email and password. Throws `EMAIL_NOT_VERIFIED` (a new link is sent), `INVALID_EMAIL_OR_PASSWORD`, `BANNED`. */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  await auth("/sign-in/email", { email, password, callbackURL: HOME, rememberMe: true });
}

/**
 * A new account. With email (`ChatConfig.email`) no password is sent: the server gives it none anyone
 * knows, and the confirmation emailed sets the first (`verify`: no session yet). Without, `password` is it.
 */
export async function signUp(name: string, email: string, password?: string): Promise<{ verify: boolean }> {
  const made = await auth<{ token: string | null }>("/sign-up/email", { name, email, ...(password !== undefined && { password }), callbackURL: HOME });
  return { verify: made.token === null };
}

/** A link by email, which signs in (and makes the account, when one may). */
export async function sendMagicLink(email: string): Promise<void> {
  await auth("/sign-in/magic-link", { email, callbackURL: HOME, newUserCallbackURL: HOME, errorCallbackURL: SIGN_IN });
}

/** Leaves for `provider`'s sign-in (a built-in provider or an OIDC platform, by id); it comes back to `/chat/`. */
export async function signInWithProvider(provider: string): Promise<void> {
  const { url } = await auth<{ url?: string }>("/sign-in/social", { provider, callbackURL: HOME, newUserCallbackURL: HOME, errorCallbackURL: SIGN_IN, disableRedirect: true });
  if (url === undefined) throw new Error("The provider gave no address to sign in at.");
  window.location.assign(url);
}

/** Sends a link that sets a new password (said done whether or not the email has an account). */
export async function requestPasswordReset(email: string): Promise<void> {
  await auth("/request-password-reset", { email, redirectTo: SET_PASSWORD });
}

/** Sets the password of the invitation's or reset's `token`. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await auth("/reset-password", { token, newPassword });
}

/** Sends the account's confirmation (a link that sets its first password) again. */
export async function sendVerificationEmail(email: string): Promise<void> {
  await auth("/send-verification-email", { email, callbackURL: HOME });
}

export async function signOut(): Promise<void> {
  await auth("/sign-out");
}

export async function updateName(name: string): Promise<void> {
  await auth("/update-user", { name });
}

/** Changes the password; every other session ends. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await auth("/change-password", { currentPassword, newPassword, revokeOtherSessions: true });
}

/** One way this user signs in, as better-auth lists it: `credential` is the password. */
export interface LinkedAccount {
  /** better-auth's id of the link: what unlinking names. */
  id: string;
  providerId: string;
  createdAt: string;
}

export const listAccounts = (): Promise<LinkedAccount[]> => request<LinkedAccount[]>("GET", "/auth/list-accounts");

/** Leaves to link `provider` to this user; it comes back to Settings' connected accounts. */
export async function linkProvider(provider: string): Promise<void> {
  const { url } = await auth<{ url?: string }>("/link-social", { provider, callbackURL: CONNECTED_ACCOUNTS, errorCallbackURL: CONNECTED_ACCOUNTS, disableRedirect: true });
  if (url === undefined) throw new Error("The provider gave no address to link at.");
  window.location.assign(url);
}

export async function unlinkAccount(id: string): Promise<void> {
  await auth("/unlink-account", { accountId: id });
}

/** One of this user's sessions (a browser signed in). */
export interface Session {
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export const listSessions = (): Promise<Session[]> => request<Session[]>("GET", "/auth/list-sessions");
/** This browser's session. */
export const currentSession = (): Promise<{ session: { id: string } } | null> => request<{ session: { id: string } } | null>("GET", "/auth/get-session");

export async function revokeSession(token: string): Promise<void> {
  await auth("/revoke-session", { token });
}

export async function revokeOtherSessions(): Promise<void> {
  await auth("/revoke-other-sessions");
}

/** Every session ends, this one too. */
export async function revokeAllSessions(): Promise<void> {
  await auth("/revoke-sessions");
  await signOut().catch(() => undefined);
}
