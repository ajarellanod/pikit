import { defineAgent } from "@pikit/contracts";

/**
 * The sample's only agent. Claude answers; Pi runs the loop. It names the installed tools it may
 * use: it reads, writes and edits files in the workspace (`.pikit/workspace/`) and runs commands
 * there. `execution-local` is not a sandbox (the sample's README, "Before you expose it").
 */
export default defineAgent({
  name: "assistant",
  model: "anthropic/claude-sonnet-4-6",
  systemPrompt:
    "You are a helpful assistant reached over an HTTP API. Answer briefly and plainly. " +
    "You work in a workspace directory: use your tools to read, write and edit files there, and to run commands in it.",
  tools: ["read", "write", "edit", "bash"],
});
