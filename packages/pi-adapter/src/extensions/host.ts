/**
 * Runs Pi extensions for one conversation (SPEC §6.2b). Pi gives each session its own extension
 * runtime; pikit does the same for each conversation it opens, so `pi.sendMessage()` and every
 * other action is bound to the conversation whose harness is open, with no ambient "current
 * conversation".
 *
 * Two phases, as in Pi:
 * 1. **Load** (`loadExtensions`): each factory runs and registers handlers, tools and providers.
 *    Actions (`sendMessage`, `setActiveTools`…) throw here: there is no conversation yet. The
 *    harness is created with the tools registered here, so a tool registered later (Pi allows it,
 *    for example once `session_start` has connected to a backend) is ignored with a warning, once
 *    per name (`features/codemode.md`).
 * 2. **Bind** (`bind`): once the harness exists, Pi's extension events are translated onto the
 *    harness hooks and events of `AgentHarness`, the class pikit runs (Pi's coding agent still
 *    runs the legacy `Agent`), and actions reach the conversation's lane.
 *
 * Tools follow Pi's exposure (`ToolDefinition.exposure`): a `direct` or `model-only` tool is
 * activated when registered (unless `defaultActive: false`); a `codemode` or `deferred` one is not,
 * and reaches the model only if an extension activates it, since pikit has neither codemode nor
 * tool search; a `hidden` one is not given to the harness at all.
 *
 * A tool's `executionMode: "sequential"` is honoured here, not by the harness (see `SequentialCalls`).
 *
 * A notification handler that throws is logged and skipped: an extension cannot fail a run. A
 * `tool_call` handler that throws blocks the call, as in Pi (its `beforeToolCall` rethrows, and the
 * call ends as an error result): a policy that cannot answer must not let the tool run.
 */

import {
  type AgentHarness,
  type AgentHarnessTool,
  type AgentLane,
  type AgentMessage,
  type Context,
  createCustomMessage,
  type JsonValue,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, Provider } from "@earendil-works/pi-ai";
import type { Logger } from "@pikit/core";
import { LANE } from "../inbound.ts";
import type {
  EventBus,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ExtensionToolContext,
  ExtensionUIContext,
  PiExtension,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolExposure,
  ToolInfo,
  ToolResultEventResult,
} from "./api.ts";
import { SUPPORTED_EVENTS } from "./surface.ts";

/** Events pikit fires. Anything else an extension registers never fires (tier C). */
const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_EVENTS);

// biome-ignore lint/suspicious/noExplicitAny: handlers of every event share one table
type AnyHandler = ExtensionHandler<any, any>;

export interface LoadOptions {
  models: Models;
  logger: Logger;
}

/** What the extensions registered, before any conversation is bound. */
export interface LoadedExtensions {
  /** The extensions' tools as harness tools, to create the harness with. */
  tools: AgentHarnessTool<undefined>[];
  bind(target: BindTarget, ctx: Context): Promise<BoundExtensions>;
}

export interface BindTarget {
  harness: AgentHarness<undefined>;
  lane: AgentLane;
  cwd: string;
  systemPrompt: string | undefined;
  /**
   * The conversation's abort, so an extension's `ctx.abort()` withdraws queued messages too. It must
   * be a no-op once the conversation is closed: it may run after `close()`.
   */
  abort(): Promise<void>;
}

export interface BoundExtensions {
  /** Fire `session_shutdown`. The harness closes after it. */
  close(ctx: Context): Promise<void>;
}

export async function loadExtensions(extensions: readonly PiExtension[], options: LoadOptions): Promise<LoadedExtensions> {
  const { logger } = options;
  const handlers = new Map<string, AnyHandler[]>();
  const definitions: ToolDefinition[] = [];
  const warned = new Set<string>();
  const unsupported = (what: string, detail?: string) => {
    if (warned.has(what)) return;
    warned.add(what);
    logger.warn("a Pi extension uses something pikit does not provide; it does nothing", { what, ...(detail !== undefined && { detail }) });
  };
  const channels = new Map<string, Set<(data: unknown) => void>>();
  const events: EventBus = {
    emit(channel, data) {
      for (const handler of channels.get(channel) ?? []) {
        try {
          handler(data);
        } catch (error) {
          logger.warn("a Pi extension's event bus handler failed", { channel, error: String(error) });
        }
      }
    },
    on(channel, handler) {
      const set = channels.get(channel) ?? new Set();
      set.add(handler);
      channels.set(channel, set);
      return () => set.delete(handler);
    },
  };

  // Set once the factories have run: the harness's tools are then fixed.
  let loaded = false;
  // Set by bind(); until then actions have no conversation to act on.
  let bound: Bound | undefined;
  const conversation = (what: string): Bound => {
    if (bound === undefined) throw new Error(`pi.${what}() is not available while an extension loads; call it from a handler`);
    return bound;
  };

  const pi: ExtensionAPI = {
    on(event: string, handler: AnyHandler) {
      if (!SUPPORTED.has(event)) unsupported(`pi.on("${event}")`);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const at = list.indexOf(handler);
        if (at !== -1) list.splice(at, 1);
      };
    },
    registerTool(tool) {
      if (loaded) {
        return unsupported(
          `pi.registerTool("${tool.name}") after the extensions loaded`,
          "pikit gives agents only the tools registered while extensions load, in their factories: this one is ignored (features/codemode.md)",
        );
      }
      // Registering a name again replaces the tool, as in Pi (which withdraws one this way, as `hidden`).
      const at = definitions.findIndex((existing) => existing.name === tool.name);
      if (at === -1) definitions.push(tool as unknown as ToolDefinition);
      else definitions[at] = tool as unknown as ToolDefinition;
    },
    registerProvider(provider: Provider) {
      const models = options.models as Models & { setProvider?(provider: Provider): void };
      if (models.setProvider === undefined) return unsupported("pi.registerProvider on read-only models");
      models.setProvider(provider);
    },
    unregisterProvider: (name) =>
      unsupported(`pi.unregisterProvider("${name}")`, "the provider is shared by the runtime's conversations and stays registered"),
    events,
    sendMessage: (message, send) => conversation("sendMessage").sendMessage(message, send),
    sendUserMessage: (content, send) => conversation("sendUserMessage").sendUserMessage(content, send),
    appendEntry: (customType, data) => conversation("appendEntry").act((c) => c.lane.appendCustomEntry(customType, data as JsonValue, c.pi)),
    setSessionName: (name) => conversation("setSessionName").setName(name),
    getSessionName: () => conversation("getSessionName").name,
    setLabel: (entryId, label) => conversation("setLabel").act((c) => c.harness.setLabel(entryId, label, c.pi)),
    exec: async () => {
      throw new Error("pi.exec() needs a shell (execution.shell), which pikit does not provide to extensions yet");
    },
    getActiveTools: () => [...conversation("getActiveTools").activeTools],
    getAllTools: () => conversation("getAllTools").allTools(),
    setActiveTools: (names) => conversation("setActiveTools").setActiveTools(names),
    setModel: async (model: Model<Api>) => {
      const c = conversation("setModel");
      await c.lane.setModel({ provider: model.provider, modelId: model.id }, c.pi);
      return true;
    },
    getThinkingLevel: () => conversation("getThinkingLevel").thinkingLevel,
    setThinkingLevel: (level) => conversation("setThinkingLevel").setThinkingLevel(level),
    registerCommand: (name) => unsupported(`pi.registerCommand("${name}")`),
    registerShortcut: () => unsupported("pi.registerShortcut"),
    registerFlag: () => unsupported("pi.registerFlag"),
    getFlag: () => undefined,
    registerMessageRenderer: () => unsupported("pi.registerMessageRenderer"),
    registerEntryRenderer: () => unsupported("pi.registerEntryRenderer"),
    registerMarkdownTransformer: () => unsupported("pi.registerMarkdownTransformer"),
    // Accurate answers, not stand-ins: pikit has no slash commands and no extension MCP servers.
    getCommands: () => [],
    getMcpServers: () => [],
    getSettings: () => {
      unsupported("pi.getSettings", "pikit has no Pi settings: every setting reads as unset");
      return {};
    },
    registerMcpServer: (name) =>
      unsupported(`pi.registerMcpServer("${name}")`, "pikit connects MCP servers with its tool-mcp component: configure the server there"),
    unregisterMcpServer: (name) => unsupported(`pi.unregisterMcpServer("${name}")`),
    registerVirtualModel: () => unsupported("pi.registerVirtualModel"),
    unregisterVirtualModel: () => unsupported("pi.unregisterVirtualModel"),
  };

  for (const extension of extensions) await extension(pi);
  loaded = true;

  const exposed = definitions.filter((definition) => {
    const exposure = exposureOf(definition);
    if (exposure === "hidden") {
      logger.info("a Pi extension's tool is hidden: it is not given to the model", { tool: definition.name });
      return false;
    }
    if (exposure === "codemode" || exposure === "deferred") {
      const reached = exposure === "codemode" ? "codemode" : "tool search";
      unsupported(`exposure "${exposure}" (tool "${definition.name}")`, `pikit has no ${reached}: the model sees the tool only if an extension activates it`);
    }
    if (definition.prepareLoadout !== undefined) unsupported(`prepareLoadout (tool "${definition.name}")`);
    return true;
  });
  const tools = exposed.map((definition) =>
    harnessTool(definition, (signal) => conversation("tool").context(signal), () =>
      unsupported("ctx.executeTool", "pikit does not run nested tool calls: the call ends as an error"),
    ),
  );
  // What Pi activates when the tool is registered.
  const activated = new Set(exposed.filter(activeOnRegistration).map((definition) => definition.name));

  return {
    tools,
    async bind(target, ctx) {
      const current = await Bound.create(target, { handlers, definitions, activated, logger }, ctx);
      bound = current;
      await current.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
      // A run a dead worker left open is continued right after this, and Pi emits no `run_start`
      // for it: the extensions learn here that the agent is running.
      if (current.resuming) await current.emit("agent_start", { type: "agent_start" }, ctx);
      return {
        close: async (closeCtx) => {
          // Notifications and actions still in flight belong to this session: let them finish
          // (an `agent_end` handler's `appendEntry`) before the shutdown, and the harness closes.
          await current.drain();
          await current.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, closeCtx);
          current.dispose();
        },
      };
    },
  };
}

function exposureOf(definition: ToolDefinition): ToolExposure {
  return definition.exposure ?? "direct";
}

/** Pi activates a `direct` or `model-only` tool when it is registered, unless `defaultActive: false`. */
function activeOnRegistration(definition: ToolDefinition): boolean {
  const exposure = exposureOf(definition);
  return (exposure === "direct" || exposure === "model-only") && definition.defaultActive !== false;
}

/** What `ctx.executeTool()` tells a tool: pikit runs no nested calls. */
export const NESTED_CALLS_UNSUPPORTED = "pikit does not run nested tool calls (ctx.executeTool)";

/** Pi's tool definition as a harness tool. Extension tools are not replayed after a crash (Pi's default). */
function harnessTool(
  definition: ToolDefinition,
  context: (signal: AbortSignal | undefined) => ExtensionContext,
  nestedCall: () => void,
): AgentHarnessTool<undefined> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.prepareArguments !== undefined && { prepareArguments: definition.prepareArguments }),
    ...(definition.outputSchema !== undefined && { outputSchema: definition.outputSchema }),
    // The harness reads none of it (its batch mode is the harness's own): `SequentialCalls` does.
    ...(definition.executionMode !== undefined && { executionMode: definition.executionMode }),
    replay: "never",
    execute: (toolCallId, params, onUpdate, _toolContext, _invocation, piContext) => {
      let nested = 0;
      const toolContext: ExtensionToolContext = {
        ...context(piContext.abortSignal),
        tools: [],
        // Never rejects, as in Pi: the failure is the outcome.
        executeTool: async (name, args) => {
          nestedCall();
          return {
            toolCall: { type: "toolCall", id: `${toolCallId}/${++nested}`, name, arguments: (args ?? {}) as Record<string, JsonValue> },
            result: { content: [{ type: "text", text: `${NESTED_CALLS_UNSUPPORTED}: "${name}" was not run` }], details: undefined, isError: true },
            isError: true,
          };
        },
      };
      return definition.execute(toolCallId, params, piContext.abortSignal, (partial) => onUpdate(partial), toolContext);
    },
  } as AgentHarnessTool<undefined>;
}

/**
 * Pi's `executionMode: "sequential"` ("this tool must execute one at a time with other tool calls")
 * on the harness pikit drives, which ignores it: it runs a batch by its own `toolExecution`
 * ("parallel"), and only Pi's `agent-loop` reads a tool's mode (`pi-gaps.test.ts`, "tools").
 *
 * The harness prepares a batch's calls in order and starts each one as soon as its `before_tool`
 * hooks return, so holding `before_tool` holds the call: a sequential call waits until the calls
 * started before it have ended (their `after_tool`), and the calls after it wait for it. The other
 * calls of the batch still overlap one another, where Pi's `agent-loop` runs the whole batch one call
 * at a time; either way a sequential call never runs alongside another. It covers every harness tool
 * that declares the mode, while extensions are loaded. A call recovered after a crash skips
 * `before_tool` and is not held; an extension's tool is never recovered (`replay: "never"`).
 */
class SequentialCalls {
  /** The harness's tools with `executionMode: "sequential"`. None: nothing is held or tracked. */
  sequential: ReadonlySet<string> = new Set();
  /** The calls let through and not ended yet, by id. */
  private readonly running = new Map<string, Running>();
  /** The sequential call among them. */
  private alone: Running | undefined;

  /** Hold the call until it may run. An abort lets it through: the harness then does not run it. */
  async before(toolCallId: string, toolName: string, signal: AbortSignal | undefined): Promise<void> {
    if (this.sequential.size === 0) return;
    const sequential = this.sequential.has(toolName);
    for (;;) {
      const waits = sequential ? [...this.running.values()] : this.alone !== undefined ? [this.alone] : [];
      if (waits.length === 0 || signal?.aborted === true) break;
      await untilAborted(Promise.all(waits.map((call) => call.ended)), signal);
    }
    let end!: () => void;
    const call: Running = { ended: new Promise<void>((resolve) => (end = resolve)), end: () => end() };
    this.running.set(toolCallId, call);
    if (sequential) this.alone = call;
  }

  /** The call ended (or never ran). Unknown ids are ignored: calls that failed before `before_tool`. */
  end(toolCallId: string): void {
    const call = this.running.get(toolCallId);
    if (call === undefined) return;
    this.running.delete(toolCallId);
    if (this.alone === call) this.alone = undefined;
    call.end();
  }

  /** A run starts, or the conversation closes: nothing of an earlier run is still running. */
  clear(): void {
    for (const id of [...this.running.keys()]) this.end(id);
  }
}

interface Running {
  ended: Promise<void>;
  end(): void;
}

function untilAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      signal?.removeEventListener("abort", done);
      resolve();
    };
    signal?.addEventListener("abort", done, { once: true });
    void work.then(done);
  });
}

interface Registry {
  handlers: Map<string, AnyHandler[]>;
  definitions: ToolDefinition[];
  /** The tools Pi activates when they are registered. */
  activated: ReadonlySet<string>;
  logger: Logger;
}

/** The extensions bound to one open conversation: its hooks, its events and its actions. */
class Bound {
  activeTools: string[] = [];
  /** The harness's tools, which alone can be activated. */
  private toolNames: ReadonlySet<string> = new Set();
  private readonly calls = new SequentialCalls();
  name: string | undefined;
  thinkingLevel: Awaited<ReturnType<AgentLane["getThinkingLevel"]>> = "off";
  private model: Model<Api> | undefined;
  private idle = true;
  /** The conversation opened with a run a dead worker left open. */
  resuming = false;
  /** Actions started by extensions and not finished yet. */
  private readonly acting = new Set<Promise<unknown>>();
  private pending = 0;
  /** A `before_agent_start` system prompt, for the run in progress. */
  private systemPromptOverride: string | undefined;
  private runMessages: AgentMessage[] = [];
  private turnIndex = 0;
  private readonly toolArgs = new Map<string, unknown>();
  private readonly unsubscribe: (() => void)[] = [];
  /** Notifications run in order, one after the other, off the harness's delivery path. */
  private notified: Promise<void> = Promise.resolve();
  readonly pi: Context;

  private constructor(
    readonly harness: AgentHarness<undefined>,
    readonly lane: AgentLane,
    private readonly target: BindTarget,
    private readonly registry: Registry,
    ctx: Context,
  ) {
    this.pi = ctx;
  }

  static async create(target: BindTarget, registry: Registry, ctx: Context): Promise<Bound> {
    const bound = new Bound(target.harness, target.lane, target, registry, ctx);
    const { lane, harness } = target;
    bound.activeTools = await lane.getActiveTools(ctx);
    await bound.readTools(ctx);
    bound.name = await harness.getName(ctx);
    bound.thinkingLevel = await lane.getThinkingLevel(ctx);
    bound.model = await lane.getModel(ctx);
    const execution = await lane.inspectExecution(ctx);
    if (execution.current?.kind === "run") {
      bound.resuming = true;
      bound.idle = false;
    }
    // A new lane starts with every tool of the harness active: deactivate those Pi does not activate
    // on registration. A lane with entries keeps what it has, including what extensions activated.
    const active =
      (await lane.getTipId(ctx)) === null
        ? bound.activeTools.filter((name) => registry.activated.has(name) || !registry.definitions.some((tool) => tool.name === name))
        : bound.activeTools;
    // A lane created before an extension was installed has its tools inactive: activate them.
    const missing = [...registry.activated].filter((name) => !active.includes(name));
    if (missing.length > 0 || active.length !== bound.activeTools.length) await bound.setActiveTools([...active, ...missing]);
    bound.wire();
    return bound;
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.calls.clear();
  }

  /** The harness's tools, which change when an agent's `prepare` sets a run's tools. */
  private async readTools(ctx: Context): Promise<void> {
    const tools = await this.harness.getTools(ctx);
    this.toolNames = new Set(tools.map((tool) => tool.name));
    this.calls.sequential = new Set(tools.filter((tool) => tool.executionMode === "sequential").map((tool) => tool.name));
  }

  /** Run every handler of `event` in order; each result goes to `fold`. */
  async emit<R>(event: string, payload: unknown, ctx: Context, fold?: (result: R) => void): Promise<void> {
    for (const handler of this.registry.handlers.get(event) ?? []) {
      try {
        const result = await handler(payload, this.context(ctx.abortSignal));
        if (result !== undefined && fold !== undefined) fold(result as R);
      } catch (error) {
        this.registry.logger.warn("a Pi extension handler failed; it is skipped", { event, error: String(error) });
      }
    }
  }

  private notify(event: string, payload: unknown): void {
    if (!this.registry.handlers.has(event)) return;
    this.notified = this.notified.then(() => this.emit(event, payload, this.pi));
  }

  context(signal: AbortSignal | undefined): ExtensionContext {
    return {
      ui: NO_UI,
      mode: "rpc",
      hasUI: false,
      cwd: this.target.cwd,
      model: this.model,
      signal,
      isIdle: () => this.idle,
      // Not an action `drain()` waits for: the conversation's abort runs in its line, and the step
      // holding the line may be the one closing this conversation (a settled run closes it once idle),
      // which waits for `drain()`. A closed conversation has no run to abort, so it is a no-op there.
      abort: () =>
        void this.target.abort().catch((error: unknown) => {
          this.registry.logger.warn("a Pi extension's abort failed", { error: String(error) });
        }),
      hasPendingMessages: () => this.pending > 0,
      waitForIdle: () => this.lane.waitForIdle(this.pi),
      getSystemPrompt: () => this.systemPromptOverride ?? this.target.systemPrompt ?? "",
      compact: (options) => void this.act((c) => c.lane.compact(options, c.pi)),
      shutdown: () => this.registry.logger.warn("a Pi extension called ctx.shutdown(); the app owns the process", {}),
    };
  }

  /** Fire and forget an action (Pi's API is synchronous where the harness is not); failures are logged. */
  act(work: (bound: Bound) => Promise<unknown>): void {
    const acting = work(this).catch((error: unknown) => {
      this.registry.logger.warn("a Pi extension's action failed", { error: String(error) });
    });
    this.acting.add(acting);
    void acting.finally(() => this.acting.delete(acting));
  }

  /** Wait for the notifications and actions in flight, including the actions they start. */
  async drain(): Promise<void> {
    for (;;) {
      const notified = this.notified;
      await notified;
      await Promise.all(this.acting);
      if (notified === this.notified && this.acting.size === 0) return;
    }
  }

  setName(name: string): void {
    this.name = name;
    this.act((c) => c.harness.setName(name, c.pi));
  }

  /** Unknown names, `hidden` tools among them, are ignored as in Pi: the harness would refuse to run. */
  async setActiveTools(names: string[]): Promise<void> {
    this.activeTools = names.filter((name, at) => this.toolNames.has(name) && names.indexOf(name) === at);
    await this.lane.setActiveTools(this.activeTools, this.pi);
  }

  setThinkingLevel(level: Bound["thinkingLevel"]): void {
    this.thinkingLevel = level;
    this.act((c) => c.lane.setThinkingLevel(level, c.pi));
  }

  allTools(): ToolInfo[] {
    return this.registry.definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      exposure: exposureOf(tool),
      ...(tool.namespace !== undefined && { namespace: tool.namespace }),
      ...(tool.annotations !== undefined && { annotations: tool.annotations }),
    }));
  }

  /** While a run is in progress a message is steered (or queued as asked); idle, it waits for the next run. */
  sendMessage(
    message: Parameters<ExtensionAPI["sendMessage"]>[0],
    options: Parameters<ExtensionAPI["sendMessage"]>[1] = {},
  ): void {
    const custom = createCustomMessage(message.customType, message.content, message.display, message.details, Date.now());
    this.deliver(custom, options.deliverAs === "nextTurn" ? "nextRun" : (options.deliverAs ?? "steer"));
  }

  sendUserMessage(content: Parameters<ExtensionAPI["sendUserMessage"]>[0], options: Parameters<ExtensionAPI["sendUserMessage"]>[1] = {}): void {
    const user: AgentMessage = { role: "user", content, timestamp: Date.now() };
    this.deliver(user, options.deliverAs ?? "steer");
  }

  private deliver(message: AgentMessage, as: "steer" | "followUp" | "nextRun"): void {
    // An idle conversation has no run to steer; starting one outside `dispatch` would bypass pikit's
    // admission, so the message waits for the next run.
    const mode = this.idle ? "nextRun" : as;
    this.act((c) => c.lane[mode](message, undefined, c.pi));
  }

  /** Pi's extension events onto the harness's hooks and events. */
  private wire(): void {
    const { hooks, events } = this.harness;
    const handled = (event: string) => this.registry.handlers.has(event);
    const on = this.unsubscribe;
    const mine = (event: { lane?: string }) => event.lane === undefined || event.lane === LANE;

    on.push(
      // First, so a `tool_call` policy sees a call only once it may run.
      hooks.on("before_tool", async (event, ctx) => {
        if (mine(event)) await this.calls.before(event.toolCallId, event.toolName, ctx.abortSignal);
        return undefined;
      }),
      hooks.on("before_tool", async (event, ctx) => {
        if (!handled("tool_call")) return undefined;
        const input = structuredClone(event.args) as Record<string, unknown>;
        const call = { type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, input } as ToolCallEvent;
        let block: ToolCallEventResult | undefined;
        for (const handler of this.registry.handlers.get("tool_call") ?? []) {
          try {
            const result = (await handler(call, this.context(ctx.abortSignal))) as ToolCallEventResult | undefined;
            if (result?.block === true) {
              block = result;
              break;
            }
          } catch (error) {
            // Fail closed. The error's text stays in the log: it may carry what the policy service
            // said, which the model must not see.
            this.registry.logger.error("a Pi extension's tool_call handler failed; the call is blocked", {
              tool: event.toolName,
              error: String(error),
            });
            block = { block: true, reason: TOOL_POLICY_FAILED };
            break;
          }
        }
        if (block !== undefined) {
          const reason = block.reason ?? "Blocked by an extension";
          return { block: { reason, ...(block.terminate === true && { terminate: true }) } };
        }
        // Pi's extensions patch arguments by mutating `event.input` in place.
        return JSON.stringify(input) === JSON.stringify(event.args) ? undefined : { args: input as Record<string, JsonValue> };
      }),
      hooks.on("after_tool", async (event, ctx) => {
        if (!handled("tool_result")) return undefined;
        const patch: ToolResultEventResult = {};
        const current = {
          type: "tool_result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
          content: event.content,
          details: event.details,
          isError: event.isError,
          ...(event.usage !== undefined && { usage: event.usage }),
        };
        await this.emit<ToolResultEventResult>("tool_result", current, ctx, (result) => {
          Object.assign(patch, result);
          Object.assign(current, result);
        });
        return Object.keys(patch).length === 0 ? undefined : (patch as never);
      }),
      // After `tool_result`: a call ends once its result is final.
      hooks.on("after_tool", (event) => {
        this.calls.end(event.toolCallId);
        return undefined;
      }),
      hooks.on("before_run", async (event, ctx) => {
        // A run that failed mid-batch may have left calls with no `after_tool` or `tool_end`.
        this.calls.clear();
        this.systemPromptOverride = undefined;
        // An agent's `prepare` sets the run's tools in its own `before_run`, which runs first.
        this.activeTools = await this.lane.getActiveTools(ctx);
        await this.readTools(ctx);
        if (!handled("before_agent_start")) return undefined;
        const added: AgentMessage[] = [];
        const start = { type: "before_agent_start", prompt: promptText(event.prompt), systemPrompt: this.target.systemPrompt ?? "" };
        await this.emit<{ message?: Parameters<ExtensionAPI["sendMessage"]>[0]; systemPrompt?: string }>(
          "before_agent_start",
          start,
          ctx,
          (result) => {
            if (result.systemPrompt !== undefined) this.systemPromptOverride = result.systemPrompt;
            if (result.message !== undefined) {
              const { customType, content, display, details } = result.message;
              added.push(createCustomMessage(customType, content, display, details, Date.now()));
            }
          },
        );
        return added.length === 0 ? undefined : { messages: [...event.prompt, ...added] };
      }),
      hooks.on("transform_context", async (event, ctx) => {
        let messages: AgentMessage[] | undefined;
        if (handled("context")) {
          await this.emit<{ messages?: AgentMessage[] }>("context", { type: "context", messages: event.messages }, ctx, (result) => {
            if (result.messages !== undefined) messages = result.messages;
          });
        }
        const systemPrompt = this.systemPromptOverride;
        if (messages === undefined && systemPrompt === undefined) return undefined;
        return { ...(messages !== undefined && { messages }), ...(systemPrompt !== undefined && { systemPrompt }) };
      }),
      hooks.on("before_payload", async (event, ctx) => {
        if (!handled("before_provider_request")) return undefined;
        let payload = event.payload;
        let replaced = false;
        await this.emit<unknown>("before_provider_request", { type: "before_provider_request", payload }, ctx, (result) => {
          payload = result;
          replaced = true;
        });
        return replaced ? { payload } : undefined;
      }),
      hooks.on("after_response", async (event, ctx) => {
        if (handled("after_provider_response")) {
          const response = { type: "after_provider_response", status: event.status ?? 200, headers: event.headers ?? {} };
          await this.emit("after_provider_response", response, ctx);
        }
        return undefined;
      }),
      hooks.on("before_run_end", (event) => {
        this.runMessages = event.messages;
        return undefined;
      }),
    );

    on.push(
      events.on("run_start", (event) => {
        if (!mine(event)) return;
        this.idle = false;
        this.turnIndex = 0;
        this.runMessages = [];
        this.notify("agent_start", { type: "agent_start" });
      }),
      events.on("run_end", (event) => {
        if (!mine(event)) return;
        this.idle = true;
        this.systemPromptOverride = undefined;
        this.notify("agent_end", { type: "agent_end", messages: this.runMessages });
      }),
      events.on("turn_start", (event) => {
        if (!mine(event)) return;
        this.notify("turn_start", { type: "turn_start", turnIndex: this.turnIndex, timestamp: Date.now() });
      }),
      events.on("turn_end", (event) => {
        if (!mine(event)) return;
        this.notify("turn_end", { type: "turn_end", turnIndex: this.turnIndex++, message: event.message, toolResults: event.toolResults });
      }),
      events.on("message_start", (event) => {
        if (mine(event)) this.notify("message_start", { type: "message_start", message: event.message });
      }),
      events.on("message_update", (event) => {
        if (!mine(event)) return;
        this.notify("message_update", { type: "message_update", message: event.message, assistantMessageEvent: event.event });
      }),
      events.on("message_end", (event) => {
        if (mine(event)) this.notify("message_end", { type: "message_end", message: event.message });
      }),
      events.on("tool_start", (event) => {
        if (!mine(event)) return;
        this.toolArgs.set(event.toolCallId, event.args);
        const start = { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
        this.notify("tool_execution_start", start);
      }),
      events.on("tool_update", (event) => {
        if (!mine(event)) return;
        this.notify("tool_execution_update", {
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: this.toolArgs.get(event.toolCallId),
          partialResult: event.partialResult,
        });
      }),
      events.on("tool_end", (event) => {
        if (!mine(event)) return;
        // A call blocked or aborted after `before_tool` has no `after_tool`, only this.
        this.calls.end(event.toolCallId);
        this.toolArgs.delete(event.toolCallId);
        this.notify("tool_execution_end", {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      }),
      events.on("queue_update", (event) => {
        if (mine(event)) this.pending = event.queues.length;
      }),
      events.on("config_update", (event) => {
        if (!mine(event) || event.property !== "model") return;
        void this.lane.getModel(this.pi).then((model) => (this.model = model));
      }),
    );
  }
}

/** The reason a call is blocked when an extension's `tool_call` handler throws. */
export const TOOL_POLICY_FAILED = "Blocked: an extension's tool_call policy failed, so the call was not allowed";

/** The text of the prompt that starts a run: its last user or inbound message. */
function promptText(prompt: readonly AgentMessage[]): string {
  const last = [...prompt].reverse().find((message) => message.role === "user" || message.role === "custom");
  if (last === undefined || !("content" in last)) return "";
  const { content } = last;
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * Pi's UI when there is none: every question goes unanswered, every notice is dropped, and any
 * other TUI call (`setStatus`, `setWidget`, `setTitle`…) is a no-op instead of a `TypeError`.
 */
const ANSWERS: Partial<ExtensionUIContext> = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
};
const NO_UI: ExtensionUIContext = new Proxy(ANSWERS as ExtensionUIContext, {
  get: (answers, method) => (typeof method === "string" && method in answers ? answers[method] : () => undefined),
});
