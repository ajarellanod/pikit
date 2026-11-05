/**
 * provider-failover's accounts on Cloudflare: in a real SQLite-backed object's App with `storage-do`,
 * `runtime-pi`, `secrets-workers` and `provider-anthropic`, an agent on `failover/main` (Anthropic's
 * claude-sonnet-4-6 on the base account, then on the account `anthropic-2`) answers while the base
 * account's key is rate-limited: through pi-ai's real SDK, the account's key read from the Worker's
 * secret `ANTHROPIC_API_KEY_2` (its `env`), never the base's. Anthropic's API is a fake behind
 * `globalThis.fetch` (the test and the object share one isolate), answering per key. The next
 * message goes to the account alone: the base account is cooling down.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type AgentConversations, type AgentRuntime, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { afterEach, expect, it } from "vitest";
import providerAnthropic from "../../../registry/components/provider-anthropic/files/src/pikit/provider-anthropic/index.ts";
import providerFailover from "../../../registry/components/provider-failover/files/src/pikit/provider-failover/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import secretsWorkers from "../../../registry/components/secrets-workers/files/src/pikit/secrets-workers/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { inObject, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Anthropic's Messages API: a rate limit for `limited`'s requests, `answer: <the newest user message>` for any other key. */
function fakeAnthropic(asked: (string | null)[], limited: string): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
    const key = request.headers.get("x-api-key");
    asked.push(key);
    if (key === limited) {
      const error = { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your organization's rate limit." } };
      return new Response(JSON.stringify(error), { status: 429, headers: { "content-type": "application/json", "request-id": "req_fake", "retry-after": "60" } });
    }
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
  }) as typeof globalThis.fetch;
}

it("provider-failover's account in a real object: the base account's rate limit moves the request to the account, with its own key", () =>
  inObject(async (host) => {
    const asked: (string | null)[] = [];
    globalThis.fetch = fakeAnthropic(asked, "sk-ant-one");
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
      components: [secretsWorkers, storageDo, providerAnthropic, providerFailover, agents, runtimePi, channel],
      config: {
        "provider-failover": {
          accounts: { "anthropic-2": { provider: "anthropic", env: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY_2" } } },
          chains: { main: ["anthropic/claude-sonnet-4-6", "anthropic-2/claude-sonnet-4-6"] },
        },
      },
      target: "durable",
      logger: silentLogger,
    }).create();
    const withKeys = { ...host, env: { ...workerEnv, ANTHROPIC_API_KEY: "sk-ant-one", ANTHROPIC_API_KEY_2: "sk-ant-two" } };
    await app.start(withContextValue(WORKERS_HOST, withKeys, BACKGROUND_CONTEXT));
    try {
      const ctx = app.context();
      const conversationId = await (conversations as AgentConversations).create(ctx);
      const conversation = { key: "test:failover-accounts", agent: "assistant", conversationId };
      await (runtime as AgentRuntime).dispatch({ requestId: "m1", conversation, prompt: "hello" }, ctx);
      await expect.poll(() => answers, { timeout: 10_000 }).toEqual(["answer: hello"]);
      expect(asked).toEqual(["sk-ant-one", "sk-ant-two"]);

      await (runtime as AgentRuntime).dispatch({ requestId: "m2", conversation, prompt: "again" }, ctx);
      await expect.poll(() => answers, { timeout: 10_000 }).toEqual(["answer: hello", "answer: again"]);
      expect(asked.slice(2)).toEqual(["sk-ant-two"]);
    } finally {
      await app.stop();
    }
  }));
