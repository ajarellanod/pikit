/**
 * platform-cloudflare with runtime-pi, in a conversation object's App: the graph a keyed
 * `actor.inbox` made a dependency cycle (the mailbox's provider depended on every handler's component,
 * which used the runtime, which used the same provider's `wakeups`). With handlers registered by
 * method, it composes, and a message delivered to the object is answered by a run its wakeups drive.
 *
 * Then the object App of a Telegram project on Cloudflare, whole: channel-telegram-webhook's object half
 * (it registers `telegram.update` with `actor.inbox` and uses `wakeups` for its deliveries), runtime-pi,
 * router-basic, and storage, sessions, the registry and submissions in the object's SQL. An update
 * delivered to the object is answered in Telegram (a local fake of its Bot API).
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (SPEC P4), so this one lives beside `files/`. The object is the component's double (its alarm
 * on the app's clock, its SQL in `node:sqlite`); `tests/workerd` runs runtime-pi's App on a real object.
 */

import { afterAll, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ConversationRef, type JsonValue, WORKERS_HOST, type WorkersHost } from "@pikit/contracts";
import type {} from "@pikit/pi-adapter";
import { testComponents } from "@pikit/pi-adapter/testing";
import channelTelegramWebhook from "../channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/index.ts";
import { startFakeTelegram } from "../channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/fake-telegram.test-support.ts";
import conversationsKv from "../conversations-kv/files/src/pikit/conversations-kv/index.ts";
import routerBasic from "../router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import sessionsSql from "../sessions-sql/files/src/pikit/sessions-sql/index.ts";
import { fakeDurableObjectStorage } from "../storage-do/files/src/pikit/storage-do/durable-object.test-support.ts";
import storageDo from "../storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import submissionsSql from "../submissions-sql/files/src/pikit/submissions-sql/index.ts";
import platformCloudflare from "./files/src/pikit/platform-cloudflare/index.ts";
import { simulatedObject } from "./files/src/pikit/platform-cloudflare/object.test-support.ts";
import { fakeSql } from "./files/src/pikit/platform-cloudflare/sql.test-support.ts";

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
      const sessions = pikit.use("sessions.store");
      const conversations = new Map<string, ConversationRef>();
      pikit.on("agent.settled", (result) => void answers.push(result.text));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            let conversation = conversations.get(key);
            if (conversation === undefined) {
              const session = await sessions.get().create({ cwd: "/" }, ctx);
              await session.close(ctx);
              conversation = { key, agent: "scripted", sessionId: session.metadata.id };
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

test("an object's App composes platform-cloudflare, runtime-pi on its wakeups, and an actor that handles messages and wakes; a delivered message is answered in an alarm", async () => {
  const object = simulatedObject(fakeSql());
  const { sessions, agents, provider } = testComponents();
  const actor = channelActor();
  const app = await defineApp({
    components: [actor.component, runtimePi, sessions, agents, provider, platformCloudflare, object.component],
    logger: silentLogger,
  }).create();
  const order = app.describe().components.map((component) => component.name);
  expect(order.indexOf("platform-cloudflare")).toBeLessThan(order.indexOf("runtime-pi"));
  expect(order.indexOf("runtime-pi")).toBeLessThan(order.indexOf("test-channel-actor"));

  await app.start(withContextValue(WORKERS_HOST, object.host, BACKGROUND_CONTEXT));
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

test("a Telegram project's object App composes channel-telegram-webhook's object half with platform-cloudflare and runtime-pi, and answers an update in Telegram", async () => {
  // The object's storage: its SQL (storage-do's double) and its one alarm (platform-cloudflare's).
  const storage = fakeDurableObjectStorage();
  const object = simulatedObject(storage.sql, { id: "telegram-conversation" });
  const simulated = object.host.object as NonNullable<WorkersHost["object"]>;
  const host: WorkersHost = { env: {}, object: { ...simulated, storage: { ...(simulated.storage as object), transaction: storage.transaction } } };
  const { agents, provider } = testComponents();
  const owner = { id: 1001, first_name: "Ada" };
  const secrets = defineComponent({
    name: "secrets-test",
    setup: (pikit) =>
      pikit.provide("secrets", {
        get: async (name) => ({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: String(owner.id) })[name],
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
      sessionsSql,
      storageKvSql,
      storageDo,
      platformCloudflare,
      object.component,
    ],
    config: { "router-basic": { defaultAgent: "scripted" }, "channel-telegram-webhook": { apiBase: telegram.url } },
    logger: silentLogger,
  }).create();
  const order = app.describe().components.map((component) => component.name);
  expect(order.indexOf("platform-cloudflare")).toBeLessThan(order.indexOf("runtime-pi"));
  expect(order.indexOf("runtime-pi")).toBeLessThan(order.indexOf("channel-telegram-webhook"));

  await app.start(withContextValue(WORKERS_HOST, host, BACKGROUND_CONTEXT));
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
