/**
 * channel-http's tests. They are copied with the component and keep running in your project.
 *
 * The routes are called as a server would call them, with no socket. What the channel uses is
 * played by small doubles defined here: secrets, a conversation registry, a router stage and an
 * agent runtime whose runs answer `answer: <newest message>` (`hold` waits to be released, `fail`
 * fails). The sample `samples/http` runs the same channel with Pi, over real HTTP.
 */

import { expect, test } from "bun:test";
import {
  type Admission,
  type AgentRuntime,
  type App,
  BACKGROUND_CONTEXT,
  type ConversationRef,
  type ConversationRegistry,
  defineApp,
  defineComponent,
  type HttpRoute,
  silentLogger,
  withAbortSignal,
} from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import channelHttp from "./index.ts";

const TOKEN = "test-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function secretsWith(values: Record<string, string>) {
  return defineComponent({
    name: "secrets-test",
    setup: (pikit) => pikit.provide("secrets", { get: async (name) => values[name] || undefined }),
  });
}

function memoryRegistry() {
  const pointers = new Map<string, ConversationRef>();
  let sessions = 0;
  const registry: ConversationRegistry = {
    async resolve(key, agent) {
      const found = pointers.get(key) ?? { key, agent, sessionId: `s${++sessions}` };
      pointers.set(key, found);
      return found;
    },
    get: async (key) => pointers.get(key),
    async reset(key, ctx) {
      const previous = pointers.get(key);
      if (previous === undefined) return undefined;
      const conversation = { ...previous, sessionId: `s${++sessions}` };
      pointers.set(key, conversation);
      const reset = { conversation, previousSessionId: previous.sessionId, newSessionId: conversation.sessionId };
      await ctx.emit("conversation.reset", reset);
      return reset;
    },
  };
  return defineComponent({ name: "registry-test", setup: (pikit) => pikit.provide("conversations.registry", registry) });
}

const router = defineComponent({
  name: "router-test",
  setup(pikit) {
    pikit.pipeline("route.resolve", (value) => {
      if (value.message.text === "deny me") return { ...value, decision: { agent: "assistant", access: "deny", reason: "not today" } };
      return value.decision !== undefined ? value : { ...value, decision: { agent: "assistant", access: "allow" } };
    });
  },
});

/** An agent runtime double: one run per session at a time; messages to a busy session join it. */
function scriptedRuntime() {
  const dispatched: { requestId: string; key: string; agent: string; prompt: string }[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let holding!: () => void;
  const held = new Promise<void>((resolve) => (holding = resolve));
  const component = defineComponent({
    name: "runtime-test",
    setup(pikit) {
      let events = BACKGROUND_CONTEXT as unknown as Parameters<AgentRuntime["dispatch"]>[1];
      const seen = new Map<string, Set<string>>();
      const runs = new Map<string, { requestIds: string[]; prompts: string[] }>();
      const run = async (conversation: ConversationRef, requestId: string) => {
        const current = runs.get(conversation.sessionId);
        if (current === undefined) return;
        if (current.prompts[0] === "hold") {
          holding();
          await released;
        }
        runs.delete(conversation.sessionId);
        const base = { conversation, requestId, requestIds: current.requestIds, messages: [] };
        if (current.prompts[0] === "fail") {
          await events.emit("agent.failed", { ...base, kind: "failed", error: { code: "provider_error", message: "the model failed" } });
        } else {
          await events.emit("agent.settled", { ...base, kind: "completed", text: `answer: ${current.prompts.at(-1)}` });
        }
      };
      const runtime: AgentRuntime = {
        async dispatch(request) {
          const { requestId, conversation, prompt } = request;
          dispatched.push({ requestId, key: conversation.key, agent: conversation.agent, prompt });
          const known = seen.get(conversation.sessionId) ?? new Set();
          seen.set(conversation.sessionId, known);
          let admission: Admission;
          if (known.has(requestId)) admission = { kind: "duplicate", requestId };
          else {
            known.add(requestId);
            const active = runs.get(conversation.sessionId);
            if (active !== undefined) {
              active.requestIds.push(requestId);
              active.prompts.push(prompt);
              admission = { kind: "queued", requestId };
            } else {
              runs.set(conversation.sessionId, { requestIds: [requestId], prompts: [prompt] });
              void run(conversation, requestId);
              admission = { kind: "started", requestId };
            }
          }
          return admission;
        },
        abort: async () => {},
        resume: async () => {},
      };
      pikit.provide("agent.runtime", runtime);
      return { start: (ctx) => void (events = ctx.derive(() => BACKGROUND_CONTEXT)) };
    },
  });
  return { component, dispatched, hold: { started: held, release: () => release() } };
}

type Init = Omit<RequestInit, "signal"> & { signal?: AbortSignal };

interface Subject {
  app: App;
  runtime: ReturnType<typeof scriptedRuntime>;
  /** Call a route the way a server would; `signal` plays the request's cancellation. */
  call(key: string, path: string, init?: Init): Promise<{ status: number; body: Record<string, unknown> }>;
}

interface Options {
  config?: Record<string, unknown>;
  /** The router stage; `null` for an app with no router. */
  router?: ReturnType<typeof defineComponent> | null;
  extra?: ReturnType<typeof defineComponent>[];
}

async function started(options: Options = {}): Promise<Subject> {
  const runtime = scriptedRuntime();
  let routes: { get(key: string): HttpRoute | undefined } | undefined;
  const server = defineComponent({
    name: "server-test",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      return { start: () => void (routes = handle) };
    },
  });
  const app = await defineApp({
    components: [
      secretsWith({ PIKIT_HTTP_TOKEN: TOKEN }),
      memoryRegistry(),
      ...(options.router === null ? [] : [options.router ?? router]),
      runtime.component,
      channelHttp,
      server,
      ...(options.extra ?? []),
    ],
    ...(options.config !== undefined && { config: options.config }),
    logger: silentLogger,
  }).create();
  await app.start();
  return {
    app,
    runtime,
    async call(key, path, init = {}) {
      const route = routes?.get(key);
      if (route === undefined) throw new Error(`no route ${key}`);
      const ctx = app.context(init.signal ? withAbortSignal(init.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
      const { signal: _signal, ...rest } = init;
      const response = await route(new Request(`http://pikit.test${path}`, rest), ctx);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

const message = (body: unknown, headers: Record<string, string> = AUTH): Init => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const send = (s: Subject, body: unknown, headers?: Record<string, string>) => s.call("POST /v1/messages", "/v1/messages", message(body, headers));

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secretsWith({}), memoryRegistry(), scriptedRuntime().component, channelHttp], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "channel-http")).toMatchObject({
    provides: ["http.route"],
    requires: ["secrets", "conversations.registry", "agent.runtime"],
    optional: [],
  });
  expect(app.describe().capabilities["http.route"]?.keys).toEqual({
    "POST /v1/messages": "channel-http",
    "POST /v1/conversations/:id/reset": "channel-http",
  });
  expect(app.describe().pipelines["inbound.authenticate"]).toEqual([{ id: "channel-http-bearer", priority: 100 }]);
});

for (const c of createLifecycleConformance(() => ({
  component: channelHttp,
  providers: [secretsWith({ PIKIT_HTTP_TOKEN: TOKEN }), memoryRegistry(), scriptedRuntime().component],
}))) {
  test(`channel-http ${c.group}: ${c.name}`, () => c.run());
}

test("a message is answered in the response, on the conversation http:<conversationId>, by the routed agent", async () => {
  const s = await started();

  const answered = await send(s, { conversationId: "c1", text: "hello", messageId: "m1" });

  expect(answered).toEqual({ status: 200, body: { requestId: "m1", text: "answer: hello" } });
  expect(s.runtime.dispatched).toEqual([{ requestId: "m1", key: "http:c1", agent: "assistant", prompt: "hello" }]);
  await s.app.stop();
});

test("without a messageId, each message gets a new request id", async () => {
  const s = await started();

  const first = await send(s, { conversationId: "c1", text: "one" });
  const second = await send(s, { conversationId: "c1", text: "two" });

  expect(first.status).toBe(200);
  expect(first.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.body.requestId).not.toBe(first.body.requestId);
  await s.app.stop();
});

test("a missing or wrong bearer token is a 401, and nothing is dispatched", async () => {
  const s = await started();

  const missing = await send(s, { conversationId: "c1", text: "hello" }, {});
  const wrong = await send(s, { conversationId: "c1", text: "hello" }, { authorization: "Bearer not-the-token-at-all" });
  const scheme = await send(s, { conversationId: "c1", text: "hello" }, { authorization: `Basic ${TOKEN}` });
  const reset = await s.call("POST /v1/conversations/:id/reset", "/v1/conversations/c1/reset", { method: "POST" });

  for (const response of [missing, wrong, scheme, reset]) expect(response).toEqual({ status: 401, body: { error: "unauthorized" } });
  expect(s.runtime.dispatched).toEqual([]);
  await s.app.stop();
});

test("a body that is not a message is a 400", async () => {
  const s = await started();
  const bodies: unknown[] = [
    { text: "hello" },
    { conversationId: "c1" },
    { conversationId: "c1", text: "" },
    { conversationId: "has spaces", text: "hello" },
    { conversationId: "c/1", text: "hello" },
    { conversationId: "c1", text: "hello", messageId: "" },
    { conversationId: "c1", text: "hello", extra: true },
    [],
  ];

  for (const body of bodies) expect((await send(s, body)).status).toBe(400);
  const notJson = await s.call("POST /v1/messages", "/v1/messages", { method: "POST", headers: AUTH, body: "{ nope" });
  expect(notJson).toEqual({ status: 400, body: { error: "invalid_request", message: "the body is not JSON" } });
  expect(s.runtime.dispatched).toEqual([]);
  await s.app.stop();
});

test("a message sent while the agent works is steered into the run, and both POSTs get its answer", async () => {
  const s = await started();

  const first = send(s, { conversationId: "c1", text: "hold", messageId: "m1" });
  await s.runtime.hold.started;
  const second = send(s, { conversationId: "c1", text: "change course", messageId: "m2" });
  while (s.runtime.dispatched.length < 2) await Bun.sleep(1);
  s.runtime.hold.release();

  expect(await first).toEqual({ status: 200, body: { requestId: "m1", text: "answer: change course" } });
  expect(await second).toEqual({ status: 200, body: { requestId: "m2", text: "answer: change course" } });
  await s.app.stop();
});

test("no answer within replyTimeoutMs is a 202 with the request id; the answer stays in the session", async () => {
  const s = await started({ config: { "channel-http": { replyTimeoutMs: 20 } } });

  const late = await send(s, { conversationId: "c1", text: "hold", messageId: "m1" });
  s.runtime.hold.release();

  expect(late).toEqual({ status: 202, body: { requestId: "m1" } });
  await s.app.stop();
});

test("a messageId already in the conversation is a 409 and does not run again", async () => {
  const s = await started();
  await send(s, { conversationId: "c1", text: "hello", messageId: "m1" });

  const again = await send(s, { conversationId: "c1", text: "hello", messageId: "m1" });
  const elsewhere = await send(s, { conversationId: "c2", text: "hello there", messageId: "m1" });

  expect(again).toEqual({ status: 409, body: { requestId: "m1", error: "duplicate" } });
  expect(elsewhere).toEqual({ status: 200, body: { requestId: "m1", text: "answer: hello there" } });
  await s.app.stop();
});

test("a failed run is a 502 with its error code", async () => {
  const s = await started();

  expect(await send(s, { conversationId: "c1", text: "fail", messageId: "m1" })).toEqual({
    status: 502,
    body: { requestId: "m1", error: "provider_error" },
  });
  await s.app.stop();
});

test("a denied route is a 403, and a message no stage routed is a 500", async () => {
  const denied = await started();
  expect(await send(denied, { conversationId: "c1", text: "deny me", messageId: "m1" })).toEqual({
    status: 403,
    body: { requestId: "m1", error: "denied", message: "not today" },
  });
  await denied.app.stop();

  const unrouted = await started({ router: null });
  expect(await send(unrouted, { conversationId: "c1", text: "hello", messageId: "m1" })).toEqual({
    status: 500,
    body: { requestId: "m1", error: "no_route" },
  });
  expect(unrouted.runtime.dispatched).toEqual([]);
  await unrouted.app.stop();
});

test("a stage that halts inbound.normalize rejects the message with a 422", async () => {
  const filter = defineComponent({
    name: "filter-test",
    setup: (pikit) => pikit.pipeline("inbound.normalize", (m) => (m.text.includes("spam") ? pikit.halt("looks like spam") : m)),
  });
  const s = await started({ extra: [filter] });

  expect(await send(s, { conversationId: "c1", text: "buy spam", messageId: "m1" })).toEqual({
    status: 422,
    body: { requestId: "m1", error: "rejected", message: "looks like spam" },
  });
  expect(s.runtime.dispatched).toEqual([]);
  await s.app.stop();
});

test("when the request is cancelled (the server is stopping), a waiting POST answers 202 at once", async () => {
  const s = await started();
  const stopping = new AbortController();

  const waiting = s.call("POST /v1/messages", "/v1/messages", { ...message({ conversationId: "c1", text: "hold", messageId: "m1" }), signal: stopping.signal });
  await s.runtime.hold.started;
  stopping.abort();

  expect(await waiting).toEqual({ status: 202, body: { requestId: "m1" } });
  s.runtime.hold.release();
  await s.app.stop();
});

test("reset points the conversation to a new session; an unknown one is a 404", async () => {
  const s = await started();
  await send(s, { conversationId: "c1", text: "hello" });

  const reset = await s.call("POST /v1/conversations/:id/reset", "/v1/conversations/c1/reset", { method: "POST", headers: AUTH });
  const unknown = await s.call("POST /v1/conversations/:id/reset", "/v1/conversations/nobody/reset", { method: "POST", headers: AUTH });

  expect(reset).toEqual({ status: 200, body: { conversationId: "c1", previousSessionId: "s1", sessionId: "s2" } });
  expect(unknown).toEqual({ status: 404, body: { error: "not_found" } });
  await s.app.stop();
});

test("its authentication stage leaves other channels' requests alone", async () => {
  const s = await started();

  const checked = await s.app.context().run("inbound.authenticate", { channel: "telegram", request: new Request("http://pikit.test/", { headers: AUTH }) });

  expect("verdict" in checked ? checked.verdict : undefined).toBeUndefined();
  await s.app.stop();
});

async function startFailure(secrets: Record<string, string>): Promise<string> {
  const app = await defineApp({ components: [secretsWith(secrets), memoryRegistry(), scriptedRuntime().component, channelHttp], logger: silentLogger }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected start() to fail");
  return String(error.cause);
}

test("it refuses to start without PIKIT_HTTP_TOKEN, or with a short one", async () => {
  expect(await startFailure({})).toContain("PIKIT_HTTP_TOKEN is not set");
  expect(await startFailure({ PIKIT_HTTP_TOKEN: "short" })).toContain("shorter than 16 characters");
});
