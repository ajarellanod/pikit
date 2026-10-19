/**
 * provider-openai: OpenAI's models for your agents, named `openai/<modelId>` (`openai/gpt-5.5`). It
 * provides the keyed capability `model.provider` under the key `openai`.
 *
 * The provider is pi-ai's, imported by subpath through `@pikit/pi-adapter/providers/openai`, so the
 * app carries this provider and no other. Pi does the rest: requests (the Responses API), retries,
 * prompt caching, and credentials.
 *
 * Credentials, in pi-ai's order:
 * 1. A credential stored for `openai` in `model.credentials`: OAuth tokens from a "Sign in with
 *    ChatGPT" login (a ChatGPT Plus/Pro subscription), or an API key. pi-ai refreshes the OAuth
 *    tokens and writes them back.
 * 2. Only when nothing is stored: the environment, `OPENAI_API_KEY`.
 *
 * Signed in with ChatGPT, the classifier models (`openai-decisions`) are not offered: they need an
 * API key. pi-ai's `openai-codex` provider is the legacy way to a ChatGPT subscription; this login
 * supersedes it.
 *
 * Targets: `server` and `durable`, the same provider on both. A ChatGPT login needs
 * `model.credentials` to keep its tokens (`pikit configure --login` refuses without one):
 * credentials-file on a server, credentials-do on Cloudflare (which also bundles pi-ai's OAuth flow,
 * and refreshes a token once for every conversation).
 */

import { defineComponent } from "@pikit/core";
import { openaiProvider } from "@pikit/pi-adapter/providers/openai";

export default defineComponent({
  name: "provider-openai",
  setup(pikit) {
    // Building the provider opens nothing: no connection, no credential read until a request.
    const provider = openaiProvider();
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});
