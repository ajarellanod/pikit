import { expect, test } from "bun:test";
import { modelsFrom } from "../models.ts";
import { openrouterProvider } from "./openrouter.ts";

test("pi-ai's OpenRouter provider: id openrouter, API-key sign-in, models named <vendor>/<model>", () => {
  const provider = openrouterProvider();

  expect(provider.id).toBe("openrouter");
  expect(provider.auth.apiKey).toBeDefined();
  expect(provider.getModels().some((model) => model.id === "z-ai/glm-5.3-flash")).toBe(true);
  // An agent names it `openrouter/z-ai/glm-5.3-flash`: the provider is what comes before the first slash.
  expect(modelsFrom([provider]).getModel("openrouter", "z-ai/glm-5.3-flash")?.id).toBe("z-ai/glm-5.3-flash");
});
