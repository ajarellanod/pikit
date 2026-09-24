/**
 * The part of Pi's extension API that pikit supports (SPEC §6.2b), vendored from
 * `@earendil-works/pi-coding-agent` 0.87.1 (`src/core/extensions/types.ts`; MIT, © Mario Zechner,
 * see NOTICE). An existing Pi extension imports these names from `@earendil-works/pi-coding-agent`;
 * the project aliases that package to `@pikit/pi-extension-shim`, which re-exports this file, so
 * the extension runs unmodified without the 19 MB coding agent.
 *
 * Shapes follow Pi's exactly where pikit implements them. What pikit does not implement is still
 * typed loosely, so an extension that registers it compiles; at runtime it is a no-op with a
 * warning (tier C), because pikit has no terminal UI.
 */

import type {
  AgentMessage,
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

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;
  prepareArguments?: (args: unknown) => Static<TParams>;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
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
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  setActiveTools(toolNames: string[]): void;
  setModel(model: Model<Api>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  /** A pi-ai provider object. Registered for every conversation of the runtime. */
  registerProvider(provider: Provider): void;
  events: EventBus;

  /** Tier B/C, no-ops in pikit: slash commands, shortcuts, flags, renderers. */
  registerCommand(name: string, options: unknown): void;
  registerShortcut(shortcut: string, options: unknown): void;
  registerFlag(name: string, options: unknown): void;
  getFlag(name: string): boolean | string | undefined;
  registerMessageRenderer(customType: string, renderer: unknown): void;
  registerEntryRenderer(customType: string, renderer: unknown): void;
  registerMarkdownTransformer(transformer: unknown): void;
}

/** A Pi extension: the default export of an extension module. */
export type PiExtension = (pi: ExtensionAPI) => void | Promise<void>;
