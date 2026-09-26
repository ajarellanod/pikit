// Public surface of @pikit/core/testing (SPEC §14): conformance suites for contracts.

export type { ConformanceCase, LifecycleConformanceOptions, LifecycleFixture } from "./lifecycle.ts";
export { createLifecycleConformance } from "./lifecycle.ts";

export type { AgentRuntimeConformanceOptions, AgentRuntimeFixture } from "./agent-runtime.ts";
export { createAgentRuntimeConformance } from "./agent-runtime.ts";

export type { SecretStoreFixture } from "./secrets.ts";
export { createSecretStoreConformance } from "./secrets.ts";

export type { ConversationRegistryFixture } from "./conversations.ts";
export { createConversationRegistryConformance } from "./conversations.ts";

export type { HttpRouteConformanceOptions, HttpRouteFixture } from "./http.ts";
export { createHttpRouteConformance } from "./http.ts";

export type { AgentStateFixture } from "./agent-state.ts";
export { createAgentStateConformance } from "./agent-state.ts";

export type { ChannelConformanceOptions, ChannelFixture, ChannelMessage, ChannelSetup } from "./channel.ts";
export { CONFORMANCE_AGENT, CONFORMANCE_ANSWER, createChannelConformance } from "./channel.ts";
