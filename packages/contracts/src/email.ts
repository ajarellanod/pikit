/**
 * `email.send`: send one email. A component that must reach a person by email (channel-web's
 * accounts: a verification, a password reset, a sign-in link, an invitation) asks it, and never
 * knows how it leaves: Amazon SES (`email-ses`), Resend (`email-resend`), another HTTP API. A provider
 * needs variables only, no SMTP and no SDK: a `fetch` to its API, so both targets.
 *
 *   const email = pikit.useOptional("email.send");
 *   // when installed:
 *   const { id } = await email.get().send({ to: "ana@example.com", subject: "Your link", text, html }, ctx);
 *
 * What every provider guarantees:
 * - **One recipient per call**: `to` is one address (`ana@example.com`, no display name, no list).
 *   `subject` and `text` are not empty and the subject has no line break; `html` is the same message
 *   for the clients that show HTML. A message that breaks these is `invalid` and nothing is sent
 *   (`emailMessageProblem`, the one check every provider runs first).
 * - **The sender is the provider's**: its `EMAIL_FROM` variable (`Assistant <bot@example.com>`). A
 *   component never picks a sender address, so no consumer can send as anyone else.
 * - **It resolves once the provider accepted the email**, with the provider's id for it (to find it
 *   in the provider's console). Accepted is not delivered: a bounce comes later, and is the
 *   provider's.
 * - **Every rejection is an `EmailError`**, by `code`:
 *   - `invalid`: the address or the message (as above, or the provider says so). Never retry it.
 *   - `rejected`: the provider refused: an unverified sender, a suppressed address, a suspended
 *     account, its credentials. Retrying changes nothing until the operator fixes the provider.
 *   - `unavailable`: the network, a timeout, a cancelled `ctx`, 429, 5xx. Retry later. One that came
 *     after the request left may have been sent: a retry may send it twice.
 * - **No content in errors or logs**: an error's message, and anything the provider logs, never holds
 *   the email's subject, text or html, nor any link (a link is a sign-in): `emailErrorDetail` cleans
 *   what a provider's API says before it goes into a message. The recipient's address may appear.
 * - **`ctx` bounds it**: a cancelled `ctx` sends nothing, or stops waiting (`unavailable`); the
 *   provider has a timeout of its own (`unavailable` past it).
 * - **Nothing is retried by the provider**: the caller decides (a route's error, a queue). Nothing is
 *   stored.
 */

import type { AppContext } from "@pikit/core";

/** One email to one person. */
export interface EmailMessage {
  /** One address: `ana@example.com`. */
  to: string;
  /** One line, not empty. */
  subject: string;
  /** The plain-text body, not empty: what every client shows. */
  text: string;
  /** The same message as HTML, for the clients that show it. */
  html?: string;
}

/** What the provider says of an email it accepted. */
export interface EmailReceipt {
  /** The provider's id for it. */
  id: string;
}

/** Why `send` rejected: see the header. */
export type EmailErrorCode = "invalid" | "rejected" | "unavailable";

export class EmailError extends Error {
  readonly code: EmailErrorCode;
  constructor(code: EmailErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EmailError";
    this.code = code;
  }
}

/** The `email.send` capability. */
export interface EmailSender {
  /** Sends `message` from the provider's sender; its id once the provider accepted it. Rejects with `EmailError`. */
  send(message: EmailMessage, ctx: AppContext): Promise<EmailReceipt>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "email.send": EmailSender;
  }
}

/** An address's characters: no space, no list or display-name punctuation. */
const PART = String.raw`[^\s@<>()",;:\[\]\\]+`;
const ADDRESS = new RegExp(`^${PART}@${PART}\\.${PART}$`);
/** `Name <address>`: the name on one line, without angle brackets. */
const NAMED = /^([^<>\r\n]*)<([^<>]*)>$/;

/** Whether `value` is one email address, `ana@example.com`: no display name, no list. */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
}

/** Whether `value` is a sender, `bot@example.com` or `Assistant <bot@example.com>`: what `EMAIL_FROM` holds. */
export function isEmailFrom(value: string): boolean {
  const named = NAMED.exec(value.trim());
  return named === null ? isEmailAddress(value.trim()) : isEmailAddress((named[2] as string).trim());
}

/** What makes `message` `invalid` (the check every provider runs before sending), or `undefined`. Never quotes the message. */
export function emailMessageProblem(message: EmailMessage): string | undefined {
  const { to, subject, text, html } = (message ?? {}) as Partial<Record<keyof EmailMessage, unknown>>;
  if (!isEmailAddress(to)) return "the recipient is not one email address";
  if (typeof subject !== "string" || subject.trim() === "") return "the subject is empty";
  if (/[\r\n]/.test(subject)) return "the subject has a line break";
  if (typeof text !== "string" || text.trim() === "") return "the text is empty";
  if (html !== undefined && typeof html !== "string") return "the html is not a string";
  return undefined;
}

/** The longest detail `emailErrorDetail` keeps. */
const DETAIL_LIMIT = 300;

/**
 * What a provider's API said of a failure (`detail`), fit for an error's message about `message`:
 * without links, empty when it quotes the subject, the text or the html, and at most 300 characters.
 */
export function emailErrorDetail(detail: string, message: EmailMessage): string {
  const quoted = [message.subject, message.text, message.html].some((part) => typeof part === "string" && part.trim() !== "" && detail.includes(part.trim()));
  if (quoted) return "";
  const cleaned = detail
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > DETAIL_LIMIT ? `${cleaned.slice(0, DETAIL_LIMIT)}...` : cleaned;
}
