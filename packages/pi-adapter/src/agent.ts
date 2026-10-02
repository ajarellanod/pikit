/**
 * pikit's `AgentDefinition` as pi-durable's per-conversation agent (README.md, "Agents and state").
 *
 * - **Tools** live in the registry, by extension: every agent has one, `pikit.agent.<name>`, holding
 *   every tool its turns used so far (its static tools, and whatever `prepare` returned). A tool named
 *   in `tools` resolves through the runtime's `tool(name)`; an object is taken as it is. Each tool is
 *   wrapped once, so it runs with `CONVERSATION` and `AGENT_STATE` in its context, as before.
 * - **Extensions** an agent names (`extensions`) resolve through the runtime's `extension(name)`
 *   (`agent.extension`) each time the agent is applied, and are installed in the registry under their
 *   own name, as a copy whose tools are wrapped like the agent's (the registry is live: pi-durable
 *   resolves names against it at each use). A name nothing provides fails the agent: no silent skip.
 * - **The agent** of a conversation is its `pi.agent` document: the model, `instructions` (the system
 *   prompt), the agent's tool extension then its named extensions as the selection, in order, and the
 *   tools offered by name (the agent's, then each extension's). pi-durable reads it when it prepares
 *   each model request.
 * - **`agent.state`** is the `pikit.agent-state` document of the conversation: only what was updated,
 *   merged over the agent's initial state when read.
 * - **`prepare(state)`** decides that `pi.agent` document. It runs where its inputs change: when a
 *   message is admitted (the definition may have changed with a deploy), in the same commit as every
 *   state update, and before a reopened Harness resumes a conversation's work. So the agent pi-durable
 *   reads at each request is always `prepare` of the state as it is then: a state update made by a tool
 *   applies from the run's next model request (the old runtime waited for the next run).
 */

import type { JsonValue } from "@earendil-works/chord";
import {
  type AgentChange,
  AgentDoc,
  configure,
  type ConversationId,
  defineDoc,
  defineExtension,
  type Extension,
  type HarnessOptions,
  type Registry,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Logger } from "@pikit/core";
import type { AgentDefinition, ConversationRef, TurnConfig } from "@pikit/contracts";

/** A tool the durable runtime runs: pi-durable's (`defineTool`). */
export type DurableTool = ToolRegistration;

/** An agent extension: pi-durable's (`defineExtension`), the `agent.extension` capability. */
export type DurableExtension = Extension;

/** The prefix of the extensions the runtime names itself (an agent's tools): never a provided one's. */
export const RESERVED_EXTENSION_PREFIX = "pikit.";

/** pi-ai 1.0's `Models`, as pi-durable takes them. */
export type DurableModels = HarnessOptions["models"];

type JsonObject = { [key: string]: JsonValue };

/**
 * What pikit knows of a conversation that pi-durable does not: its `ConversationRef` minus the id
 * (`key`, `agent`). Written when a message is admitted, so a settlement found later (a run resumed
 * after a restart) can be announced with its conversation.
 */
export const ConversationDoc = defineDoc<{ key: string; agent: string }>({
  kind: "pikit.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ key: "", agent: "" }),
});

/** `agent.state`: the updates of the conversation's state (only those), merged over the agent's initial state when read. */
export const AgentStateDoc = defineDoc<JsonObject>({
  kind: "pikit.agent-state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

/** The extension of an agent's tools. */
export function extensionName(agent: string): string {
  return `pikit.agent.${agent}`;
}

/** One turn's configuration, resolved. */
export interface Turn {
  model: { provider: string; modelId: string };
  systemPrompt: string | undefined;
  tools: DurableTool[];
  /** The agent's named extensions, as provided, in order. */
  extensions: DurableExtension[];
}

export interface AgentConfigSource {
  models: DurableModels;
  registry: Registry;
  /** An installed tool by name (`agent.tool`). */
  tool?: ((name: string) => DurableTool | undefined) | undefined;
  /** An installed agent extension by name (`agent.extension`). */
  extension?: ((name: string) => DurableExtension | undefined) | undefined;
  /** The tool as it runs in a conversation: with `CONVERSATION` and `AGENT_STATE` in its context. */
  wrap(tool: DurableTool): DurableTool;
}

/** The effective state: the agent's initial state with the stored updates over it, a copy. */
export function effectiveState(agent: AgentDefinition, stored: Readonly<JsonObject> | undefined): Record<string, unknown> {
  return structuredClone({ ...(agent.state ?? {}), ...(stored ?? {}) });
}

/** Maps definitions to the registry and to each conversation's `pi.agent`. One per runtime. */
export class AgentConfigs {
  /** Per agent, the wrapped tools its extension holds, by name. */
  private readonly installed = new Map<string, Map<string, DurableTool>>();
  private readonly wrapped = new WeakMap<object, DurableTool>();
  /** Per provided extension, the copy installed in the registry (its tools wrapped). */
  private readonly installedExtensions = new WeakMap<DurableExtension, DurableExtension>();

  constructor(private readonly source: AgentConfigSource) {}

  /**
   * The static fields of `agent` with `prepare`'s changes over them. Throws when a model, a tool or an
   * extension name cannot be resolved, or when two tools share a name.
   */
  resolve(agent: AgentDefinition, changes: Partial<Record<keyof TurnConfig, unknown>> = {}): Turn {
    const tools = ((changes.tools as TurnConfig["tools"] | undefined) ?? agent.tools ?? []).map((entry) => this.toolOf(agent.name, entry));
    const names = tools.map((tool) => tool.name);
    const twice = names.find((name, index) => names.indexOf(name) !== index);
    if (twice !== undefined) throw new Error(`agent "${agent.name}": two tools are named "${twice}"`);
    const name = (changes.model as string | undefined) ?? agent.model;
    const slash = name.indexOf("/");
    const model = slash === -1 ? undefined : { provider: name.slice(0, slash), modelId: name.slice(slash + 1) };
    if (model === undefined || this.source.models.getModel(model.provider, model.modelId) === undefined) {
      throw new Error(`agent "${agent.name}": model "${name}" is not provided by any model.provider`);
    }
    const extensions = ((changes.extensions as TurnConfig["extensions"] | undefined) ?? agent.extensions ?? []).map((entry) => this.extensionOf(agent.name, entry));
    return { model, systemPrompt: (changes.systemPrompt as string | undefined) ?? agent.systemPrompt, tools, extensions };
  }

  /**
   * The turn `prepare` gives for `state`, or the static one when it throws or returns what cannot be
   * resolved (logged): the static fields are the agent's baseline. A static definition that cannot be
   * resolved throws: such an agent cannot run.
   */
  turn(agent: AgentDefinition, ref: ConversationRef, state: Readonly<Record<string, unknown>>, logger: Logger): Turn {
    const initial = this.resolve(agent);
    if (agent.prepare === undefined) return initial;
    try {
      return this.resolve(agent, agent.prepare.call(agent, state, { conversation: ref }) ?? {});
    } catch (error) {
      logger.error("prepare failed; the conversation has the agent's static definition", {
        conversation: ref.key,
        agent: agent.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return initial;
    }
  }

  /**
   * In `tx`: record the conversation's key and agent, and make its `pi.agent` what `prepare` gives
   * for `state` (installing the tools it names). Writes `pi.agent` only when it differs, so an
   * unchanged agent adds nothing to the transcript.
   */
  async apply(
    tx: Tx,
    conversationId: ConversationId,
    ref: ConversationRef,
    agent: AgentDefinition,
    state: Readonly<Record<string, unknown>>,
    logger: Logger,
  ): Promise<void> {
    const recorded = await tx.doc(ConversationDoc, conversationId);
    if (recorded.key !== ref.key) recorded.key = ref.key;
    if (recorded.agent !== ref.agent) recorded.agent = ref.agent;

    const turn = this.turn(agent, ref, state, logger);
    const own = this.install(agent.name, turn.tools);
    const selected = turn.extensions.map((extension) => this.installExtension(extension));
    // Offered by name: the agent's tools, then each extension's; a later one of the same name wins.
    const tools = [...own, ...selected.flatMap((extension) => extension.tools ?? [])];
    const names = [...new Set(tools.map((tool) => tool.name))];
    const extensions = [extensionName(agent.name), ...selected.map((extension) => extension.name)];
    const current = await tx.doc(AgentDoc, conversationId);
    const same =
      current.model?.provider === turn.model.provider &&
      current.model?.modelId === turn.model.modelId &&
      current.instructions === turn.systemPrompt &&
      JSON.stringify(current.extensions) === JSON.stringify(extensions) &&
      JSON.stringify(current.tools) === JSON.stringify(names);
    if (same) return;
    const change: AgentChange = {
      model: turn.model,
      instructions: turn.systemPrompt ?? null,
      // Stored by name: the objects only name them.
      extensions: extensions.map((name) => defineExtension({ name })),
      tools: names.map((name) => tools.find((tool) => tool.name === name) as DurableTool),
    };
    await configure(tx, conversationId, change);
  }

  /**
   * Install `extension` in the registry under its name, as a copy whose tools are wrapped, unless that
   * copy is installed already; a provider that changed the object installs it again (a reload).
   * Returns the installed copy.
   */
  private installExtension(extension: DurableExtension): DurableExtension {
    let copy = this.installedExtensions.get(extension);
    if (copy === undefined) {
      copy = extension.tools === undefined ? extension : { ...extension, tools: extension.tools.map((tool) => this.wrapOnce(tool)) };
      this.installedExtensions.set(extension, copy);
    }
    if (this.source.registry.snapshot().extension(copy.name) !== copy) this.source.registry.install(copy);
    return copy;
  }

  /**
   * Make the agent's extension hold `tools` (wrapped), installing it again when one is missing or
   * replaced by another object of the same name. Returns them wrapped, in order.
   */
  private install(agent: string, tools: readonly DurableTool[]): DurableTool[] {
    let held = this.installed.get(agent);
    if (held === undefined) {
      held = new Map();
      this.installed.set(agent, held);
    }
    let changed = !this.source.registry.snapshot().extension(extensionName(agent));
    const wrapped = tools.map((tool) => {
      const runnable = this.wrapOnce(tool);
      if (held.get(tool.name) !== runnable) {
        held.set(tool.name, runnable);
        changed = true;
      }
      return runnable;
    });
    if (changed) this.source.registry.install(defineExtension({ name: extensionName(agent), tools: [...held.values()] }));
    return wrapped;
  }

  private wrapOnce(tool: DurableTool): DurableTool {
    let runnable = this.wrapped.get(tool);
    if (runnable === undefined) {
      runnable = this.source.wrap(tool);
      this.wrapped.set(tool, runnable);
    }
    return runnable;
  }

  /** An extension the definition names, resolved through `agent.extension`. */
  private extensionOf(agent: string, name: unknown): DurableExtension {
    if (typeof name !== "string") throw new Error(`agent "${agent}": an extension is named by a string, as agent.extension provides it`);
    const resolved = this.source.extension?.(name);
    if (resolved === undefined) throw new Error(`agent "${agent}" names the extension "${name}", which no agent.extension provides`);
    if (resolved.name !== name) throw new Error(`agent "${agent}": the agent.extension "${name}" is an extension named "${resolved.name}"; an extension is provided under its own name`);
    if (name.startsWith(RESERVED_EXTENSION_PREFIX)) throw new Error(`agent "${agent}": the extension name "${name}" is reserved (${RESERVED_EXTENSION_PREFIX}*: the runtime's own)`);
    return resolved;
  }

  /** A tool of the definition as pi-durable's: a name resolved through `agent.tool`, an object as it is. */
  private toolOf(agent: string, entry: unknown): DurableTool {
    if (typeof entry === "string") {
      const resolved = this.source.tool?.(entry);
      if (resolved === undefined) throw new Error(`agent "${agent}" names the tool "${entry}", which no agent.tool provides`);
      return resolved;
    }
    // `AgentPayloads.tool` types it as pi-durable's; a project without the adapter's types may pass anything.
    const tool = entry as Partial<DurableTool> | null;
    if (typeof tool?.name !== "string" || typeof tool.execute !== "function") {
      throw new Error(`agent "${agent}": a tool object must be a pi-durable tool (defineTool)`);
    }
    return tool as DurableTool;
  }
}
