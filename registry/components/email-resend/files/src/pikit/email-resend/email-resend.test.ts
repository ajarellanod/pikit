/**
 * email-resend's tests. They are copied with the component and keep running in your project.
 * Resend is a local stand-in of its `POST /emails` on a free port (`Bun.serve`), reached through
 * `apiBase`: no test reaches the network or needs a real key.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, type Handle, silentLogger } from "@pikit/core";
import type { EmailSender, SecretStore } from "@pikit/contracts";
import { createEmailSenderConformance, type EmailApiFailure, type EmailSenderFixture, type SentEmail } from "@pikit/contracts/testing";
import emailResend, { FROM_VARIABLE, KEY_SECRET, resendErrorCode } from "./index.ts";

const KEY = "re_test_0123456789abcdef";
const FROM = "Assistant <bot@example.com>";

/** `secrets` holding `values`. */
function secrets(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => (values[name] === "" ? undefined : values[name]) };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

/** What the fake answers for each failure, as Resend does: its status, error name and message. */
const FAILURES: Record<Exclude<EmailApiFailure, "network" | "hang">, [number, string, string]> = {
  invalid: [422, "validation_error", "Invalid `to` field."],
  unauthorized: [401, "missing_api_key", "Missing API key in the authorization header."],
  forbidden: [403, "invalid_api_key", "API key is invalid."],
  refused: [403, "validation_error", "The example.com domain is not verified. Please, add and verify your domain on https://resend.com/domains"],
  rate_limited: [429, "rate_limit_exceeded", "Too many requests. You can only make 2 requests per second."],
  server_error: [500, "application_error", "An unexpected error occurred."],
};

/** A fake Resend: it checks the key, reads each email, and fails the next request when asked. */
function fakeResend() {
  const sent: SentEmail[] = [];
  let requests = 0;
  let next: { failure: EmailApiFailure; echo: string } | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests++;
      const failing = next;
      next = undefined;
      if (failing?.failure === "hang") return new Promise<Response>(() => {});
      if (failing !== undefined && failing.failure !== "network") {
        const [status, name, message] = FAILURES[failing.failure];
        return Response.json({ statusCode: status, name, message: `${message} ${failing.echo}` }, { status });
      }
      if (new URL(request.url).pathname !== "/emails" || request.method !== "POST") return Response.json({ statusCode: 404, name: "not_found", message: "Not found" }, { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ statusCode: 401, name: "missing_api_key", message: "Missing API key" }, { status: 401 });
      const body = (await request.json()) as { from: string; to: string[]; subject: string; text: string; html?: string };
      if (body.to.length !== 1) return Response.json({ statusCode: 422, name: "validation_error", message: "one recipient" }, { status: 422 });
      sent.push({ from: body.from, to: body.to[0] as string, subject: body.subject, text: body.text, ...(body.html !== undefined && { html: body.html }) });
      return Response.json({ id: crypto.randomUUID() });
    },
  });
  return {
    apiBase: `http://127.0.0.1:${server.port}`,
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

function fixture(): EmailSenderFixture {
  const resend = fakeResend();
  return {
    components: () => [secrets({ [KEY_SECRET]: KEY, [FROM_VARIABLE]: FROM }), emailResend],
    config: { "email-resend": { apiBase: resend.apiBase, timeoutMs: TIMEOUT_MS } },
    from: FROM,
    api: resend.api,
    timeoutMs: TIMEOUT_MS,
    dispose: () => resend.stop(),
  };
}

for (const c of createEmailSenderConformance(fixture)) test(`email-resend ${c.group}: ${c.name}`, () => c.run());

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secrets({}), emailResend], logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "email-resend")).toEqual({ name: "email-resend", provides: ["email.send"], requires: ["secrets"], optional: [] });
});

/** Why the app did not start with `values` as its variables. */
async function startFailure(values: Record<string, string>): Promise<string> {
  const app = await defineApp({ components: [secrets(values), emailResend], logger: silentLogger }).create();
  return app.start().then(
    () => "started",
    (error: unknown) => String((error as Error).cause ?? error),
  );
}

test("without its key or its sender, or with a sender that is not one, the app does not start, naming the variable", async () => {
  expect(await startFailure({ [FROM_VARIABLE]: FROM })).toContain("the secret RESEND_API_KEY is not set");
  expect(await startFailure({ [KEY_SECRET]: KEY })).toContain("the variable EMAIL_FROM is not set");
  const bad = await startFailure({ [KEY_SECRET]: KEY, [FROM_VARIABLE]: "Assistant bot at example.com" });
  expect(bad).toContain("the variable EMAIL_FROM is not a sender");
  expect(bad).not.toContain("bot at example.com");
});

test("Resend's answers map to the contract's codes", () => {
  expect(resendErrorCode(422, "validation_error")).toBe("invalid");
  expect(resendErrorCode(400, "missing_required_field")).toBe("invalid");
  expect(resendErrorCode(422, "invalid_from_address")).toBe("rejected");
  expect(resendErrorCode(401, "missing_api_key")).toBe("rejected");
  expect(resendErrorCode(403, "validation_error")).toBe("rejected");
  expect(resendErrorCode(404, "not_found")).toBe("rejected");
  expect(resendErrorCode(408, undefined)).toBe("unavailable");
  expect(resendErrorCode(429, "daily_quota_exceeded")).toBe("unavailable");
  expect(resendErrorCode(503, undefined)).toBe("unavailable");
});

test("a refusal says what Resend said, without its links, and never the key", async () => {
  const resend = fakeResend();
  let email: Handle<EmailSender> | undefined;
  const consumer = defineComponent({ name: "consumer-test", setup: (pikit) => void (email = pikit.use("email.send")) });
  const app = await defineApp({
    components: [secrets({ [KEY_SECRET]: KEY, [FROM_VARIABLE]: FROM }), emailResend, consumer],
    config: { "email-resend": { apiBase: resend.apiBase } },
    logger: silentLogger,
  }).create();
  await app.start();
  try {
    resend.api.failNext("refused", "");
    const error = (await email
      ?.get()
      .send({ to: "ana@example.com", subject: "Hello", text: "Hi." }, app.context())
      .catch((thrown: unknown) => thrown)) as Error & { code?: string };
    expect(error.code).toBe("rejected");
    expect(error.message).toBe("email-resend: Resend refused the email (HTTP 403 validation_error): The example.com domain is not verified. Please, add and verify your domain on [link]");
    expect(error.message).not.toContain(KEY);
  } finally {
    await app.stop();
    await resend.stop();
  }
});
