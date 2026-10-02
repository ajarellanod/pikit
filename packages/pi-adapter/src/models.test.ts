// pi-ai 1.0 models and providers (`models.ts`, `providers/*`). No network: the only
// model call goes to pi-ai's faux provider, and environment variables come from a stub AuthContext.

import { expect, test } from "bun:test";
import type { AuthContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { modelRefOf, modelsFrom, parseModelName } from "./models.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { OPENROUTER_API_BASE, openrouterProvider } from "./providers/openrouter.ts";

const env = (values: Record<string, string>): AuthContext => ({ env: async (name) => values[name], fileExists: async () => false });

test("an agent's <provider>/<modelId> resolves to pi-durable's ModelRef, split at the first slash", () => {
  const models = modelsFrom([anthropicProvider(), openrouterProvider()]);

  expect(modelRefOf(models, "a", "anthropic/claude-sonnet-4-6")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
  // OpenRouter's models are <vendor>/<model>: the provider is only what comes before the first slash.
  expect(modelRefOf(models, "a", "openrouter/z-ai/glm-5.3-flash")).toEqual({ provider: "openrouter", modelId: "z-ai/glm-5.3-flash" });
  expect(models.getModel("openrouter", "z-ai/glm-5.3-flash")?.id).toBe("z-ai/glm-5.3-flash");
});

test("a name that is not <provider>/<modelId>, an unknown provider and an unknown model each fail, naming the agent", () => {
  const models = modelsFrom([anthropicProvider(), openrouterProvider()]);

  for (const name of ["claude-sonnet-4-6", "/claude", "anthropic/"]) {
    expect(parseModelName(name)).toBeUndefined();
    expect(() => modelRefOf(models, "helper", name)).toThrow(`agent "helper": model "${name}" is not named <provider>/<modelId>`);
  }
  expect(() => modelRefOf(models, "helper", "openai/gpt-6-sol")).toThrow(
    'agent "helper": model "openai/gpt-6-sol" names the provider "openai", which no model.provider provides (installed: anthropic, openrouter)',
  );
  expect(() => modelRefOf(modelsFrom([]), "helper", "openai/gpt-6-sol")).toThrow("(installed: none)");
  expect(() => modelRefOf(models, "helper", "anthropic/claude-nope")).toThrow('the model provider "anthropic" has no model "claude-nope"');
});

test("the Models answer through the provider that owns the ModelRef (faux, no network)", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("hello from 1.0")]);
  const models = modelsFrom([faux.provider, anthropicProvider()]);
  const ref = modelRefOf(models, "a", `faux/${faux.getModel().id}`);
  const model = models.getModel(ref.provider, ref.modelId);
  if (model === undefined) throw new Error("faux model missing");

  const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });

  expect(message.content).toEqual([{ type: "text", text: "hello from 1.0" }]);
});

test("Anthropic on 1.0: id anthropic, API-key and subscription OAuth sign-in, the same Claude models as 0.99", async () => {
  const provider = anthropicProvider();

  expect(provider.id).toBe("anthropic");
  expect(provider.auth.apiKey).toBeDefined();
  expect(provider.auth.oauth?.isSubscription).toBe(true);
  expect(provider.getModels().some((model) => model.id === "claude-sonnet-4-6")).toBe(true);

  // Without a credential store, the environment: ANTHROPIC_API_KEY.
  const models = modelsFrom([provider], { authContext: env({ ANTHROPIC_API_KEY: "sk-test-env" }) });
  expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe("sk-test-env");
  expect(await modelsFrom([provider], { authContext: env({}) }).checkAuth("anthropic")).toBeUndefined();
});

test("OpenRouter on 1.0: id openrouter, OPENROUTER_API_KEY, and apiBase moves every model's address", async () => {
  const plain = openrouterProvider();
  expect(plain.id).toBe("openrouter");
  expect(plain.auth.apiKey).toBeDefined();
  const models = modelsFrom([plain], { authContext: env({ OPENROUTER_API_KEY: "or-test-env" }) });
  expect((await models.getAuth("openrouter"))?.auth.apiKey).toBe("or-test-env");
  expect(openrouterProvider({ apiBase: `${OPENROUTER_API_BASE}/` }).getModels()).toEqual(plain.getModels());

  const moved = openrouterProvider({ apiBase: "http://127.0.0.1:9999/proxy/" });
  const chat = modelsFrom([moved]).getModel("openrouter", "z-ai/glm-5.3-flash");
  expect(chat?.baseUrl.startsWith("http://127.0.0.1:9999/proxy")).toBe(true);
  expect(moved.baseUrl).toBe("http://127.0.0.1:9999/proxy/v1");
  const all = moved.getAllModels?.() ?? [];
  expect(all.length).toBeGreaterThan(moved.getModels().length);
  expect(all.every((model) => !model.baseUrl.startsWith(OPENROUTER_API_BASE))).toBe(true);
});
