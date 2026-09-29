// Public surface of @pikit/pi-adapter/testing/neutral: the part of `@pikit/pi-adapter/testing` that
// runs on every target, so Pi's suites and the scripted agent run in workerd too (tests/workerd).
// Nothing here spawns a process or touches a disk. `@pikit/pi-adapter/testing` re-exports all of it.

export { createRuntimeFixture, interruptInProcess, testComponents } from "./runtime-fixture.ts";
export type { PiRuntimeUnderTest, RuntimeFixtureRecords, TestComponents } from "./runtime-fixture.ts";
export { holdTool, recordingBash, scriptedAgent, scriptedProvider } from "./script.ts";
export type { ModelRequest, ScriptedProviderOptions } from "./script.ts";
export {
  createSessionRepoConformance,
  createSessionRepoStreamingForkConformance,
  createStorageConformance,
  JSONL_REPO_CONFORMANCE_GAPS,
  storageOf,
} from "./sessions.ts";
export type { StorageFixture } from "./sessions.ts";
export { createExecutionConformance } from "./execution.ts";
export type { ExecutionFixture } from "./execution.ts";
