/**
 * email-ses: `email.send` (@pikit/contracts' email.ts) over Amazon SES v2's `SendEmail`
 * (`POST /v2/email/outbound-emails`): one email to one person, from the sender in `EMAIL_FROM`.
 *
 * - **Variables only**: `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, the
 *   optional `AWS_SES_SESSION_TOKEN` (temporary credentials) and `EMAIL_FROM` (`Assistant
 *   <bot@example.com>`, an identity verified in SES), read through `secrets` at start. Without one,
 *   with a region that is not one or a sender that is not an address, the app does not start, naming
 *   the variable (never its value).
 * - **No AWS SDK**: each request is signed with Signature Version 4 over Web Crypto (`sigv4.ts`,
 *   checked against AWS's test vectors), the service's signing name `ses`. The secret key never
 *   leaves memory; only the signature is sent.
 * - **What SES answers is mapped to the contract's codes** (`sesErrorCode`, by SES's error type, then
 *   by status): `MessageRejected`, `MailFromDomainNotVerified`, `AccountSuspended`, `SendingPaused` and
 *   the credentials' errors (403) are `rejected`; `BadRequest` and validation errors `invalid`;
 *   `TooManyRequests`, `LimitExceeded`, `Throttling`, 429 and 5xx `unavailable`, as is a network
 *   failure, a cancel or the timeout (`timeoutMs`, 10 s by default). What SES says is cleaned by
 *   `emailErrorDetail` before it goes into a message: no subject, text or link.
 * - **Nothing is retried or stored here**: the caller decides.
 *
 * Targets: `server` and `durable`: it uses only `secrets`, `fetch` and Web Crypto.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { EmailError, type EmailErrorCode, emailErrorDetail, type EmailMessage, emailMessageProblem, type EmailSender, isEmailFrom } from "@pikit/contracts";
import Type from "typebox";
import { type AwsCredentials, signAws4 } from "./sigv4.ts";

export { type AwsCredentials, type SignableRequest, signAws4 } from "./sigv4.ts";

export const REGION_VARIABLE = "AWS_SES_REGION";
export const ACCESS_KEY_SECRET = "AWS_SES_ACCESS_KEY_ID";
export const SECRET_KEY_SECRET = "AWS_SES_SECRET_ACCESS_KEY";
export const SESSION_TOKEN_SECRET = "AWS_SES_SESSION_TOKEN";
/** The variable holding the sender: `bot@example.com` or `Assistant <bot@example.com>`. */
export const FROM_VARIABLE = "EMAIL_FROM";
/** SES v2's `SendEmail`, under the endpoint. */
export const SEND_PATH = "/v2/email/outbound-emails";
/** SES's name in a signature's scope. */
const SERVICE = "ses";
/** An AWS region: `us-east-1`, `eu-west-2`, `us-gov-west-1`. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

const Config = Type.Object({
  /** SES's endpoint; absent, `https://email.<region>.amazonaws.com`. A value, for a VPC endpoint or a test double. */
  endpoint: Type.Optional(Type.String({ minLength: 1 })),
  /** How long SES may take to answer, in milliseconds. */
  timeoutMs: Type.Integer({ minimum: 1, default: 10_000 }),
});

const REJECTED = new Set([
  "MessageRejected",
  "MailFromDomainNotVerified",
  "AccountSuspended",
  "SendingPaused",
  "NotFound",
  "AccessDenied",
  "UnrecognizedClient",
  "InvalidClientTokenId",
  "InvalidSignature",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
  "MissingAuthenticationToken",
  "ExpiredToken",
]);
const UNAVAILABLE = new Set(["TooManyRequests", "LimitExceeded", "Throttling", "ServiceUnavailable", "InternalFailure", "RequestTimeout"]);
const INVALID = new Set(["BadRequest", "Validation", "ValidationError", "Serialization", "InvalidParameterValue"]);

/** SES's error type as a bare name: `MessageRejected` from `MessageRejected:http://…` or `…#MessageRejectedException`. */
export function sesErrorType(raw: string | undefined): string | undefined {
  const name = raw
    ?.split(":")[0]
    ?.split("#")
    .pop()
    ?.trim()
    .replace(/Exception$/, "");
  return name === undefined || name === "" ? undefined : name;
}

/** The contract's code for SES's answer `status` with the error `type` it gave (`sesErrorType`). */
export function sesErrorCode(status: number, type: string | undefined): EmailErrorCode {
  if (type !== undefined) {
    if (REJECTED.has(type)) return "rejected";
    if (UNAVAILABLE.has(type)) return "unavailable";
    if (INVALID.has(type)) return "invalid";
  }
  if (status === 408 || status === 429 || status >= 500) return "unavailable";
  if (status === 400) return "invalid";
  return "rejected";
}

interface Account {
  endpoint: string;
  region: string;
  credentials: AwsCredentials;
  from: string;
}

export default defineComponent({
  name: "email-ses",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    /** Where and as whom it sends, from start to stop. */
    let account: Account | undefined;

    const sender: EmailSender = {
      async send(message, ctx) {
        const problem = emailMessageProblem(message);
        if (problem !== undefined) throw new EmailError("invalid", `email-ses: ${problem}`);
        if (account === undefined) throw new EmailError("unavailable", "email-ses: not started");
        const content = (data: string) => ({ Data: data, Charset: "UTF-8" });
        const body = JSON.stringify({
          FromEmailAddress: account.from,
          Destination: { ToAddresses: [message.to] },
          Content: { Simple: { Subject: content(message.subject), Body: { Text: content(message.text), ...(message.html !== undefined && { Html: content(message.html) }) } } },
        });
        const response = await post(account, body, config.timeoutMs, message, ctx);
        const answer = response.answer as { MessageId?: unknown; message?: unknown; Message?: unknown; __type?: unknown; code?: unknown } | undefined;
        if (response.status >= 200 && response.status < 300) {
          if (typeof answer?.MessageId !== "string" || answer.MessageId === "") throw new EmailError("unavailable", `email-ses: SES answered HTTP ${response.status} without a MessageId; the email may have been sent`);
          return { id: answer.MessageId };
        }
        const type = sesErrorType(response.type ?? (typeof answer?.__type === "string" ? answer.__type : typeof answer?.code === "string" ? answer.code : undefined));
        const said = typeof answer?.message === "string" ? answer.message : typeof answer?.Message === "string" ? answer.Message : "";
        const detail = emailErrorDetail(said, message);
        throw new EmailError(sesErrorCode(response.status, type), `email-ses: SES refused the email (HTTP ${response.status}${type === undefined ? "" : ` ${type}`})${detail === "" ? "" : `: ${detail}`}`);
      },
    };
    pikit.provide("email.send", sender);

    return {
      async start() {
        const read = async (name: string, kind: "secret" | "variable"): Promise<string> => {
          const value = (await secrets.get().get(name))?.trim();
          if (value === undefined || value === "") throw new Error(`email-ses: the ${kind} ${name} is not set`);
          return value;
        };
        const region = await read(REGION_VARIABLE, "variable");
        if (!REGION.test(region)) throw new Error(`email-ses: the variable ${REGION_VARIABLE} is not an AWS region (us-east-1, eu-west-1…)`);
        const accessKeyId = await read(ACCESS_KEY_SECRET, "secret");
        const secretAccessKey = await read(SECRET_KEY_SECRET, "secret");
        const sessionToken = (await secrets.get().get(SESSION_TOKEN_SECRET))?.trim();
        const from = await read(FROM_VARIABLE, "variable");
        if (!isEmailFrom(from)) throw new Error(`email-ses: the variable ${FROM_VARIABLE} is not a sender: write bot@example.com or Assistant <bot@example.com>`);
        account = {
          endpoint: `${(config.endpoint ?? `https://email.${region}.amazonaws.com`).replace(/\/+$/, "")}${SEND_PATH}`,
          region,
          credentials: { accessKeyId, secretAccessKey, ...(sessionToken !== undefined && sessionToken !== "" && { sessionToken }) },
          from,
        };
      },
      stop() {
        account = undefined;
      },
    };
  },
});

/** Signs and POSTs `body` to SES and reads its answer, bounded by `ctx` and `timeoutMs`; no answer is `unavailable`. */
async function post(account: Account, body: string, timeoutMs: number, message: EmailMessage, ctx: AppContext): Promise<{ status: number; type: string | undefined; answer: unknown }> {
  const signal = ctx.abortSignal;
  if (signal?.aborted === true) throw new EmailError("unavailable", "email-ses: the send was cancelled before it started", { cause: signal.reason });
  const headers = await signAws4({
    method: "POST",
    url: account.endpoint,
    headers: { "content-type": "application/json" },
    body,
    region: account.region,
    service: SERVICE,
    credentials: account.credentials,
    date: new Date(ctx.clock.now()),
  });
  // A timer cleared once the answer came, not `AbortSignal.timeout`: a pending timer keeps a Durable Object from being evicted.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const response = await fetch(account.endpoint, { method: "POST", headers, body, signal: signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]) });
    const text = await response.text();
    return { status: response.status, type: response.headers.get("x-amzn-errortype") ?? undefined, answer: parseJson(text) };
  } catch (error) {
    if (timeout.signal.aborted) throw new EmailError("unavailable", `email-ses: SES did not answer within ${timeoutMs} ms; the email may have been sent`);
    // `signal.aborted` may have changed since the check above: `fetch` was waited for.
    if (signal?.aborted) throw new EmailError("unavailable", "email-ses: the send was cancelled; the email may have been sent", { cause: signal.reason });
    const reason = emailErrorDetail(error instanceof Error ? error.message : String(error), message);
    throw new EmailError("unavailable", `email-ses: SES could not be reached${reason === "" ? "" : `: ${reason}`}`);
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
