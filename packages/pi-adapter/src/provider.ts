/**
 * @pikit/pi-adapter/provider: what writing a model provider takes, from pi-ai's lean entries (no
 * catalog, no SDK), so a project writes one without importing Pi (only the adapter does):
 *
 * ```ts
 * import { createProvider, envApiKeyAuth } from "@pikit/pi-adapter/provider";
 * import { openAICompletionsApi } from "@pikit/pi-adapter/api/openai-completions";
 *
 * const provider = createProvider({
 *   id: "my-llm",
 *   baseUrl: "https://llm.example.com/v1",
 *   auth: { apiKey: envApiKeyAuth("My LLM API key", ["MY_LLM_API_KEY"]) },
 *   models: [{ id: "big", name: "Big", api: "openai-completions", provider: "my-llm", baseUrl: "https://llm.example.com/v1",
 *     reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 }],
 *   api: openAICompletionsApi(),
 * });
 * ```
 *
 * - `createProvider` builds a `Provider` from parts (`@earendil-works/pi-ai/models`).
 * - `envApiKeyAuth(name, variables)`: a stored credential wins, else the first variable set, read
 *   through the runtime's `AuthContext` (runtime-pi reads `secrets` first, then the environment).
 * - The APIs are one subpath each, `@pikit/pi-adapter/api/<name>` (generated: `openai-completions`,
 *   `openai-responses`, `anthropic-messages`, `google-generative-ai`, `mistral-conversations`…).
 *
 * Neutral: no node-only import.
 */

export { createProvider } from "@earendil-works/pi-ai/models";
export type { CreateProviderOptions, Provider } from "@earendil-works/pi-ai/models";
export { envApiKeyAuth } from "@earendil-works/pi-ai";
export type { Api, ApiKeyAuth, AuthContext, Model, ModelCost, ProviderAuth, ProviderStreams } from "@earendil-works/pi-ai";
