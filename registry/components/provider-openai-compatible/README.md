# provider-openai-compatible

The models of any endpoint that speaks OpenAI's chat completions, for your agents: a vLLM or Ollama
server, LM Studio, a gateway, or a provider pi-ai has no factory for. An agent names one as
`<id>/<model>`, for example `ollama/llama3.1:8b`.

- **Provides:** `model.provider`, under the key `id` in config (`openai-compatible` by default).
- **Requires:** nothing. The agent runtime reads credentials from `model.credentials` when it is
  installed, and the key's variable through `secrets` when it is installed.
- **Targets:** `server` and `durable`: the provider's modules import nothing node-only.
- **Installs to:** `src/pikit/provider-openai-compatible/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

It builds a pi-ai provider from config with `createProvider` and the lazy `openai-completions` API
(`@pikit/pi-adapter/provider`, `@pikit/pi-adapter/api/openai-completions`): the parts any provider
of your own is written with ("Your own provider" below). Pi handles requests, retries, streaming and
tool calls.

## Config

The config has no default for the endpoint or its models: the App refuses to start until you give
them.

```ts
config: {
  "provider-openai-compatible": {
    id: "ollama",                          // agents name ollama/<model>; kebab-case
    baseUrl: "http://localhost:11434/v1",  // requests go to <baseUrl>/chat/completions
    apiKey: "OLLAMA_API_KEY",              // the variable holding the key; leave it out for none
    models: [
      { id: "llama3.1:8b" },
      { id: "qwen3-vl", name: "Qwen3 VL", images: true, reasoning: true, contextWindow: 32000, maxTokens: 4096 },
    ],
  },
}
```

- `models`: the endpoint's model ids, as it expects them in a request's `model`. pikit cannot list an
  unknown endpoint's models or know its prices: `contextWindow` (default 128000) and `maxTokens`
  (16384) are yours to set, and usage reports a cost of 0.
- `compat` (optional): pi-ai's OpenAI compatibility settings (`maxTokensField`,
  `supportsDeveloperRole`…), for every model, when pi-ai's detection from `baseUrl` is wrong for your
  endpoint.
- For a second endpoint, install a component of your own, or copy this one under another name: one
  component provides one id.

## Credentials

With `apiKey`, pi-ai looks for the key in this order:
1. A credential stored for `id` in `model.credentials` (for example `credentials-file`).
2. Only when nothing is stored, the variable `apiKey` names: through `secrets` first when installed
   (on Cloudflare, the Worker's secrets), then the environment.

The agent runtime refuses to start when neither exists. The variable's name is config, so
`component.json` cannot declare it and `pikit configure` does not ask for it: put it in `.env`
(`pikit dev`, Docker) or in the Worker's secrets (`wrangler secret put`) yourself.

Without `apiKey`, the endpoint needs no key: the provider is always configured, and requests carry
`Authorization: Bearer unused` (pi-ai's OpenAI client sends nothing without a key), which a server
without keys ignores.

## Your own provider

A provider pi-ai ships is a subpath of the adapter (`@pikit/pi-adapter/providers/<id>`: `groq`,
`mistral`, `google`…), so a component for it is about ten lines:

```ts
import { defineComponent } from "@pikit/core";
import { groqProvider } from "@pikit/pi-adapter/providers/groq";

export default defineComponent({
  name: "provider-groq",
  setup(pikit) {
    const provider = groqProvider();
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});
```

and a `component.json` with its targets and its key's variable in `environment` (`GROQ_API_KEY`,
pi-ai's README lists them). An endpoint pi-ai does not know is `createProvider` with an API from
`@pikit/pi-adapter/api/<name>`, as `index.ts` here does.

## Tests

`provider-openai-compatible.test.ts` is copied with the component and runs in your project. It
reads no credential and reaches no network: a model answers from `fake-endpoint.test-support.ts`, a
local stand-in of OpenAI's streamed chat completions that answers `answer: <your message>` and
records the model and key it was asked with. Only tests import it.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
