/**
 * provider-openai's tests. They are copied with the component and keep running in your project.
 * They make no request to OpenAI and read no credential.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { modelsFrom, type Provider } from "@pikit/pi-adapter";
import providerOpenai from "./index.ts";

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [providerOpenai], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "provider-openai", provides: ["model.provider"], requires: [], optional: [] }]);
  expect(app.describe().capabilities["model.provider"]).toEqual({ providers: ["provider-openai"], keys: { openai: "provider-openai" } });
});

/** The provider the component provides under `openai`. */
async function provided(): Promise<Provider | undefined> {
  let provider: Provider | undefined;
  const reader = defineComponent({
    name: "provider-reader",
    setup(pikit) {
      const providers = pikit.useKeyed("model.provider");
      return { start: () => void (provider = providers.get("openai")) };
    },
  });
  const app = await defineApp({ components: [providerOpenai, reader], logger: silentLogger }).create();
  await app.start();
  await app.stop();
  return provider;
}

test("it provides pi-ai's OpenAI provider under the key openai, with Sign in with ChatGPT and API-key sign-in", async () => {
  const provider = await provided();

  expect(provider?.id).toBe("openai");
  expect(provider?.auth.oauth).toBeDefined();
  expect(provider?.auth.apiKey).toBeDefined();
  expect(provider?.getModels().map((model) => model.id)).toContain("gpt-5.5");
});

test("without model.credentials (Cloudflare), a key in the environment configures it", async () => {
  const provider = await provided();

  const models = modelsFrom(provider === undefined ? [] : [provider], { authContext: { env: async (name) => (name === "OPENAI_API_KEY" ? "sk-test" : undefined), fileExists: async () => false } });
  expect((await models.getAuth("openai"))?.auth.apiKey).toBe("sk-test");
});
