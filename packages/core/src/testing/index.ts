// Public surface of @pikit/core/testing (SPEC §14): conformance suites for contracts.

export type { ConformanceCase, LifecycleConformanceOptions, LifecycleFixture } from "./lifecycle.ts";
export { createLifecycleConformance } from "./lifecycle.ts";

export type { AgentRuntimeConformanceOptions, AgentRuntimeFixture } from "./agent-runtime.ts";
export { createAgentRuntimeConformance } from "./agent-runtime.ts";
