/**
 * channel-telegram against the channel conformance suite (`@pikit/core/testing`): what every channel
 * does with a message. The suite brings the runtime, the conversation registry, a router and stages
 * that halt, deny or move messages; this fixture speaks Telegram through `fake-telegram.ts`. Each of
 * the suite's conversations is an allowed user's private chat; delivering an id again is Telegram
 * redelivering the update, as after a crash.
 */

import { test } from "bun:test";
import { defineComponent } from "@pikit/core";
import { createChannelConformance } from "@pikit/core/testing";
import { startFakeTelegram } from "./fake-telegram.ts";
import channelTelegram from "./index.ts";

for (const c of createChannelConformance(({ conversations }) => {
  const telegram = startFakeTelegram();
  const users = new Map(conversations.map((conversation, i) => [conversation, { id: 3001 + i, first_name: conversation }]));
  const user = (conversation: string) => {
    const found = users.get(conversation);
    if (found === undefined) throw new Error(`no user for the conversation "${conversation}"`);
    return found;
  };
  const secrets: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: telegram.token,
    TELEGRAM_ALLOWED_USERS: [...users.values()].map((u) => u.id).join(","),
  };
  const delivered = new Set<string>();
  return {
    components: [
      channelTelegram,
      defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => secrets[name] }) }),
    ],
    config: { "channel-telegram": { apiBase: telegram.url, pollTimeoutSeconds: 1 } },
    async deliver({ id, conversation, text }) {
      if (delivered.has(id)) {
        telegram.redeliver();
        return;
      }
      delivered.add(id);
      telegram.say(user(conversation), text);
    },
    told: (conversation) => telegram.sent.filter((m) => m.chatId === user(conversation).id).map((m) => m.text),
    dispose: () => telegram.stop(),
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run(), 15_000);
}
