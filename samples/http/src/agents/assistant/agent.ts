import { defineAgent } from "@pikit/core";

/** The sample's only agent. Claude answers; Pi runs the loop. */
export default defineAgent({
  name: "assistant",
  model: "anthropic/claude-sonnet-4-6",
  systemPrompt: "You are a helpful assistant reached over an HTTP API. Answer briefly and plainly.",
});
