/**
 * tool-websearch-gemini: the agent tool `websearch`, for the agents that name it
 * (`tools: ["websearch"]`). It asks Gemini, grounded in Google Search, and returns its answer and the
 * sources it used. An alternative to tool-websearch-brave: the same tool name and parameters, so no
 * agent changes; install one of the two (both provide `agent.tool` `websearch`).
 *
 * Built as tool-websearch-brave, the reference for a tool that needs a secret:
 * - **The tool** (`websearch.ts`) is pi-durable's `defineTool` from `@pikit/pi-adapter/tools`. It takes
 *   the key as a function (`apiKey()`), asked at each call: it never holds the key, never puts it in
 *   its description, parameters, answers or errors, so the model and the transcript never see it.
 * - **The key is a secret**, read through `secrets` (the component `use`s it): an environment variable
 *   on a server, a Worker secret on Cloudflare. A call without it fails, saying so. `configure.ts`
 *   asks for `GEMINI_API_KEY` in `pikit configure`; `component.json` declares it.
 * - **Config**: `apiKey`, the name of the variable holding the key (`GEMINI_API_KEY`), never the key
 *   itself: config is not secret; `model`, the Gemini model that searches; `apiBase`, the Gemini API
 *   (a proxy or a test double replaces it). All have defaults: a project needs no config.
 * - **Its replay is `"safe"`**: a search only reads, so a run resumed after a crash searches again.
 *
 * Targets: `server` and `durable`: it uses only `fetch`, wherever a `secrets` provider is installed.
 */

import { defineComponent } from "@pikit/core";
import Type from "typebox";
import { createGeminiSearchTool, GEMINI_DEFAULT_MODEL, GEMINI_KEY_SECRET } from "./websearch.ts";

export {
  createGeminiSearchTool,
  GEMINI_DEFAULT_MODEL as DEFAULT_MODEL,
  GEMINI_KEY_SECRET as KEY_SECRET,
  GEMINI_TIMEOUT_MS as TIMEOUT_MS,
  type GeminiSearchToolOptions,
} from "./websearch.ts";

const Config = Type.Object({
  apiKey: Type.String({
    pattern: "^[A-Z][A-Z0-9_]*$",
    default: GEMINI_KEY_SECRET,
    description: "The name of the variable (or secret) holding the Gemini API key, never the key itself: config is not secret.",
  }),
  model: Type.String({ minLength: 1, default: GEMINI_DEFAULT_MODEL, description: "The Gemini model that searches: one that can use the `google_search` tool." }),
  apiBase: Type.String({ minLength: 1, default: "https://generativelanguage.googleapis.com", description: "The Gemini API: a proxy or a test double replaces it." }),
});

export default defineComponent({
  name: "tool-websearch-gemini",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    // The key is read at each call, in start or later: `secrets.get()` throws during setup.
    const tool = createGeminiSearchTool({ apiKey: () => secrets.get().get(config.apiKey), apiKeyName: config.apiKey, apiBase: config.apiBase, model: config.model });
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match. Its
    // `summary` is what an operator reads next to it in the dashboard (the model reads its description).
    pikit.provideKeyed("agent.tool", "websearch", { ...tool, summary: "Searches the web (Google Search, through Gemini) and answers with its sources" });
  },
});
