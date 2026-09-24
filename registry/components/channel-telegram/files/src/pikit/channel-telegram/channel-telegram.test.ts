/**
 * channel-telegram's tests. They are copied with the component and keep running in your project.
 *
 * Telegram is `fake-telegram.ts`, a local stand-in of the Bot API. What the channel uses is played by
 * small doubles defined here: secrets, a conversation registry, a router stage and an agent runtime
 * whose runs answer `answer: <newest message>` (`hold` waits to be released, `fail` fails, `long`
 * answers 9000 characters). The samples run the same channel with Pi.
 */

import { afterEach, expect, test } from "bun:test";
import {
  type Admission,
  type AgentRuntime,
  type App,
  type AppContext,
  BACKGROUND_CONTEXT,
  type ConversationRef,
  type ConversationRegistry,
  defineApp,
  defineComponent,
  silentLogger,
} from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import { type FakeTelegram, startFakeTelegram } from "./fake-telegram.ts";
import channelTelegram from "./index.ts";

const OWNER = { id: 1001, first_name: "Ada", username: "ada" };
const STRANGER = { id: 2002, first_name: "Eve" };

const fakes: FakeTelegram[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const fake of fakes.splice(0)) await fake.stop();
});

function secretsWith(values: Record<string, string>) {
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => values[name] || undefined }) });
}

function memoryRegistry(resets: string[]) {
  const pointers = new Map<string, ConversationRef>();
  let sessions = 0;
  const registry: ConversationRegistry = {
    async resolve(key, agent) {
      const found = pointers.get(key) ?? { key, agent, sessionId: `s${++sessions}` };
      pointers.set(key, found);
      return found;
    },
    get: async (key) => pointers.get(key),
    async reset(key) {
      const previous = pointers.get(key);
      if (previous === undefined) return undefined;
      const conversation = { ...previous, sessionId: `s${++sessions}` };
      pointers.set(key, conversation);
      resets.push(key);
      return { conversation, previousSessionId: previous.sessionId, newSessionId: conversation.sessionId };
    },
  };
  return defineComponent({ name: "registry-test", setup: (pikit) => pikit.provide("conversations.registry", registry) });
}

const router = defineComponent({
  name: "router-test",
  setup: (pikit) => pikit.pipeline("route.resolve", (value) => (value.decision !== undefined ? value : { ...value, decision: { agent: "assistant", access: "allow" } })),
});

/** Records every dispatch; one run per session at a time; a request seen before is a duplicate. */
function scriptedRuntime(seen: Set<string> = new Set()) {
  const dispatched: { requestId: string; key: string; prompt: string }[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const component = defineComponent({
    name: "runtime-test",
    setup(pikit) {
      let events: AppContext | undefined;
      const runtime: AgentRuntime = {
        async dispatch({ requestId, conversation, prompt }) {
          dispatched.push({ requestId, key: conversation.key, prompt });
          if (seen.has(requestId)) return { kind: "duplicate", requestId } satisfies Admission;
          seen.add(requestId);
          void (async () => {
            const ctx = events ?? BACKGROUND_CONTEXT;
            await (ctx as AppContext).emit("agent.started", { conversation, requestId, resumed: false });
            if (prompt === "hold") await released;
            const base = { conversation, requestId, requestIds: [requestId], messages: [] };
            if (prompt === "fail") await (ctx as AppContext).emit("agent.failed", { ...base, kind: "failed", error: { code: "provider_error", message: "no" } });
            else await (ctx as AppContext).emit("agent.settled", { ...base, kind: "completed", text: prompt === "long" ? "word ".repeat(1800) : `answer: **${prompt}**` });
          })();
          return { kind: "started", requestId };
        },
        abort: async () => {},
        resume: async () => {},
      };
      pikit.provide("agent.runtime", runtime);
      return { start: (ctx) => void (events = ctx.derive(() => BACKGROUND_CONTEXT)) };
    },
  });
  return { component, dispatched, release: () => release() };
}

interface Subject {
  telegram: FakeTelegram;
  runtime: ReturnType<typeof scriptedRuntime>;
  resets: string[];
  app: App;
}

async function started(options: { secrets?: Record<string, string>; telegram?: FakeTelegram; seen?: Set<string> } = {}): Promise<Subject> {
  const telegram = options.telegram ?? startFakeTelegram();
  if (options.telegram === undefined) fakes.push(telegram);
  const runtime = scriptedRuntime(options.seen);
  const resets: string[] = [];
  const app = await defineApp({
    components: [
      secretsWith(options.secrets ?? { TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: String(OWNER.id) }),
      memoryRegistry(resets),
      router,
      runtime.component,
      channelTelegram,
    ],
    config: { "channel-telegram": { apiBase: telegram.url, pollTimeoutSeconds: 1 } },
    logger: silentLogger,
  }).create();
  apps.push(app);
  await app.start();
  return { telegram, runtime, resets, app };
}

async function startFailure(secrets: Record<string, string>, prepare?: (telegram: FakeTelegram) => void): Promise<string> {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  prepare?.(telegram);
  const app = await defineApp({
    components: [secretsWith(secrets), memoryRegistry([]), router, scriptedRuntime().component, channelTelegram],
    config: { "channel-telegram": { apiBase: telegram.url, pollTimeoutSeconds: 1 } },
    logger: silentLogger,
  }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected start() to fail");
  return String(error.cause);
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [secretsWith({}), memoryRegistry([]), scriptedRuntime().component, channelTelegram], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "channel-telegram")).toMatchObject({
    provides: [],
    requires: ["secrets", "conversations.registry", "agent.runtime"],
    optional: [],
  });
});

for (const c of createLifecycleConformance(() => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  return {
    component: channelTelegram,
    providers: [secretsWith({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: "1" }), memoryRegistry([]), scriptedRuntime().component],
    config: { "channel-telegram": { apiBase: telegram.url, pollTimeoutSeconds: 1 } },
  };
})) {
  test(`channel-telegram ${c.group}: ${c.name}`, () => c.run());
}

test("a message from an allowed user reaches its conversation, and the answer comes back formatted", async () => {
  const s = await started();

  s.telegram.say(OWNER, "hello");
  const [reply] = await s.telegram.sentCount(1);

  expect(s.runtime.dispatched).toEqual([{ requestId: `telegram:${OWNER.id}:1`, key: `telegram:${OWNER.id}`, prompt: "hello" }]);
  expect(reply).toEqual({ chatId: OWNER.id, text: "answer: <b>hello</b>", html: true });
});

test("the bot shows typing while the agent works", async () => {
  const s = await started();

  s.telegram.say(OWNER, "hold");
  while (s.telegram.actions.length === 0) await Bun.sleep(5);
  s.runtime.release();
  await s.telegram.sentCount(1);

  expect(s.telegram.actions[0]).toEqual({ chatId: OWNER.id, action: "typing" });
});

test("a stranger is told their id once, and nothing reaches the agent", async () => {
  const s = await started();

  s.telegram.say(STRANGER, "let me in");
  s.telegram.say(STRANGER, "please");
  s.telegram.say(OWNER, "hello");
  const sent = await s.telegram.sentCount(2);
  await Bun.sleep(50);

  expect(sent[0]).toMatchObject({ chatId: STRANGER.id, text: expect.stringContaining(`Your Telegram user id is ${STRANGER.id}`) });
  expect(s.telegram.sent.filter((m) => m.chatId === STRANGER.id)).toHaveLength(1);
  expect(s.runtime.dispatched.map((d) => d.prompt)).toEqual(["hello"]);
});

test("group messages are ignored, and a message without text gets a hint", async () => {
  const s = await started();

  s.telegram.say(OWNER, "in a group", { chat: "group" });
  s.telegram.say(OWNER, undefined);
  s.telegram.say(OWNER, undefined, { caption: "a photo caption" });
  await s.telegram.sentCount(2);

  expect(s.telegram.sent[0]).toMatchObject({ text: "I can only read text messages for now." });
  expect(s.runtime.dispatched.map((d) => d.prompt)).toEqual(["a photo caption"]);
});

test("/start and /help explain, /new starts the conversation over", async () => {
  const s = await started();

  s.telegram.say(OWNER, "/start");
  s.telegram.say(OWNER, "hello");
  s.telegram.say(OWNER, "/new@pikit_test_bot");
  await s.telegram.sentCount(3);

  expect(s.telegram.sent[0]?.text).toContain("Hi Ada! Send me a message");
  expect(s.telegram.sent[2]?.text).toBe("Started a new conversation.");
  expect(s.resets).toEqual([`telegram:${OWNER.id}`]);
  expect(s.runtime.dispatched.map((d) => d.prompt)).toEqual(["hello"]);
});

test("a failed run is told in the chat, with its error code", async () => {
  const s = await started();

  s.telegram.say(OWNER, "fail");

  expect((await s.telegram.sentCount(1))[0]?.text).toContain("something went wrong while answering (provider_error)");
});

test("a long answer is sent in pieces within Telegram's limit", async () => {
  const s = await started();

  s.telegram.say(OWNER, "long");
  await s.telegram.sentCount(3);

  for (const message of s.telegram.sent) expect(message.text.length).toBeLessThanOrEqual(4096);
});

test("HTML that Telegram refuses is sent again as plain text; a 429 is retried after retry_after", async () => {
  const s = await started();
  s.telegram.rejectHtml = true;
  s.telegram.rateLimitNextSend = 1;

  s.telegram.say(OWNER, "hello");

  expect((await s.telegram.sentCount(1, 8000))[0]).toEqual({ chatId: OWNER.id, text: "answer: **hello**", html: false });
});

test("a message Telegram delivers again (after a crash) is one request, answered once", async () => {
  const s = await started();
  s.telegram.say(OWNER, "hello");
  await s.telegram.sentCount(1);

  s.telegram.redeliver();
  while (s.runtime.dispatched.length < 2) await Bun.sleep(5);
  await Bun.sleep(50);

  // The same request id both times: the conversation answers it once.
  expect(s.runtime.dispatched.map((d) => d.requestId)).toEqual([`telegram:${OWNER.id}:1`, `telegram:${OWNER.id}:1`]);
  expect(s.telegram.sent).toHaveLength(1);
});

test("stopping confirms the handled updates to Telegram", async () => {
  const s = await started();
  s.telegram.say(OWNER, "hello");
  await s.telegram.sentCount(1);

  await s.app.stop();

  expect(s.telegram.pending()).toEqual([]);
});

test("it refuses to start without a valid token, without allowed users, or with a webhook", async () => {
  const token = startFakeTelegram().token;
  expect(await startFailure({ TELEGRAM_ALLOWED_USERS: "1" })).toContain("TELEGRAM_BOT_TOKEN is not set");
  expect(await startFailure({ TELEGRAM_BOT_TOKEN: token })).toContain("TELEGRAM_ALLOWED_USERS is empty");
  expect(await startFailure({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USERS: "@ada" })).toContain('"@ada" is not a Telegram user id');
  expect(await startFailure({ TELEGRAM_BOT_TOKEN: "1:wrong", TELEGRAM_ALLOWED_USERS: "1" })).toContain("is not valid (Telegram answered 401)");
  expect(await startFailure({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USERS: "1" }, (t) => (t.webhookUrl = "https://example.com/hook"))).toContain("has a webhook");
});
