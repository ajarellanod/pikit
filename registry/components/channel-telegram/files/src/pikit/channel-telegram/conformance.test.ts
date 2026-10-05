/**
 * channel-telegram against the channel conformance suite (`@pikit/contracts/testing`): what every
 * channel does with a message, and how its answers survive what happens to the process. The suite
 * brings the runtime, the conversation registry, `agent.submissions`, `storage.kv`, a router and
 * stages that halt, deny or move messages; this fixture speaks Telegram through `fake-telegram.test-support.ts`.
 * Each of the suite's conversations is an allowed user's private chat; delivering an id again is
 * Telegram redelivering the update, as after a crash. The platform fails a chat's sends with a 502,
 * or takes one and never answers; a piece sent again as a possible duplicate starts with `↻ `.
 */

import { test } from "bun:test";
import { defineComponent } from "@pikit/core";
import { createChannelConformance } from "@pikit/contracts/testing";
import { startFakeTelegram } from "./fake-telegram.test-support.ts";
import channelTelegram from "./index.ts";
import { POSSIBLE_DUPLICATE_MARK } from "./transport.ts";

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
  const told = (conversation: string) => telegram.sent.filter((m) => m.chatId === user(conversation).id).map((m) => m.text);
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
    told,
    platform: {
      fail: (conversation, count) => void telegram.failChat.set(user(conversation).id, count),
      hang: (conversation) => void telegram.hangChat.add(user(conversation).id),
      received: (conversation) => told(conversation).map((text) => ({ text, possibleDuplicate: text.startsWith(POSSIBLE_DUPLICATE_MARK) })),
    },
    dispose: () => telegram.stop(),
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run(), 15_000);
}
