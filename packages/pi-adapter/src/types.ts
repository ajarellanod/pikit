/**
 * Pi's exact types for the core's opaque agent payloads and for the capabilities whose contract is
 * Pi's own (SPEC §6.1, "Who owns these types"). Importing `@pikit/pi-adapter` anywhere in a project
 * makes them precise everywhere, by declaration merging, as `AppEvents` is extended.
 */

import type { AgentHarnessTool, AgentMessage, Context, ExecutionEnv, SessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core";
import type { CredentialStore, Provider, Usage } from "@earendil-works/pi-ai";
import type { ConversationRef, Context as PikitContext } from "@pikit/core";
import type { PiExtension } from "./extensions/api.ts";

/**
 * Any `SessionRepo`: JSONL, memory, SQLite. Their metadata and options differ; the adapter only
 * lists, opens and creates, so it accepts them all.
 */
// biome-ignore lint/suspicious/noExplicitAny: the repo's metadata type is the store's own
export interface SessionStore extends SessionRepo<any, any, any> {
  /**
   * The metadata `open` needs for the session `id`, or `undefined` when there is none. Pi's repos
   * open a session from its metadata and can only find it by listing every session; a store that can
   * look one up by id (an index, a SQL `WHERE id = ?`) offers `find`, and the runtime uses it for
   * every conversation it opens. Optional: without it, the runtime lists.
   */
  find?(id: string, context: Context): Promise<SessionMetadata | undefined>;
}

/**
 * The `workspace` capability (SPEC §8.2): where an agent's tools work. The tool components ask it for
 * the workspace of the conversation a run belongs to (`CONVERSATION` in the run's context); without a
 * provider they work on `execution`, as every agent did before.
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
   * Pi's `ExecutionEnv`: files and shell. A provider without a real shell answers `exec` with
   * `shell_unavailable`, and Pi's `bash` then fails every call: do not give `bash` to its agents.
   */
  env: ExecutionEnv;
}

declare module "@pikit/core" {
  interface AgentPayloads {
    message: AgentMessage;
    // The tool context (Pi's own tools take `{ env }`) is decided with the tool-* components (§6.3).
    // biome-ignore lint/suspicious/noExplicitAny: see above
    tool: AgentHarnessTool<any>;
    usage: Usage;
  }
  interface AppCapabilities {
    /** Pi's `SessionRepo` (SPEC §7.5): where conversations' sessions live. */
    "sessions.store": SessionStore;
    /**
     * pi-ai's `CredentialStore`: the credentials the model providers use, stored per provider id.
     * Tokens that Pi refreshes are written back through it. Without it, providers read only their
     * environment variables (`ANTHROPIC_API_KEY`).
     */
    "model.credentials": CredentialStore;
    /**
     * Pi's `ExecutionEnv` (SPEC §8.3): the filesystem the agent's tools work on. Its `exec` may answer
     * `shell_unavailable`.
     */
    execution: ExecutionEnv;
    /** The same contract, provided only when `exec` really runs commands. Shell tools require it. */
    "execution.shell": ExecutionEnv;
    /**
     * Where each agent's tools work (SPEC §8.2): the file and shell tools resolve it per run, from the
     * run's conversation. Optional for them: without it they work on `execution`.
     */
    workspace: WorkspaceProvider;
  }
  interface AppKeyedCapabilities {
    /** One pi-ai model provider per key (its id): `anthropic`, `openai`, `faux` in tests. */
    "model.provider": Provider;
    /**
     * One Pi extension factory per key (its name), unmodified (SPEC §6.2b). An agent loads it only if
     * it names it in `AgentDefinition.extensions`.
     */
    "agent.extension": PiExtension;
  }
}
