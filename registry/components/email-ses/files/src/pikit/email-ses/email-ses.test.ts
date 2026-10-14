/**
 * email-ses's tests. They are copied with the component and keep running in your project. SES is a
 * local stand-in of its v2 `SendEmail` on a free port (`Bun.serve`), reached through `endpoint`: no
 * test reaches the network or needs real credentials. The stand-in checks each request's signature
 * as SES does (recomputed from what it received), so a request signed over another body, path or
 * header than the one sent is refused. The signer itself is checked against AWS's vectors in
 * `sigv4.test.ts`.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { EmailSender, SecretStore } from "@pikit/contracts";
import { createEmailSenderConformance, type EmailApiFailure, type EmailSenderFixture, type SentEmail } from "@pikit/contracts/testing";
import emailSes, { ACCESS_KEY_SECRET, FROM_VARIABLE, REGION_VARIABLE, SECRET_KEY_SECRET, SESSION_TOKEN_SECRET, sesErrorCode, sesErrorType, signAws4 } from "./index.ts";

const REGION = "eu-west-1";
const ACCESS_KEY = "AKIAEXAMPLE0SES0TEST";
const SECRET_KEY = "ses-test-secret/0123456789+abcdefghijklmnop";
const FROM = "Assistant <bot@example.com>";
const VARIABLES = { [REGION_VARIABLE]: REGION, [ACCESS_KEY_SECRET]: ACCESS_KEY, [SECRET_KEY_SECRET]: SECRET_KEY, [FROM_VARIABLE]: FROM };

/** `secrets` holding `values`. */
function secrets(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

/** What the fake answers for each failure, as SES does: its status, error type (`x-amzn-ErrorType`) and message. */
const FAILURES: Record<Exclude<EmailApiFailure, "network" | "hang">, [number, string, string]> = {
  invalid: [400, "BadRequestException", "Missing required field Destination."],
  unauthorized: [403, "UnrecognizedClientException", "The security token included in the request is invalid."],
  forbidden: [403, "AccessDeniedException", "User is not authorized to perform: ses:SendEmail"],
  refused: [400, "MessageRejected", "Email address is not verified. The following identities failed the check in region EU-WEST-1: bot@example.com"],
  rate_limited: [429, "TooManyRequestsException", "Too many requests."],
  server_error: [500, "InternalFailure", "The request processing has failed because of an unknown error."],
};

/** Whether `request` (whose body is `body`) carries the signature SES would compute for it. */
async function signedCorrectly(request: Request, body: string, sessionToken?: string): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const names = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? [];
  const amzDate = request.headers.get("x-amz-date") ?? "";
  const date = new Date(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
  if (!names.includes("host") || Number.isNaN(date.getTime())) return false;
  const headers: Record<string, string> = {};
  for (const name of names) if (!["host", "x-amz-date", "x-amz-security-token"].includes(name)) headers[name] = request.headers.get(name) ?? "";
  const expected = await signAws4({
    method: request.method,
    url: request.url,
    headers,
    body,
    region: REGION,
    service: "ses",
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, ...(sessionToken !== undefined && { sessionToken }) },
    date,
  });
  return expected.authorization === authorization;
}

/** A fake SES v2: it checks the signature, reads each email, and fails the next request when asked. */
function fakeSes(sessionToken?: string) {
  const sent: SentEmail[] = [];
  let requests = 0;
  let next: { failure: EmailApiFailure; echo: string } | undefined;
  const error = (status: number, type: string, message: string) => Response.json({ message }, { status, headers: { "x-amzn-ErrorType": `${type}:http://internal.amazon.com/coral/com.amazonaws.sesv2/` } });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests++;
      const failing = next;
      next = undefined;
      if (failing?.failure === "hang") return new Promise<Response>(() => {});
      if (failing !== undefined && failing.failure !== "network") {
        const [status, type, message] = FAILURES[failing.failure];
        return error(status, type, `${message} ${failing.echo}`);
      }
      if (new URL(request.url).pathname !== "/v2/email/outbound-emails" || request.method !== "POST") return error(404, "NotFoundException", "Not found");
      const text = await request.text();
      if (!(await signedCorrectly(request, text, sessionToken))) return error(403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.");
      if (request.headers.get("x-amz-security-token") !== (sessionToken ?? null)) return error(403, "UnrecognizedClientException", "The security token included in the request is invalid.");
      const body = JSON.parse(text) as {
        FromEmailAddress: string;
        Destination: { ToAddresses: string[] };
        Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string }; Html?: { Data: string } } } };
      };
      if (body.Destination.ToAddresses.length !== 1) return error(400, "BadRequestException", "one recipient");
      const simple = body.Content.Simple;
      sent.push({
        from: body.FromEmailAddress,
        to: body.Destination.ToAddresses[0] as string,
        subject: simple.Subject.Data,
        text: simple.Body.Text.Data,
        ...(simple.Body.Html !== undefined && { html: simple.Body.Html.Data }),
      });
      return Response.json({ MessageId: `0102018f-${crypto.randomUUID()}-000000` });
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    api: {
      sent: () => [...sent],
      requests: () => requests,
      failNext(failure: EmailApiFailure, echo: string) {
        // No answer at all: the port is closed, nothing reaches it.
        if (failure === "network") void server.stop(true);
        else next = { failure, echo };
      },
    },
    stop: () => server.stop(true),
  };
}

const TIMEOUT_MS = 300;

function fixture(sessionToken?: string): EmailSenderFixture {
  const ses = fakeSes(sessionToken);
  return {
    components: () => [secrets({ ...VARIABLES, ...(sessionToken !== undefined && { [SESSION_TOKEN_SECRET]: sessionToken }) }), emailSes],
    config: { "email-ses": { endpoint: ses.endpoint, timeoutMs: TIMEOUT_MS } },
    from: FROM,
    api: ses.api,
    timeoutMs: TIMEOUT_MS,
    dispose: () => ses.stop(),
  };
}

for (const c of createEmailSenderConformance(() => fixture())) test(`email-ses ${c.group}: ${c.name}`, () => c.run());

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secrets({}), emailSes], logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "email-ses")).toEqual({ name: "email-ses", provides: ["email.send"], requires: ["secrets"], optional: [] });
});

/** Why the app did not start with `values` as its variables. */
async function startFailure(values: Record<string, string>): Promise<string> {
  const app = await defineApp({ components: [secrets(values), emailSes], logger: silentLogger }).create();
  return app.start().then(
    () => "started",
    (error: unknown) => String((error as Error).cause ?? error),
  );
}

test("without a variable, or with a region or a sender that is not one, the app does not start, naming the variable, never its value", async () => {
  for (const name of [REGION_VARIABLE, ACCESS_KEY_SECRET, SECRET_KEY_SECRET, FROM_VARIABLE]) {
    const failure = await startFailure({ ...VARIABLES, [name]: "" });
    expect(failure).toContain(`${name} is not set`);
    expect(failure).not.toContain(SECRET_KEY);
  }
  expect(await startFailure({ ...VARIABLES, [REGION_VARIABLE]: "Ireland" })).toContain("the variable AWS_SES_REGION is not an AWS region");
  expect(await startFailure({ ...VARIABLES, [FROM_VARIABLE]: "bot" })).toContain("the variable EMAIL_FROM is not a sender");
  expect(await startFailure(VARIABLES)).toBe("started");
});

test("temporary credentials: the session token is sent and signed", async () => {
  const token = "FwoGZXIvYXdzEXAMPLE-session-token";
  const ses = fixture(token);
  let email: Handle<EmailSender> | undefined;
  const consumer = defineComponent({ name: "consumer-test", setup: (pikit) => void (email = pikit.use("email.send")) });
  const app = await defineApp({ components: [...ses.components(silentLogger), consumer], config: ses.config ?? {}, logger: silentLogger }).create();
  await app.start();
  try {
    await email?.get().send({ to: "ana@example.com", subject: "Hello", text: "Hi." }, app.context());
    expect(ses.api.sent()).toEqual([{ from: FROM, to: "ana@example.com", subject: "Hello", text: "Hi." }]);
  } finally {
    await app.stop();
    await ses.dispose?.();
  }
});

test("SES's error types map to the contract's codes, then its status", () => {
  const code = (status: number, raw?: string) => sesErrorCode(status, sesErrorType(raw));
  expect(sesErrorType("MessageRejected:http://internal.amazon.com/coral/com.amazonaws.sesv2/")).toBe("MessageRejected");
  expect(sesErrorType("com.amazonaws.sesv2#AccountSuspendedException")).toBe("AccountSuspended");

  expect(code(400, "MessageRejected")).toBe("rejected");
  expect(code(400, "MailFromDomainNotVerifiedException")).toBe("rejected");
  expect(code(400, "AccountSuspendedException")).toBe("rejected");
  expect(code(400, "SendingPausedException")).toBe("rejected");
  expect(code(403, "SignatureDoesNotMatch")).toBe("rejected");
  expect(code(403, "ExpiredTokenException")).toBe("rejected");
  expect(code(400, "BadRequestException")).toBe("invalid");
  expect(code(400, "ValidationException")).toBe("invalid");
  expect(code(400, "LimitExceededException")).toBe("unavailable");
  expect(code(400, "ThrottlingException")).toBe("unavailable");
  expect(code(429, "TooManyRequestsException")).toBe("unavailable");
  expect(code(400)).toBe("invalid");
  expect(code(403)).toBe("rejected");
  expect(code(503)).toBe("unavailable");
  expect(code(500, "SomethingNewException")).toBe("unavailable");
});
