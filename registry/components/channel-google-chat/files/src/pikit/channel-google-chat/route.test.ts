// Owner: ingress. The endpoint's route composed on a server (in process) and on Cloudflare's shape (actor.mailbox) (route.ts).
/**
 * The route of the default instance, composed in an App and served over real HTTP, with Google's keys
 * fetched from the fake Google's port and tokens signed with its test key pair:
 *
 * - **On a server**, first: the sink is the handler in process (as index.ts's `receive` / `clickOf`).
 * - **On Cloudflare's shape**: the sink is `mailboxSink` over `createMemoryMailbox`, whose inbox
 *   handlers stand for the conversation's object.
 *
 * The key is key.ts's `eventKey`, as `routeOf` (worker.ts) makes it: each message's thread, the
 * `conversations` setting saying `thread` (the events say their space has threads); a click's, the key
 * its action names.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Logger } from "@pikit/core";
import type { ActorMailbox, JsonValue } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import type { AddOnEvent, AddOnResponse } from "./event.ts";
import { addedEvent, clickEvent, eventRequest, type FakeGoogleChat, messageEvent, removedEvent, startFakeGoogleChat } from "./fake-google-chat.test-support.ts";
import { instancesOf, readCredentials } from "./instance.ts";
import { createSpaceThreading, eventKey } from "./key.ts";
import { createRoute, strangerText } from "./route.ts";
import { createIdTokenVerifier, createJwks } from "./token.ts";
import { type ChatApi, CLICK_TYPE, EVENT_TYPE, type EventSink, type KeyOf } from "./types.ts";
import { mailboxSink, type Route, serve } from "./worker.ts";

const fakes: FakeGoogleChat[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.stop().catch(() => {});
  for (const fake of fakes.splice(0)) await fake.stop();
});

const [INSTANCE] = instancesOf([]);
const instance = INSTANCE!;
const ALLOWED = "spaces/AAA";

/** Google's API, which the key never needs here: every event says whether its space has threads. */
const noApi = new Proxy({} as ChatApi, { get: () => () => Promise.reject(new Error("the key asked Google")) });
/** key.ts's `eventKey`, as `routeOf` makes it: a message's (or a clicked card's) thread, the setting saying `thread`. */
const threadKey: KeyOf = (event, ctx) => eventKey(event, { instance, threading: createSpaceThreading(noApi, undefined), mode: async () => "thread" }, ctx);

interface Line {
  level: keyof Logger;
  message: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: keyof Logger) => (message: string, fields?: Record<string, unknown>) => void lines.push({ level, message, fields });
  return { logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

/** The handler in process, recording what it is handed; what it does is the test's (`behave`, `answer`). */
function inProcess() {
  const events: { key: string; event: AddOnEvent }[] = [];
  const clicks: { key: string; event: AddOnEvent }[] = [];
  const state = {
    behave: async (_ctx: AppContext): Promise<void> => {},
    answer: async (): Promise<AddOnResponse> => ({ action: { notification: { text: "answered" } } }),
  };
  const sink: EventSink = {
    async event(key, event, ctx) {
      events.push({ key, event });
      await state.behave(ctx);
    },
    async click(key, event) {
      clicks.push({ key, event });
      return state.answer();
    },
  };
  return { sink, events, clicks, state };
}

/** The route of the default instance, built in `start` as index.ts builds it, its sink from `sinkOf`. */
function ingress(google: FakeGoogleChat, options: { sinkOf: (mailbox: ActorMailbox | undefined) => EventSink; keyOf?: KeyOf; handOffMs?: number; allowed?: string[] }) {
  return defineComponent({
    name: "ingress-test",
    setup(pikit) {
      const mailbox = pikit.useOptional("actor.mailbox");
      let route: Route | undefined;
      pikit.provideKeyed("http.route", `POST ${instance.path}`, (request, ctx) => serve(route, request, ctx));
      return {
        async start(ctx) {
          const secrets = google.secrets(options.allowed ?? [ALLOWED]);
          const credentials = await readCredentials(instance, async (name) => secrets[name]);
          // Google's keys over real HTTP, from the fake's port (the global fetch).
          const jwks = createJwks({ url: google.jwksUrl, clock: ctx.clock });
          const verifier = createIdTokenVerifier({ jwks, audience: credentials.audience, email: credentials.tokenEmail, clock: ctx.clock });
          route = createRoute({
            instance,
            credentials,
            verifier,
            keyOf: options.keyOf ?? threadKey,
            sink: options.sinkOf(mailbox.get()),
            ...(options.handOffMs !== undefined && { handOffMs: options.handOffMs }),
          });
        },
      };
    },
  });
}

/** Serves the App's routes over real HTTP, as server-bun does. */
function httpServer() {
  let url = "";
  const component = defineComponent({
    name: "server-test",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      let server: ReturnType<typeof Bun.serve> | undefined;
      return {
        start(ctx) {
          const background = ctx.derive(() => BACKGROUND_CONTEXT);
          server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
              const route = routes.get(`${request.method} ${new URL(request.url).pathname}`);
              if (route === undefined) return new Response("not found", { status: 404 });
              return await Promise.resolve(route(request, background)).catch(() => new Response("error", { status: 500 }));
            },
          });
          url = `http://127.0.0.1:${server.port}`;
        },
        async stop() {
          await server?.stop(true);
        },
      };
    },
  });
  return { component, url: () => `${url}${instance.path}` };
}

async function started(components: ComponentDefinition[], logger: Logger): Promise<App> {
  const app = await defineApp({ components, config: {}, logger }).create();
  apps.push(app);
  await app.start();
  return app;
}

async function fake(): Promise<FakeGoogleChat> {
  const google = await startFakeGoogleChat();
  fakes.push(google);
  return google;
}

/** On a server: the route in one App, handing events to the handler in process. */
async function onAServer(options: { handOffMs?: number; keyOf?: KeyOf; allowed?: string[] } = {}) {
  const google = await fake();
  const handler = inProcess();
  const server = httpServer();
  const { logger, lines } = recordingLogger();
  await started([ingress(google, { ...options, sinkOf: () => handler.sink }), server.component], logger);
  const post = (event: unknown, authorization: string | null) => fetch(eventRequest(server.url(), event, authorization));
  return { google, handler, lines, post, bearer: () => google.idTokens.bearer() };
}

/** `{}`, as JSON: an event acknowledged. */
const ACKNOWLEDGED_JSON = { status: 200, type: expect.stringContaining("application/json"), body: {} };
const bodyOf = async (response: Response) => ({ status: response.status, type: response.headers.get("content-type"), body: response.status === 200 ? await response.json() : await response.text() });

test("on a server: a message with Google's token is verified, keyed and handed to the handler in process, then acknowledged {} as JSON", async () => {
  const { handler, post, bearer, google, lines } = await onAServer();
  const token = await bearer();
  const event = messageEvent({ space: ALLOWED, thread: "spaces/AAA/threads/T1", text: "hello", idToken: token.slice("Bearer ".length) });
  const response = await post(event, token);
  expect(await bodyOf(response)).toEqual(ACKNOWLEDGED_JSON);
  expect(handler.events).toHaveLength(1);
  expect(handler.events[0]?.key).toBe("googlechat:spaces/AAA:threads/T1");
  // The token goes no further than the route.
  const { authorizationEventObject, ...rest } = event;
  expect(authorizationEventObject?.systemIdToken).toBeDefined();
  expect(handler.events[0]?.event).toEqual(rest);
  expect(JSON.stringify(lines)).not.toContain(token.slice("Bearer ".length));
  expect(google.callsTo({ path: "/certs" })).toHaveLength(1);

  // An add and a removal too, each its space's.
  expect(await bodyOf(await post(addedEvent({ space: ALLOWED }), await bearer()))).toEqual(ACKNOWLEDGED_JSON);
  expect(await bodyOf(await post(removedEvent({ space: ALLOWED }), await bearer()))).toEqual(ACKNOWLEDGED_JSON);
  expect(handler.events.map((each) => each.key)).toEqual(["googlechat:spaces/AAA:threads/T1", "googlechat:spaces/AAA", "googlechat:spaces/AAA"]);
});

test("on a server: no token, a refused one, or Google's keys unreachable: nothing is read or handed on (401, 401, 500); the reason is logged, never sent", async () => {
  const { handler, post, google, lines } = await onAServer();
  const event = messageEvent({ space: ALLOWED });
  const none = await post(event, null);
  expect(await bodyOf(none)).toMatchObject({ status: 401, body: "unauthorized" });
  const wrong = await google.idTokens.bearer({ aud: "https://elsewhere.example/google-chat" });
  expect(await bodyOf(await post(event, wrong))).toMatchObject({ status: 401, body: "unauthorized" });
  expect(await bodyOf(await post("not even an event", await google.idTokens.bearer({ email_verified: false })))).toMatchObject({ status: 401 });
  expect(lines.filter((line) => line.level === "warn").map((line) => line.fields?.reason)).toEqual([
    "no Authorization header",
    expect.stringMatching(/audience/),
    expect.stringMatching(/not verified/),
  ]);

  // Google's keys unreachable: 500, so Google sends the event again.
  const fresh = await onAServer();
  fresh.google.fail({ path: "/certs" }, { status: 503 });
  expect(await bodyOf(await fresh.post(event, await fresh.bearer()))).toMatchObject({ status: 500 });
  expect(fresh.lines.some((line) => line.level === "error" && /signing keys/.test(line.message))).toBe(true);
  expect(handler.events).toEqual([]);
  expect(fresh.handler.events).toEqual([]);
  expect(JSON.stringify([...lines, ...fresh.lines])).not.toContain(wrong.slice("Bearer ".length));
});

test("on a server: a body that is not an add-on event of Chat is 400; a payload this channel does not handle, or no key, is {}", async () => {
  const { handler, post, bearer } = await onAServer();
  for (const body of ["not json", { chat: 1 }, { chat: { messagePayload: {} } }, [], null]) {
    expect(await bodyOf(await post(body, await bearer()))).toMatchObject({ status: 400 });
  }
  expect(await bodyOf(await post({ chat: { space: { name: ALLOWED }, widgetUpdatedPayload: {} } }, await bearer()))).toEqual(ACKNOWLEDGED_JSON);
  expect(handler.events).toEqual([]);

  const noKey = await onAServer({ keyOf: async () => undefined });
  expect(await bodyOf(await noKey.post(messageEvent({ space: ALLOWED }), await noKey.bearer()))).toEqual(ACKNOWLEDGED_JSON);
  expect(noKey.handler.events).toEqual([]);
  const failing = await onAServer({
    keyOf: async () => {
      throw new Error("settings unreadable");
    },
  });
  expect(await bodyOf(await failing.post(messageEvent({ space: ALLOWED }), await failing.bearer()))).toMatchObject({ status: 500 });
  expect(failing.handler.events).toEqual([]);
});

test("on a server: a stranger space is told once, in the response, its id and where to allow it; nothing is handed on", async () => {
  const { handler, post, bearer, lines } = await onAServer();
  const told = { status: 200, type: expect.stringContaining("application/json"), body: { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: strangerText(instance, "spaces/ZZZ") } } } } } };
  expect(strangerText(instance, "spaces/ZZZ")).toContain("spaces/ZZZ");
  expect(strangerText(instance, "spaces/ZZZ")).toContain("GOOGLE_CHAT_ALLOWED_SPACES");
  expect(await bodyOf(await post(addedEvent({ space: "spaces/ZZZ" }), await bearer()))).toEqual(told);
  expect(await bodyOf(await post(messageEvent({ space: "spaces/ZZZ" }), await bearer()))).toEqual(ACKNOWLEDGED_JSON);
  // Another stranger is told too, from its first message.
  expect(await bodyOf(await post(messageEvent({ space: "spaces/YYY" }), await bearer()))).toMatchObject({
    status: 200,
    body: { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: strangerText(instance, "spaces/YYY") } } } } },
  });
  // A click there gets a notice; a removal is acknowledged.
  expect(await bodyOf(await post(clickEvent({ space: "spaces/ZZZ", parameters: { question: "q1" } }), await bearer()))).toMatchObject({
    status: 200,
    body: { action: { notification: { text: strangerText(instance, "spaces/ZZZ") } } },
  });
  expect(await bodyOf(await post(removedEvent({ space: "spaces/ZZZ" }), await bearer()))).toEqual(ACKNOWLEDGED_JSON);
  expect(handler.events).toEqual([]);
  expect(handler.clicks).toEqual([]);
  expect(lines.filter((line) => line.level === "warn").map((line) => line.fields?.space)).toEqual(["spaces/ZZZ", "spaces/ZZZ", "spaces/YYY", "spaces/ZZZ"]);
  // With no space allowed, every space is a stranger.
  const closed = await onAServer({ allowed: [] });
  expect(await bodyOf(await closed.post(messageEvent({ space: ALLOWED }), await closed.bearer()))).toMatchObject({ status: 200, body: { hostAppDataAction: {} } });
  expect(closed.handler.events).toEqual([]);
});

test("on a server: a handler that fails answers 500 (Google sends it again); one past the deadline answers 500 and its context is cancelled", async () => {
  const { handler, post, bearer, lines } = await onAServer({ handOffMs: 100 });
  handler.state.behave = async () => {
    throw new Error("could not admit");
  };
  expect(await bodyOf(await post(messageEvent({ space: ALLOWED }), await bearer()))).toMatchObject({ status: 500 });
  expect(lines.some((line) => line.level === "error" && line.fields?.error === "could not admit")).toBe(true);

  let cancelled: unknown;
  handler.state.behave = (ctx) =>
    new Promise<void>((resolve) => {
      ctx.abortSignal?.addEventListener("abort", () => {
        cancelled = ctx.abortSignal?.reason;
        // A handler that does not stop: the route answers anyway.
        setTimeout(resolve, 500);
      });
    });
  const begun = Date.now();
  expect(await bodyOf(await post(messageEvent({ space: ALLOWED }), await bearer()))).toMatchObject({ status: 500 });
  expect(Date.now() - begun).toBeLessThan(450);
  expect(String(cancelled)).toMatch(/within 100 ms/);
});

test("on a server: a click is answered with the handler's response, in time, from the conversation its action's key names; a failed one is 500", async () => {
  const { handler, post, bearer } = await onAServer();
  const card = { name: "spaces/AAA/messages/card1", thread: { name: "spaces/AAA/threads/T9" } };
  const response: AddOnResponse = { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text: "Ada answered: yes" } } } } };
  handler.state.answer = async () => response;
  const clicked = clickEvent({ space: ALLOWED, message: card, parameters: { key: "googlechat:spaces/AAA:threads/T9", question: "q1", value: "yes" } });
  expect(await bodyOf(await post(clicked, await bearer()))).toEqual({ status: 200, type: expect.stringContaining("application/json"), body: response });
  expect(handler.clicks.map((each) => each.key)).toEqual(["googlechat:spaces/AAA:threads/T9"]);
  expect(handler.events).toEqual([]);

  handler.state.answer = async () => {
    throw new Error("no such question");
  };
  expect(await bodyOf(await post(clicked, await bearer()))).toMatchObject({ status: 500 });
});

// ---------------------------------------------------------------------------------------------------
// Cloudflare's shape: the Worker's route hands each event to its conversation's object through actor.mailbox

/** The conversation's object, as index.ts's inbox handlers: records what the mailbox carried. */
function conversations() {
  const events: { key: string; message: JsonValue }[] = [];
  const clicks: { key: string; message: JsonValue }[] = [];
  const state = { fail: false };
  const component = defineComponent({
    name: "object-test",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      return {
        start() {
          inbox.get().handle(EVENT_TYPE, async (key, message) => {
            if (state.fail) throw new Error("the object could not take it");
            events.push({ key, message });
          });
          inbox.get().answer(CLICK_TYPE, async (key, message) => {
            if (state.fail) throw new Error("the object could not answer");
            clicks.push({ key, message });
            return { action: { notification: { text: "answered by the object" } } };
          });
        },
      };
    },
  });
  return { component, events, clicks, state };
}

test("on Cloudflare: a message goes to its conversation's object with actor.mailbox.send (google-chat.event), a click with call (google-chat.click); a rejection is 500", async () => {
  const google = await fake();
  const object = conversations();
  const server = httpServer();
  const { logger, lines } = recordingLogger();
  await started(
    [createMemoryMailbox(), object.component, ingress(google, { sinkOf: (mailbox) => mailboxSink(mailbox as ActorMailbox) }), server.component],
    logger,
  );
  const post = async (event: unknown) => fetch(eventRequest(server.url(), event, await google.idTokens.bearer()));

  const token = await google.idTokens.sign();
  const event = messageEvent({ space: ALLOWED, thread: "spaces/AAA/threads/T1", idToken: token });
  expect(await bodyOf(await post(event))).toEqual(ACKNOWLEDGED_JSON);
  const { authorizationEventObject, ...carried } = event;
  void authorizationEventObject;
  expect(object.events).toEqual([{ key: "googlechat:spaces/AAA:threads/T1", message: JSON.parse(JSON.stringify(carried)) }]);
  expect(JSON.stringify(object.events)).not.toContain(token);

  const clicked = clickEvent({ space: ALLOWED, message: { name: "spaces/AAA/messages/c1", thread: { name: "spaces/AAA/threads/T1" } }, parameters: { key: "googlechat:spaces/AAA:threads/T1", question: "q1" } });
  expect(await bodyOf(await post(clicked))).toMatchObject({ status: 200, body: { action: { notification: { text: "answered by the object" } } } });
  expect(object.clicks.map((each) => each.key)).toEqual(["googlechat:spaces/AAA:threads/T1"]);

  // A stranger never reaches an object.
  expect(await bodyOf(await post(messageEvent({ space: "spaces/ZZZ" })))).toMatchObject({ status: 200, body: { hostAppDataAction: {} } });
  expect(object.events).toHaveLength(1);

  object.state.fail = true;
  expect(await bodyOf(await post(messageEvent({ space: ALLOWED })))).toMatchObject({ status: 500 });
  expect(await bodyOf(await post(clicked))).toMatchObject({ status: 500 });
  expect(lines.filter((line) => line.level === "error")).toHaveLength(2);
  expect(JSON.stringify(lines)).not.toContain(token);
});
