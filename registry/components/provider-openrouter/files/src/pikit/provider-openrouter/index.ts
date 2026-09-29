/**
 * provider-openrouter: the models OpenRouter serves, for your agents, named
 * `openrouter/<vendor>/<model>` (`openrouter/z-ai/glm-5.3-flash`). It provides the keyed capability
 * `model.provider` under the key `openrouter` (SPEC §4.5).
 *
 * The provider is pi-ai's, imported by subpath through `@pikit/pi-adapter/providers/openrouter`, so
 * the app carries this provider and no other. Pi does the rest: requests, retries, and credentials.
 *
 * Credentials, in pi-ai's order:
 * 1. A credential stored for `openrouter` in `model.credentials`: an API key.
 * 2. Only when nothing is stored: the environment, `OPENROUTER_API_KEY`.
 *
 * Your OpenRouter account's guardrails (allowed providers, data policy, a budget) apply: a model they
 * exclude fails at its first request with OpenRouter's error, not at start.
 *
 * Targets: `server` and `cloudflare`: the provider's module imports nothing node-only, and an API key
 * needs nothing more.
 */

import { defineComponent } from "@pikit/core";
import type { Provider } from "@pikit/pi-adapter";
import { openrouterProvider } from "@pikit/pi-adapter/providers/openrouter";

export default defineComponent({
  name: "provider-openrouter",
  setup(pikit) {
    // Building the provider opens nothing: no connection, no credential read until a request.
    const provider: Provider = openrouterProvider();
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});
