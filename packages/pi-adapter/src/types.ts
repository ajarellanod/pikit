/**
 * Pi's exact types for the contracts' opaque agent payloads and for the capabilities whose contract
 * is Pi's own (a contract whose type is Pi's lives here). Importing `@pikit/pi-adapter` anywhere in
 * a project makes them precise everywhere, by declaration merging, as `AppEvents` is extended.
 *
 * Pi is pi-durable 1.0 and pi-ai 1.0: an agent's tool is pi-durable's `ToolRegistration`
 * (`defineTool`), the environment its tools work on is pi-durable's `ExecutionEnv`, and messages and
 * usage are pi-ai's.
 */

import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { Context as PikitContext } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import type { DurableMessage, DurableUsage } from "./result.ts";

/**
 * The `workspace` capability: where an agent's tools work. The runtime asks it for the workspace of
 * the conversation a tool call belongs to (`harnessEnv`); without a provider tools work on
 * `execution`, as every agent did before.
 *
 * Built so far: `resolve` and `env`. `ref` (the `WorkspaceRef` kept in the conversation registry),
 * `checkpoint` and `release` are `[planned]` with the providers that need them (snapshots, git).
 */
export interface WorkspaceProvider {
  /**
   * The workspace of `conversation`. A provider decides what it is keyed by (`workspace-local`: the
   * agent, one directory each) and may create it on the first call. It fails, and the tool call with
   * it, rather than hand out a workspace it cannot keep apart from the others.
   */
  resolve(conversation: ConversationRef, context: PikitContext): Promise<Workspace>;
}

export interface Workspace {
  /**
   * pi-durable's `ExecutionEnv`: files and shell. A provider without a real shell answers `exec` with
   * `shell_unavailable`, and `bash` then fails every call: do not give `bash` to its agents.
   */
  env: ExecutionEnv;
}

declare module "@pikit/contracts" {
  interface AgentPayloads {
    message: DurableMessage;
    tool: ToolRegistration;
    usage: DurableUsage;
  }
}

declare module "@pikit/core" {
  interface AppCapabilities {
    /**
     * pi-ai's `CredentialStore`: the credentials the model providers use, stored per provider id.
     * Tokens that pi-ai refreshes are written back through it. Without it, providers read only their
     * environment variables (`ANTHROPIC_API_KEY`).
     */
    "model.credentials": CredentialStore;
    /**
     * pi-durable's `ExecutionEnv`: the filesystem the agent's tools work on. Its `exec` may answer
     * `shell_unavailable`.
     */
    execution: ExecutionEnv;
    /** The same contract, provided only when `exec` really runs commands. Shell tools require it. */
    "execution.shell": ExecutionEnv;
    /**
     * Where each agent's tools work: the runtime resolves it per tool call, from the call's
     * conversation. Optional: without it tools work on `execution`.
     */
    workspace: WorkspaceProvider;
  }
  interface AppKeyedCapabilities {
    /** One pi-ai model provider per key (its id): `anthropic`, `openrouter`, `faux` in tests. */
    "model.provider": Provider;
  }
}
