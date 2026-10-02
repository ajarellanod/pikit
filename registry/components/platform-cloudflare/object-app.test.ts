/**
 * platform-cloudflare with runtime-pi, in a conversation object's App: the graph a keyed
 * `actor.inbox` made a dependency cycle (the mailbox's provider depended on every handler's component,
 * which used the runtime, which used the same provider's `wakeups`). With handlers registered by
 * method, it composes, and a message delivered to the object is answered by a run its wakeups drive.
 *
 * Then the object App of a Telegram project on Cloudflare, whole: channel-telegram-webhook's object half
 * (it registers `telegram.update` with `actor.inbox` and uses `wakeups` for its deliveries), runtime-pi,
 * router-basic, and storage (pi-durable's tables), the registry and submissions in the object's SQL. An update
 * delivered to the object is answered in Telegram (a local fake of its Bot API).
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (SPEC P4), so this one lives beside `files/`. The object is the component's double (its alarm
 * on the app's clock, its SQL in `node:sqlite`); `tests/workerd` runs runtime-pi's App on a real object.
 */

import { afterAll, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, type Clock, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { ConversationRef, JsonValue } from "@pikit/contracts";
import { WORKERS_HOST, type WorkersHost } from "@pikit/contracts/cloudflare";
import { createManualClock } from "@pikit/core/testing";
import type {} from "@pikit/pi-adapter";
import { holdTool, scriptedAgent, testComponents } from "@pikit/pi-adapter/testing";
import { TYPING_EVERY_MS } from "../channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/delivery.ts";
import channelTelegramWebhook from "../channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/index.ts";
import { type FakeTelegram, startFakeTelegram } from "../channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/fake-telegram.test-support.ts";
import conversationsKv from "../conversations-kv/files/src/pikit/conversations-kv/index.ts";
import routerBasic from "../router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import { fakeDurableObjectStorage } from "../storage-do/files/src/pikit/storage-do/durable-object.test-support.ts";
import storageDo from "../storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import submissionsSql from "../submissions-sql/files/src/pikit/submissions-sql/index.ts";
import platformCloudflare from "./files/src/pikit/platform-cloudflare/index.ts";
import { simulatedObject } from "./files/src/pikit/platform-cloudflare/object.test-support.ts";

/**
 * A channel's object half, as real ones will be: it handles its messages through `actor.inbox`, admits
 * them to the runtime, and uses `wakeups` itself. Each answer is recorded in `answers`.
 */
function channelActor() {
  const answers: (string | undefined)[] = [];
  const component = defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const wakeups = pikit.use("wakeups");
      const runtime = pikit.use("agent.runtime");
      const created = pikit.use("agent.conversations");
      const conversations = new Map<string, ConversationRef>();
      pikit.on("agent.settled", (result) => void answers.push(result.text));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            let conversation = conversations.get(key);
            if (conversation === undefined) {
              conversation = { key, agent: "scripted", conversationId: await created.get().create(ctx) };
              conversations.set(key, conversation);
            }
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
          wakeups.get().handle("test-channel-actor.tidy", async () => {});
        },
      };
    },
  });
  return { component, answers };
}

/**
 * One simulated object whose storage is storage-do's double: its SQL (where pi-durable, the registry
 * and submissions keep their tables) and its transactions, with platform-cloudflare's one alarm.
 */
function objectWithStorage(options: { id?: string } = {}) {
  const storage = fakeDurableObjectStorage();
  const object = simulatedObject(storage.sql, options);
  const simulated = object.host.object as NonNullable<WorkersHost["object"]>;
  const host: WorkersHost = { env: {}, object: { ...simulated, storage: { ...(simulated.storage as object), transaction: storage.transaction } } };
  return { object, host };
}

test("an object's App composes platform-cloudflare, runtime-pi on its wakeups, and an actor that handles messages and wakes; a delivered message is answered in an alarm", async () => {
  const { object, host } = objectWithStorage();
  const { agents, provider } = testComponents();
  const actor = channelActor();
  const app = await defineApp({
    components: [actor.component, runtimePi, storageDo, agents, provider, platformCloudflare, object.component],
    logger: silentLogger,
  }).create();
  const order = app.describe().components.map((component) => component.name);
  expect(order.indexOf("platform-cloudflare")).toBeLessThan(order.indexOf("runtime-pi"));
  expect(order.indexOf("runtime-pi")).toBeLessThan(order.indexOf("test-channel-actor"));

  await app.start(withContextValue(WORKERS_HOST, host, BACKGROUND_CONTEXT));
  try {
    await object.deliver("test.message", "test:conversation-1", { id: "m1", text: "hello" } satisfies JsonValue);
    for (let waited = 0; actor.answers.length === 0 && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(actor.answers).toEqual(["answer: hello"]);
    // The run was driven inside the object's alarm (runtime-pi.drive), not by a promise left running.
    expect(object.fired()).toBeGreaterThan(0);
  } finally {
    await app.stop();
  }
});

const telegram = startFakeTelegram();
afterAll(() => telegram.stop());

const owner = { id: 1001, first_name: "Ada" };

/**
 * A Telegram project's object App over `fake`: channel-telegram-webhook's object half, runtime-pi and
 * what they use, with its storage in storage-do's double and its alarm platform-cloudflare's.
 */
async function telegramObjectApp(fake: FakeTelegram, options: { clock?: Clock; components?: ReturnType<typeof testComponents> } = {}) {
  // The object's storage: its SQL (storage-do's double) and its one alarm (platform-cloudflare's).
  const { object, host } = objectWithStorage({ id: "telegram-conversation" });
  const { agents, provider } = options.components ?? testComponents();
  const secrets = defineComponent({
    name: "secrets-test",
    setup: (pikit) =>
      pikit.provide("secrets", {
        get: async (name) => ({ TELEGRAM_BOT_TOKEN: fake.token, TELEGRAM_ALLOWED_USERS: String(owner.id) })[name],
      }),
  });
  const app = await defineApp({
    components: [
      channelTelegramWebhook,
      runtimePi,
      routerBasic,
      agents,
      provider,
      secrets,
      conversationsKv,
      submissionsSql,
      storageKvSql,
      storageDo,
      platformCloudflare,
      object.component,
    ],
    config: { "router-basic": { defaultAgent: "scripted" }, "channel-telegram-webhook": { apiBase: fake.url } },
    logger: silentLogger,
    ...(options.clock !== undefined && { clock: options.clock }),
  }).create();
  return { app, object, start: () => app.start(withContextValue(WORKERS_HOST, host, BACKGROUND_CONTEXT)) };
}

test("a Telegram project's object App composes channel-telegram-webhook's object half with platform-cloudflare and runtime-pi, and answers an update in Telegram", async () => {
  const { app, object, start } = await telegramObjectApp(telegram);
  const order = app.describe().components.map((component) => component.name);
  expect(order.indexOf("platform-cloudflare")).toBeLessThan(order.indexOf("runtime-pi"));
  expect(order.indexOf("runtime-pi")).toBeLessThan(order.indexOf("channel-telegram-webhook"));

  await start();
  try {
    // What the Worker's half sends through actor.mailbox, as the object's deliver RPC receives it.
    await object.deliver("telegram.update", `telegram:${owner.id}`, telegram.message(owner, "hello") as unknown as JsonValue);
    const [answer] = await telegram.sentCount(1, 5_000);
    expect(answer).toMatchObject({ chatId: owner.id, text: "answer: hello" });
    expect(object.fired()).toBeGreaterThan(0);
  } finally {
    await app.stop();
  }
});

test("while a slow model thinks, the chat shows \"typing\u2026\" without a gap, from the message to the answer, and not after", async () => {
  // runtime-pi.drive waits in the alarm while the run goes: the channel's renewals must still run.
  const fake = startFakeTelegram();
  const clock = createManualClock();
  const t0 = clock.now();
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  // The model's turn takes as long as the test says: `hold` returns once released.
  const components = testComponents({ agents: [scriptedAgent(holdTool(() => released.then(() => "released")))] });
  const { app, object, start } = await telegramObjectApp(fake, { clock, components });
  // What reached Telegram, on the app's clock.
  const timeline: { at: number; what: string }[] = [];
  const record = <T>(list: T[], what: (item: T) => string) => {
    const push = list.push.bind(list);
    list.push = (...items: T[]) => {
      for (const item of items) timeline.push({ at: clock.now() - t0, what: what(item) });
      return push(...items);
    };
  };
  record(fake.actions, (action) => action.action);
  record(fake.sent, (sent) => `sent: ${sent.text}`);
  // Moves the app's clock in steps, giving each step's requests to the fake Telegram real time to land.
  const pass = async (ms: number, until = () => false) => {
    for (let passed = 0; passed < ms && !until(); passed += 250) {
      await clock.advance(250);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  await start();
  try {
    await object.deliver("telegram.update", `telegram:${owner.id}`, fake.message(owner, "hold") as unknown as JsonValue);
    await pass(15_000);
    release();
    await pass(10_000, () => fake.sent.length > 0);
    expect(fake.sent.map((sent) => sent.text)).toEqual(["answer: hold"]);
    await pass(20_000);

    const answeredAt = timeline.findIndex((event) => event.what.startsWith("sent: "));
    const typing = timeline.slice(0, answeredAt).map((event) => event.at);
    expect(timeline.slice(answeredAt)).toEqual([{ at: expect.any(Number), what: "sent: answer: hold" }]);
    expect(timeline.slice(0, answeredAt).every((event) => event.what === "typing")).toBe(true);
    // From the message on, renewed before Telegram's ~5 s display ends: no gap in "typing\u2026".
    expect(typing[0]).toBeLessThan(1_000);
    expect(typing.length).toBeGreaterThanOrEqual(Math.floor(15_000 / TYPING_EVERY_MS));
    const gaps = typing.slice(1).map((at, i) => at - (typing[i] as number));
    expect(Math.max(...gaps)).toBeLessThan(5_000);
    expect(timeline[answeredAt]?.at).toBeLessThan((typing.at(-1) as number) + 5_000);
  } finally {
    await app.stop();
    await fake.stop();
  }
});
