/**
 * `model.complete`: ask one of the App's models for a text, once. No conversation, no tools, no
 * transcript: a prompt in, the model's text out (a title for a conversation, a summary, a label).
 *
 * The agent runtime provides it (runtime-pi: it owns the models, their providers and credentials, so
 * a component that wants a text needs no provider of its own):
 *
 *   const title = await pikit.use("model.complete").get().complete(
 *     { model: "anthropic/claude-haiku-4-5", system: "Answer with a title.", prompt: text, maxTokens: 32 },
 *     ctx,
 *   );
 *
 * What every provider guarantees:
 * - `model` is `provider/modelId`, as an agent names one, and a model of the App's providers: another
 *   (or a malformed name) is refused, and no model is asked.
 * - It resolves with the answer's text (its text parts, joined; it may be empty: an answer `maxTokens`
 *   cut is its text so far, not a failure), and rejects when the model call fails (no credentials, the
 *   provider's error) or `ctx` is cancelled (its signal reaches the model call; a cancelled context
 *   asks no model).
 * - It costs what the model call costs, and is not counted in any conversation's usage.
 */

import type { AppContext } from "@pikit/core";

/** One request: a prompt, and how to answer it. */
export interface CompletionRequest {
  /** `provider/modelId`: one the App's providers have. */
  model: string;
  /** The system prompt: what to do with the prompt. */
  system?: string;
  /** The user's text. */
  prompt: string;
  /** The most tokens the answer may take; absent, the model's own limit. */
  maxTokens?: number;
}

/** The `model.complete` capability. */
export interface ModelComplete {
  /** The model's text for `request`. Rejects for a model none of the providers has, a failed call, a cancelled `ctx`. */
  complete(request: CompletionRequest, ctx: AppContext): Promise<string>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "model.complete": ModelComplete;
  }
}
