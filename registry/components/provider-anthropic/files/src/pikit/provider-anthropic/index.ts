/**
 * provider-anthropic: Anthropic's Claude models for your agents, named `anthropic/<modelId>`
 * (`anthropic/claude-sonnet-4-6`). It provides the keyed capability `model.provider` under the key
 * `anthropic`.
 *
 * The provider is pi-ai's, imported by subpath through `@pikit/pi-adapter/providers/anthropic`, so
 * the app carries this provider and no other. Pi does the rest: requests, retries, prompt caching,
 * and credentials.
 *
 * Credentials, in pi-ai's order:
 * 1. A credential stored for `anthropic` in `model.credentials`: OAuth tokens from a Claude
 *    subscription login, or an API key. pi-ai refreshes the OAuth tokens and writes them back.
 * 2. Only when nothing is stored: the environment, `ANTHROPIC_API_KEY` (or
 *    `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`), then workload identity federation when
 *    `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE`
 *    are all set.
 *
 * Its OAuth login first asks how to log in: `browser` (a callback on localhost) or `copy_code`
 * (Anthropic's page shows a code to paste, for a login where the app runs).

 *
 * Target: `server`. On Cloudflare, an API key would work, but an OAuth refresh loads its flow
 * with a dynamic import, which Workers do not allow.
 */

import { defineComponent } from "@pikit/core";
import type { Provider } from "@pikit/pi-adapter";
import { anthropicProvider } from "@pikit/pi-adapter/providers/anthropic";

export default defineComponent({
  name: "provider-anthropic",
  setup(pikit) {
    // Building the provider opens nothing: no connection, no credential read until a request.
    const provider: Provider = anthropicProvider();
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});
