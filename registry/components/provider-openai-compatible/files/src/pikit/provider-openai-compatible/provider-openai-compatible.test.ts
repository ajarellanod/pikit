/**
 * provider-openai-compatible's tests. They are copied with the component and keep running in your
 * project. They reach no network and read no real credential: a local fake endpoint answers.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { modelsFrom, type Provider } from "@pikit/pi-adapter";
import { startFakeEndpoint } from "./fake-endpoint.test-support.ts";
import providerOpenAICompatible from "./index.ts";

/** The provider the component provides under `id`, with `config` as its config. */
async function providerWith(config: Record<string, unknown>): Promise<{ provider: Provider | undefined; stop(): Promise<void> }> {
  let provider: Provider | undefined;
  const reader = defineComponent({
    name: "provider-reader",
    setup(pikit) {
      const providers = pikit.useKeyed("model.provider");
      return { start: () => void (provider = providers.get(String(config.id ?? "openai-compatible"))) };
    },
  });
  const app = await defineApp({ components: [providerOpenAICompatible, reader], config: { "provider-openai-compatible": config }, logger: silentLogger }).create();
  await app.start();
  return { provider, stop: () => app.stop() };
}

const ask = (provider: Provider, modelId: string, options: { apiKey?: string; env?: Record<string, string> } = {}) => {
  const models = modelsFrom([provider], { authContext: { env: async (name) => options.env?.[name], fileExists: async () => false } });
  const model = models.getModel(provider.id, modelId);
  if (model === undefined) throw new Error(`no model ${modelId}`);
  return models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, options.apiKey === undefined ? {} : { apiKey: options.apiKey });
};

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({
    components: [providerOpenAICompatible],
    config: { "provider-openai-compatible": { baseUrl: "http://localhost:11434/v1", models: [{ id: "llama3.1:8b" }] } },
    logger: silentLogger,
  }).create();

  expect(app.describe().components).toEqual([{ name: "provider-openai-compatible", provides: ["model.provider"], requires: [], optional: [] }]);
  expect(app.describe().capabilities["model.provider"]).toEqual({ providers: ["provider-openai-compatible"], keys: { "openai-compatible": "provider-openai-compatible" } });
});

test("its config needs a baseUrl and at least one model; the id is kebab-case", () => {
  const define = (config: Record<string, unknown>) => () => defineApp({ components: [providerOpenAICompatible], config: { "provider-openai-compatible": config }, logger: silentLogger });
  expect(define({ models: [{ id: "m" }] })).toThrow("baseUrl");
  expect(define({ baseUrl: "http://x/v1", models: [] })).toThrow("/provider-openai-compatible/models");
  expect(define({ id: "My LLM", baseUrl: "http://x/v1", models: [{ id: "m" }] })).toThrow("/provider-openai-compatible/id");
});

test("its models are config's, under its id, at baseUrl, with pi-ai's defaults where config says nothing", async () => {
  const { provider, stop } = await providerWith({
    id: "ollama",
    baseUrl: "http://localhost:11434/v1",
    models: [{ id: "llama3.1:8b" }, { id: "qwen3-vl", name: "Qwen3 VL", images: true, reasoning: true, contextWindow: 32_000, maxTokens: 4_096 }],
  });
  try {
    expect(provider?.id).toBe("ollama");
    expect(provider?.getModels()).toEqual([
      expect.objectContaining({ id: "llama3.1:8b", name: "llama3.1:8b", provider: "ollama", api: "openai-completions", baseUrl: "http://localhost:11434/v1", input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 16_384 }),
      expect.objectContaining({ id: "qwen3-vl", name: "Qwen3 VL", input: ["text", "image"], reasoning: true, contextWindow: 32_000, maxTokens: 4_096 }),
    ]);
  } finally {
    await stop();
  }
});

test("with apiKey, the key is the variable it names; without one stored or set, the provider is not configured", async () => {
  const fake = startFakeEndpoint();
  const { provider, stop } = await providerWith({ id: "my-llm", baseUrl: `${fake.url}/v1`, apiKey: "MY_LLM_API_KEY", models: [{ id: "big" }] });
  try {
    const p = provider as Provider;
    const none = modelsFrom([p], { authContext: { env: async () => undefined, fileExists: async () => false } });
    expect(await none.checkAuth("my-llm")).toBeUndefined();

    const answer = await ask(p, "big", { env: { MY_LLM_API_KEY: "sk-test" } });
    expect(answer.content).toEqual([{ type: "text", text: "answer: hello" }]);
    expect(fake.requests).toEqual([{ model: "big", apiKey: "sk-test", messages: [expect.objectContaining({ role: "user" })] }]);
  } finally {
    await stop();
    await fake.stop();
  }
});

test("without apiKey, it is configured with no key, and a model answers (a local server); the client's placeholder key goes along", async () => {
  const fake = startFakeEndpoint();
  const { provider, stop } = await providerWith({ baseUrl: `${fake.url}/v1`, models: [{ id: "small" }] });
  try {
    const p = provider as Provider;
    expect(await modelsFrom([p], { authContext: { env: async () => undefined, fileExists: async () => false } }).checkAuth("openai-compatible")).toBeDefined();
    const answer = await ask(p, "small");
    expect(answer.content).toEqual([{ type: "text", text: "answer: hello" }]);
    // pi-ai's OpenAI client refuses to send without a key: the provider resolves a placeholder.
    expect(fake.requests.map((request) => [request.model, request.apiKey])).toEqual([["small", "unused"]]);
  } finally {
    await stop();
    await fake.stop();
  }
});
