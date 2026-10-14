/**
 * `email.send` conformance: what every provider guarantees to the components that send an email
 * (`../email.ts`). Runner-independent:
 *
 *   for (const c of createEmailSenderConformance(() => myProviderFixture()))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * No email leaves: the fixture points its provider at a fake of the provider's HTTP API (a local
 * `Bun.serve`), which reads each request the provider's way and answers what the suite asks of it:
 * an acceptance, or a failure in the API's own words. A case starts an App of the fixture's
 * components and a consumer that sends, as channel-web does.
 */

import { type App, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Handle, type Logger, withAbortSignal } from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import { EmailError, type EmailErrorCode, type EmailMessage, type EmailSender } from "../email.ts";
import { checker, expecter } from "./assert.ts";

/** An email as the fake API read it from a request. */
export interface SentEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * How the fake API fails the next request, in the provider's own way: `invalid` (it calls the message
 * invalid), `unauthorized` (a wrong key: 401, or 403 for some), `forbidden` (a key without the right:
 * 403), `refused` (the provider's refusal of this email: an unverified sender, a suppressed address),
 * `rate_limited` (429), `server_error` (5xx),
 * `network` (no answer at all: the fake closes, nothing after reaches it), `hang` (it never answers).
 */
export type EmailApiFailure = "invalid" | "unauthorized" | "forbidden" | "refused" | "rate_limited" | "server_error" | "network" | "hang";

/** The fake of the provider's HTTP API. */
export interface EmailApiFake {
  /** The emails it accepted, in order. */
  sent(): SentEmail[];
  /** How many requests reached it, accepted or not. */
  requests(): number;
  /** The next request fails as `failure`; the API's message about it quotes `echo`, as a careless API might. */
  failNext(failure: EmailApiFailure, echo: string): void;
}

/** A provider under test, pointed at a fake of its API, built for one case. */
export interface EmailSenderFixture {
  /** The components of one App: the provider and what it needs (`secrets` with its variables). `logger` is the App's. */
  components(logger: Logger): ComponentDefinition[];
  config?: Record<string, unknown>;
  /** The sender the provider was configured with (`EMAIL_FROM`), as the API should receive it. */
  from: string;
  api: EmailApiFake;
  /** The provider's timeout as the fixture configured it: short, so a case can wait it out, and at least 200 ms, so a cancel is seen before it. */
  timeoutMs: number;
  dispose?(): Promise<void>;
}

const GROUP = "email.send";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** A link with a token, as a sign-in email carries. */
const LINK = "https://chat.example.com/chat/api/auth/verify?token=tok-5f3a9c2e";
const MESSAGE: EmailMessage = {
  to: "ana@example.com",
  subject: "Your sign-in link 7c1e",
  text: `Open this link to sign in: ${LINK}`,
  html: `<p>Open <a href="${LINK}">this link</a> to sign in.</p>`,
};

type Line = { level: string; message: string; fields?: Record<string, unknown> };

interface Running {
  email: EmailSender;
  app: App;
  lines: Line[];
}

/** `work`'s rejection, or `undefined` when it resolved. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error ?? new Error("rejected with nothing");
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `api` has had `count` requests; throws past a second. */
async function requestsReach(api: EmailApiFake, count: number): Promise<void> {
  for (let waited = 0; api.requests() < count; waited += 5) {
    if (waited > 1000) throw new Error(`${GROUP}: the request never reached the API`);
    await wait(5);
  }
}

function checkCode(error: unknown, code: EmailErrorCode, what: string): asserts error is EmailError {
  check(error instanceof EmailError, `${what} to reject with an EmailError, not ${String(error)}`);
  expect((error as EmailError).code, code, `${what}: the error's code`);
}

/** Neither `error`'s message nor a log line holds the message's subject, text, html or link. */
function checkNoContent(error: EmailError, lines: Line[], what: string): void {
  const visible = [error.message, String(error.cause ?? ""), ...lines.map((line) => `${line.message} ${JSON.stringify(line.fields ?? {}, stringifyErrors)}`)].join("\n");
  for (const [part, value] of [
    ["subject", MESSAGE.subject],
    ["text", MESSAGE.text],
    ["html", MESSAGE.html as string],
    ["link", LINK],
    ["link's token", "tok-5f3a9c2e"],
  ]) {
    check(!visible.includes(value as string), `${what}: the ${part} to appear in no error message or log line`);
  }
}

/** Errors in log fields are logged with their message; content inside one must be caught too. */
function stringifyErrors(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, cause: String(value.cause ?? "") } : value;
}

export function createEmailSenderConformance(factory: () => EmailSenderFixture | Promise<EmailSenderFixture>): readonly ConformanceCase[] {
  const emailCase = (name: string, run: (fixture: EmailSenderFixture, running: Running) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory();
      const lines: Line[] = [];
      const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void lines.push({ level, message, ...(fields !== undefined && { fields }) });
      const logger: Logger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
      let handle: Handle<EmailSender> | undefined;
      const consumer = defineComponent({ name: "email-conformance", setup: (pikit) => void (handle = pikit.use("email.send")) });
      const app = await defineApp({
        components: [...fixture.components(logger), consumer],
        ...(fixture.config !== undefined && { config: fixture.config }),
        logger,
      }).create();
      await app.start();
      try {
        if (handle === undefined) throw new Error(`${GROUP}: the consumer did not set up`);
        await run(fixture, { email: handle.get(), app, lines });
      } finally {
        await app.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  /** The API fails the next send as `failure`: the send rejects with `code`, and says nothing of the content. */
  const fails = async (fixture: EmailSenderFixture, { email, app, lines }: Running, failure: EmailApiFailure, code: EmailErrorCode): Promise<void> => {
    fixture.api.failNext(failure, `${MESSAGE.subject} ${MESSAGE.text} ${MESSAGE.html}`);
    const error = await rejection(email.send(MESSAGE, app.context()));
    checkCode(error, code, `an API failing as ${failure}`);
    checkNoContent(error, lines, `an API failing as ${failure}`);
    expect(fixture.api.sent().length, 0, `emails sent by an API failing as ${failure}`);
  };

  return [
    emailCase("a send resolves with the provider's id, and the API got the message from the configured sender", async (fixture, { email, app }) => {
      const receipt = await email.send(MESSAGE, app.context());
      check(typeof receipt?.id === "string" && receipt.id !== "", "a non-empty id");
      expect(fixture.api.sent(), [{ from: fixture.from, to: MESSAGE.to, subject: MESSAGE.subject, text: MESSAGE.text, html: MESSAGE.html }], "what the API received");
    }),

    emailCase("without html, the API gets the text alone; each send is one email", async (fixture, { email, app }) => {
      const first = await email.send({ to: "ana@example.com", subject: "One", text: "The first." }, app.context());
      const second = await email.send({ to: "bo@example.org", subject: "Two", text: "The second ñandú ✓." }, app.context());
      check(first.id !== "" && second.id !== "", "two ids");
      expect(
        fixture.api.sent(),
        [
          { from: fixture.from, to: "ana@example.com", subject: "One", text: "The first." },
          { from: fixture.from, to: "bo@example.org", subject: "Two", text: "The second ñandú ✓." },
        ],
        "what the API received",
      );
    }),

    emailCase("an invalid address or message is invalid, and nothing reaches the API", async (fixture, { email, app, lines }) => {
      const invalid: [string, EmailMessage][] = [
        ["no address", { ...MESSAGE, to: "" }],
        ["not an address", { ...MESSAGE, to: "ana at example.com" }],
        ["two addresses", { ...MESSAGE, to: "ana@example.com, bo@example.com" }],
        ["a display name", { ...MESSAGE, to: "Ana <ana@example.com>" }],
        ["a line break in the address", { ...MESSAGE, to: "ana@example.com\r\nbcc: eve@example.com" }],
        ["an empty subject", { ...MESSAGE, subject: " " }],
        ["a line break in the subject", { ...MESSAGE, subject: `${MESSAGE.subject}\r\nBcc: eve@example.com` }],
        ["an empty text", { ...MESSAGE, text: "" }],
      ];
      for (const [what, message] of invalid) {
        const error = await rejection(email.send(message, app.context()));
        checkCode(error, "invalid", what);
        checkNoContent(error, lines, what);
      }
      expect(fixture.api.requests(), 0, "requests that reached the API");
    }),

    emailCase("the API calls the message invalid: invalid", async (fixture, running) => {
      await fails(fixture, running, "invalid", "invalid");
    }),

    emailCase("a wrong key, a key without the right or a refusal of the email: rejected", async (fixture, running) => {
      await fails(fixture, running, "unauthorized", "rejected");
      await fails(fixture, running, "forbidden", "rejected");
      await fails(fixture, running, "refused", "rejected");
    }),

    emailCase("429 and 5xx: unavailable", async (fixture, running) => {
      await fails(fixture, running, "rate_limited", "unavailable");
      await fails(fixture, running, "server_error", "unavailable");
    }),

    emailCase("an API that cannot be reached: unavailable", async (fixture, running) => {
      await fails(fixture, running, "network", "unavailable");
    }),

    emailCase("a cancelled context sends nothing: unavailable", async (fixture, { email, app }) => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled by the caller"));
      const error = await rejection(email.send(MESSAGE, app.context(withAbortSignal(controller.signal, BACKGROUND_CONTEXT))));
      checkCode(error, "unavailable", "a send with a cancelled context");
      expect(fixture.api.requests(), 0, "requests that reached the API");
    }),

    emailCase("cancelling the context while the API has not answered stops the send: unavailable", async (fixture, { email, app, lines }) => {
      fixture.api.failNext("hang", "");
      const controller = new AbortController();
      const sending = rejection(email.send(MESSAGE, app.context(withAbortSignal(controller.signal, BACKGROUND_CONTEXT))));
      await requestsReach(fixture.api, 1);
      const started = Date.now();
      controller.abort(new Error("cancelled by the caller"));
      const error = await sending;
      const took = Date.now() - started;
      check(took < Math.min(1000, fixture.timeoutMs / 2), `the send to stop at the cancel, before its own timeout (${fixture.timeoutMs} ms), not after ${took} ms`);
      checkCode(error, "unavailable", "a cancelled send");
      checkNoContent(error, lines, "a cancelled send");
    }),

    emailCase("an API that never answers: unavailable after the provider's timeout", async (fixture, { email, app, lines }) => {
      fixture.api.failNext("hang", "");
      const started = Date.now();
      const error = await rejection(email.send(MESSAGE, app.context()));
      const took = Date.now() - started;
      checkCode(error, "unavailable", "a send the API never answers");
      checkNoContent(error, lines, "a send the API never answers");
      check(took >= fixture.timeoutMs - 50 && took < fixture.timeoutMs + 2000, `the send to give up after its timeout (${fixture.timeoutMs} ms), not after ${took} ms`);
    }),
  ];
}
