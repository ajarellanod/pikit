/**
 * The part of Pi's extension API that pikit supports (SPEC §6.2b), vendored from
 * `@earendil-works/pi-coding-agent` (`src/core/extensions/types.ts`; MIT, © Mario Zechner, see
 * NOTICE): first from 0.87.1, then checked against 0.99.0, from which the tool exposure types,
 * `executionMode`, `ExtensionToolContext` and the MCP server, virtual model and settings members of `ExtensionAPI`
 * come. `bun scripts/pi-extension-drift.ts <tag>` lists what a Pi release has that this file
 * lacks. An existing Pi extension imports these names from `@earendil-works/pi-coding-agent`;
 * the project aliases that package to `@pikit/pi-extension-shim`, which re-exports this file, so
 * the extension runs unmodified without the 19 MB coding agent.
 *
 * Shapes follow Pi's exactly where pikit implements them. What pikit does not implement is still
 * typed loosely, so an extension that registers it compiles; at runtime it is a no-op with a
 * warning (tier C), because pikit has no terminal UI.
 */

import type {
  AgentMessage,
  AgentTool,
  AgentToolCallOutcome,
  AgentToolResult,
  AgentToolUpdateCallback,
  CustomMessage,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessageEvent,
  ImageContent,
  Model,
  Provider,
  Static,
  TextContent,
  ToolResultMessage,
  TSchema,
  Usage,
} from "@earendil-works/pi-ai";

/** The arguments a Pi tool receives, from Pi's own tool (the one pikit's `tool-*` wraps). */
type InputOf<Factory extends (...args: never[]) => { execute(...args: never[]): unknown }> = Parameters<
  ReturnType<Factory>["execute"]
>[1];
export type BashToolInput = InputOf<typeof createBashTool>;
export type ReadToolInput = InputOf<typeof createReadTool>;
export type WriteToolInput = InputOf<typeof createWriteTool>;
export type EditToolInput = InputOf<typeof createEditTool>;

// ----------------------------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------------------------

export interface SessionStartEvent {
  type: "session_start";
  /** In pikit a conversation opens as `resume` (it has a session) or `new` (it has none yet). */
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  /** In pikit a conversation closes when idle or when the app stops: always `quit`. */
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}
export interface ContextEventResult {
  messages?: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  payload: unknown;
}
export type BeforeProviderRequestEventResult = unknown;

export interface AfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string>;
}

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  /** The text of the message that starts the run. */
  prompt: string;
  images?: ImageContent[];
  readonly systemPrompt: string;
}
export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  /** Replace the system prompt for this run. */
  systemPrompt?: string;
}

export interface AgentStartEvent {
  type: "agent_start";
}
export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}

export interface TurnStartEvent {
  type: "turn_start";
  turnIndex: number;
  timestamp: number;
}
export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}
export interface MessageUpdateEvent {
  type: "message_update";
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}
export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  // biome-ignore lint/suspicious/noExplicitAny: Pi's shape
  args: any;
}
export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  // biome-ignore lint/suspicious/noExplicitAny: Pi's shape
  args: any;
  // biome-ignore lint/suspicious/noExplicitAny: Pi's shape
  partialResult: any;
}
export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  // biome-ignore lint/suspicious/noExplicitAny: Pi's shape
  result: any;
  isError: boolean;
}

interface ToolCallEventBase {
  type: "tool_call";
  toolCallId: string;
}
export interface BashToolCallEvent extends ToolCallEventBase {
  toolName: "bash";
  input: BashToolInput;
}
export interface ReadToolCallEvent extends ToolCallEventBase {
  toolName: "read";
  input: ReadToolInput;
}
export interface WriteToolCallEvent extends ToolCallEventBase {
  toolName: "write";
  input: WriteToolInput;
}
export interface EditToolCallEvent extends ToolCallEventBase {
  toolName: "edit";
  input: EditToolInput;
}
export interface CustomToolCallEvent extends ToolCallEventBase {
  toolName: string;
  input: Record<string, unknown>;
}
/**
 * Before a tool runs. Can block it. `event.input` is mutable: mutate it in place to patch the
 * arguments; later handlers see earlier changes.
 */
export type ToolCallEvent = BashToolCallEvent | ReadToolCallEvent | WriteToolCallEvent | EditToolCallEvent | CustomToolCallEvent;
export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
  /** Stop after the current tool batch when every blocked call in it asks to. */
  terminate?: boolean;
}

/** After a tool ran. Can change its result. */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  details: unknown;
  isError: boolean;
  usage?: Usage;
}
export interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
}

export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
  toolName: TName,
  event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
  return event.toolName === toolName;
}

export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

// ----------------------------------------------------------------------------------------------
// Context and tools
// ----------------------------------------------------------------------------------------------

/**
 * Pi's UI context. pikit has no terminal UI: every method is a no-op that returns the "no answer"
 * value (`undefined`, `false`), which is what Pi's own RPC mode gives an extension that does not
 * check `hasUI`.
 */
export interface ExtensionUIContext {
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  // biome-ignore lint/suspicious/noExplicitAny: widgets, status lines and the rest are TUI-only
  [method: string]: any;
}

export type ExtensionMode = "interactive" | "rpc" | "print" | "json";

/** What a handler receives about the conversation it runs for. */
export interface ExtensionContext {
  /** No-ops: pikit has no terminal UI. */
  ui: ExtensionUIContext;
  /** Always `rpc`. */
  mode: ExtensionMode;
  /** Always `false`: take the non-interactive path. */
  hasUI: boolean;
  cwd: string;
  /** The conversation's model when the handler runs. */
  model: Model<Api> | undefined;
  /** The running operation's cancellation, when there is one. */
  signal: AbortSignal | undefined;
  isIdle(): boolean;
  abort(): void;
  hasPendingMessages(): boolean;
  waitForIdle(): Promise<void>;
  getSystemPrompt(): string;
  compact(options?: { customInstructions?: string }): void;
  /** Not available in pikit: the process belongs to the app, not to an extension. No-op. */
  shutdown(): void;
}

/** Options for {@link ExtensionToolContext.executeTool}. */
export interface ExecuteToolOptions {
  /** Defaults to the calling tool's signal. */
  signal?: AbortSignal;
  /** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
  onUpdate?: AgentToolUpdateCallback;
}

/**
 * What a tool's `execute()` receives: the extension context plus `executeTool()`, which in Pi runs
 * another tool through the same validation and hooks as a model-issued call.
 *
 * pikit does not run nested tool calls: `tools` is empty, and `executeTool()` resolves to an
 * `isError: true` outcome saying so. Like Pi's, it never rejects.
 */
export interface ExtensionToolContext extends ExtensionContext {
  /** Tools {@link executeTool} can call: none in pikit. */
  readonly tools: readonly AgentTool[];
  executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>;
}

/**
 * How the model reaches a tool. "Callable" means callable from other tools through
 * `ctx.executeTool()`, as Pi's `codemode` tool does.
 *
 * - `direct`: declared to the model while active, and callable while active.
 * - `model-only`: declared to the model while active, never callable.
 * - `codemode`: callable whenever registered. Not declared to the model unless explicitly
 *   activated. Codemode tools list it in their description.
 * - `deferred`: like `codemode`, but codemode tools do not list it; tool search can find it.
 * - `hidden`: registered but unreachable. Activating it has no effect.
 *
 * `direct` and `model-only` tools are activated when they are registered; the others are not.
 * The active tool set (`getActiveTools`/`setActiveTools`) is the set declared to the model.
 *
 * In pikit, which has neither codemode nor tool search, `codemode` and `deferred` tools reach the
 * model only when an extension activates them, and `hidden` tools are not given to the harness.
 */
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

/**
 * Hints about what a tool does, with the meaning of MCP tool annotations. They come from the tool's
 * author and are not verified; permission extensions can use them to decide which calls to confirm.
 */
export interface ToolAnnotations {
  /** The tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** The tool may delete or overwrite data, rather than only add to it. Meaningful when not read-only. */
  destructiveHint?: boolean;
  /** Repeating a call with the same arguments has no further effect. Meaningful when not read-only. */
  idempotentHint?: boolean;
  /** The tool reaches an open world of external entities, such as the web, rather than a closed domain. */
  openWorldHint?: boolean;
}

/** A group of related tools, such as the tools of one MCP server. Codemode tools list them together. */
export interface ToolNamespace {
  /** For example `mcp__docs`. */
  name: string;
  /** Shown once above the group's tools. */
  description?: string;
}

/** The tools of a session as {@link ToolDefinition.prepareLoadout} sees them. */
export interface ToolLoadout {
  /** Tools declared to the model (the active tools), in order, with their original descriptions. */
  readonly declared: readonly AgentTool[];
  /** Tools callable through `ctx.executeTool()`. */
  readonly callable: readonly AgentTool[];
  /** Every registered tool. */
  readonly registered: readonly AgentTool[];
  getExposure(name: string): ToolExposure;
  getNamespace(name: string): ToolNamespace | undefined;
}

/** Changes {@link ToolDefinition.prepareLoadout} makes to what the model sees. */
export interface ToolLoadoutChanges {
  /** Model-facing descriptions of declared tools, by tool name. */
  descriptions?: Readonly<Record<string, string>>;
  /** Declared tools whose declarations requests leave out. They stay active and callable. */
  hiddenDeclarations?: readonly string[];
}

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * What `pi.registerTool()` takes. pikit gives the model only the tools registered while the
 * extensions load (their factories): one registered later, from a handler such as `session_start`,
 * is ignored with a warning (`features/codemode.md`).
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;
  prepareArguments?: (args: unknown) => Static<TParams>;
  /** JSON Schema of `structuredContent` in successful results. Given to the harness as is. */
  outputSchema?: TSchema;
  /** How the model reaches the tool. Default: `"direct"`. See {@link ToolExposure}. */
  exposure?: ToolExposure;
  /** Group the tool belongs to, for example its MCP server. Reported by `pi.getAllTools()`. */
  namespace?: ToolNamespace;
  /** Hints about what the tool does. Reported by `pi.getAllTools()`. */
  annotations?: ToolAnnotations;
  /**
   * Whether registering the tool activates it. Default: `true` for `direct` and `model-only` tools;
   * other exposures are never activated on registration. A tool with `defaultActive: false` is
   * activated with `setActiveTools()`.
   */
  defaultActive?: boolean;
  /** For tools that orchestrate other tools (codemode, tool search): ignored by pikit, which has none. */
  prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
  /**
   * Per-tool execution mode override.
   * - "sequential": this tool must execute one at a time with other tool calls.
   * - "parallel": this tool can execute concurrently with other tool calls.
   *
   * If omitted, the default execution mode applies: in pikit, "parallel". A "sequential" call waits
   * for the calls started before it, and the calls after it wait for it; the other calls of its batch
   * still overlap one another, where Pi's CLI runs the whole batch one call at a time.
   */
  executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult<TDetails>>;
  /** TUI rendering: ignored by pikit. */
  renderCall?: unknown;
  /** TUI rendering: ignored by pikit. */
  renderResult?: unknown;
  /** Carried for Pi's TUI; unused by pikit. */
  readonly __state?: TState;
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's own erasure for heterogeneous tool lists
type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Keep parameter inference for a tool defined on its own. Same as Pi's. */
// biome-ignore lint/suspicious/noExplicitAny: Pi's signature
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
  return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

export interface ExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
}
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** A channel between extensions of one conversation. */
export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ToolInfo {
  name: string;
  description: string;
  exposure: ToolExposure;
  namespace?: ToolNamespace;
  annotations?: ToolAnnotations;
}

/** An MCP server an extension registered. None in pikit: see `pi.registerMcpServer()`. */
export interface RegisteredMcpServer {
  name: string;
  /** An `mcpServers` entry of Pi's `mcp.json`. */
  config: unknown;
  /** Path of the extension that registered the server. */
  extensionPath: string;
}

// ----------------------------------------------------------------------------------------------
// The API
// ----------------------------------------------------------------------------------------------

/** What an extension's factory receives: `export default function (pi: ExtensionAPI) { … }`. */
export interface ExtensionAPI {
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
  on(
    event: "before_provider_request",
    handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
  ): () => void;
  on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
  on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): () => void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): () => void;
  on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
  on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
  on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): () => void;
  on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
  on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
  /** Any other Pi event: registered, never fired in pikit (tier C; `doctor` lists it). */
  // biome-ignore lint/suspicious/noExplicitAny: events pikit does not implement
  on(event: string, handler: ExtensionHandler<any, any>): () => void;

  /**
   * Register a tool, or replace the one with its name. Only while the extension loads (in its
   * factory): pikit ignores, with a warning, a tool registered later, from a handler.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Pi's signature
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void;
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  /** Needs a shell (`execution.shell`), which pikit does not wire yet: it rejects. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** The names of the active tools, which are the tools declared to the model. */
  getActiveTools(): string[];
  /** The extensions' tools, `hidden` ones included. */
  getAllTools(): ToolInfo[];
  /** Set the active tools by name. Unknown and `hidden` tools are ignored. */
  setActiveTools(toolNames: string[]): void;
  setModel(model: Model<Api>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  /** A pi-ai provider object. Registered for every conversation of the runtime. */
  registerProvider(provider: Provider): void;
  /**
   * No-op in pikit: a provider is shared by every conversation of the runtime, and pikit cannot
   * restore the one it replaced.
   */
  unregisterProvider(name: string): void;
  events: EventBus;

  /** Tier B/C, no-ops in pikit: slash commands, shortcuts, flags, renderers. */
  registerCommand(name: string, options: unknown): void;
  registerShortcut(shortcut: string, options: unknown): void;
  registerFlag(name: string, options: unknown): void;
  getFlag(name: string): boolean | string | undefined;
  registerMessageRenderer(customType: string, renderer: unknown): void;
  registerEntryRenderer(customType: string, renderer: unknown): void;
  registerMarkdownTransformer(transformer: unknown): void;
  /** The slash commands: none in pikit, where `registerCommand` is a no-op. */
  getCommands(): { name: string; description?: string }[];
  /**
   * Pi's settings (`settings.json`). pikit has none: an empty object, where every setting reads as
   * unset, so an extension takes Pi's default for it. The conversation's own model and thinking
   * level are `ctx.model` and `pi.getThinkingLevel()`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Pi's `Settings`, of which pikit has no field
  getSettings(): { [setting: string]: any };

  /** No-op in pikit, which connects MCP servers with its `tool-mcp` component. */
  registerMcpServer(name: string, config: unknown): void;
  /** No-op in pikit. */
  unregisterMcpServer(name: string): void;
  /** The MCP servers extensions registered: none in pikit. */
  getMcpServers(): RegisteredMcpServer[];
  /** No-op in pikit, which has no virtual models. */
  registerVirtualModel<TState = unknown>(model: unknown): void;
  /** No-op in pikit. */
  unregisterVirtualModel(provider: string, id: string): void;
}

/** A Pi extension: the default export of an extension module. */
export type PiExtension = (pi: ExtensionAPI) => void | Promise<void>;
