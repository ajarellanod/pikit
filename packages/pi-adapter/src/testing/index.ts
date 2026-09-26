// Public surface of @pikit/pi-adapter/testing: what a component's tests need to run Pi without
// importing it (rule 1). Server-only: it uses the filesystem and child processes.

export { createPiRuntimeFixture, killMidRun, testComponents } from "./fixture.ts";
export type { PiRuntimeUnderTest, TestComponents } from "./fixture.ts";
export { holdTool, recordingBash, scriptedAgent, scriptedProvider } from "./script.ts";
export type { ModelRequest, ScriptedProviderOptions } from "./script.ts";
export { createSessionRepoConformance, createStorageConformance, JSONL_REPO_CONFORMANCE_GAPS, storageOf } from "./sessions.ts";
export type { StorageFixture } from "./sessions.ts";
export { createCredentialStoreConformance } from "./credentials.ts";
export type { CredentialStoreFixture } from "./credentials.ts";
export { createExecutionConformance } from "./execution.ts";
export type { ExecutionFixture } from "./execution.ts";
export { createWorkspaceConformance } from "./workspace.ts";
export type { WorkspaceFixture } from "./workspace.ts";
