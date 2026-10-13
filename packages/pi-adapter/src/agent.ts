/**
 * pikit's `AgentDefinition` as pi-durable's per-conversation agent (README.md, "Agents and state").
 *
 * - **Tools** live in the registry, by extension: every agent has one, `pikit.agent.<name>`, holding
 *   every tool its turns used so far (its static tools, and whatever `prepare` returned). A tool named
 *   in `tools` resolves through the runtime's `tool(name)`; an object is taken as it is. Each tool is
 *   wrapped once, so it runs in its conversation's scope (the runtime's `scope`: `CONVERSATION`,
 *   `AGENT_STATE` and `RUN_REQUESTS` in its context).
 * - **Extensions** an agent names (`extensions`) resolve through the runtime's `extension(name)`
 *   (`agent.extension`) each time the agent is applied, and are installed in the registry under their
 *   own name, as a copy whose tools, system prompt sections and hooks (on the generation, tool and
 *   compaction tasks) are wrapped like the agent's tools (the registry is live: pi-durable resolves
 *   names against it at each use). A name nothing provides fails the agent: no silent skip.
 * - **Skills** an agent has (`skills`) are an extension of the runtime's, `pikit.skills.<agent>.<hash>`
 *   (one per set of skills): a system prompt section listing each one's name, description and
 *   location, as Pi's coding agent lists them, and the tool `skill` (`SKILL_TOOL`), which returns a
 *   skill's instructions. It comes right after the agent's tools, so a named extension may replace it.
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

import type { Context as ChordContext, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  AgentDoc,
  CompactionTask,
  configure,
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  type HarnessOptions,
  type HookRegistration,
  type PromptSection,
  type Registry,
  section,
  ToolTask,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Logger } from "@pikit/core";
import { type AgentDefinition, type AgentSkill, type ConversationRef, SKILL_TOOL, skillsProblem, type TurnConfig } from "@pikit/contracts";

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
 * (`key`, `agent`, and `channel` once a ref gave one). Written when a message is admitted, so a
 * settlement found later (a run resumed after a restart) can be announced with its conversation, and a
 * run sees its channel whatever ref reached it.
 */
export const ConversationDoc = defineDoc<{ key: string; agent: string; channel?: string }>({
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
  skills: readonly AgentSkill[];
}

/** The tasks whose hooks the runtime scopes: their handlers all end with `(…, api, context)`. */
const SCOPED_HOOK_TASKS: ReadonlySet<string> = new Set([GenerationTask.definition.name, ToolTask.definition.name, CompactionTask.definition.name]);

export interface AgentConfigSource {
  models: DurableModels;
  registry: Registry;
  /** An installed tool by name (`agent.tool`). */
  tool?: ((name: string) => DurableTool | undefined) | undefined;
  /** An installed agent extension by name (`agent.extension`). */
  extension?: ((name: string) => DurableExtension | undefined) | undefined;
  /**
   * `context` in the scope of the conversation `conversationId`: what a tool, a section or a hook of its
   * agent runs with (`CONVERSATION`, `AGENT_STATE`, `RUN_REQUESTS`); `context` itself when it has none.
   */
  scope(conversationId: ConversationId, context: ChordContext): Promise<ChordContext>;
}

/** `ref` with the conversation's recorded channel, which wins over a ref's own (a conversation's channel never changes). */
export function withChannel(ref: ConversationRef, channel: string | undefined): ConversationRef {
  return channel === undefined || channel === ref.channel ? ref : { ...ref, channel };
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
  /** Per provided extension, the copy installed in the registry (its tools, sections and hooks scoped). */
  private readonly installedExtensions = new WeakMap<DurableExtension, DurableExtension>();
  /** The runtime's skills extensions, by name. */
  private readonly installedSkills = new Map<string, DurableExtension>();

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
    const skills = (changes.skills as TurnConfig["skills"] | undefined) ?? agent.skills ?? [];
    const problem = skillsProblem(skills, names);
    if (problem !== undefined) throw new Error(`agent "${agent.name}": ${problem}`);
    return { model, systemPrompt: (changes.systemPrompt as string | undefined) ?? agent.systemPrompt, tools, extensions, skills };
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
   * In `tx`: record the conversation's key and agent (and its channel, the first time a ref gives one),
   * and make its `pi.agent` what `prepare` gives for `state` (installing the tools it names). Writes
   * `pi.agent` only when it differs, so an unchanged agent adds nothing to the transcript. The
   * definition owns `pi.agent` (SPEC §6): a `configure()` made on the conversation directly is undone
   * here. Returns the conversation as a run sees it: `ref` with the recorded channel.
   */
  async apply(
    tx: Tx,
    conversationId: ConversationId,
    ref: ConversationRef,
    agent: AgentDefinition,
    state: Readonly<Record<string, unknown>>,
    logger: Logger,
  ): Promise<ConversationRef> {
    const recorded = await tx.doc(ConversationDoc, conversationId);
    if (recorded.key !== ref.key) recorded.key = ref.key;
    if (recorded.agent !== ref.agent) recorded.agent = ref.agent;
    // A conversation belongs to one channel for good: the first ref with one records it.
    if (recorded.channel === undefined && ref.channel !== undefined) recorded.channel = ref.channel;
    const conversation = withChannel(ref, recorded.channel);

    const turn = this.turn(agent, conversation, state, logger);
    const own = this.install(agent.name, turn.tools);
    const selected = [...(turn.skills.length === 0 ? [] : [this.installSkills(agent.name, turn.skills)]), ...turn.extensions.map((extension) => this.installExtension(extension))];
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
    if (same) return conversation;
    const change: AgentChange = {
      model: turn.model,
      instructions: turn.systemPrompt ?? null,
      // Stored by name: the objects only name them.
      extensions: extensions.map((name) => defineExtension({ name })),
      tools: names.map((name) => tools.find((tool) => tool.name === name) as DurableTool),
    };
    await configure(tx, conversationId, change);
    return conversation;
  }

  /**
   * Install `extension` in the registry under its name, as a copy whose tools are wrapped, unless that
   * copy is installed already; a provider that changed the object installs it again (a reload).
   * Returns the installed copy.
   */
  private installExtension(extension: DurableExtension): DurableExtension {
    let copy = this.installedExtensions.get(extension);
    if (copy === undefined) {
      copy = {
        ...extension,
        ...(extension.tools !== undefined && { tools: extension.tools.map((tool) => this.wrapOnce(tool)) }),
        ...(extension.sections !== undefined && { sections: extension.sections.map((each) => this.scopedSection(each)) }),
        ...(extension.hooks !== undefined && { hooks: extension.hooks.map((each) => this.scopedHook(each)) }),
      };
      this.installedExtensions.set(extension, copy);
    }
    if (this.source.registry.snapshot().extension(copy.name) !== copy) this.source.registry.install(copy);
    return copy;
  }

  /** The runtime's extension of `skills` for `agent`, installed once per set of skills. */
  private installSkills(agent: string, skills: readonly AgentSkill[]): DurableExtension {
    const name = `${RESERVED_EXTENSION_PREFIX}skills.${agent}.${fingerprint(JSON.stringify(skills))}`;
    let extension = this.installedSkills.get(name);
    if (extension === undefined) {
      extension = skillsExtension(name, skills);
      this.installedSkills.set(name, extension);
    }
    if (this.source.registry.snapshot().extension(name) !== extension) this.source.registry.install(extension);
    return extension;
  }

  /** `prompt` rendered in its conversation's scope. */
  private scopedSection(prompt: PromptSection): PromptSection {
    return { ...prompt, render: async (input, context) => prompt.render(input, await this.source.scope(input.conversationId, context)) };
  }

  /** `registration`'s handlers called in their conversation's scope, for the built-in tasks (their last two arguments are `api`, `context`). */
  private scopedHook(registration: HookRegistration): HookRegistration {
    if (!SCOPED_HOOK_TASKS.has(registration.task)) return registration;
    const handlers: Record<string, unknown> = {};
    for (const [key, handler] of Object.entries(registration.handlers as Record<string, unknown>)) {
      handlers[key] =
        typeof handler !== "function"
          ? handler
          : async (...args: unknown[]) => {
              const context = args.at(-1) as ChordContext;
              const api = args.at(-2) as { conversationId: ConversationId };
              return (handler as (...given: unknown[]) => unknown).apply(registration.handlers, [...args.slice(0, -1), await this.source.scope(api.conversationId, context)]);
            };
    }
    return { ...registration, handlers };
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
      runnable = { ...tool, execute: async (args, api, context) => tool.execute(args, api, await this.source.scope(api.conversationId, context)) };
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

/** A short, stable fingerprint of `text` (FNV-1a, 32 bits, hex): names one set of skills. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** The skills section: Pi's coding agent's list, loaded with the `skill` tool. */
export function skillsText(skills: readonly AgentSkill[]): string {
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    `Use the ${SKILL_TOOL} tool to load a skill's instructions when the task matches its description.`,
    "When a skill's instructions reference a relative path, resolve it against the skill's location and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>", `    <name>${escapeXml(skill.name)}</name>`, `    <description>${escapeXml(skill.description)}</description>`);
    if (skill.location !== undefined) lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** What the `skill` tool returns for `skill`: its instructions, after where its files are. */
export function skillText(skill: AgentSkill): string {
  const where = skill.location === undefined ? "" : `Its files are in ${skill.location}: resolve the relative paths below against it.\n\n`;
  return `${where}${skill.instructions === "" ? "(This skill has no instructions.)" : skill.instructions}`;
}

/** The extension of an agent's skills: their section, and the `skill` tool. Read-only, so replay is safe. */
function skillsExtension(name: string, skills: readonly AgentSkill[]): DurableExtension {
  const text = skillsText(skills);
  const names = skills.map((skill) => skill.name);
  const tool = defineTool({
    name: SKILL_TOOL,
    description: "Loads a skill's instructions by its name. Use it when the task matches a skill's description in <available_skills>, before you start the task.",
    parameters: Type.Object({ name: Type.String({ description: `The skill's name: one of ${names.join(", ")}.` }) }),
    replay: "safe",
    async execute(args) {
      const skill = skills.find((each) => each.name === args.name);
      if (skill === undefined) throw new Error(`there is no skill "${args.name}"; the skills are: ${names.join(", ")}`);
      return { output: [{ type: "text", text: skillText(skill) }] };
    },
  });
  // Rendered once: the same text on every request, so the provider's prompt cache stays warm.
  return defineExtension({ name, sections: [section("skills", () => text, { tag: false })], tools: [tool as DurableTool] });
}
