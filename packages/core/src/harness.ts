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
 */

import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { type CapabilityRegistry, createCapabilityRegistry, type HarnessCapabilities } from "./capabilities.ts";
import { BACKGROUND_CONTEXT, type Context } from "./context.ts";
import { type Clock, systemClock } from "./contracts/clock.ts";
import { consoleLogger, type Logger } from "./contracts/logger.ts";
import { createEventBus, type EventBus, type HarnessEvents } from "./events.ts";
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
    "runtime.starting": Record<string, never>;
    "runtime.ready": Record<string, never>;
    "runtime.stopping": Record<string, never>;
    "runtime.stopped": Record<string, never>;
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
  /**
   * For optional capabilities. Meaningful after `create()`. Only `use()` orders startup, so a
   * component must not rely on an optional capability's provider having started.
   */
  has(name: string): boolean;
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

/** What a component's `setup` receives: the context plus registration. */
export interface Pikit extends HarnessContext {
  on: EventBus<HarnessEvents, HarnessContext>["on"];
  pipeline: PipelineRegistry<HarnessPipelines, HarnessContext>["register"];
  /** Declare that this component provides `name`, and install its implementation. */
  provide<K extends keyof HarnessCapabilities & string>(name: K, impl: HarnessCapabilities[K]): void;
  /** Declare that this component depends on `name`. Its provider starts first. */
  use<K extends keyof HarnessCapabilities & string>(name: K): Handle<HarnessCapabilities[K]>;
  halt: typeof halt;
}

/**
 * What `setup` may return: the component's resources, acquired in `start` and released in
 * `stop`. Setup-local variables are shared with both through the closure.
 */
export interface ComponentLifecycle {
  /** Runs in dependency order. A throw rolls back the components already started and fails `start()`. */
  start?(ctx: HarnessContext): void | Promise<void>;
  /** Runs in reverse dependency order. A throw is collected; the remaining components still stop. */
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
  components: ComponentDefinition[];
  /** Sugar for project-local components. Concatenated after `components`. */
  extensions?: ComponentDefinition[];
  /** Values, never a path. `config.capabilities[name]` selects among several providers. */
  config?: Record<string, unknown>;
  target?: Target;
  logger?: Logger;
  clock?: Clock;
}

export interface HarnessDescription {
  target: Target;
  /** In start order. `provides`/`requires` are derived from setup; `component.json` must match. */
  components: { name: string; version?: string; provides: string[]; requires: string[] }[];
  capabilities: Record<string, { providers: string[]; selected?: string }>;
  pipelines: Record<string, ResolvedStage[]>;
  config: Readonly<Record<string, unknown>>;
}

export interface Harness {
  /** Harness context over `parent` (its cancellation and values); `BACKGROUND_CONTEXT` if omitted. */
  context(parent?: Context): HarnessContext;
  /** Rejects if a component fails to start, after stopping the ones that did. */
  start(): Promise<void>;
  /** Stops every started component; rejects with an `AggregateError` if any `stop` threw. */
  stop(): Promise<void>;
  describe(): HarnessDescription;
}

export interface HarnessDefinition {
  /** Components as listed. Start order is known only after `create()` (see `describe()`). */
  readonly components: readonly ComponentDefinition[];
  readonly config: Readonly<Record<string, unknown>>;
  create(): Promise<Harness>;
}

export function defineHarness(options: HarnessOptions): HarnessDefinition {
  const all = [...options.components, ...(options.extensions ?? [])];
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
      const capabilities: CapabilityRegistry<HarnessCapabilities> = createCapabilityRegistry(selection);

      // Plain own properties (no getters): `setup` spreads the base context into `pikit`.
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
          has: (name) => capabilities.has(name),
          emit: (name, payload) => events.emit(name, payload, ctx),
          run: (name, input) => pipelines.run(name, input, ctx),
          derive: (change) => context(change(inner)),
        };
        return ctx;
      };
      const base = context();

      // Handles resolve only after the graph is validated; until then a provider's setup may not
      // have run, so `get()` would return nothing or the wrong thing.
      let validated = false;
      const handle = <K extends keyof HarnessCapabilities & string>(
        name: K,
        user: string,
      ): Handle<HarnessCapabilities[K]> => ({
        name,
        get: () => {
          if (!validated) {
            throw new Error(
              `component "${user}": "${name}" is not available during setup; call get() in start or later`,
            );
          }
          return capabilities.require(name);
        },
      });

      // Every setup runs, in list order, and records what it provides and uses.
      const records: SetupRecord[] = [];
      for (const component of all) {
        const record: SetupRecord = { component, provides: [], uses: [] };
        const pikit: Pikit = {
          ...base,
          on: (name, listener) => events.on(name, listener),
          pipeline: (name, stage, opts) => pipelines.register(name, stage, opts),
          provide: (name, impl) => {
            capabilities.provide(name, impl, component.name);
            record.provides.push(name);
          },
          use: (name) => {
            if (!record.uses.includes(name)) record.uses.push(name);
            return handle(name, component.name);
          },
          halt,
        };
        const hooks: unknown = component.setup(pikit, config[component.name]);
        if (isThenable(hooks)) {
          throw new Error(
            `component "${component.name}": setup must be synchronous; acquire resources in start`,
          );
        }
        if (hooks) record.hooks = hooks as ComponentLifecycle;
        records.push(record);
      }

      const ordered = orderRecords(records, capabilities, selection);
      // Surface bad anchors now, not on the first message.
      for (const name of pipelines.names()) pipelines.chain(name);
      validated = true;

      const lifecycles = ordered.flatMap(({ component, hooks }) =>
        hooks ? [{ name: component.name, hooks }] : [],
      );

      /** Stops `running` in reverse order; every stop runs even if an earlier one threw. */
      const shutdown = async (running: typeof lifecycles): Promise<Error[]> => {
        await base.emit("runtime.stopping", {});
        const errors: Error[] = [];
        for (const { name, hooks } of [...running].reverse()) {
          try {
            await hooks.stop?.(base);
          } catch (error) {
            errors.push(new Error(`component "${name}" failed to stop`, { cause: error }));
          }
        }
        await base.emit("runtime.stopped", {});
        return errors;
      };

      let started = false;
      let running: typeof lifecycles = [];
      return {
        context,

        async start() {
          if (started) throw new Error("harness already started");
          started = true;
          await base.emit("runtime.starting", {});
          const up: typeof lifecycles = [];
          for (const entry of lifecycles) {
            try {
              await entry.hooks.start?.(base);
            } catch (error) {
              // Every runtime.starting is closed by runtime.stopped, even when start fails.
              for (const stopError of await shutdown(up)) {
                logger.error("rollback after failed start", { error: stopError });
              }
              started = false;
              throw new Error(`component "${entry.name}" failed to start`, { cause: error });
            }
            up.push(entry);
          }
          running = up;
          await base.emit("runtime.ready", {});
        },

        async stop() {
          if (!started) return;
          started = false;
          const errors = await shutdown(running);
          running = [];
          if (errors.length) throw new AggregateError(errors, "harness stopped with errors");
        },

        describe() {
          return {
            target,
            components: ordered.map(({ component, provides, uses }) => ({
              name: component.name,
              ...(component.version !== undefined && { version: component.version }),
              provides: [...provides],
              requires: [...uses],
            })),
            capabilities: Object.fromEntries(
              capabilities.names().map((name) => {
                const selected = capabilities.selected(name);
                return [name, { providers: capabilities.providers(name), ...(selected && { selected }) }];
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

// ---- validation helpers ----

function checkUniqueNames(components: ComponentDefinition[]): void {
  const seen = new Set<string>();
  for (const { name } of components) {
    if (seen.has(name)) throw new Error(`component "${name}" is listed twice`);
    seen.add(name);
  }
}

/** What one component's setup did. */
interface SetupRecord {
  component: ComponentDefinition;
  provides: string[];
  uses: string[];
  hooks?: ComponentLifecycle;
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** Shape only; whether the chosen component provides the capability is known after setup. */
function readSelection(config: Record<string, unknown> | undefined, components: ComponentDefinition[]) {
  const raw = config?.capabilities;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config.capabilities must be an object of capability → component name");
  }
  const names = new Set(components.map((c) => c.name));
  const selection: Record<string, string> = {};
  for (const [capability, chosen] of Object.entries(raw)) {
    if (typeof chosen !== "string") throw new Error(`config.capabilities["${capability}"] must be a component name`);
    if (!names.has(chosen)) {
      throw new Error(`config.capabilities["${capability}"] selects "${chosen}", which is not an installed component`);
    }
    selection[capability] = chosen;
  }
  return selection;
}

/**
 * Validates the graph recorded by setup and returns records in start order: providers before
 * consumers, list order as tiebreaker, depth-first with cycle detection. A consumer depends only
 * on the provider `get()` will return (the selected one), so an installed-but-unselected provider
 * cannot create a false cycle.
 */
function orderRecords(
  records: SetupRecord[],
  capabilities: CapabilityRegistry<HarnessCapabilities>,
  selection: Record<string, string>,
): SetupRecord[] {
  for (const [capability, chosen] of Object.entries(selection)) {
    const providers = capabilities.providers(capability);
    if (!providers.includes(chosen)) {
      throw new Error(
        `config.capabilities["${capability}"] selects "${chosen}", which does not provide it` +
          (providers.length ? ` (provided by ${providers.join(", ")})` : ""),
      );
    }
  }

  const byName = new Map(records.map((r) => [r.component.name, r]));
  const providerOf = (user: string, capability: string): string => {
    const providers = capabilities.providers(capability);
    if (providers.length === 0) {
      throw new Error(`component "${user}" uses "${capability}" but no installed component provides it`);
    }
    const chosen = selection[capability] ?? (providers.length === 1 ? providers[0] : undefined);
    if (chosen === undefined) {
      throw new Error(
        `capability "${capability}" has several providers (${providers.join(", ")}); ` +
          `select one with config.capabilities["${capability}"]`,
      );
    }
    return chosen;
  };

  const state = new Map<string, "visiting" | "done">();
  const ordered: SetupRecord[] = [];
  const visit = (record: SetupRecord, path: string[]): void => {
    const name = record.component.name;
    const mark = state.get(name);
    if (mark === "done") return;
    if (mark === "visiting") throw new Error(`dependency cycle: ${[...path, name].join(" → ")}`);
    state.set(name, "visiting");
    for (const capability of record.uses) {
      const provider = providerOf(name, capability);
      if (provider === name) continue; // a component may consume what it provides
      visit(byName.get(provider) as SetupRecord, [...path, name]);
    }
    state.set(name, "done");
    ordered.push(record);
  };
  for (const record of records) visit(record, []);
  return ordered;
}

/**
 * Merged schema: `capabilities` plus one property per component that declares `config`,
 * with `additionalProperties: false` so a typo in a component name is an error, not silence.
 */
function validateConfig(components: ComponentDefinition[], raw: Record<string, unknown>) {
  const properties: Record<string, TSchema> = {
    capabilities: Type.Optional(Type.Record(Type.String(), Type.String())),
  };
  const value: Record<string, unknown> = { ...raw };
  for (const component of components) {
    if (!component.config) continue;
    properties[component.name] = component.config;
    value[component.name] ??= {};
  }
  const schema = Type.Object(properties, { additionalProperties: false });
  const defaulted = Value.Default(schema, value) as Record<string, unknown>;
  if (!Value.Check(schema, defaulted)) {
    const problems = Value.Errors(schema, defaulted).map((e) => `${e.instancePath || "/"}: ${e.message}`);
    throw new Error(`invalid config:\n  ${problems.join("\n  ")}`);
  }
  return defaulted;
}
