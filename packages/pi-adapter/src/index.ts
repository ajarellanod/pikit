// Public surface of @pikit/pi-adapter: the only package that imports Pi (pi-durable 1.0, pi-ai 1.0).
// Its pikit-facing surface follows the core's stability rule; its Pi-facing internals do not. Neutral:
// it runs on a server (storage-sqlite) and in a Cloudflare Durable Object (storage-do) alike.

export { createDurableRuntime, INBOX_KICK } from "./runtime.ts";
export type { DurableRuntime, DurableRuntimeOptions } from "./runtime.ts";
export { openDurableStorage, type SqliteDatabase, SqliteStorage, splitSqlStatements, sqliteDatabaseFrom } from "./sql.ts";
export { AgentStateDoc, ConversationDoc, extensionName } from "./agent.ts";
export type { DurableModels, DurableTool } from "./agent.ts";
export type { DurableMessage, DurableUsage } from "./result.ts";
export { toChord } from "./context.ts";
export { modelRefOf, modelsFrom, parseModelName } from "./models.ts";
export type { ModelsOptions } from "./models.ts";
export { driveSlice, nextWakeAt, nextWakeAtOf } from "./wakeups.ts";
export type { DriveSliceOptions, LiveTaskRecord, SliceResult, WakeOptions } from "./wakeups.ts";
export { harnessEnv } from "./execution.ts";
export type { HarnessEnvSources } from "./execution.ts";
export { loginInteraction } from "./credentials.ts";
export type { LoginTerminal } from "./credentials.ts";
export type { Workspace, WorkspaceProvider } from "./types.ts";

// Pi's types, for components that implement or wire them without importing Pi (only the adapter does).
export type { HarnessInspection, ToolRegistration } from "@earendil-works/pi-durable";
export type { ExecutionEnv } from "@earendil-works/pi-durable/env";
export type { AuthInteraction, AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
export type { Models, Provider } from "@earendil-works/pi-ai/models";
