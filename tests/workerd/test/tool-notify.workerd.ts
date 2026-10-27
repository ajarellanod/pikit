/**
 * tool-notify on Cloudflare: conversation objects of deployment-cloudflare's real `Conversation` class
 * (`PlatformConversation`), composed as a telegram-cloudflare project with tool-notify: storage-do,
 * storage-kv-sql, actors-do, runtime-pi on the scripted model, conversations-kv, router-basic,
 * outbound-durable, channel-telegram-webhook's object half, and a test channel that admits each message
 * to the assistant.
 *
 * From conversation A's object, the model calls `notify`: the call crosses by RPC to the destination's
 * object (`idFromName("telegram:-100123")`), whose handler stores the message in its own outbox, not
 * A's. That object is evicted, and its alarm, starting a new instance, delivers it to Telegram (a fake
 * behind `globalThis.fetch`) once, with no new message.
 *
 * `Date` is a day ahead, so the alarms never fire on their own and each is fired by the test, between
 * which the object is evicted (AGENTS.md, the workerd lesson).
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type ConversationRef, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import channelTelegramWebhook from "../../../registry/components/channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import outboundDurable from "../../../registry/components/outbound-durable/files/src/pikit/outbound-durable/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolNotify from "../../../registry/components/tool-notify/files/src/pikit/tool-notify/index.ts";
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
const GROUP = -100123;
const OPS = `telegram:${GROUP}`;
const DAY = 24 * 60 * 60 * 1_000;

/** The Bot API at `API`: `sendMessage` accepts and records. */
function fakeTelegram() {
  const accepted: { chatId: number; text: string }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${API}/bot${TOKEN}/`)) return await realFetch(input, init);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: number; text: string };
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } });
    if (method !== "sendMessage") return Response.json({ ok: true, result: true });
    accepted.push({ chatId: body.chat_id, text: body.text });
    return Response.json({ ok: true, result: { message_id: accepted.length } });
  };
  return { fetch: fetch as typeof globalThis.fetch, accepted };
}

/** The assistant names `notify`, on the scripted model. */
function model(): ComponentDefinition[] {
  const agent = defineAgent({ name: "assistant", model: "faux/scripted", tools: ["notify"] });
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

/** A channel's object half: admits each message to the assistant (one conversation per key); records the requests settled. */
function channelActor(settled: string[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      pikit.on("agent.settled", (result) => void settled.push(result.requestId));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const conversation: ConversationRef = { key, agent: "assistant", conversationId: await conversations.get().create(ctx) };
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text, sender: { channel: "test", id: "alice" } }, ctx);
          });
        },
      };
    },
  });
}

/** The Worker's App: a mailbox to the objects. */
async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const worker = await defineApp({ components: [actorsDo, channel], config: { "actors-do": { binding: PLATFORM_BINDING } }, logger: silentLogger }).create();
  await worker.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    send: (key: string, message: { id: string; text: string }) => mailbox?.send(key, "test.message", message, worker.context()),
    stop: () => worker.stop(),
  };
}

const objectOf = (key: string) => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));
/** The outbox's pieces in `key`'s object: their conversation and state. */
const pieces = (key: string) =>
  runInDurableObject(objectOf(key), (_instance, state) => state.storage.sql.exec("SELECT conversation_key, state FROM outbound_durable_pieces").toArray());

it("from conversation A's object, a notify lands in the destination's object's outbox, and its alarm delivers it after an eviction", async () => {
  const telegram = fakeTelegram();
  globalThis.fetch = telegram.fetch;
  const settled: string[] = [];
  composeObjects([storageDo, storageKvSql, actorsDo, secrets, ...model(), runtimePi, conversationsKv, routerBasic, outboundDurable, channelTelegramWebhook, toolNotify, channelActor(settled)], {
    "router-basic": { defaultAgent: "assistant" },
    "channel-telegram-webhook": { apiBase: API },
    "tool-notify": { destinations: { ops: { channel: "telegram", conversation: OPS, description: "The operations group." } } },
  });
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const worker = await workerApp();
  const a = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(a, { id: "m1", text: 'call: notify {"to":"ops","text":"Deployed **v2**."}' });
    // A's alarms run the model, whose notify crosses to the destination's object.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(objectOf(a));
        expect(settled).toContain("m1");
      },
      { timeout: 10_000, interval: 200 },
    );
    // Stored in the destination's outbox, not A's; nothing sent yet.
    expect(await pieces(OPS)).toEqual([{ conversation_key: OPS, state: "pending" }]);
    expect(await pieces(a)).toEqual([]);
    expect(telegram.accepted).toEqual([]);

    // The destination's instance goes; its next alarm starts a new one, which delivers.
    await evictDurableObject(objectOf(OPS));
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(objectOf(OPS));
        expect(telegram.accepted).toEqual([{ chatId: GROUP, text: "<b>assistant:</b>\nDeployed <b>v2</b>." }]);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(await pieces(OPS)).toEqual([{ conversation_key: OPS, state: "delivered" }]);
    // Once: more alarms send nothing, and the destination's conversation never ran.
    await runDurableObjectAlarm(objectOf(OPS));
    expect(telegram.accepted).toHaveLength(1);
    expect(settled).toEqual(["m1"]);
  } finally {
    await worker.stop();
  }
});
