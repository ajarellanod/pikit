/**
 * provider-openai-compatible: the models of any endpoint that speaks OpenAI's chat completions (a
 * vLLM or Ollama server, LM Studio, a gateway, a provider pi-ai has no factory for), for your agents.
 * It provides the keyed capability `model.provider` under the key `id` in config
 * (`openai-compatible` by default): an agent names a model `<id>/<model id>`.
 *
 * The provider is built with pi-ai's `createProvider` and its lazy `openai-completions` API, through
 * `@pikit/pi-adapter/provider` and `@pikit/pi-adapter/api/openai-completions`: the same parts any
 * provider of your own is written with. Pi does the rest: requests, retries, streaming, tool calls.
 *
 * Credentials, in pi-ai's order (`envApiKeyAuth`):
 * 1. A credential stored for `id` in `model.credentials`: an API key.
 * 2. Only when nothing is stored: the variable `apiKey` in config names, read through `secrets` first
 *    (when installed), then the environment.
 * Without `apiKey`, the provider counts as configured and requests carry a placeholder key,
 * `Bearer unused` (a local server ignores it).
 *
 * The models are config: pikit cannot list an unknown endpoint's models, nor know their prices, so
 * their cost is 0 in usage.
 *
 * Targets: `server` and `durable`: the provider's modules import nothing node-only.
 */

import { defineComponent } from "@pikit/core";
import { openAICompletionsApi } from "@pikit/pi-adapter/api/openai-completions";
import { type ApiKeyAuth, createProvider, envApiKeyAuth, type Model } from "@pikit/pi-adapter/provider";
import Type from "typebox";

const ModelConfig = Type.Object(
  {
    id: Type.String({ minLength: 1, description: "The model's id at the endpoint, sent as `model` (`llama3.1:8b`). An agent names it `<provider id>/<this id>`." }),
    name: Type.Optional(Type.String({ minLength: 1, description: "Its display name. Default: its id." })),
    contextWindow: Type.Integer({ minimum: 1, default: 128_000, description: "Its context window, in tokens: when to compact." }),
    maxTokens: Type.Integer({ minimum: 1, default: 16_384, description: "The most tokens an answer may have." }),
    reasoning: Type.Boolean({ default: false, description: "Whether it thinks before answering." }),
    images: Type.Boolean({ default: false, description: "Whether it reads images." }),
  },
  { additionalProperties: false },
);

const Config = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$",
      default: "openai-compatible",
      description: "The provider's id (kebab-case): the key it is provided under, before the slash of an agent's model.",
    }),
    baseUrl: Type.String({ minLength: 1, description: "The endpoint's API, up to the version: requests go to `<baseUrl>/chat/completions` (`http://localhost:11434/v1`)." }),
    apiKey: Type.Optional(
      Type.String({
        pattern: "^[A-Z][A-Z0-9_]*$",
        description: "The name of the variable (or secret) holding the endpoint's API key, never the key itself. Without it, the endpoint needs none (requests carry `Bearer unused`).",
      }),
    ),
    models: Type.Array(ModelConfig, { minItems: 1, description: "The endpoint's models your agents may name." }),
    compat: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "pi-ai's OpenAI compatibility settings (`maxTokensField`, `supportsDeveloperRole`…), for every model, when its detection from `baseUrl` is wrong.",
      }),
    ),
  },
  {
    additionalProperties: false,
    // A full config: `registry generate` describes setup with it too.
    examples: [{ id: "ollama", baseUrl: "http://localhost:11434/v1", models: [{ id: "llama3.1:8b" }] }],
  },
);

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * An endpoint without a key: always configured. pi-ai's OpenAI client refuses to send a request with
 * no key at all, so it sends `Bearer unused`, which a server without keys ignores.
 */
const KEYLESS: ApiKeyAuth = { name: "no key", resolve: async () => ({ auth: { apiKey: "unused" }, source: "no key" }) };

export default defineComponent({
  name: "provider-openai-compatible",
  config: Config,
  setup(pikit, config) {
    const models: Model<"openai-completions">[] = config.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      api: "openai-completions",
      provider: config.id,
      baseUrl: config.baseUrl,
      reasoning: model.reasoning,
      input: model.images ? ["text", "image"] : ["text"],
      cost: FREE,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(config.compat !== undefined && { compat: config.compat }),
    }));
    // Building the provider opens nothing: no connection, no credential read until a request.
    const provider = createProvider({
      id: config.id,
      baseUrl: config.baseUrl,
      auth: { apiKey: config.apiKey === undefined ? KEYLESS : envApiKeyAuth(`${config.id} API key`, [config.apiKey]) },
      models,
      api: openAICompletionsApi(),
    });
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});
