// Public surface of @pikit/pi-adapter/testing/neutral: the part of `@pikit/pi-adapter/testing` that
// runs on every target, so the runtime's suites and the scripted agent run in workerd too
// (tests/workerd). Nothing here spawns a process or touches a disk. `@pikit/pi-adapter/testing`
// re-exports all of it.

export { createRuntimeFixture, fakeConversations, interruptRun, testComponents } from "./runtime-fixture.ts";
export type { RuntimeFixtureRecords, TestComponents } from "./runtime-fixture.ts";
export { holdTool, recordingBash, scriptedAgent, scriptedProvider } from "./script.ts";
export type { ModelRequest, ScriptedProviderOptions } from "./script.ts";
export { createWorkspaceConformance } from "./workspace.ts";
export type { WorkspaceFixture } from "./workspace.ts";
export { createCredentialStoreConformance } from "./credentials.ts";
export type { CredentialStoreFixture } from "./credentials.ts";
