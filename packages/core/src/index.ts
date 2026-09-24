// Public surface of @pikit/core (SPEC §12a). Additive changes only within a major.

export { defineComponent, defineApp } from "./app.ts";
export type {
  ComponentDefinition,
  ComponentLifecycle,
  Handle,
  KeyedHandle,
  App,
  AppContext,
  AppDefinition,
  AppDescription,
  AppOptions,
  Pikit,
  Target,
} from "./app.ts";

export type { Context, ContextKey } from "./context.ts";
export {
  BACKGROUND_CONTEXT,
  createContextKey,
  withAbortSignal,
  withCancel,
  withContextValue,
} from "./context.ts";

export { Halt, halt } from "./pipeline.ts";
export type { AppPipelines, ResolvedStage, Stage, StageOptions } from "./pipeline.ts";

export { defineAgent } from "./agent.ts";
export type {
  Admission,
  AgentDefinition,
  AgentMessage,
  AgentPayloads,
  AgentRequest,
  AgentResult,
  AgentRuntime,
  AgentTool,
  ConversationRef,
  TurnConfig,
  Usage,
} from "./agent.ts";

export type { InboundMessage, RouteDecision } from "./inbound.ts";

export type { AppEvents } from "./events.ts";
export type { CapabilityMode, AppCapabilities, AppKeyedCapabilities, Keyed } from "./capabilities.ts";

export type { Clock } from "./contracts/clock.ts";
export { systemClock } from "./contracts/clock.ts";
export type { Logger } from "./contracts/logger.ts";
export type { AgentState } from "./contracts/agent-state.ts";
export { AGENT_STATE } from "./contracts/agent-state.ts";
export type { ConversationRegistry, ConversationReset } from "./contracts/conversations.ts";
export type { HttpRoute } from "./contracts/http.ts";
export type { SecretStore } from "./contracts/secrets.ts";
export { consoleLogger, silentLogger } from "./contracts/logger.ts";
