/**
 * provider-openai on Cloudflare: composed in a real SQLite-backed object's App with `storage-do`,
 * `runtime-pi` and `secrets-cloudflare`, an agent on `openai/gpt-5.5` answers. The key is a Worker
 * secret (`OPENAI_API_KEY` in the host's env, as `wrangler secret put` leaves it), read through
 * `secrets`; OpenAI's Responses API is a fake behind `globalThis.fetch` (the test and the object share
 * one isolate), so pi-ai's OpenAI SDK, loaded by its lazy API in workerd, really streams. Nothing
 * provides `model.credentials` here: only keys, no Sign in with ChatGPT.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type AgentConversations, type AgentRuntime, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { afterEach, expect, it } from "vitest";
import providerOpenai from "../../../registry/components/provider-openai/files/src/pikit/provider-openai/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import secretsCloudflare from "../../../registry/components/secrets-cloudflare/files/src/pikit/secrets-cloudflare/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { inObject, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface OpenAIRequest {
  url: string;
  authorization: string | null;
  model: string;
}

type InputItem = { role?: string; content?: string | { type: string; text?: string }[] };

/** OpenAI's Responses API, streamed: `answer: <the newest user message>`; records each request. */
function fakeOpenAI(requests: OpenAIRequest[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/responses") return new Response("not found", { status: 404 });
    const body = (await request.json()) as { model: string; input: InputItem[] };
    requests.push({ url: `${url.origin}${url.pathname}`, authorization: request.headers.get("authorization"), model: body.model });
    const newest = body.input.filter((item) => item.role === "user").at(-1)?.content;
    const text = `answer: ${typeof newest === "string" ? newest : (newest ?? []).map((part) => part.text ?? "").join("")}`;
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const response = { id: "resp_fake", object: "response", model: body.model, status: "in_progress", output: [] };
    const message = { id: "msg_fake", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
    const stream = [
      event("response.created", { response }),
      event("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
      event("response.output_text.delta", { output_index: 0, item_id: "msg_fake", content_index: 0, delta: text }),
      event("response.output_item.done", { output_index: 0, item: message }),
      event("response.completed", { response: { ...response, status: "completed", output: [message], usage } }),
    ].join("");
    return new Response(stream, { headers: { "content-type": "text/event-stream", "x-request-id": "req_fake" } });
  }) as typeof globalThis.fetch;
}

it("provider-openai in a real object: an agent answers with the key from the Worker's secrets", () =>
  inObject(async (host) => {
    const requests: OpenAIRequest[] = [];
    globalThis.fetch = fakeOpenAI(requests);
    const answers: (string | undefined)[] = [];
    let runtime: AgentRuntime | undefined;
    let conversations: AgentConversations | undefined;
    const agent = defineAgent({ name: "assistant", model: "openai/gpt-5.5" });
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
    const app = await defineApp({ components: [secretsCloudflare, storageDo, providerOpenai, agents, runtimePi, channel], target: "durable", logger: silentLogger }).create();
    // The object's host, its env holding the key as a Worker secret.
    const withKey = { ...host, env: { ...workerEnv, OPENAI_API_KEY: "sk-workerd" } };
    await app.start(withContextValue(WORKERS_HOST, withKey, BACKGROUND_CONTEXT));
    try {
      const ctx = app.context();
      const conversationId = await (conversations as AgentConversations).create(ctx);
      await (runtime as AgentRuntime).dispatch({ requestId: "m1", conversation: { key: "test:openai", agent: "assistant", conversationId }, prompt: "hello" }, ctx);
      await expect.poll(() => answers, { timeout: 10_000 }).toEqual(["answer: hello"]);
      expect(requests).toEqual([{ url: "https://api.openai.com/v1/responses", authorization: "Bearer sk-workerd", model: "gpt-5.5" }]);
    } finally {
      await app.stop();
    }
  }));
