/**
 * Answer delivery without an outbox (`startAnswerDelivery` sending directly, its retries as wakeups),
 * in a real object of deployment-cloudflare's `Conversation` class (`PlatformConversation`), composed
 * as the telegram-cloudflare preset composes a conversation's object minus `outbound-durable`:
 * storage-do, storage-kv-sql, platform-cloudflare, runtime-pi, conversations-kv, router-basic and
 * channel-telegram-webhook's object half, with the scripted model and secrets of the test's own.
 *
 * Telegram is a fake behind `globalThis.fetch` (the tests and the objects share one isolate). Its
 * first `sendMessage` is refused with a 429, so the answer waits for its retry, a wakeup row; the
 * object is evicted then, and the next instance, started by that alarm, delivers it once.
 *
 * `Date` is a day ahead, so the alarms never fire on their own and each is fired by the test, between
 * which the object is evicted (AGENTS.md, the workerd lesson).
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { ActorMailbox } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { holdTool, scriptedAgent, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import channelTelegramWebhook, { UPDATE_TYPE } from "../../../registry/components/channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  await resetObjects();
});

const API = "https://telegram.test";
const TOKEN = "123:test-token";
const USER = { id: 1001, is_bot: false, first_name: "Ada" };

/** The Bot API at `API`: `sendMessage` refuses the first `refuse` sends with a 429, then accepts and records. */
function fakeTelegram(refuse: number) {
  const accepted: { chatId: number; text: string }[] = [];
  let refused = 0;
  const ok = (result: unknown) => Response.json({ ok: true, result });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${API}/bot${TOKEN}/`)) return await realFetch(input, init);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: number; text: string };
    if (method === "getMe") return ok({ id: 1, is_bot: true, first_name: "Bot", username: "test_bot" });
    if (method === "sendChatAction") return ok(true);
    if (method !== "sendMessage") return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
    if (refused < refuse) {
      refused++;
      return Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 300 } }, { status: 429 });
    }
    accepted.push({ chatId: body.chat_id, text: body.text });
    return ok({ message_id: accepted.length });
  };
  return { fetch: fetch as typeof globalThis.fetch, accepted, refused: () => refused };
}

/** The scripted agent and model: each run answers `answer: <message>`. */
function model(): ComponentDefinition[] {
  const agent = scriptedAgent(holdTool(async () => "released"));
  const provider = scriptedProvider();
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

const secrets = defineComponent({
  name: "secrets-test",
  setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => (name === "TELEGRAM_BOT_TOKEN" ? TOKEN : undefined) }),
});

/** The Worker's App, which hands updates to the objects through `actor.mailbox`, as the channel's Worker half does. */
async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const worker = await defineApp({ components: [platformCloudflare, channel], config: { "platform-cloudflare": { binding: PLATFORM_BINDING } }, logger: silentLogger }).create();
  await worker.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    write: (key: string, messageId: number, text: string) =>
      mailbox?.send(
        key,
        UPDATE_TYPE,
        { update_id: messageId, message: { message_id: messageId, from: USER, chat: { id: USER.id, type: "private" }, date: Math.floor(Date.now() / 1_000), text } },
        worker.context(),
      ),
    stop: () => worker.stop(),
  };
}

const DAY = 24 * 60 * 60 * 1_000;

it("an answer delivered directly (no outbox) waits for its retry across an eviction, and the next instance delivers it once", async () => {
  const telegram = fakeTelegram(1);
  globalThis.fetch = telegram.fetch;
  composeObjects([storageDo, storageKvSql, platformCloudflare, secrets, ...model(), runtimePi, conversationsKv, routerBasic, channelTelegramWebhook], {
    "router-basic": { defaultAgent: "scripted" },
    "channel-telegram-webhook": { apiBase: API },
  });
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const worker = await workerApp();
  const key = `telegram:${USER.id}`;
  const object = () => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));
  /** The delivery's retry row, read in the object. */
  const retryAt = () =>
    runInDurableObject(object(), (_instance, state) =>
      state.storage.sql.exec("SELECT time FROM platform_cloudflare_wakeups WHERE name = ?", "channel-telegram-webhook.answers").toArray()[0]?.time as number | undefined,
    );
  try {
    await worker.write(key, 1, "hello");
    // The alarms run the model, then the delivery, whose send Telegram refuses: it waits 300 s.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(object());
        expect(telegram.refused()).toBe(1);
        expect(await retryAt()).toBeGreaterThan(Date.now() + 200_000);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(telegram.accepted).toEqual([]);

    // Between two of its alarms: the instance goes; the answer, its cursor and the retry stay.
    await evictDurableObject(object());
    vi.useFakeTimers({ toFake: ["Date"], now: ((await retryAt()) as number) + 1_000, shouldAdvanceTime: true });
    // The next instance starts its App at that alarm and delivers the answer.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(object());
        expect(telegram.accepted).toEqual([{ chatId: USER.id, text: "answer: hello" }]);
      },
      { timeout: 10_000, interval: 200 },
    );
    // Once: nothing is left to deliver, and more alarms send nothing.
    expect(await retryAt()).toBeUndefined();
    await runDurableObjectAlarm(object());
    expect(telegram.accepted).toHaveLength(1);
    expect(telegram.refused()).toBe(1);
  } finally {
    await worker.stop();
  }
});
