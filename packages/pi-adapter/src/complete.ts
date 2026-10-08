/**
 * `model.complete` over pi-ai 1.0's models (`@pikit/contracts`' `ModelComplete`): one request, no
 * conversation, no tools, no transcript. runtime-pi provides it over the same models its agents run
 * on (`modelsFrom`: the `model.provider` components, `model.credentials`, `secrets`).
 *
 * - The model is `provider/modelId` (`parseModelName`), checked against the models first: an unknown
 *   one asks nothing.
 * - pi-ai's `completeSimple` never rejects for a provider's failure: its answer says so
 *   (`stopReason` `error` or `aborted`, `errorMessage`). Here that is a rejection, as the contract says.
 * - `ctx`'s signal reaches the model call; a cancelled context asks no model.
 * - **A model that reasons**: `maxTokens` is the answer's text, and a provider counts the thinking in
 *   it (OpenRouter does), so `REASONING_TOKENS` more are allowed for it. One whose thinking cannot be
 *   turned off (`thinkingLevelMap.off` null: `openrouter/z-ai/glm-5.3-flash`) thinks at the least it
 *   allows (`minimal`, which pi-ai raises to the lowest level the model has); pi-ai turns off another's.
 *   Without that, a short answer (a title's 32 tokens) was spent thinking, and came back empty.
 */

import type { Models } from "@earendil-works/pi-ai/models";
import type { AppContext } from "@pikit/core";
import type { CompletionRequest, ModelComplete } from "@pikit/contracts";
import { parseModelName } from "./models.ts";

/** The tokens a reasoning model may think in, besides the answer's `maxTokens`. */
export const REASONING_TOKENS = 2_048;

/** `model.complete` over `models()`, read at each call (runtime-pi makes them at start). */
export function createModelComplete(models: () => Models): ModelComplete {
  return {
    async complete(request: CompletionRequest, ctx: AppContext): Promise<string> {
      ctx.abortSignal?.throwIfAborted();
      const ref = parseModelName(request.model);
      const all = models();
      const model = ref === undefined ? undefined : all.getModel(ref.provider, ref.modelId);
      if (model === undefined) throw new Error(`model.complete: no model "${request.model}" among the App's providers (provider/modelId)`);
      const answer = await all.completeSimple(
        model,
        {
          ...(request.system !== undefined && { systemPrompt: request.system }),
          messages: [{ role: "user", content: request.prompt, timestamp: ctx.clock.now() }],
        },
        {
          ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens + (model.reasoning ? REASONING_TOKENS : 0) }),
          ...(model.reasoning && model.thinkingLevelMap?.off === null && { reasoning: "minimal" as const }),
          ...(ctx.abortSignal !== undefined && { signal: ctx.abortSignal }),
        },
      );
      if (answer.stopReason === "error" || answer.stopReason === "aborted") {
        throw new Error(`model.complete: ${request.model} ${answer.stopReason === "aborted" ? "was cancelled" : "failed"}${answer.errorMessage === undefined ? "" : `: ${answer.errorMessage}`}`);
      }
      return answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    },
  };
}
