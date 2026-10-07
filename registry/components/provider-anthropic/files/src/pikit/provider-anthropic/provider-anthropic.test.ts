/**
 * provider-anthropic's tests. They are copied with the component and keep running in your project.
 * They make no request to Anthropic and read no credential.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger, type Target } from "@pikit/core";
import { modelsFrom, type Provider } from "@pikit/pi-adapter";
import providerAnthropic from "./index.ts";

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [providerAnthropic], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "provider-anthropic", provides: ["model.provider"], requires: [], optional: [] }]);
  expect(app.describe().capabilities["model.provider"]).toEqual({ providers: ["provider-anthropic"], keys: { anthropic: "provider-anthropic" } });
});

/** The provider the component provides under `anthropic`, on `target`. */
async function providerOn(target: Target): Promise<Provider | undefined> {
  let provider: Provider | undefined;
  const reader = defineComponent({
    name: "provider-reader",
    setup(pikit) {
      const providers = pikit.useKeyed("model.provider");
      return { start: () => void (provider = providers.get("anthropic")) };
    },
  });
  const app = await defineApp({ components: [providerAnthropic, reader], target, logger: silentLogger }).create();
  await app.start();
  await app.stop();
  return provider;
}

test("it provides pi-ai's Anthropic provider under the key anthropic, with OAuth and API-key sign-in", async () => {
  const provider = await providerOn("server");

  expect(provider?.id).toBe("anthropic");
  expect(provider?.auth.oauth).toBeDefined();
  expect(provider?.auth.apiKey).toBeDefined();
  expect(provider?.getModels().map((model) => model.id)).toContain("claude-sonnet-4-6");
});

test("on durable (a Worker), keys only: no OAuth, the same models, and a key in the environment configures it", async () => {
  const provider = await providerOn("durable");

  expect(provider?.auth.oauth).toBeUndefined();
  expect(provider?.auth.apiKey).toBeDefined();
  expect(provider?.getModels()).toEqual((await providerOn("server"))?.getModels() ?? []);
  const models = modelsFrom(provider === undefined ? [] : [provider], { authContext: { env: async (name) => (name === "ANTHROPIC_API_KEY" ? "sk-ant-test" : undefined), fileExists: async () => false } });
  expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-test");
});
