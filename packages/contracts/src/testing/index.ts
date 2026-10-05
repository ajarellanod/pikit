// Public surface of @pikit/contracts/testing: the conformance suites of the contracts.
// Every provider of a contract passes its suite. A suite checks what every provider must do, never
// the policy of one provider.

export type { AgentRuntimeConformanceOptions, AgentRuntimeFixture } from "./agent-runtime.ts";
export { createAgentRuntimeConformance } from "./agent-runtime.ts";

export type { SecretStoreFixture } from "./secrets.ts";
export { createSecretStoreConformance } from "./secrets.ts";

export type { ConversationRegistryFixture } from "./conversations.ts";
export { createConversationRegistryConformance } from "./conversations.ts";

export type { HttpRouteConformanceOptions, HttpRouteFixture } from "./http.ts";
export { createHttpRouteConformance } from "./http.ts";

export type { OutboundQueueConformanceOptions, OutboundQueueFixture } from "./outbound-queue.ts";
export { createOutboundQueueConformance } from "./outbound-queue.ts";

export type { FeedConformanceOptions, FeedFixture, MemoryFeed } from "./feed.ts";
export { createFeedConformance, createMemoryFeed } from "./feed.ts";

export type { MemorySubmissions, RecordingSubmissions, SubmissionsConformanceOptions, SubmissionsFixture, SubmissionsRecorder } from "./submissions.ts";
export { createMemorySubmissions, createSubmissionsConformance } from "./submissions.ts";

export type { ConvergenceFixture, ConvergenceProcess, ProcessLife } from "./convergence.ts";
export { createConvergenceConformance, SimulatedCrash, SimulatedStorageFailure } from "./convergence.ts";

export type { SqlDatabaseFixture } from "./storage-sql.ts";
export { createSqlDatabaseConformance } from "./storage-sql.ts";
export type { KeyValueFixture } from "./storage-kv.ts";
export { createKeyValueConformance, createMemoryKeyValueStorage } from "./storage-kv.ts";

export { withWorkersHost } from "./workers-host.ts";
export type { MailboxFixture } from "./mailbox.ts";
export { createMailboxConformance, createMemoryMailbox } from "./mailbox.ts";
export type { WakeupsConformanceOptions, WakeupsFixture } from "./wakeups.ts";
export { createMemoryWakeups, createWakeupsConformance } from "./wakeups.ts";

export type { AgentStateFixture } from "./agent-state.ts";
export { createAgentStateConformance } from "./agent-state.ts";

export type { ChannelConformanceOptions, ChannelFixture, ChannelMessage, ChannelPlatform, ChannelSetup, ReceivedPiece } from "./channel.ts";
export { CONFORMANCE_AGENT, CONFORMANCE_ANSWER, createChannelConformance } from "./channel.ts";

export type { AgentObserveConformanceOptions, AgentObserveFixture } from "./observe.ts";
export { createAgentObserveConformance } from "./observe.ts";

export type { AdminAuthFixture } from "./admin.ts";
export { createAdminAuthConformance } from "./admin.ts";

export type { HealthFixture, HealthPolicy } from "./health.ts";
export { createHealthConformance } from "./health.ts";
