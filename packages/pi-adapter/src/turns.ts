/**
 * What an agent has for each run: its static definition, or what its `prepare(state)` returns
 * (SPEC §6.2a). Pi provides every mechanism; this file only decides when to use them:
 * - `prepare` runs in Pi's `before_run` hook, before the run's first model call;
 * - the model and the active tools are Pi's lane configuration (`setModel`, `setActiveTools`),
 *   persisted by Pi, so a resumed run keeps them;
 * - the tool objects are the harness's (`setTools`), and the system prompt is the harness's
 *   `systemPrompt` function, which reads the prompt chosen for the run;
 * - what the run had is appended to the session as a `pikit.turn` custom entry, so "what did the
 *   agent have on run N" is read from the transcript. Custom entries never reach the model.
 *
 * A run a dead worker left open is prepared again when a new worker resumes it, with the state as
 * it is then. Pi persists neither the system prompt nor the tool objects, and the run's own tools
 * may have moved the state on before the crash; preparing again keeps the harness consistent with
 * the lane. The interrupted tool call follows Pi's replay rules: a `safe` tool that the new
 * configuration no longer has is recorded as interrupted, like a `never` one.
 */

import type { AgentHarness, AgentLane, Context, JsonValue } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { AgentDefinition, AgentState, AgentTool, ConversationRef, Logger, TurnConfig } from "@pikit/core";

/** `customType` of the entry that records what a run had. */
export const TURN = "pikit.turn";

/** What the `pikit.turn` entry holds: the resolved `TurnConfig`, tools by name. */
export interface TurnRecord {
  model: string;
  systemPrompt?: string;
  tools: string[];
}

/** One run's configuration, resolved to Pi's objects. */
export interface Turn {
  model: Model<Api>;
  systemPrompt: string | undefined;
  tools: AgentTool[];
}

export interface TurnSource {
  agent: AgentDefinition;
  models: Models;
  /** An installed tool by name (`agent.tool`). */
  tool: ((name: string) => AgentTool | undefined) | undefined;
  /** Tools the extensions registered: always in the harness, next to the agent's. */
  extensionTools: readonly AgentTool[];
}

/** What `prepare` returns: the `TurnConfig` fields it changes. */
type TurnChanges = ReturnType<NonNullable<AgentDefinition["prepare"]>>;

/**
 * The static fields of the definition, with `changes` over them. Throws when a model or a tool name
 * cannot be resolved, or when two tools share a name.
 */
export function resolveTurn(source: TurnSource, changes: TurnChanges = {}): Turn {
  const { agent } = source;
  const tools = resolveTools(agent.name, changes.tools ?? agent.tools ?? [], source.tool);
  const names = [...tools, ...source.extensionTools].map(nameOf);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) throw new Error(`agent "${agent.name}": two tools are named "${twice}"`);
  const model = resolveModel(source.models, agent.name, changes.model ?? agent.model);
  return { model, systemPrompt: changes.systemPrompt ?? agent.systemPrompt, tools };
}

/**
 * The prepared turns of one open conversation. `systemPrompt` is what the harness sends for the
 * run in progress; everything else lives in Pi.
 */
export class Turns {
  systemPrompt: string | undefined;
  /** The static definition, resolved: what the harness starts with. */
  readonly initial: Turn;

  constructor(
    private readonly source: TurnSource,
    private readonly ref: ConversationRef,
    private readonly state: AgentState,
    private readonly logger: Logger,
  ) {
    // The static turn resolves when the conversation opens, as before prepare existed: a definition
    // that cannot run fails the open, not a run.
    this.initial = resolveTurn(source);
    this.systemPrompt = this.initial.systemPrompt;
  }

  /** The tools the harness is created with. */
  get tools(): AgentTool[] {
    return [...this.initial.tools, ...this.source.extensionTools];
  }

  /**
   * Before a run starts (Pi's `before_run`) or a new worker resumes it: ask `prepare` with the
   * conversation's current state and give the run what it returned. If `prepare` throws or returns
   * what cannot be resolved, the run gets the static definition and the error is logged: the static
   * fields are the agent's baseline.
   */
  async prepareRun(harness: AgentHarness<undefined>, lane: AgentLane, ctx: Context): Promise<void> {
    const turn = await this.prepared(ctx);
    await harness.setTools([...turn.tools, ...this.source.extensionTools], ctx);
    // Extension tools stay as the extensions left them; the agent's are exactly this run's.
    const active = await lane.getActiveTools(ctx);
    const extensions = this.source.extensionTools.map(nameOf).filter((name) => active.includes(name));
    const names = [...turn.tools.map(nameOf), ...extensions];
    if (!sameList(active, names)) await lane.setActiveTools(names, ctx);
    const model = await lane.getModel(ctx);
    if (model?.provider !== turn.model.provider || model.id !== turn.model.id) {
      await lane.setModel({ provider: turn.model.provider, modelId: turn.model.id }, ctx);
    }
    this.systemPrompt = turn.systemPrompt;
    const record: TurnRecord = {
      model: `${turn.model.provider}/${turn.model.id}`,
      ...(turn.systemPrompt !== undefined && { systemPrompt: turn.systemPrompt }),
      tools: turn.tools.map(nameOf),
    };
    // During a run Pi places the entry at the run's next boundary, before its first model call.
    await lane.appendCustomEntry(TURN, record as unknown as JsonValue, ctx);
  }

  /** The turn `prepare` gives for the current state, or the static one if it fails. */
  private async prepared(ctx: Context): Promise<Turn> {
    const prepare = this.source.agent.prepare;
    if (prepare === undefined) return this.initial;
    try {
      const state = await this.state.get(ctx);
      return resolveTurn(this.source, prepare.call(this.source.agent, state, { conversation: this.ref }) ?? {});
    } catch (error) {
      this.logger.error("prepare failed; the run has the agent's static definition", {
        conversation: this.ref.key,
        agent: this.source.agent.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.initial;
    }
  }
}

function resolveModel(models: Models, agent: string, name: string): Model<Api> {
  const slash = name.indexOf("/");
  const model = slash === -1 ? undefined : models.getModel(name.slice(0, slash), name.slice(slash + 1));
  if (model === undefined) throw new Error(`agent "${agent}": model "${name}" is not provided by any model.provider`);
  return model;
}

/** The agent's tools as objects: each name resolved through `agent.tool`, each object as it is. */
function resolveTools(agent: string, tools: TurnConfig["tools"], tool: TurnSource["tool"]): AgentTool[] {
  return tools.map((entry) => {
    if (typeof entry !== "string") return entry;
    const resolved = tool?.(entry);
    if (resolved === undefined) throw new Error(`agent "${agent}" names the tool "${entry}", which no agent.tool provides`);
    return resolved;
  });
}

function nameOf(tool: AgentTool): string {
  return tool.name;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}
