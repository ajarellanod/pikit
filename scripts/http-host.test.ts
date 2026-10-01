/** Integration stays outside copied components: neither component imports its sibling. No model or credentials. */
import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import channelHttp from "../registry/components/channel-http/files/src/pikit/channel-http/index.ts";
import { createServerBun } from "../registry/components/server-bun/files/src/pikit/server-bun/index.ts";

const TOKEN = "http-host-test-token-0123456789";

test("server-bun serves channel-http's message endpoint, not just a healthy process", async () => {
  let address: URL | undefined;
  const conversations = new Map<string, ConversationRef>();
  const dependencies = defineComponent({
    name: "http-host-test",
    setup(pikit) {
      pikit.provide("secrets", { get: async (name) => name === "PIKIT_HTTP_TOKEN" ? TOKEN : undefined });
      pikit.provide("conversations.registry", {
        async resolve(key, agent) {
          const conversation = conversations.get(key) ?? { key, agent, sessionId: "session-1" };
          conversations.set(key, conversation);
          return conversation;
        },
        get: async (key) => conversations.get(key),
        reset: async () => undefined,
      });
      pikit.pipeline("route.resolve", (value) => ({ ...value, decision: { agent: "assistant", access: "allow" } }));
      pikit.provide("agent.runtime", {
        async dispatch({ conversation, requestId, prompt }, ctx) {
          await ctx.emit("agent.settled", { conversation, requestId, requestIds: [requestId], kind: "completed", messages: [], text: `answer: ${prompt}` });
          return { kind: "started", requestId };
        },
        abort: async () => {},
        resume: async () => {},
      });
    },
  });
  const app = await defineApp({
    components: [dependencies, channelHttp, createServerBun({ onListening: (url) => { address = url; } })],
    target: "server",
    config: { "server-bun": { port: 0, hostname: "127.0.0.1" }, "channel-http": { replyTimeoutMs: 1000 } },
    logger: silentLogger,
  }).create();
  try {
    await app.start();
    if (address === undefined) throw new Error("server did not listen");
    const call = (path: string, init?: RequestInit) => fetch(new URL(path, address), { ...init, signal: AbortSignal.timeout(2000) });
    expect((await call("/health")).status).toBe(200);
    expect((await call("/ready")).status).toBe(200);
    expect((await call("/v1/messages", { method: "POST" })).status).toBe(401);
    const response = await call("/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "c1", messageId: "m1", text: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: "answer: hello" });
  } finally {
    await app.stop();
  }
}, 10_000);
