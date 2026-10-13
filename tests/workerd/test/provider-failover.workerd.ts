/**
 * provider-failover on Cloudflare: composed in a real SQLite-backed object's App with `storage-do`,
 * `runtime-pi`, `secrets-cloudflare`, `provider-openai` and `provider-anthropic`, an agent on
 * `failover/main` (OpenAI's gpt-5.5, then Anthropic's claude-sonnet-4-6) answers while OpenAI refuses
 * with a 429: through pi-ai's real SDKs, loaded by their lazy APIs in workerd, each with its own key
 * from the Worker's secrets. Both APIs are fakes behind `globalThis.fetch` (the test and the object
 * share one isolate). The next message goes to Anthropic alone: OpenAI is cooling down.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type AgentConversations, type AgentRuntime, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { afterEach, expect, it } from "vitest";
import providerAnthropic from "../../../registry/components/provider-anthropic/files/src/pikit/provider-anthropic/index.ts";
import providerFailover from "../../../registry/components/provider-failover/files/src/pikit/provider-failover/index.ts";
import providerOpenai from "../../../registry/components/provider-openai/files/src/pikit/provider-openai/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import secretsCloudflare from "../../../registry/components/secrets-cloudflare/files/src/pikit/secrets-cloudflare/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { inObject, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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
      components: [secretsCloudflare, storageDo, providerOpenai, providerAnthropic, providerFailover, agents, runtimePi, channel],
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
