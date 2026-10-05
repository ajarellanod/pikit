/**
 * The adapter's generated provider and API subpaths against the pinned pi-ai (`pi-providers.ts`): a
 * pin bump that adds, renames or drops a provider fails here until the generator runs again.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SERVER_ONLY_EXPORTS } from "../packages/cli/src/registry/imports.ts";
import { ADAPTER_DIR, drift, lazyApis, piAiDist } from "./pi-providers.ts";

const exportsOf = () => (JSON.parse(readFileSync(join(ADAPTER_DIR, "package.json"), "utf8")) as { exports: Record<string, string> }).exports;
const load = async (specifier: string) => (await import(pathToFileURL(Bun.resolveSync(specifier, ADAPTER_DIR)).href)) as Record<string, unknown>;

test("the generated files and package.json exports are what pi-ai gives (bun scripts/pi-providers.ts)", async () => {
  expect(await drift()).toEqual([]);
});

test("one subpath per pi-ai built-in provider: getBuiltinProviders() plus the dynamic ones (Radius), each exporting its factory", async () => {
  const all = (await import(pathToFileURL(join(piAiDist(), "providers", "all.js")).href)) as {
    getBuiltinProviders(): string[];
    builtinProviders(): { id: string }[];
  };
  const expected = new Set([...all.getBuiltinProviders(), ...all.builtinProviders().map((provider) => provider.id)]);
  expect(expected.has("radius")).toBe(true);
  const subpaths = Object.keys(exportsOf())
    .filter((key) => key.startsWith("./providers/") && key !== "./providers/faux")
    .map((key) => key.slice("./providers/".length));
  expect(subpaths.sort()).toEqual([...expected].sort());

  for (const id of subpaths) {
    const module = await load(`@pikit/pi-adapter/providers/${id}`);
    const factories = Object.entries(module).filter(([name, value]) => name.endsWith("Provider") && typeof value === "function");
    expect(factories.length, `providers/${id}`).toBe(1);
    const provider = (factories[0]?.[1] as () => { id: string; auth: object })();
    expect(provider.id).toBe(id);
  }
});

test("one subpath per lazy API, each exporting its ProviderStreams wrapper; no barrel", async () => {
  const apis = Object.keys(exportsOf())
    .filter((key) => key.startsWith("./api/"))
    .map((key) => key.slice("./api/".length));
  expect(apis).toEqual(lazyApis());
  expect(apis).toContain("openai-completions");
  const { openAICompletionsApi } = await load("@pikit/pi-adapter/api/openai-completions");
  expect(typeof (openAICompletionsApi as () => { stream: unknown })().stream).toBe("function");
  expect(Object.keys(exportsOf())).not.toContain("./providers");
});

test("the provider kit: createProvider and envApiKeyAuth build a working provider without importing Pi", async () => {
  const { createProvider, envApiKeyAuth } = (await load("@pikit/pi-adapter/provider")) as typeof import("../packages/pi-adapter/src/provider.ts");
  const { openAICompletionsApi } = (await load("@pikit/pi-adapter/api/openai-completions")) as typeof import("../packages/pi-adapter/src/api/openai-completions.ts");
  const provider = createProvider({
    id: "my-llm",
    auth: { apiKey: envApiKeyAuth("My LLM API key", ["MY_LLM_API_KEY"]) },
    models: [],
    api: openAICompletionsApi(),
  });
  expect(provider.id).toBe("my-llm");
  expect(provider.auth.apiKey?.name).toBe("My LLM API key");
});

test("every server-only provider or API subpath is an export of the adapter", () => {
  const exported = new Set(Object.keys(exportsOf()).map((key) => `@pikit/pi-adapter${key.slice(1)}`));
  const listed = SERVER_ONLY_EXPORTS.filter((entry) => /^@pikit\/pi-adapter\/(providers|api)\//.test(entry));
  expect(listed.length).toBeGreaterThan(0);
  for (const entry of listed) expect(exported.has(entry), entry).toBe(true);
});
