// Public surface of @pikit/core, the kernel (SPEC §3; K8, K10): what `createApp` runs itself, with no
// word of the domain. The vocabulary components share is in @pikit/contracts. Additive changes only
// within a major; a new export needs a [decision] (SPEC §3.2), and `exports.test.ts` holds this list.

export { APP_DESCRIPTION, defineComponent, defineApp } from "./app.ts";
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
