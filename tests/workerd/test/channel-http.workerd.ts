/**
 * channel-http on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation` class, as
 * `PlatformConversation`, `src/platform.ts`), through the Worker's `fetch` (deployment-cloudflare's
 * `createWorkerHost`, which boots the Worker's App at its first request). Each conversation's object
 * runs the objects' App, composed as a project's: storage-do, storage-kv-sql, actors-do (mailbox,
 * inbox, wakeups), runtime-pi with provider-faux (`faux/scripted`), conversations-kv, router-basic and
 * channel-http; the Worker's App runs actors-do and channel-http's Worker half.
 *
 * - A message is admitted in the object of `http:<conversationId>` by the Worker's `actor.mailbox.call`
 *   (a real RPC), its run driven by the object's alarm, and the answer returned in the POST's response:
 *   the call waited for it inside its own event.
 * - A run longer than `replyTimeoutMs` (a tool held by the test) is `202`, the message durably admitted:
 *   GET finds it pending, then answered once the run ends, and the same POST then answers it.
 * - The same `messageId` sent again, while it runs and after, runs once (one `agent.settled`).
 * - A request without the token is `401` from the Worker, and no object holds a conversation of it.
 */

import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import { defineTool } from "@pikit/pi-adapter/tools";
import Type from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import channelHttp, { worker as channelHttpWorker } from "../../../registry/components/channel-http/files/src/pikit/channel-http/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import { createWorkerHost } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import providerFaux from "../../../registry/components/provider-faux/files/src/pikit/provider-faux/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  gate.release();
  await resetObjects();
});

const TOKEN = "workerd-http-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SECRETS: Record<string, string> = { PIKIT_HTTP_TOKEN: TOKEN };

const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => SECRETS[name] }) });

/** What `hold` waits for: released by the test (the tests and the objects share one isolate). */
const gate = (() => {
  let open!: () => void;
  let opened = Promise.resolve();
  return {
    close() {
      opened = new Promise<void>((resolve) => (open = resolve));
    },
    release: () => open?.(),
    wait: () => opened,
  };
})();

const hold = defineTool({
  name: "hold",
  description: "Waits until the test lets it go",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async () => {
    await gate.wait();
    return { output: [{ type: "text", text: "let go" }] };
  },
}) as unknown as AgentTool;

/** Each run's end in the objects, by its requests (`agent.settled` / `agent.failed`). */
const settled: string[][] = [];
const probe = defineComponent({
  name: "probe-test",
  setup(pikit) {
    pikit.provideKeyed("agent.tool", "hold", hold);
    pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "faux/scripted", tools: ["hold"] });
    pikit.on("agent.settled", (result) => void settled.push([...result.requestIds]));
    pikit.on("agent.failed", (result) => void settled.push([...result.requestIds]));
  },
});

/** The objects' App and the Worker's; the Worker's `fetch`. */
function compose(replyTimeoutMs: number) {
  settled.length = 0;
  composeObjects([storageDo, storageKvSql, actorsDo, secrets, probe, providerFaux, runtimePi, conversationsKv, routerBasic, channelHttp], {
    "router-basic": { defaultAgent: "assistant" },
    "channel-http": { replyTimeoutMs },
  });
  const worker = defineApp({
    components: [actorsDo, secrets, channelHttpWorker],
    config: { "actors-do": { binding: PLATFORM_BINDING } },
    target: "durable",
    logger: silentLogger,
  });
  const host = createWorkerHost(worker, { logger: silentLogger });
  return async (method: string, path: string, init: { json?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await host.fetch(
      new Request(`https://pikit.test${path}`, {
        method,
        headers: { ...AUTH, ...(init.json !== undefined && { "content-type": "application/json" }), ...init.headers },
        ...(init.json !== undefined && { body: JSON.stringify(init.json) }),
      }),
      workerEnv,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}

it("a message is admitted in its conversation's object and answered in the POST's response; the same messageId again runs once", async () => {
  const fetch = compose(20_000);

  expect(await fetch("POST", "/v1/messages", { json: { conversationId: "c1", text: "hello", messageId: "m1" } })).toEqual({
    status: 200,
    body: { requestId: "m1", text: "faux: hello" },
  });
  expect(await fetch("POST", "/v1/messages", { json: { conversationId: "c1", text: "hello", messageId: "m1" } })).toEqual({
    status: 200,
    body: { requestId: "m1", text: "faux: hello" },
  });
  expect(await fetch("GET", "/v1/conversations/c1/messages/m1")).toEqual({ status: 200, body: { requestId: "m1", text: "faux: hello" } });
  // Each conversation is its own object.
  expect(await fetch("POST", "/v1/messages", { json: { conversationId: "c2", text: "other", messageId: "m1" } })).toEqual({
    status: 200,
    body: { requestId: "m1", text: "faux: other" },
  });
  expect(settled).toEqual([["m1"], ["m1"]]);
});

it("a run longer than replyTimeoutMs is a 202, the message admitted; GET finds it, and its answer once the run ends, which ran once", async () => {
  const fetch = compose(300);
  gate.close();

  expect(await fetch("POST", "/v1/messages", { json: { conversationId: "slow", text: "call: hold {}", messageId: "m1" } })).toEqual({ status: 202, body: { requestId: "m1" } });
  expect(await fetch("GET", "/v1/conversations/slow/messages/m1")).toEqual({ status: 202, body: { requestId: "m1" } });
  // Sent again while it runs: a duplicate, still running.
  expect(await fetch("POST", "/v1/messages", { json: { conversationId: "slow", text: "call: hold {}", messageId: "m1" } })).toEqual({ status: 202, body: { requestId: "m1" } });
  gate.release();

  const done = await vi.waitFor(
    async () => {
      const read = await fetch("GET", "/v1/conversations/slow/messages/m1");
      expect(read.status).toBe(200);
      return read;
    },
    { timeout: 15_000, interval: 50 },
  );
  expect(done).toEqual({ status: 200, body: { requestId: "m1", text: "hold: let go" } });
  expect(await fetch("POST", "/v1/messages", { json: { conversationId: "slow", text: "call: hold {}", messageId: "m1" } })).toEqual({ status: 200, body: { requestId: "m1", text: "hold: let go" } });
  expect(settled).toEqual([["m1"]]);
});

it("a request without the token, or with a wrong one, is a 401 from the Worker, and reaches no object", async () => {
  const fetch = compose(20_000);

  const missing = await fetch("POST", "/v1/messages", { json: { conversationId: "stranger", text: "hello", messageId: "m1" }, headers: { authorization: "" } });
  const wrong = await fetch("POST", "/v1/messages", { json: { conversationId: "stranger", text: "hello", messageId: "m1" }, headers: { authorization: "Bearer not-the-token-at-all" } });
  const read = await fetch("GET", "/v1/conversations/stranger/messages/m1", { headers: { authorization: "" } });

  for (const response of [missing, wrong, read]) expect(response).toEqual({ status: 401, body: { error: "unauthorized" } });
  // With the token: the conversation has no message, it was never made.
  expect(await fetch("GET", "/v1/conversations/stranger/messages/m1")).toEqual({ status: 404, body: { requestId: "m1", error: "not_found" } });
  expect(await fetch("POST", "/v1/conversations/stranger/reset")).toEqual({ status: 404, body: { error: "not_found" } });
  expect(settled).toEqual([]);
});
