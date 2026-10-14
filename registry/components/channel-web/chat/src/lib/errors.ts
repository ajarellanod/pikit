/**
 * What went wrong, said humanly. An answer that is not a success becomes a `ChatFailure` (`failureOf`):
 * its HTTP status, a code and a message for a person, which `ErrorNote` shows (`{ status, message }`).
 * The code is the chat API's (`ChatError.error`), better-auth's (`{ code }`), or `http_<status>`.
 *
 * Codes also come back in the page's address after a sign-in by a provider or a link
 * (`?error=SIGN_UP_NOT_ALLOWED`, `?error=account_not_linked`): `landingText` says those, a known
 * code's text or a generic one, never words from the address (anyone can make a link that carries
 * some). Pure (`scripts/chat.test.ts` reads it).
 */

export class ChatFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ChatFailure";
    this.status = status;
    this.code = code;
  }
}

/** A code in one spelling: `account not linked`, `account_not_linked` and `ACCOUNT-NOT-LINKED` alike. */
export const normalCode = (code: string): string => code.trim().toUpperCase().replace(/[\s-]+/g, "_");

const TEXTS: Record<string, string> = {
  // Who may have an account, and bans (channel-web's own).
  SIGN_UP_NOT_ALLOWED: "Accounts here are by invitation: ask whoever runs this assistant to invite you.",
  BANNED: "This account is suspended.",
  // Signing in.
  INVALID_EMAIL_OR_PASSWORD: "That email and password do not match an account.",
  INVALID_EMAIL: "That is not an email address.",
  INVALID_PASSWORD: "That is not your current password.",
  EMAIL_NOT_VERIFIED: "Confirm your email first: open the link we sent you, or ask for a new one.",
  USER_ALREADY_EXISTS: "There is already an account with that email: sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "There is already an account with that email: sign in instead.",
  PASSWORD_TOO_SHORT: "The password is too short: at least 8 characters.",
  PASSWORD_TOO_LONG: "The password is too long.",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "This account has no password: sign in another way, or set one with “Forgot password”.",
  // Links: invitations, resets, verification, magic links.
  INVALID_TOKEN: "This link is not valid any more: it was used, or it expired. Ask for a new one.",
  TOKEN_EXPIRED: "This link expired. Ask for a new one.",
  EXPIRED_TOKEN: "This link expired. Ask for a new one.",
  ATTEMPTS_EXCEEDED: "This link was tried too many times. Ask for a new one.",
  NEW_USER_SIGNUP_DISABLED: "Accounts here are by invitation: ask whoever runs this assistant to invite you.",
  USER_NOT_FOUND: "There is no account with that email.",
  FAILED_TO_CREATE_USER: "The account could not be made.",
  FAILED_TO_CREATE_SESSION: "You could not be signed in. Try again.",
  // Providers (OAuth, OIDC).
  ACCOUNT_NOT_LINKED: "That email already has an account here: sign in with it, then link this provider from your account page.",
  UNABLE_TO_LINK_ACCOUNT: "That account could not be linked: its email must be verified by the provider and match yours.",
  EMAIL_DOESNT_MATCH: "That account's email is not yours here.",
  SIGNUP_DISABLED: "Accounts here are by invitation: ask whoever runs this assistant to invite you.",
  UNABLE_TO_CREATE_USER: "The account could not be made.",
  UNABLE_TO_CREATE_SESSION: "You could not be signed in. Try again.",
  ACCESS_DENIED: "The sign-in was cancelled.",
  STATE_NOT_FOUND: "That sign-in took too long or was started elsewhere. Try again.",
  STATE_MISMATCH: "That sign-in took too long or was started elsewhere. Try again.",
  PLEASE_RESTART_THE_PROCESS: "That sign-in took too long or was started elsewhere. Try again.",
  INVALID_CALLBACK_REQUEST: "The provider's answer was not understood. Try again.",
  NO_CODE: "The provider's answer was not understood. Try again.",
  OAUTH_PROVIDER_NOT_FOUND: "That way of signing in is not set up here.",
  PROVIDER_NOT_FOUND: "That way of signing in is not set up here.",
  SOCIAL_ACCOUNT_ALREADY_LINKED: "That account is already linked to another user here.",
  LINKED_ACCOUNT_ALREADY_EXISTS: "That account is already linked.",
  // The account page.
  FAILED_TO_UNLINK_LAST_ACCOUNT: "That is your only way to sign in: link another first.",
  ACCOUNT_NOT_FOUND: "That account is not linked any more.",
  SESSION_NOT_FRESH: "For that, sign in again first.",
  SESSION_EXPIRED: "For that, sign in again first.",
  // The chat API.
  UNAUTHORIZED: "Your session ended: sign in again.",
  RATE_LIMITED: "You are sending messages too fast: wait a moment, then send again.",
  PUBLIC_URL_REQUIRED: "Signing in is not set up for this address yet: ask whoever runs this assistant.",
  NOT_FOUND: "This conversation is not here: it was deleted, or the link is not yours.",
  TOO_LARGE: "That message is too large.",
  NO_ROUTE: "This assistant cannot take messages right now.",
  UNAVAILABLE: "The assistant did not answer in time. Try again in a moment.",
  INTERNAL_SERVER_ERROR: "Something failed on the server. Try again.",
};

/** The chat API's codes whose own message says why better than a fixed text. */
const SAYS_WHY = new Set(["DENIED", "REJECTED", "INVALID_REQUEST"]);

/** A person's text for `code`, else `fallback`. */
export function errorText(code: string, fallback?: string): string {
  const key = normalCode(code);
  if (SAYS_WHY.has(key) && fallback !== undefined && fallback !== "") return fallback;
  return TEXTS[key] ?? (fallback !== undefined && fallback !== "" ? fallback : `That did not work (${code}).`);
}

/** What a failed sign-in by a provider or a link left in the address (`?error=<code>`), said: a known code's text, else a generic one. */
export function landingText(code: string): string {
  return TEXTS[normalCode(code)] ?? "That sign-in did not work. Try again, or sign in another way.";
}

/** The failure of an answer with `status` and the JSON `body` it had (or `undefined`). */
export function failureOf(status: number, body: unknown): ChatFailure {
  const fields = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; code?: unknown; message?: unknown };
  const code = typeof fields.error === "string" ? fields.error : typeof fields.code === "string" && fields.code !== "" ? fields.code : `http_${status}`;
  const message = typeof fields.message === "string" ? fields.message : undefined;
  if (status === 429) return new ChatFailure(status, code, "Too many tries: wait a minute, then try again.");
  if (code.startsWith("http_") && message === undefined) {
    return new ChatFailure(status, code, status >= 500 ? "The service is not answering right now. Try again in a moment." : `That did not work (HTTP ${status}).`);
  }
  return new ChatFailure(status, code, errorText(code, message));
}

/** An error thrown by anything, as a `ChatFailure` or an `Error`. */
export const asError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));
