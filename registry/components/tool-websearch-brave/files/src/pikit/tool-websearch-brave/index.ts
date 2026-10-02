/**
 * tool-websearch-brave: the agent tool `websearch`, for the agents that name it
 * (`tools: ["websearch"]`). It searches the web with the Brave Search API and returns the results:
 * title, address, when Brave knows it how old the page is, and a snippet.
 *
 * - **The key is a secret.** `BRAVE_API_KEY` is read through `secrets` at each call and sent only to
 *   Brave, in the `X-Subscription-Token` header. It never appears in the tool's description,
 *   parameters, answers or errors, so the model never sees it. A call without it fails, saying so.
 * - **Its replay is `"safe"`**: a search only reads, so a run resumed after a crash searches again.
 * - **`apiBase`** in config is Brave's API by default; a proxy or a test double replaces it.
 *
 * The tool itself is `createBraveSearchTool` in @pikit/pi-adapter/tools (pi-durable's `defineTool`);
 * this component gives it the key and `apiBase`.
 *
 * Targets: `server` and `cloudflare`: it uses only `fetch`, wherever a `secrets` provider is
 * installed.
 */

import { defineComponent } from "@pikit/core";
import { BRAVE_KEY_SECRET, BRAVE_SEARCH_PATH, BRAVE_TIMEOUT_MS, createBraveSearchTool } from "@pikit/pi-adapter/tools";
import Type from "typebox";

/** The secret holding the Brave Search API key (api-dashboard.search.brave.com). */
export const KEY_SECRET = BRAVE_KEY_SECRET;
/** Brave's web search endpoint, under `apiBase`. */
export const SEARCH_PATH = BRAVE_SEARCH_PATH;
export const TIMEOUT_MS = BRAVE_TIMEOUT_MS;

const Config = Type.Object({
  /** Brave Search's API. A value, for a proxy or a test double. */
  apiBase: Type.String({ minLength: 1, default: "https://api.search.brave.com" }),
});

export default defineComponent({
  name: "tool-websearch-brave",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const tool = createBraveSearchTool({ apiKey: () => secrets.get().get(KEY_SECRET), apiBase: config.apiBase });
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
    pikit.provideKeyed("agent.tool", "websearch", tool);
  },
});
