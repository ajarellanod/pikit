// Public surface of @pikit/core (SPEC §12a). Additive changes only within a major.

export { defineComponent, defineHarness } from "./harness.ts";
export type {
  ComponentDefinition,
  ComponentLifecycle,
  Handle,
  KeyedHandle,
  UseOptions,
  Harness,
  HarnessContext,
  HarnessDefinition,
  HarnessDescription,
  HarnessOptions,
  Pikit,
  Target,
} from "./harness.ts";

export type { Context, ContextKey } from "./context.ts";
export {
  BACKGROUND_CONTEXT,
  createContextKey,
  withAbortSignal,
  withCancel,
  withContextValue,
} from "./context.ts";

export { Halt, halt } from "./pipeline.ts";
export type { HarnessPipelines, ResolvedStage, Stage, StageOptions } from "./pipeline.ts";

export type { HarnessEvents } from "./events.ts";
export type { CapabilityMode, HarnessCapabilities, HarnessKeyedCapabilities, Keyed } from "./capabilities.ts";

export type { Clock } from "./contracts/clock.ts";
export { systemClock } from "./contracts/clock.ts";
export type { Logger } from "./contracts/logger.ts";
export { consoleLogger, silentLogger } from "./contracts/logger.ts";
