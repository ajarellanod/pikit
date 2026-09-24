import { expect, test } from "bun:test";
import { anthropicProvider } from "./anthropic.ts";

test("pi-ai's Anthropic provider: id anthropic, API-key and OAuth sign-in, Claude models", () => {
  const provider = anthropicProvider();

  expect(provider.id).toBe("anthropic");
  expect(provider.auth.apiKey).toBeDefined();
  expect(provider.auth.oauth).toBeDefined();
  expect(provider.getModels().some((model) => model.id === "claude-sonnet-4-6")).toBe(true);
});
