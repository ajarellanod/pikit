/**
 * Composition root and lifecycle (SPEC §4.1, §4.2, §4.6).
 *
 *   defineHarness({ components, config })   checks names and config (sync, throws)
 *     .create()                              runs every setup, derives the dependency graph
 *                                            from what they did, validates it
 *     .start()                               runtime.starting → start() in order → runtime.ready
 *     .stop()                                runtime.stopping → stop() in reverse → runtime.stopped
 *     .describe()                            what `pikit doctor` prints
 *
 * There is no `provides`/`requires` manifest: `setup` is the only truth. The harness records
 * each `pikit.provide(name)` and `pikit.use(name)` and derives the graph from them (as Chord's
 * plugin host does). Missing and ambiguous providers, bad selections and cycles fail in
 * `create()`, after every setup and before any `start`.
 *
 * `setup` is synchronous and only registers; it must not open sockets, files or timers. That is
 * why running every setup before validating is safe, why a failed `create()` has nothing to
 * clean up, and why a failed `start()` can roll back exactly the components that did start.
 * `use()` returns a handle whose `get()` works only once the graph is valid, so no component can
 * reach a provider whose setup has not run. `runtime.*` events stay notifications: a listener
 * that throws is logged and cannot make the harness look healthy or unhealthy.
 *
 * Definition-time checks live in `config.ts`, graph ordering in `graph.ts`, selection rules in
 * the capability registry, and start/stop (with their deadlines) in `lifecycle.ts`.
 */

import type { Static, TSchema } from "typebox";
import {
  type CapabilityRegistry,
  createCapabilityRegistry,
  type HarnessCapabilities,
  type HarnessKeyedCapabilities,
  type Keyed,
} from "./capabilities.ts";
import { checkUniqueNames, readSelection, validateConfig } from "./config.ts";
import { BACKGROUND_CONTEXT, type Context } from "./context.ts";
import { type Clock, systemClock } from "./contracts/clock.ts";
import { consoleLogger, type Logger } from "./contracts/logger.ts";
import { createEventBus, type EventBus, type HarnessEvents } from "./events.ts";
import { orderRecords, recordUse, type SetupRecord, type Use } from "./graph.ts";
import { createLifecycle } from "./lifecycle.ts";
import {
  createPipelineRegistry,
  type Halt,
  halt,
  type HarnessPipelines,
  type PipelineRegistry,
  type ResolvedStage,
} from "./pipeline.ts";

declare module "./events.ts" {
  interface HarnessEvents {
    "pipeline.halted": { pipeline: string; stage: string; reason: string };
  }
}

export type Target = "server" | "cloudflare";

/** What every handler receives (SPEC §4.7). `emit`/`run` propagate this same context. */
export interface HarnessContext extends Context {
  target: Target;
  /** Resolved, validated global config. Component config lives under `config[name]`. */
  config: Readonly<Record<string, unknown>>;
  logger: Logger;
  clock: Clock;
  emit<K extends keyof HarnessEvents & string>(name: K, payload: HarnessEvents[K]): Promise<void>;
  run<K extends keyof HarnessPipelines & string>(
    name: K,
    input: HarnessPipelines[K],
  ): Promise<HarnessPipelines[K] | Halt>;
  /**
   * A harness context over a derived invocation context, e.g.
   * `ctx.derive((c) => withContextValue(TENANT, "acme", c))`. Handlers reached through the
   * result's `emit`/`run` receive the result.
   */
  derive(change: (context: Context) => Context): HarnessContext;
}

/** A declared dependency. `get()` returns the provider's implementation once the graph is valid. */
export interface Handle<T> {
  readonly name: string;
  /** Throws during setup: the provider's setup may not have run yet. Call it in `start` or later. */
  get(): T;
}

/**
 * A declared dependency on a keyed capability. `get(key)` returns the implementation for that
 * key; `keys()` lists them (possibly none). Both throw during setup, like `Handle.get()`.
 */
export interface KeyedHandle<T> {
  readonly name: string;
  get(key: string): T | undefined;
  keys(): string[];
}

type SingleName = keyof HarnessCapabilities & string;
type KeyedName = keyof HarnessKeyedCapabilities & string;

/**
 * What a component's `setup` receives: read-only harness values plus registration. Not a
 * context: setup only registers, so it cannot emit, run a pipeline or see a cancellation. Work
 * happens in `start`/`stop` and in handlers, which receive a `HarnessContext`.
 */
export interface Pikit {
  readonly target: Target;
  /** Resolved, validated global config. The component's own config is `setup`'s second argument. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly logger: Logger;
  readonly clock: Clock;
  on: EventBus<HarnessEvents, HarnessContext>["on"];
  pipeline: PipelineRegistry<HarnessPipelines, HarnessContext>["register"];
  /** Declare that this component provides the single capability `name`, and install it. */
  provide<K extends SingleName>(name: K, impl: HarnessCapabilities[K]): void;
  /** Declare that this component provides the keyed capability `name` under `key`, and install it. */
  provideKeyed<K extends KeyedName>(name: K, key: string, impl: HarnessKeyedCapabilities[K]): void;
  /** Depend on the single capability `name`. Its provider starts first; no provider is an error. */
  use<K extends SingleName>(name: K): Handle<HarnessCapabilities[K]>;
  /**
   * Depend on `name` if it is installed: `get()` returns `undefined` when nothing provides it.
   * When it is installed, its provider starts first. A separate verb rather than an option, so
   * whether a dependency is optional is written in code and cannot be switched from config.
   */
  useOptional<K extends SingleName>(name: K): Handle<HarnessCapabilities[K] | undefined>;
  /**
   * Depend on every implementation of the keyed capability `name`. All its providers start
   * first. No provider is not an error: an empty set is a normal state, and a consumer handles
   * a missing key per call anyway.
   */
  useKeyed<K extends KeyedName>(name: K): KeyedHandle<HarnessKeyedCapabilities[K]>;
  halt: typeof halt;
}

/**
 * What `setup` may return: the component's resources, acquired in `start` and released in
 * `stop`. Setup-local variables are shared with both through the closure.
 */
export interface ComponentLifecycle {
  /**
   * Runs in dependency order. A throw rolls back the components already started and fails
   * `start()`. When `ctx.abortSignal` fires (the start deadline, or `stop()` during boot) the
   * harness stops waiting: release what was acquired and throw.
   */
  start?(ctx: HarnessContext): void | Promise<void>;
  /**
   * Runs in reverse dependency order. A throw is collected; the remaining components still stop.
   * When `ctx.abortSignal` fires (the stop deadline) the harness moves on to the next component.
   */
  stop?(ctx: HarnessContext): void | Promise<void>;
}

export interface ComponentDefinition<Schema extends TSchema = TSchema> {
  /** kebab-case, prefixed by kind (`channel-telegram`). */
  name: string;
  version?: string;
  /** typebox schema for `config[name]`. Absent = the component takes no config. */
  config?: Schema;
  /** Synchronous and registration-only. What it provides and uses is the component's manifest. */
  // Method syntax on purpose: keeps heterogeneous component lists assignable.
  setup(pikit: Pikit, config: Static<Schema>): void | ComponentLifecycle;
}

const COMPONENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Top-level config keys owned by the core; a component with that name would collide. */
const RESERVED_NAMES = new Set(["capabilities"]);

export function defineComponent<Schema extends TSchema = TSchema>(
  definition: ComponentDefinition<Schema>,
): ComponentDefinition<Schema> {
  if (!COMPONENT_NAME.test(definition.name)) {
    throw new Error(`component name "${definition.name}" must be kebab-case (e.g. "channel-http")`);
  }
  if (RESERVED_NAMES.has(definition.name)) {
    throw new Error(`component name "${definition.name}" is reserved by the core config`);
  }
  return definition;
}

export interface HarnessOptions {
  /** Registry and project-local components alike; list order is the tiebreaker for start order. */
  components: ComponentDefinition[];
  /** Values, never a path. `config.capabilities[name]` selects among several providers. */
  config?: Record<string, unknown>;
  target?: Target;
  logger?: Logger;
  clock?: Clock;
}

export interface HarnessDescription {
  target: Target;
  /**
   * In start order. `provides`/`requires`/`optional` are derived from setup; `component.json` is
   * generated from them. `requires` are `use()`s; `optional` are `useOptional()`s and
   * `useKeyed()`s, which install fine with no provider.
   */
  components: { name: string; version?: string; provides: string[]; requires: string[]; optional: string[] }[];
  /** `selected` for single capabilities; `keys` (key → provider) for keyed ones. */
  capabilities: Record<string, { providers: string[]; selected?: string; keys?: Record<string, string> }>;
  pipelines: Record<string, ResolvedStage[]>;
  config: Readonly<Record<string, unknown>>;
}

export interface Harness {
  /** Harness context over `parent` (its cancellation and values); `BACKGROUND_CONTEXT` if omitted. */
  context(parent?: Context): HarnessContext;
  /**
   * Rejects if a component fails to start, after stopping the ones that did. `parent` bounds the
   * start (e.g. `withAbortSignal(AbortSignal.timeout(ms), BACKGROUND_CONTEXT)`); the rollback is
   * not bounded by it, only by a `stop()` that interrupts the start.
   */
  start(parent?: Context): Promise<void>;
  /**
   * Stops every started component; rejects with an `AggregateError` if any `stop` threw or was
   * abandoned when `parent` was cancelled. During a `start()` it cancels the start and waits for
   * its rollback, bounded by `parent`. Concurrent calls share the first call's shutdown.
   */
  stop(parent?: Context): Promise<void>;
  describe(): HarnessDescription;
}

export interface HarnessDefinition {
  /** Components as listed. Start order is known only after `create()` (see `describe()`). */
  readonly components: readonly ComponentDefinition[];
  readonly config: Readonly<Record<string, unknown>>;
  create(): Promise<Harness>;
}

export function defineHarness(options: HarnessOptions): HarnessDefinition {
  const all = [...options.components];
  const target = options.target ?? "server";
  const logger = options.logger ?? consoleLogger;
  const clock = options.clock ?? systemClock;

  checkUniqueNames(all);
  const selection = readSelection(options.config, all);
  const config = validateConfig(all, options.config ?? {});

  return {
    components: all,
    config,

    async create() {
      const events = createEventBus<HarnessEvents, HarnessContext>((error, event) =>
        logger.error("event listener failed", { event, error }),
      );
      const pipelines = createPipelineRegistry<HarnessPipelines, HarnessContext>((info, ctx) =>
        ctx.emit("pipeline.halted", info),
      );
      const capabilities: CapabilityRegistry<HarnessCapabilities, HarnessKeyedCapabilities> =
        createCapabilityRegistry(selection);

      // Reading `abortSignal` once is safe because a context never changes after derivation.
      const context = (inner: Context = BACKGROUND_CONTEXT): HarnessContext => {
        const ctx: HarnessContext = {
          abortSignal: inner.abortSignal,
          value: (key) => inner.value(key),
          toString: () => inner.toString(),
          target,
          config,
          logger,
          clock,
          emit: (name, payload) => events.emit(name, payload, ctx),
          run: (name, input) => pipelines.run(name, input, ctx),
          derive: (change) => context(change(inner)),
        };
        return ctx;
      };

      // Handles resolve only after the graph is validated; until then a provider's setup may not
      // have run, so `get()` would return nothing or the wrong thing.
      let validated = false;
      const assertReady = (use: Use, user: string): void => {
        if (!validated) {
          throw new Error(
            `component "${user}": "${use.name}" is not available during setup; call get() in start or later`,
          );
        }
      };
      const handle = <T>(use: Use, user: string, resolve: () => T): Handle<T> => ({
        name: use.name,
        get: () => {
          assertReady(use, user);
          return resolve();
        },
      });
      const keyedHandle = <T>(use: Use, user: string, resolve: () => Keyed<T>): KeyedHandle<T> => ({
        name: use.name,
        get: (key) => {
          assertReady(use, user);
          return resolve().get(key);
        },
        keys: () => {
          assertReady(use, user);
          return resolve().keys();
        },
      });

      // Every setup runs, in list order, and records what it provides and uses.
      const records: SetupRecord[] = [];
      for (const component of all) {
        const record: SetupRecord = { component, provides: [], uses: [] };
        // Registration is sealed when this setup returns: anything registered later (from start,
        // a listener, a timer) would bypass the validated graph and the pipeline chains.
        let sealed = false;
        const open = (what: string): void => {
          if (sealed) {
            throw new Error(`component "${component.name}": ${what} is only allowed during setup`);
          }
        };
        const pikit: Pikit = {
          target,
          config,
          logger,
          clock,
          on: (name, listener) => {
            open(`on("${name}")`);
            return events.on(name, listener);
          },
          pipeline: (name, stage, opts) => {
            open(`pipeline("${name}")`);
            pipelines.register(name, stage, opts);
          },
          provide: (name, impl) => {
            open(`provide("${name}")`);
            capabilities.provide(name, impl, component.name);
            if (!record.provides.includes(name)) record.provides.push(name);
          },
          provideKeyed: (name, key, impl) => {
            open(`provideKeyed("${name}")`);
            capabilities.provideKeyed(name, key, impl, component.name);
            if (!record.provides.includes(name)) record.provides.push(name);
          },
          use: (name) => {
            open(`use("${name}")`);
            const use = recordUse(record, { name, mode: "single", optional: false });
            return handle(use, component.name, () => capabilities.require(name));
          },
          useOptional: (name) => {
            open(`useOptional("${name}")`);
            const use = recordUse(record, { name, mode: "single", optional: true });
            // `use.optional` is read at get() time: a use(name) in the same setup makes it required.
            return handle(use, component.name, () =>
              use.optional && !capabilities.has(name) ? undefined : capabilities.require(name),
            );
          },
          useKeyed: (name) => {
            open(`useKeyed("${name}")`);
            const use = recordUse(record, { name, mode: "keyed", optional: true });
            return keyedHandle(use, component.name, () => capabilities.keyed(name));
          },
          halt,
        };
        let hooks: unknown;
        try {
          hooks = component.setup(pikit, config[component.name]);
        } finally {
          sealed = true;
        }
        if (isThenable(hooks)) {
          throw new Error(
            `component "${component.name}": setup must be synchronous; acquire resources in start`,
          );
        }
        if (hooks) record.hooks = hooks as ComponentLifecycle;
        records.push(record);
      }

      capabilities.validateSelection();
      const ordered = orderRecords(records, capabilities);
      validated = true;

      const lifecycle = createLifecycle({
        components: ordered.flatMap(({ component, hooks }) => (hooks ? [{ name: component.name, hooks }] : [])),
        context,
        logger,
      });

      return {
        context,
        start: (parent = BACKGROUND_CONTEXT) => lifecycle.start(parent),
        stop: (parent = BACKGROUND_CONTEXT) => lifecycle.stop(parent),

        describe() {
          return {
            target,
            components: ordered.map(({ component, provides, uses }) => ({
              name: component.name,
              ...(component.version !== undefined && { version: component.version }),
              provides: [...provides],
              requires: uses.filter((u) => !u.optional).map((u) => u.name),
              optional: uses.filter((u) => u.optional).map((u) => u.name),
            })),
            capabilities: Object.fromEntries(
              capabilities.names().map((name) => {
                const providers = capabilities.providers(name);
                if (capabilities.mode(name) === "keyed") return [name, { providers, keys: capabilities.keys(name) }];
                const selected = capabilities.selected(name);
                return [name, { providers, ...(selected && { selected }) }];
              }),
            ),
            pipelines: Object.fromEntries(pipelines.names().map((name) => [name, pipelines.chain(name)])),
            config,
          };
        },
      };
    },
  };
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
