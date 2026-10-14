// Owner: integration. The channel and lifecycle conformance suites, on a server's App and on Cloudflare's two halves.
/**
 * channel-google-chat against the channel conformance suite (`@pikit/contracts/testing`) and the
 * lifecycle suite (`@pikit/core/testing`). The channel suite brings the runtime, the conversation
 * registry, `agent.submissions`, `storage.kv`, `wakeups`, a router and stages that halt, deny or move
 * messages; this fixture speaks Google Chat through `fake-google-chat.test-support.ts`, every event
 * signed and posted over real HTTP to the app's endpoint.
 *
 * - **On a server**: the default export alone serves its route (a test server, as server-bun does) and
 *   hands each event to the handler in process.
 * - **On Cloudflare**: two Apps. The Worker's (the Worker half, `worker`) serves the route and hands
 *   each event to its conversation's object through `actor.mailbox`; the suite's App is the objects'
 *   (the default export, `actor.inbox` with the scope `"one"`), whose handlers the mailbox reaches in
 *   memory. The Worker's App outlives the objects' restarts, as a Worker does.
 *
 * Each of the suite's conversations is a thread of an allowed space (`spaces/<conversation>`, its
 * thread `main`). Delivering an id again is Google posting the same event again, as it does by itself
 * while the endpoint answers 5xx. The platform fails a space's answers with a 503, or takes one and
 * never answers; an answer's sends are the creations that are not "Thinking…" and the edits of the
 * text and cards (a preview edits the text only), under the piece's `messageId`: a send again is
 * under the same key. What it took is what it answered 2xx, or never answered (an edit of a
 * placeholder that is not there, answered 404, is followed by its creation).
 */

import { afterAll, test } from "bun:test";
import { type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { ActorCallHandler, ActorInboxHandler, ActorMailbox, AgentRuntime, ConversationRegistry, JsonValue } from "@pikit/contracts";
import { type ChannelFixture, createChannelConformance, createMemoryKeyValueStorage, createMemorySubmissions, createMemoryWakeups } from "@pikit/contracts/testing";
import type { AddOnEvent, ChatMessage } from "./event.ts";
import { eventRequest, type FakeCall, type FakeGoogleChat, googleError, messageEvent, startFakeGoogleChat } from "./fake-google-chat.test-support.ts";
import channelGoogleChat, { NAME, worker, WORKER_NAME } from "./index.ts";

const THINKING = "Thinking…";

const secretsOf = (values: Record<string, string>): ComponentDefinition =>
  defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => values[name] || undefined }) });

/** Serves an App's routes over real HTTP, as server-bun does; `url()` once started. */
function httpServer() {
  let url = "";
  const component = defineComponent({
    name: "server-test",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      let serving: ReturnType<typeof Bun.serve> | undefined;
      return {
        start(ctx) {
          const background = ctx.derive(() => BACKGROUND_CONTEXT);
          serving = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: async (request) => (await routes.get(`${request.method} ${new URL(request.url).pathname}`)?.(request, background)) ?? new Response(null, { status: 404 }),
          });
          url = `http://127.0.0.1:${serving.port}`;
        },
        stop: () => serving?.stop(true),
      };
    },
  });
  return { component, url: () => url };
}

/**
 * `actor.inbox` (scope `"one"`) in the objects' App and `actor.mailbox` in both Apps, in memory: the
 * Worker's `send` and `call` reach the handlers the running objects' App registered, with a copy of the
 * message and a context of that App's. Nothing running there: the hand-off rejects (the route answers 500).
 */
function objectsMailbox() {
  const handlers = new Map<string, ActorInboxHandler>();
  const answerers = new Map<string, ActorCallHandler>();
  let running: AppContext | undefined;
  const copy = (message: JsonValue): JsonValue => JSON.parse(JSON.stringify(message)) as JsonValue;
  const reach = <T,>(found: T | undefined, type: string): { handler: T; ctx: AppContext } => {
    if (found === undefined || running === undefined) throw new Error(`the conversation's object does not handle "${type}" now`);
    return { handler: found, ctx: running };
  };
  const mailbox: ActorMailbox = {
    async send(key, type, message) {
      const { handler, ctx } = reach(handlers.get(type), type);
      await handler(key, copy(message), ctx);
    },
    async call(key, type, message) {
      const { handler, ctx } = reach(answerers.get(type), type);
      return copy(await handler(key, copy(message), ctx));
    },
    stream: () => Promise.reject(new Error("no streams here")),
  };
  const objects = defineComponent({
    name: "objects-test",
    setup(pikit) {
      pikit.provide("actor.inbox", { scope: "one", handle: (type, handler) => void handlers.set(type, handler), answer: (type, handler) => void answerers.set(type, handler), answerStream: () => {} });
      pikit.provide("actor.mailbox", mailbox);
      return {
        start: (ctx) => void (running = ctx.derive(() => BACKGROUND_CONTEXT)),
        stop() {
          running = undefined;
          handlers.clear();
          answerers.clear();
        },
      };
    },
  });
  const inWorker = defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", mailbox) });
  return { objects, inWorker };
}

/** The suite's conversation `conversation`: a space's thread. */
const spaceOf = (conversation: string) => `spaces/${conversation}`;

/** The fixture of one case: the Google side, and the components on each target's shape. */
async function fixtureOn(target: "server" | "cloudflare", conversations: readonly string[]): Promise<ChannelFixture> {
  const google = await startFakeGoogleChat();
  const secrets = google.secrets(conversations.map(spaceOf));
  const config = { apiBase: google.apiBase, jwksUrl: google.jwksUrl };
  const server = httpServer();
  let components: ComponentDefinition[];
  let stopWorker = async () => {};
  if (target === "server") {
    components = [secretsOf(secrets), channelGoogleChat, server.component];
  } else {
    const mailbox = objectsMailbox();
    components = [secretsOf(secrets), mailbox.objects, channelGoogleChat];
    const workerApp = await defineApp({ components: [secretsOf(secrets), mailbox.inWorker, worker, server.component], config: { [WORKER_NAME]: config }, logger: silentLogger }).create();
    await workerApp.start();
    stopWorker = () => workerApp.stop();
  }

  /** An answer's send in `space`: a creation that is not the placeholder, an edit of the text and the cards. */
  const answerSend = (space: string) => (call: FakeCall) =>
    call.path.startsWith(`/v1/${space}/messages`) &&
    ((call.method === "POST" && (call.body as ChatMessage | undefined)?.text !== THINKING) || (call.method === "PATCH" && (call.query.updateMask ?? "").includes("cardsV2")));

  const events = new Map<string, AddOnEvent>();
  let disposed = false;
  const post = async (event: AddOnEvent): Promise<number> => {
    const response = await fetch(eventRequest(`${server.url()}/google-chat`, event, await google.idTokens.bearer())).catch(() => undefined);
    await response?.arrayBuffer();
    return response?.status ?? 0;
  };
  /** Posts `event` again, a moment later, while the endpoint answers 5xx or does not answer, as Google does. */
  const postUntilTaken = async (event: AddOnEvent): Promise<void> => {
    while (!disposed) {
      await Bun.sleep(100);
      const status = await post(event);
      if (status > 0 && status < 500) return;
    }
  };
  const told = (conversation: string): string[] =>
    [...google.messages.values()].filter((message) => message.space?.name === spaceOf(conversation) && message.sender?.type === "BOT" && message.text !== THINKING).map((message) => message.text ?? "");

  return {
    components,
    config: { [NAME]: config },
    async deliver({ id, conversation, text }) {
      const space = spaceOf(conversation);
      const event = events.get(id) ?? messageEvent({ space, thread: `${space}/threads/main`, name: `${space}/messages/${id}`, text });
      events.set(id, event);
      const status = await post(event);
      if (status === 0 || status >= 500) void postUntilTaken(event);
    },
    told,
    platform: {
      fail: (conversation, count) => google.fail(answerSend(spaceOf(conversation)), googleError(503, "UNAVAILABLE", "The service is currently unavailable."), count),
      hang: (conversation) => google.fail(answerSend(spaceOf(conversation)), "hang", 1),
      // What Google took: a send it answered 2xx, or one it never answered (the one left hanging).
      received: (conversation) =>
        google.callsTo(answerSend(spaceOf(conversation))).flatMap((call) => {
          if (call.status !== undefined && call.status >= 300) return [];
          const body = call.body as ChatMessage | undefined;
          return [{ text: body?.text ?? "", possibleDuplicate: false, key: call.method === "POST" ? (call.query.messageId ?? "") : (call.path.split("/").at(-1) ?? "") }];
        }),
    },
    async dispose() {
      disposed = true;
      await stopWorker();
      await google.stop();
    },
  };
}

for (const target of ["server", "cloudflare"] as const) {
  for (const c of createChannelConformance(({ conversations }) => fixtureOn(target, conversations), { resetCommand: "/new", timeoutMs: 10_000 })) {
    test(`on ${target === "server" ? "a server" : "Cloudflare's two halves"}: ${c.group}: ${c.name}`, () => c.run(), 20_000);
  }
}

// ---------------------------------------------------------------------------------------------------
// Lifecycle: each App's component starts and stops, also when its hooks are cut

const lifecycleFakes: FakeGoogleChat[] = [];
afterAll(async () => {
  for (const fake of lifecycleFakes.splice(0)) await fake.stop();
});

/** Nothing here may be called by a start or a stop. */
const untouched = <T extends object>(what: string): T =>
  new Proxy({} as T, { get: (_target, property) => (property === "then" ? undefined : () => Promise.reject(new Error(`${what}.${String(property)} called`))) });

async function lifecycleGoogle() {
  const google = await startFakeGoogleChat();
  lifecycleFakes.push(google);
  return { google, config: { apiBase: google.apiBase, jwksUrl: google.jwksUrl } };
}

const provide = (name: string, capability: string, value: unknown): ComponentDefinition => defineComponent({ name, setup: (pikit) => pikit.provide(capability as "secrets", value as never) });

/** What the default export requires besides secrets. */
const defaultProviders = () => [
  provide("registry-test", "conversations.registry", untouched<ConversationRegistry>("conversations.registry")),
  provide("runtime-test", "agent.runtime", untouched<AgentRuntime>("agent.runtime")),
  provide("submissions-test", "agent.submissions", createMemorySubmissions().submissions),
  provide("kv-test", "storage.kv", createMemoryKeyValueStorage()),
  createMemoryWakeups(),
];

for (const c of createLifecycleConformance(async () => {
  const { google, config } = await lifecycleGoogle();
  return { component: channelGoogleChat, providers: [secretsOf(google.secrets(["spaces/AAA"])), ...defaultProviders()], config: { [NAME]: config } };
})) {
  test(`on a server: ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createLifecycleConformance(async () => {
  const { google, config } = await lifecycleGoogle();
  return { component: channelGoogleChat, providers: [secretsOf(google.secrets(["spaces/AAA"])), ...defaultProviders(), objectsMailbox().objects], config: { [NAME]: config } };
})) {
  test(`on Cloudflare, a conversation's object: ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createLifecycleConformance(async () => {
  const { google, config } = await lifecycleGoogle();
  return { component: worker, providers: [secretsOf(google.secrets(["spaces/AAA"])), provide("mailbox-test", "actor.mailbox", untouched<ActorMailbox>("actor.mailbox"))], config: { [WORKER_NAME]: config } };
})) {
  test(`on Cloudflare, the Worker: ${c.group}: ${c.name}`, () => c.run());
}
