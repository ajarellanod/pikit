/**
 * email-resend: `email.send` (@pikit/contracts' email.ts) over Resend's API, `POST /emails`: one
 * email to one person, from the sender in `EMAIL_FROM`.
 *
 * - **Variables only**: `RESEND_API_KEY` (a secret) and `EMAIL_FROM` (`Assistant <bot@example.com>`,
 *   a sender on a domain verified in Resend), read through `secrets` at start. Without either, or
 *   with a sender that is not an address, the app does not start, naming the variable (never its
 *   value). The key is sent only to Resend, in `Authorization`, and is in no error.
 * - **What Resend answers is mapped to the contract's codes** (`resendErrorCode`): 400 and 422 are
 *   `invalid` (but a sender Resend refuses, `invalid_from_address`, is `rejected`: it is the
 *   operator's to fix), 401 and 403 `rejected` (a wrong key, an unverified domain), 408, 429 and 5xx
 *   `unavailable`, as is a network failure, a cancel or the timeout (`timeoutMs`, 10 s by default).
 *   What Resend says is cleaned by `emailErrorDetail` before it goes into a message: no subject, text
 *   or link.
 * - **Nothing is retried or stored here**: the caller decides.
 *
 * Targets: `server` and `durable`: it uses only `secrets` and `fetch`.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { EmailError, type EmailErrorCode, emailErrorDetail, type EmailMessage, emailMessageProblem, type EmailSender, isEmailFrom } from "@pikit/contracts";
import Type from "typebox";

/** The secret holding Resend's API key (resend.com/api-keys). */
export const KEY_SECRET = "RESEND_API_KEY";
/** The variable holding the sender: `bot@example.com` or `Assistant <bot@example.com>`. */
export const FROM_VARIABLE = "EMAIL_FROM";
/** Resend's endpoint for one email, under `apiBase`. */
export const SEND_PATH = "/emails";

const Config = Type.Object({
  /** Resend's API. A value, for a proxy or a test double. */
  apiBase: Type.String({ minLength: 1, default: "https://api.resend.com" }),
  /** How long Resend may take to answer, in milliseconds. */
  timeoutMs: Type.Integer({ minimum: 1, default: 10_000 }),
});

/** The contract's code for Resend's answer `status` with the error `name` it gave. */
export function resendErrorCode(status: number, name: string | undefined): EmailErrorCode {
  if (status === 408 || status === 429 || status >= 500) return "unavailable";
  if (name === "invalid_from_address") return "rejected";
  if (status === 400 || status === 422) return "invalid";
  return "rejected";
}

export default defineComponent({
  name: "email-resend",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const endpoint = `${config.apiBase.replace(/\/+$/, "")}${SEND_PATH}`;
    /** The key and the sender, from start to stop. */
    let account: { key: string; from: string } | undefined;

    const sender: EmailSender = {
      async send(message, ctx) {
        const problem = emailMessageProblem(message);
        if (problem !== undefined) throw new EmailError("invalid", `email-resend: ${problem}`);
        if (account === undefined) throw new EmailError("unavailable", "email-resend: not started");
        const body = { from: account.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html !== undefined && { html: message.html }) };
        const response = await post(endpoint, account.key, JSON.stringify(body), config.timeoutMs, message, ctx);
        const answer = response.answer as { id?: unknown; name?: unknown; message?: unknown } | undefined;
        if (response.status >= 200 && response.status < 300) {
          if (typeof answer?.id !== "string" || answer.id === "") throw new EmailError("unavailable", `email-resend: Resend answered HTTP ${response.status} without an id; the email may have been sent`);
          return { id: answer.id };
        }
        const name = typeof answer?.name === "string" ? answer.name : undefined;
        const detail = typeof answer?.message === "string" ? emailErrorDetail(answer.message, message) : "";
        throw new EmailError(resendErrorCode(response.status, name), `email-resend: Resend refused the email (HTTP ${response.status}${name === undefined ? "" : ` ${name}`})${detail === "" ? "" : `: ${detail}`}`);
      },
    };
    pikit.provide("email.send", sender);

    return {
      async start() {
        const key = await secrets.get().get(KEY_SECRET);
        if (key === undefined) throw new Error(`email-resend: the secret ${KEY_SECRET} is not set`);
        const from = (await secrets.get().get(FROM_VARIABLE))?.trim();
        if (from === undefined || from === "") throw new Error(`email-resend: the variable ${FROM_VARIABLE} is not set`);
        if (!isEmailFrom(from)) throw new Error(`email-resend: the variable ${FROM_VARIABLE} is not a sender: write bot@example.com or Assistant <bot@example.com>`);
        account = { key, from };
      },
      stop() {
        account = undefined;
      },
    };
  },
});

/** POSTs `body` to Resend and reads its JSON answer (`undefined` when it is not JSON), bounded by `ctx` and `timeoutMs`; no answer is `unavailable`. */
async function post(url: string, key: string, body: string, timeoutMs: number, message: EmailMessage, ctx: AppContext): Promise<{ status: number; answer: unknown }> {
  const signal = ctx.abortSignal;
  if (signal?.aborted === true) throw new EmailError("unavailable", "email-resend: the send was cancelled before it started", { cause: signal.reason });
  // A timer cleared once the answer came, not `AbortSignal.timeout`: a pending timer keeps a Durable Object from being evicted.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "pikit-email-resend" },
      body,
      signal: signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]),
    });
    const text = await response.text();
    return { status: response.status, answer: parseJson(text) };
  } catch (error) {
    if (timeout.signal.aborted) throw new EmailError("unavailable", `email-resend: Resend did not answer within ${timeoutMs} ms; the email may have been sent`);
    // `signal.aborted` may have changed since the check above: `fetch` was waited for.
    if (signal?.aborted) throw new EmailError("unavailable", "email-resend: the send was cancelled; the email may have been sent", { cause: signal.reason });
    const reason = emailErrorDetail(error instanceof Error ? error.message : String(error), message).replaceAll(key, "[redacted]");
    throw new EmailError("unavailable", `email-resend: Resend could not be reached${reason === "" ? "" : `: ${reason}`}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
