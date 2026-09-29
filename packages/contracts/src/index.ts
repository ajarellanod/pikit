// Public surface of @pikit/contracts (SPEC §4.9): the vocabulary components share. Types, identities,
// names of events and pipelines, capability interfaces, and one protocol function (`admitInbound`).
// No implementation, no policy. Each contract has a stability level (SPEC §12a); the capabilities'
// levels are in the catalogue (`packages/cli/src/registry/capabilities.ts`).

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
  PrepareContext,
  TurnConfig,
  Usage,
} from "./agent.ts";

export { admitInbound } from "./inbound.ts";
export type { AdmitOptions, InboundMessage, InboundOutcome, RouteDecision } from "./inbound.ts";

export type { AgentState } from "./agent-state.ts";
export { AGENT_STATE } from "./agent-state.ts";
export { CONVERSATION } from "./conversation-context.ts";
export type { WorkersHost } from "./workers-host.ts";
export { WORKERS_HOST } from "./workers-host.ts";
export type { ConversationRegistry, ConversationReset } from "./conversations.ts";
export type { HttpRoute } from "./http.ts";
export type { SecretStore } from "./secrets.ts";
export type { JsonValue, KeyValueStorage, KeyValueStore, SqlDatabase, SqlRow, SqlStatements, SqlValue } from "./storage.ts";
export type { Feed, FeedItem, FeedPage } from "./feed.ts";
export type { ActorInboxHandler, ActorMailbox } from "./actor.ts";
export type { WakeupHandler, Wakeups } from "./wakeups.ts";
export type { AgentSubmissions, PendingConversation, RunSettlement, SubmissionStatus } from "./submissions.ts";
export type {
  ChannelTransport,
  DeliveryErrorKind,
  DeliveryReceipt,
  OutboundMessage,
  OutboundPiece,
  OutboundQueue,
} from "./outbound.ts";
export { answerKey, DeliveryError } from "./outbound.ts";
