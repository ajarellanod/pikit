// Public surface of @pikit/pi-adapter (SPEC §6.2): the only package that imports Pi.
// Its pikit-facing surface follows the core's stability rule; its Pi-facing internals do not.

export { createPiRuntime } from "./runtime.ts";
export type { PiRuntime, PiRuntimeOptions } from "./runtime.ts";
export type { HarnessHook } from "./conversation.ts";
export type { ExtensionAPI, PiExtension } from "./extensions/api.ts";
export { modelsFrom } from "./models.ts";
export type { ModelsOptions } from "./models.ts";
export type { SessionStore, Workspace, WorkspaceProvider } from "./types.ts";

// Pi contract types, for components that implement or wire them without importing Pi (rule 1).
export type { AgentHarness, AgentHarnessTool, ExecutionEnv, Session, SessionRepo } from "@earendil-works/pi-agent-core";
export type {
  AuthInteraction,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
