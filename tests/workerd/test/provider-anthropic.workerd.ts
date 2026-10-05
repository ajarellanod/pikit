/**
 * provider-anthropic on Cloudflare: composed in a real SQLite-backed object's App with `storage-do`,
 * `runtime-pi` and `secrets-cloudflare`, an agent on `anthropic/claude-sonnet-4-6` answers. The key is
 * a Worker secret (`ANTHROPIC_API_KEY` in the host's env, as `wrangler secret put` leaves it), read
 * through `secrets`; Anthropic's API is a fake behind `globalThis.fetch` (the test and the object share
 * one isolate), so pi-ai's Anthropic SDK, loaded by its lazy API in workerd, really streams. On this
 * target the provider has no OAuth: only keys.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type AgentConversations, type AgentRuntime, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import type { Provider } from "@pikit/pi-adapter";
import { afterEach, expect, it } from "vitest";
import providerAnthropic from "../../../registry/components/provider-anthropic/files/src/pikit/provider-anthropic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import secretsCloudflare from "../../../registry/components/secrets-cloudflare/files/src/pikit/secrets-cloudflare/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { inObject, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface AnthropicRequest {
  /** Without its query (`?beta=true`). */
  url: string;
  apiKey: string | null;
  model: string;
}

/** Anthropic's Messages API, streamed: `answer: <the newest user message>`; records each request. */
function fakeAnthropic(requests: AnthropicRequest[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 });
    const body = (await request.json()) as { model: string; messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    requests.push({ url: `${new URL(request.url).origin}${new URL(request.url).pathname}`, apiKey: request.headers.get("x-api-key"), model: body.model });
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
  }) as typeof globalThis.fetch;
}

it("provider-anthropic in a real object: an agent answers with the key from the Worker's secrets, and there is no OAuth", () =>
  inObject(async (host) => {
    const requests: AnthropicRequest[] = [];
    globalThis.fetch = fakeAnthropic(requests);
    const answers: (string | undefined)[] = [];
    let runtime: AgentRuntime | undefined;
    let conversations: AgentConversations | undefined;
    let provider: Provider | undefined;
    const agent = defineAgent({ name: "assistant", model: "anthropic/claude-sonnet-4-6" });
    const agents = defineComponent({ name: "test-agents", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) });
    const channel = defineComponent({
      name: "test-channel",
      setup(pikit) {
        const runtimeHandle = pikit.use("agent.runtime");
        const conversationsHandle = pikit.use("agent.conversations");
        const providers = pikit.useKeyed("model.provider");
        pikit.on("agent.settled", (result) => void answers.push(result.text));
        return {
          start() {
            runtime = runtimeHandle.get();
            conversations = conversationsHandle.get();
            provider = providers.get("anthropic");
          },
        };
      },
    });
    const app = await defineApp({ components: [secretsCloudflare, storageDo, providerAnthropic, agents, runtimePi, channel], target: "durable", logger: silentLogger }).create();
    // The object's host, its env holding the key as a Worker secret.
    const withKey = { ...host, env: { ...workerEnv, ANTHROPIC_API_KEY: "sk-ant-workerd" } };
    await app.start(withContextValue(WORKERS_HOST, withKey, BACKGROUND_CONTEXT));
    try {
      expect(provider?.auth.oauth).toBeUndefined();
      const ctx = app.context();
      const conversationId = await (conversations as AgentConversations).create(ctx);
      await (runtime as AgentRuntime).dispatch({ requestId: "m1", conversation: { key: "test:anthropic", agent: "assistant", conversationId }, prompt: "hello" }, ctx);
      await expect.poll(() => answers, { timeout: 10_000 }).toEqual(["answer: hello"]);
      expect(requests).toEqual([{ url: "https://api.anthropic.com/v1/messages", apiKey: "sk-ant-workerd", model: "claude-sonnet-4-6" }]);
    } finally {
      await app.stop();
    }
  }));
