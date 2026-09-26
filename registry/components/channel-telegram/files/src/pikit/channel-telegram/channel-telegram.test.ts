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
  type ChannelTransport,
  DeliveryError,
  defineApp,
  defineComponent,
  type OutboundMessage,
  type OutboundQueue,
  silentLogger,
} from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import { type FakeTelegram, startFakeTelegram } from "./fake-telegram.ts";
import { accountsOf, chatIn, conversationKeyOf } from "./account.ts";
import { createTelegramApi } from "./api.ts";
import channelTelegram from "./index.ts";
import { createTelegramTransport, POSSIBLE_DUPLICATE_MARK } from "./transport.ts";

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

/** A queue that records what the channel does with it, and delivers each enqueued piece at once through the attached transport. */
function recordingQueue() {
  const enqueued: OutboundMessage[] = [];
  const attached: string[] = [];
  const detached: string[] = [];
  const transports = new Map<string, ChannelTransport>();
  const queue: OutboundQueue = {
    async enqueue(message) {
      enqueued.push(message);
      const transport = transports.get(message.channel);
      if (transport === undefined) throw new Error("no transport");
      for (const [index, text] of transport.split(message.text).entries()) {
        await transport.send({ key: `${message.idempotencyKey}#${index}`, conversationKey: message.conversationKey, text, possibleDuplicate: false }, new AbortController().signal);
      }
    },
    attach(channel, transport) {
      attached.push(channel);
      transports.set(channel, transport);
    },
    async detach(channel) {
      detached.push(channel);
      transports.delete(channel);
    },
  };
  const component = defineComponent({ name: "queue-test", setup: (pikit) => pikit.provide("outbound.queue", queue) });
  return { component, enqueued, attached, detached };
}

async function started(options: { secrets?: Record<string, string>; telegram?: FakeTelegram; seen?: Set<string>; queue?: ReturnType<typeof recordingQueue> } = {}): Promise<Subject> {
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
      ...(options.queue === undefined ? [] : [options.queue.component]),
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
    optional: ["outbound.queue"],
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

// ---------------------------------------------------------------------------------------------
// Durable delivery: the transport, and the channel with an outbound.queue (SPEC §5).

function transportOver(telegram: FakeTelegram) {
  return createTelegramTransport(createTelegramApi(telegram.token, telegram.url), "telegram");
}

test("the transport sends a piece as HTML and returns Telegram's message id; a possible duplicate is marked", async () => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const transport = transportOver(telegram);
  const signal = new AbortController().signal;
  expect(transport.idempotent).toBe(false);

  const sent = await transport.send({ key: "k#0", conversationKey: `telegram:${OWNER.id}`, text: "**hi**", possibleDuplicate: false }, signal);
  await transport.send({ key: "k#1", conversationKey: `telegram:${OWNER.id}`, text: "again", possibleDuplicate: true }, signal);

  expect(sent.platformMessageId).toMatch(/^\d+$/);
  expect(telegram.sent).toEqual([
    { chatId: OWNER.id, text: "<b>hi</b>", html: true },
    { chatId: OWNER.id, text: `${POSSIBLE_DUPLICATE_MARK}again`, html: true },
  ]);
});

test("the transport falls back to plain text when Telegram refuses the HTML", async () => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  telegram.rejectHtml = true;
  await transportOver(telegram).send({ key: "k#0", conversationKey: `telegram:${OWNER.id}`, text: "**hi**", possibleDuplicate: false }, new AbortController().signal);
  expect(telegram.sent).toEqual([{ chatId: OWNER.id, text: "**hi**", html: false }]);
});

test("the transport classifies Telegram's refusals for the queue", async () => {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const transport = transportOver(telegram);
  const piece = { key: "k#0", conversationKey: `telegram:${OWNER.id}`, text: "hi", possibleDuplicate: false };
  const failure = (): Promise<DeliveryError> =>
    transport.send(piece, new AbortController().signal).then(
      () => {
        throw new Error("expected the send to fail");
      },
      (error: unknown) => error as DeliveryError,
    );

  telegram.rateLimitNextSend = 7;
  const limited = await failure();
  expect([limited.kind, limited.retryAfterMs]).toEqual(["rate_limited", 7000]);

  telegram.failNextSend = { code: 403, description: "Forbidden: bot was blocked by the user" };
  expect((await failure()).kind).toBe("permanent");

  telegram.failNextSend = { code: 500, description: "Internal Server Error" };
  const transient = await failure();
  expect([transient.kind, transient.maybeSent]).toEqual(["transient", false]);

  const foreign = await transport.send({ ...piece, conversationKey: "http:abc" }, new AbortController().signal).catch((error: unknown) => error as DeliveryError);
  expect(foreign).toBeInstanceOf(DeliveryError);
  expect((foreign as DeliveryError).kind).toBe("permanent");
});

test("with an outbound.queue, the answer is enqueued once per run and delivered through the attached transport", async () => {
  const queue = recordingQueue();
  const { telegram, app } = await started({ queue });
  expect(queue.attached).toEqual(["telegram"]);

  telegram.say(OWNER, "hello");
  await telegram.sentCount(1);
  expect(queue.enqueued).toEqual([
    { idempotencyKey: `s1:telegram:${OWNER.id}:1`, channel: "telegram", conversationKey: `telegram:${OWNER.id}`, text: "answer: **hello**" },
  ]);
  expect(telegram.sent[0]).toEqual({ chatId: OWNER.id, text: "answer: <b>hello</b>", html: true });

  await app.stop();
  expect(queue.detached).toEqual(["telegram"]);
});

// ---------------------------------------------------------------------------------------------
// Accounts: several bots in one channel, each its own instance (SPEC §5, "Channels, accounts and keys").

test("accounts: the default bot keeps its keys and secrets; a named one gets its own", () => {
  expect(accountsOf(["ops", "customer-care"])).toEqual([
    { name: undefined, instance: "telegram", tokenSecret: "TELEGRAM_BOT_TOKEN", allowedSecret: "TELEGRAM_ALLOWED_USERS" },
    { name: "ops", instance: "telegram:ops", tokenSecret: "TELEGRAM_OPS_BOT_TOKEN", allowedSecret: "TELEGRAM_OPS_ALLOWED_USERS" },
    { name: "customer-care", instance: "telegram:customer-care", tokenSecret: "TELEGRAM_CUSTOMER_CARE_BOT_TOKEN", allowedSecret: "TELEGRAM_CUSTOMER_CARE_ALLOWED_USERS" },
  ]);
  expect(conversationKeyOf("telegram:ops", 42)).toBe("telegram:ops:42");
  expect(chatIn("telegram", "telegram:42")).toBe(42);
  expect(chatIn("telegram", "telegram:ops:42")).toBeUndefined();
  expect(chatIn("telegram:ops", "telegram:ops:-42")).toBe(-42);
  expect(chatIn("telegram:ops", "telegram:42")).toBeUndefined();
});

const OPS_BOT = { id: 5353, is_bot: true, first_name: "Ops Bot", username: "acme_ops_bot" };
const OPS_TOKEN = "555555:ops-token-for-tests";
const OPERATOR = { id: 3003, first_name: "Olga" };

async function twoBots(secrets: Record<string, string>) {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const ops = telegram.addBot(OPS_TOKEN, OPS_BOT);
  const runtime = scriptedRuntime();
  const app = await defineApp({
    components: [secretsWith(secrets), memoryRegistry([]), router, runtime.component, channelTelegram],
    config: { "channel-telegram": { apiBase: telegram.url, pollTimeoutSeconds: 1, accounts: ["ops"] } },
    logger: silentLogger,
  }).create();
  apps.push(app);
  return { telegram, ops, runtime, app };
}

test("accounts: two bots run side by side, each with its own users, conversations and answers", async () => {
  const { telegram, ops, runtime, app } = await twoBots({
    TELEGRAM_BOT_TOKEN: "123456789:fake-token-for-tests",
    TELEGRAM_ALLOWED_USERS: String(OWNER.id),
    TELEGRAM_OPS_BOT_TOKEN: OPS_TOKEN,
    TELEGRAM_OPS_ALLOWED_USERS: String(OPERATOR.id),
  });
  await app.start();

  telegram.say(OWNER, "to the default bot");
  ops.say(OPERATOR, "to the ops bot");
  await telegram.sentCount(1);
  await ops.sentCount(1);

  expect(runtime.dispatched.map((d) => [d.key, d.requestId]).sort()).toEqual(
    [
      [`telegram:${OWNER.id}`, `telegram:${OWNER.id}:1`],
      [`telegram:ops:${OPERATOR.id}`, `telegram:ops:${OPERATOR.id}:1`],
    ].sort(),
  );
  expect(telegram.sent).toEqual([{ chatId: OWNER.id, text: "answer: <b>to the default bot</b>", html: true }]);
  expect(ops.sent).toEqual([{ chatId: OPERATOR.id, text: "answer: <b>to the ops bot</b>", html: true }]);

  // Each bot has its own allowlist: the owner is a stranger to the ops bot.
  ops.say(OWNER, "let me in");
  const [, refused] = await ops.sentCount(2);
  expect(refused?.text).toContain(`Your Telegram user id is ${OWNER.id}`);
  expect(runtime.dispatched).toHaveLength(2);
});

test("accounts: a named bot without its token fails the start, and leaves no bot polling", async () => {
  const { telegram, app } = await twoBots({
    TELEGRAM_BOT_TOKEN: "123456789:fake-token-for-tests",
    TELEGRAM_ALLOWED_USERS: String(OWNER.id),
  });
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
  expect(String((error?.cause as Error | undefined)?.message)).toContain("TELEGRAM_OPS_BOT_TOKEN is not set");
  // The default bot's first poll may have been in flight when the start failed; none follows it.
  await Bun.sleep(300);
  const polls = telegram.offsets.length;
  await Bun.sleep(1_500);
  expect(telegram.offsets.length).toBe(polls);
});

