// Public surface of @pikit/core, the kernel (SPEC §4, §12a): what `createApp` runs itself, with no
// word of the domain. The vocabulary components share is in @pikit/contracts. Additive changes only
// within a major; a new export needs a [decision] (S2), and `exports.test.ts` holds this list.

export { defineComponent, defineApp } from "./app.ts";
export type {
  ComponentDefinition,
  ComponentLifecycle,
  Handle,
  KeyedHandle,
  App,
  AppContext,
  AppDefinition,
  AppDescription,
  AppOptions,
  Pikit,
  Target,
} from "./app.ts";

export type { Context, ContextKey } from "./context.ts";
export {
  BACKGROUND_CONTEXT,
  createContextKey,
  withAbortSignal,
  withCancel,
  withContextValue,
} from "./context.ts";

export { Halt, halt } from "./pipeline.ts";
export type { AppPipelines, ResolvedStage, Stage, StageOptions } from "./pipeline.ts";

export type { AppEvents } from "./events.ts";
export type { CapabilityMode, AppCapabilities, AppKeyedCapabilities, Keyed } from "./capabilities.ts";

export type { Clock } from "./clock.ts";
export { systemClock } from "./clock.ts";
export type { Logger } from "./logger.ts";
export { consoleLogger, silentLogger } from "./logger.ts";
