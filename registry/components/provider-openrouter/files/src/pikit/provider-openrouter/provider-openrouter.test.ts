/**
 * provider-openrouter's tests. They are copied with the component and keep running in your project.
 * They make no request to OpenRouter and read no credential.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { modelsFrom, type Provider } from "@pikit/pi-adapter";
import providerOpenRouter from "./index.ts";

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [providerOpenRouter], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "provider-openrouter", provides: ["model.provider"], requires: [], optional: [] }]);
  expect(app.describe().capabilities["model.provider"]).toEqual({ providers: ["provider-openrouter"], keys: { openrouter: "provider-openrouter" } });
});

test("it provides pi-ai's OpenRouter provider under the key openrouter, with API-key sign-in and <vendor>/<model> ids", async () => {
  let provider: Provider | undefined;
  const reader = defineComponent({
    name: "provider-reader",
    setup(pikit) {
      const providers = pikit.useKeyed("model.provider");
      return { start: () => void (provider = providers.get("openrouter")) };
    },
  });
  const app = await defineApp({ components: [providerOpenRouter, reader], logger: silentLogger }).create();
  await app.start();

  expect(provider?.id).toBe("openrouter");
  expect(provider?.auth.apiKey).toBeDefined();
  // An agent's `openrouter/z-ai/glm-5.3-flash`: the provider before the first slash, the model id after.
  expect(modelsFrom(provider === undefined ? [] : [provider]).getModel("openrouter", "z-ai/glm-5.3-flash")?.id).toBe("z-ai/glm-5.3-flash");
  await app.stop();
});
