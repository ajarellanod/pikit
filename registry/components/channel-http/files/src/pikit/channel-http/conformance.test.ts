/**
 * channel-http against the channel conformance suite (`@pikit/contracts/testing`): what every channel
 * does with a message, on each target. The suite brings the runtime, the conversation registry, a
 * router and stages that halt, deny or move messages; this fixture speaks HTTP. It calls
 * `POST /v1/messages` as a server would, with no socket: what a sender is told is each response
 * (status and body), and a handler that throws is the `500` a server answers. Delivering an id again
 * is a client retrying with the same `messageId`. Its answers are in its responses
 * (`answers: "in-response"`): after a restart, a client reads an answer that ended meanwhile by
 * sending the message again, which `agent.submissions` (the suite's) answers with the run's outcome.
 *
 * - **server**: one App, the suite's, whose routes are called.
 * - **durable**: the suite's App is the conversations' objects (`actor.inbox` of scope `"one"`), and
 *   the routes called are the Worker half's, in an App of their own that reaches them by
 *   `actor.mailbox.call` (`actors.test-support.ts`). A restart is the objects' App's (an eviction); the
 *   Worker's App goes on.
 */

import { test } from "bun:test";
import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import { type HttpRoute } from "@pikit/contracts";
import { type ChannelFixture, createChannelConformance } from "@pikit/contracts/testing";
import { createActors, startWorker } from "./actors.test-support.ts";
import channelHttp from "./index.ts";

const TOKEN = "conformance-token-0123456789abcdef";
const SECRETS = { PIKIT_HTTP_TOKEN: TOKEN };
const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => SECRETS[name as keyof typeof SECRETS] }) });

/** What a sender is told, by conversation, from each response to its `POST /v1/messages`. */
function speaker(route: () => { handler: HttpRoute; ctx: AppContext } | undefined): Pick<ChannelFixture, "deliver" | "told"> {
  const told = new Map<string, string[]>();
  return {
    async deliver({ id, conversation, text }) {
      const now = route();
      if (now === undefined) throw new Error("the app has not started");
      const request = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conversation, text, messageId: id }),
      });
      const line = await Promise.resolve(now.handler(request, now.ctx)).then(
        async (response) => `${response.status} ${await response.text()}`,
        () => "500",
      );
      told.set(conversation, [...(told.get(conversation) ?? []), line]);
    },
    told: (conversation) => told.get(conversation) ?? [],
  };
}

for (const c of createChannelConformance(() => {
  let route: { handler: HttpRoute; ctx: AppContext } | undefined;
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
    components: [channelHttp, caller, secrets],
    config: { "channel-http": { replyTimeoutMs: 2000 } },
    ...speaker(() => route),
  };
}, { answers: "in-response" })) {
  test(`server: ${c.group}: ${c.name}`, () => c.run(), 15_000);
}

for (const c of createChannelConformance(async () => {
  const actors = createActors();
  const worker = await startWorker(actors, SECRETS);
  const route = { handler: worker.route("POST /v1/messages"), ctx: worker.app.context(BACKGROUND_CONTEXT) };
  return {
    components: [channelHttp, actors.object, secrets],
    config: { "channel-http": { replyTimeoutMs: 2000 } },
    ...speaker(() => route),
    dispose: () => worker.app.stop(),
  };
}, { answers: "in-response" })) {
  test(`durable: ${c.group}: ${c.name}`, () => c.run(), 15_000);
}
