/**
 * channel-http against the channel conformance suite (`@pikit/core/testing`): what every channel does
 * with a message. The suite brings the runtime, the conversation registry, a router and stages that
 * halt, deny or move messages; this fixture speaks HTTP. It calls `POST /v1/messages` as a server
 * would, with no socket: what a sender is told is each response (status and body), and a handler
 * that throws is the `500` a server answers. Delivering an id again is a client retrying with the
 * same `messageId`.
 */

import { test } from "bun:test";
import { type AppContext, BACKGROUND_CONTEXT, defineComponent, type HttpRoute } from "@pikit/core";
import { createChannelConformance } from "@pikit/core/testing";
import channelHttp from "./index.ts";

const TOKEN = "conformance-token-0123456789abcdef";

for (const c of createChannelConformance(() => {
  let route: { handler: HttpRoute; ctx: AppContext } | undefined;
  const told = new Map<string, string[]>();
  const caller = defineComponent({
    name: "server-test",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      return {
        start(ctx) {
          const handler = routes.get("POST /v1/messages");
          if (handler === undefined) throw new Error("channel-http provides no POST /v1/messages");
          route = { handler, ctx: ctx.derive(() => BACKGROUND_CONTEXT) };
        },
      };
    },
  });
  return {
    components: [
      channelHttp,
      caller,
      defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => (name === "PIKIT_HTTP_TOKEN" ? TOKEN : undefined) }) }),
    ],
    config: { "channel-http": { replyTimeoutMs: 2000 } },
    async deliver({ id, conversation, text }) {
      if (route === undefined) throw new Error("the app has not started");
      const request = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conversation, text, messageId: id }),
      });
      const line = await Promise.resolve(route.handler(request, route.ctx)).then(
        async (response) => `${response.status} ${await response.text()}`,
        () => "500",
      );
      told.set(conversation, [...(told.get(conversation) ?? []), line]);
    },
    told: (conversation) => told.get(conversation) ?? [],
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run(), 15_000);
}
