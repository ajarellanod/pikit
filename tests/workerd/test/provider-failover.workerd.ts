/**
 * provider-failover on Cloudflare: composed in a real SQLite-backed object's App with `storage-do`,
 * `runtime-pi`, `secrets-workers`, `provider-openai` and `provider-anthropic`, an agent on
 * `failover/main` (OpenAI's gpt-5.5, then Anthropic's claude-sonnet-4-6) answers while OpenAI refuses
 * with a 429: through pi-ai's real SDKs, loaded by their lazy APIs in workerd, each with its own key
 * from the Worker's secrets. Both APIs are fakes behind `globalThis.fetch` (the test and the object
 * share one isolate). The next message goes to Anthropic alone: OpenAI is cooling down.
 *
 * The cooldowns shared on Cloudflare: in two conversations' objects (deployment-cloudflare's real
 * class, as `PlatformConversation`, `src/platform.ts`, with actors-do), the first meets OpenAI's 429
 * and reports it to the owner object `provider-failover:cooldowns`, which keeps it in its own SQLite;
 * the second conversation's object, started afterwards, asks Anthropic alone from its first request.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type AgentConversations, type AgentRuntime, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { afterEach, expect, it } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import providerAnthropic from "../../../registry/components/provider-anthropic/files/src/pikit/provider-anthropic/index.ts";
import providerFailover from "../../../registry/components/provider-failover/files/src/pikit/provider-failover/index.ts";
import { COOLDOWNS_KEY } from "../../../registry/components/provider-failover/files/src/pikit/provider-failover/shared.ts";
import providerOpenai from "../../../registry/components/provider-openai/files/src/pikit/provider-openai/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import secretsWorkers from "../../../registry/components/secrets-workers/files/src/pikit/secrets-workers/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, resetObjects, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetObjects();
});

/** Each request: where it went and with which key. */
type Asked = { url: string; key: string | null };

/**
 * OpenAI's Responses API refusing every request with a rate limit, and Anthropic's Messages API
 * streaming `answer: <the newest user message>`.
 */
function fakeApis(asked: Asked[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      asked.push({ url: `${url.origin}${url.pathname}`, key: request.headers.get("authorization") });
      const error = { error: { message: "Rate limit reached for gpt-5.5 in organization org-test on requests per min.", type: "requests", code: "rate_limit_exceeded" } };
      return new Response(JSON.stringify(error), { status: 429, headers: { "content-type": "application/json", "x-request-id": "req_fake" } });
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      asked.push({ url: `${url.origin}${url.pathname}`, key: request.headers.get("x-api-key") });
      const body = (await request.json()) as { model: string; messages: { role: string; content: string | { type: string; text?: string }[] }[] };
      const newest = body.messages.filter((message) => message.role === "user").at(-1)?.content;
      const text = `answer: ${typeof newest === "string" ? newest : (newest ?? []).map((part) => part.text ?? "").join("")}`;
      const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const stream = [
        event("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }),
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
        event("content_block_stop", { index: 0 }),
        event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }),
        event("message_stop", {}),
      ].join("");
      return new Response(stream, { headers: { "content-type": "text/event-stream", "request-id": "req_fake" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

it("provider-failover in a real object: OpenAI's rate limit moves the request to Anthropic, and the next one starts there", () =>
  inObject(async (host) => {
    const asked: Asked[] = [];
    globalThis.fetch = fakeApis(asked);
    const answers: (string | undefined)[] = [];
    let runtime: AgentRuntime | undefined;
    let conversations: AgentConversations | undefined;
    const agent = defineAgent({ name: "assistant", model: "failover/main" });
    const agents = defineComponent({ name: "test-agents", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) });
    const channel = defineComponent({
      name: "test-channel",
      setup(pikit) {
        const runtimeHandle = pikit.use("agent.runtime");
        const conversationsHandle = pikit.use("agent.conversations");
        pikit.on("agent.settled", (result) => void answers.push(result.text));
        return {
          start() {
            runtime = runtimeHandle.get();
            conversations = conversationsHandle.get();
          },
        };
      },
    });
    const app = await defineApp({
      components: [secretsWorkers, storageDo, providerOpenai, providerAnthropic, providerFailover, agents, runtimePi, channel],
      config: { "provider-failover": { chains: { main: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"] } } },
      target: "durable",
      logger: silentLogger,
    }).create();
    const withKeys = { ...host, env: { ...workerEnv, OPENAI_API_KEY: "sk-openai-workerd", ANTHROPIC_API_KEY: "sk-ant-workerd" } };
    await app.start(withContextValue(WORKERS_HOST, withKeys, BACKGROUND_CONTEXT));
    try {
      const ctx = app.context();
      const conversationId = await (conversations as AgentConversations).create(ctx);
      const conversation = { key: "test:failover", agent: "assistant", conversationId };
      await (runtime as AgentRuntime).dispatch({ requestId: "m1", conversation, prompt: "hello" }, ctx);
      await expect.poll(() => answers, { timeout: 10_000 }).toEqual(["answer: hello"]);
      expect(asked).toEqual([
        { url: "https://api.openai.com/v1/responses", key: "Bearer sk-openai-workerd" },
        { url: "https://api.anthropic.com/v1/messages", key: "sk-ant-workerd" },
      ]);

      await (runtime as AgentRuntime).dispatch({ requestId: "m2", conversation, prompt: "again" }, ctx);
      await expect.poll(() => answers, { timeout: 10_000 }).toEqual(["answer: hello", "answer: again"]);
      expect(asked.slice(2)).toEqual([{ url: "https://api.anthropic.com/v1/messages", key: "sk-ant-workerd" }]);
    } finally {
      await app.stop();
    }
  }));

it("two conversations' objects share the cooldowns: after OpenAI's 429 in one, the other's first request goes to Anthropic alone", async () => {
  // A stub of its own each time: one made before a reset is broken.
  const owner = () => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(COOLDOWNS_KEY));
  // The owner object starts empty.
  await runInDurableObject(owner(), (_instance, state) => state.storage.deleteAll());
  await resetObjects();
  const asked: Asked[] = [];
  globalThis.fetch = fakeApis(asked);

  const agent = defineAgent({ name: "assistant", model: "failover/main" });
  const agents = defineComponent({ name: "test-agents", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) });
  const keys: Record<string, string> = { OPENAI_API_KEY: "sk-openai-workerd", ANTHROPIC_API_KEY: "sk-ant-workerd" };
  const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => keys[name] }) });
  // A conversation's object: answers `test.complete` with its agent's model (`failover/main`).
  const completer = defineComponent({
    name: "test-completer",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const complete = pikit.use("model.complete");
      return {
        start() {
          inbox.get().answer("test.complete", async (_key, message, ctx) => complete.get().complete({ model: agent.model, prompt: String((message as { prompt: string }).prompt) }, ctx));
        },
      };
    },
  });
  composeObjects([storageDo, actorsDo, secrets, providerOpenai, providerAnthropic, providerFailover, agents, runtimePi, completer], {
    "provider-failover": { chains: { main: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"] } },
  });

  let mailbox: ActorMailbox | undefined;
  const reader = defineComponent({
    name: "test-reader",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [actorsDo, reader], config: { "actors-do": { binding: PLATFORM_BINDING } }, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  const ask = (key: string, prompt: string) => (mailbox as ActorMailbox).call(key, "test.complete", { prompt }, app.context());
  const stored = () => runInDurableObject(owner(), (_instance, state) => state.storage.sql.exec("SELECT name, kind FROM provider_failover_cooldowns").toArray());
  try {
    expect(await ask(`test:${crypto.randomUUID()}`, "hello")).toBe("answer: hello");
    expect(asked.map((each) => each.url)).toEqual(["https://api.openai.com/v1/responses", "https://api.anthropic.com/v1/messages"]);
    // The first conversation's report reaches the owner object, which keeps it in its own SQLite: why, never the error's text.
    await expect.poll(stored, { timeout: 5_000 }).toEqual([{ name: "model:openai/gpt-5.5", kind: "rate" }]);

    // Another conversation's object, new: its first request goes to Anthropic alone.
    expect(await ask(`test:${crypto.randomUUID()}`, "hi")).toBe("answer: hi");
    expect(asked.slice(2).map((each) => each.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
  } finally {
    await app.stop();
  }
});
