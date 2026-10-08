/**
 * `agent.directory`: agents that exist by name although no component provided them at setup (SPEC §6,
 * "What changes live is data"; features/settings.md, "Multi-agent"). `agent.definition` is keyed, and
 * its keys are fixed when the App is set up: an agent an operator creates in the dashboard is data, and
 * a runtime asks a directory for a name its definitions do not have.
 *
 *   const directory = pikit.useOptional("agent.directory");
 *   // when used (an admission, a rule that names an agent):
 *   const agent = await directory.get()?.get("support", ctx);   // a DirectoryAgent, or undefined
 *
 * A directory's agent is plain data (JSON): a name, a description, a model, a system prompt, and the
 * names of installed tools and extensions. It has no `prepare` and no tool objects: what needs code is
 * an `agent.definition`. A runtime builds it as it builds a definition (`DirectoryAgent` is one), with
 * the same overrides.
 *
 * What every provider guarantees:
 * - **Names are agents' names** (kebab-case, as `defineAgent` checks), unique, and **never a key of
 *   `agent.definition`**: an agent of the code cannot be shadowed by one of data. A provider refuses
 *   to store one (and does not list one a deploy made a code agent's).
 * - **A live agent is never the steward** (SPEC §6, `AgentDefinition.steward`): it has no `steward`
 *   field (a provider refuses one), and names no extension only the steward may (`pikit-self`, what
 *   the project is made of): a provider refuses it when stored, and a runtime when used.
 * - **Each agent is one `defineAgent` accepts**: a model named `provider/modelId`, tools and extensions
 *   by name, each named once. A provider checks what it can against the App when an agent is stored
 *   (a model an installed provider has, installed tools and extensions); a runtime checks again when
 *   it uses one, since a deploy may take a model away. A name nothing lists is no agent.
 * - **`list` is every agent now, by name; `get(name)` is `list`'s entry, or `undefined`.** A change
 *   applies to the next read, within the provider's bound (its settings', a second at most on
 *   Cloudflare): to the next admission, never a run already going.
 * - **Answers are copies**: changing one changes nothing stored.
 * - A provider that cannot be read rejects; a consumer then keeps what it read last.
 */

import type { AppContext } from "@pikit/core";

/** One agent of a directory: JSON, the fields of an `AgentDefinition` that are data. */
export interface DirectoryAgent {
  /** kebab-case; never an `agent.definition` key. */
  name: string;
  /** One line for an operator: what it is for. */
  description?: string;
  /** `provider/modelId`. */
  model: string;
  systemPrompt?: string;
  /** Names of `agent.tool` keys. */
  tools?: string[];
  /** Names of `agent.extension` keys, in order. */
  extensions?: string[];
}

/** The `agent.directory` capability. */
export interface AgentDirectory {
  /** Every agent of the directory now, sorted by name. */
  list(ctx: AppContext): Promise<DirectoryAgent[]>;
  /** The agent named `name` now, or `undefined`. */
  get(name: string, ctx: AppContext): Promise<DirectoryAgent | undefined>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    /** Agents that are data (an operator's), by name; optional: without it every agent is a definition. */
    "agent.directory": AgentDirectory;
  }
}
