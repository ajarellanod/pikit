/**
 * channel-web against the channel conformance suite (`@pikit/contracts/testing`), its answers
 * `pushed`: the platform is the channel's own table, which the transport writes into. The suite
 * brings the runtime, the registry, `agent.submissions`, `storage.kv`, `wakeups`, a router and its
 * stages; this fixture is a browser: each of the suite's conversations is a user of its own (the
 * accounts' double), its first message `POST /chat/api/conversations` (the page's request id, so a
 * redelivery reaches the same conversation), the next ones `POST …/messages`, sent again while the
 * API answers `503` as the page does. A user is told the refusals the API answered and the answers
 * in the transcript (`GET …/transcript`, the suite's runs write no messages: the answers delivery
 * stored). The platform fails or hangs the transport's writes.
 */

import { test } from "bun:test";
import { BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import { type ChannelTransport, compareHttpRoutes, DeliveryError, type HttpRoute, matchesHttpRoute, parseHttpRouteKey } from "@pikit/contracts";
import { createChannelConformance, type ReceivedPiece } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import type { ChatTranscriptEntry } from "./api.ts";
import { chatIdFor, parseKey } from "./chat.ts";
import { createChannelWeb } from "./index.ts";
import { FakeAccounts, secretsOf } from "./runtime.test-support.ts";

for (const c of createChannelConformance(({ conversations }) => {
  const accounts = new FakeAccounts();
  for (const conversation of conversations) accounts.add(conversation);
  let routes: { get(key: string): HttpRoute | undefined; keys(): string[] } | undefined;
  let background = BACKGROUND_CONTEXT as never;
  const server = defineComponent({
    name: "server-test",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      return {
        start(ctx) {
          routes = handle;
          background = ctx.derive(() => BACKGROUND_CONTEXT) as never;
        },
        stop() {
          routes = undefined;
        },
      };
    },
  });
  const observe = defineComponent({
    name: "observe-test",
    setup: (pikit) =>
      pikit.provide("agent.observe", {
        conversations: async () => ({ items: [] }),
        conversation: async () => undefined,
        transcript: async () => undefined,
        watch: async function* () {},
        usage: async () => undefined,
      }),
  });

  const fetch = async (path: string, init: RequestInit): Promise<Response> => {
    const request = new Request(`http://pikit.test${path}`, init);
    const { pathname } = new URL(request.url);
    const key = (routes?.keys() ?? [])
      .map((each) => ({ each, parsed: parseHttpRouteKey(each) }))
      .filter((r) => r.parsed !== undefined && matchesHttpRoute(r.parsed, request.method, pathname))
      .sort((a, b) => compareHttpRoutes(a.parsed!, b.parsed!))[0]?.each;
    const route = key === undefined ? undefined : routes?.get(key);
    // Between two Apps (a restart): nothing answers.
    if (route === undefined) return new Response(null, { status: 503 });
    return route(request, background);
  };
  const headers = (user: string) => ({ ...FakeAccounts.session(user), "x-pikit-chat": "1", "content-type": "application/json" });

  /** Each conversation's first message id and chat id (the page's request id names it). */
  const chats = new Map<string, { first: string; chatId: string }>();
  const refusals = new Map<string, string[]>();
  let disposed = false;

  /** One send, as the page does; `true` when the API took it or refused it for good. */
  const send = async (conversation: string, id: string, text: string): Promise<boolean> => {
    const chat = chats.get(conversation) as { first: string; chatId: string };
    const path = chat.first === id ? "/chat/api/conversations" : `/chat/api/conversations/${chat.chatId}/messages`;
    const response = await fetch(path, { method: "POST", headers: headers(conversation), body: JSON.stringify({ text, requestId: `web:${id}` }) });
    if (response.status === 503) return false;
    if (response.status >= 400) {
      const body = (await response.json()) as { error: string; message?: string };
      refusals.set(conversation, [...(refusals.get(conversation) ?? []), body.message ?? body.error]);
    }
    return true;
  };

  /** The transport's writes as the platform takes them; a conversation's failing or hanging ones. */
  const received = new Map<string, ReceivedPiece[]>();
  const failing = new Map<string, number>();
  const hanging = new Set<string>();
  const wrap = (inner: ChannelTransport): ChannelTransport => ({
    idempotent: inner.idempotent,
    split: (text) => inner.split(text),
    async send(piece, signal) {
      const conversation = parseKey(piece.conversationKey)?.userId ?? "";
      const left = failing.get(conversation) ?? 0;
      if (left > 0) {
        failing.set(conversation, left - 1);
        throw new DeliveryError("transient", "the platform failed for a while");
      }
      const sent = await inner.send(piece, signal);
      received.set(conversation, [...(received.get(conversation) ?? []), { text: piece.text, possibleDuplicate: piece.possibleDuplicate, key: piece.key }]);
      if (hanging.delete(conversation)) {
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return sent;
    },
  });

  return {
    components: [secretsOf(), sqliteStorage(), observe, createChannelWeb({ accounts: accounts.wiring(), transport: wrap }), server],
    async deliver({ id, conversation, text }) {
      if (!chats.has(conversation)) chats.set(conversation, { first: id, chatId: await chatIdFor(conversation, `web:${id}`) });
      if (await send(conversation, id, text)) return;
      void (async () => {
        while (!disposed) {
          await Bun.sleep(100);
          if (await send(conversation, id, text)) return;
        }
      })();
    },
    async told(conversation) {
      const chat = chats.get(conversation);
      const answers: string[] = [];
      if (chat !== undefined) {
        const response = await fetch(`/chat/api/conversations/${chat.chatId}/transcript`, { headers: headers(conversation) });
        if (response.status === 200) {
          const { items } = (await response.json()) as { items: ChatTranscriptEntry[] };
          const messages = items.flatMap((entry) => entry.messages as { role: string; content: { type: string; text?: string }[] }[]).reverse();
          answers.push(...messages.filter((each) => each.role === "assistant").map((each) => each.content.map((block) => block.text ?? "").join("")));
        }
      }
      return [...(refusals.get(conversation) ?? []), ...answers];
    },
    platform: {
      fail: (conversation, count) => void failing.set(conversation, count),
      hang: (conversation) => void hanging.add(conversation),
      received: (conversation) => received.get(conversation) ?? [],
    },
    dispose: async () => {
      disposed = true;
    },
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run(), 15_000);
}
