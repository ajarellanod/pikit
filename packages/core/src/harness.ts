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
 * Deadlines belong to whoever runs the harness (systemd, a Durable Object constructor), so
 * `start(ctx)` and `stop(ctx)` take a context instead of timeout options. Its cancellation
 * reaches every hook as `ctx.abortSignal`, and the harness stops waiting for a hook that
 * outlives it. JavaScript cannot kill a promise, so an abandoned hook keeps running and must
 * release what it acquired when it sees the abort.
 */

import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import {
  type CapabilityRegistry,
  createCapabilityRegistry,
  type HarnessCapabilities,
  type HarnessKeyedCapabilities,
  type Keyed,
} from "./capabilities.ts";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal, withCancel } from "./context.ts";
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
   * Whether a capability is provided. Meaningful after `create()`. It does not order startup:
   * a component that needs an optional capability declares it with `useOptional(name)`.
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

/** What a component's `setup` receives: the context plus registration. */
export interface Pikit extends HarnessContext {
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
      const capabilities: CapabilityRegistry<HarnessCapabilities, HarnessKeyedCapabilities> =
        createCapabilityRegistry(selection);

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
      /** Record a use once per name and mode; a required use wins over an optional one. */
      const recordUse = (record: SetupRecord, use: Use): Use => {
        const existing = record.uses.find((u) => u.name === use.name && u.mode === use.mode);
        if (!existing) {
          record.uses.push(use);
          return use;
        }
        existing.optional &&= use.optional;
        return existing;
      };

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
          ...base,
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

      const ordered = orderRecords(records, capabilities, selection);
      // Surface bad anchors now, not on the first message.
      for (const name of pipelines.names()) pipelines.chain(name);
      validated = true;

      const lifecycles = ordered.flatMap(({ component, hooks }) =>
        hooks ? [{ name: component.name, hooks }] : [],
      );

      /**
       * Stops `list` in reverse order under `ctx`. Every stop runs even if an earlier one threw;
       * one still running when `ctx.abortSignal` fires is abandoned and reported.
       */
      const shutdown = async (list: typeof lifecycles, ctx: HarnessContext): Promise<Error[]> => {
        await ctx.emit("runtime.stopping", {});
        const errors: Error[] = [];
        for (const { name, hooks } of [...list].reverse()) {
          try {
            await bounded(() => hooks.stop?.(ctx), ctx.abortSignal);
          } catch (error) {
            errors.push(new Error(`component "${name}" failed to stop`, { cause: error }));
          }
        }
        await ctx.emit("runtime.stopped", {});
        return errors;
      };

      /** One in-flight `start()`: `stop()` cancels it and bounds its rollback with its own deadline. */
      interface Boot {
        done: Promise<void>;
        cancel(reason: unknown): void;
        boundRollback(signal: AbortSignal | undefined): void;
      }

      const boot = (parent: Context): Boot => {
        const { context: bootContext, cancel } = withCancel(parent);
        // The rollback does not inherit the start's cancellation, which is usually why it runs;
        // only a stop() that interrupts the start bounds it.
        const rollback = new AbortController();
        const done = (async () => {
          const ctx = context(bootContext);
          await ctx.emit("runtime.starting", {});
          const up: typeof lifecycles = [];
          for (const entry of lifecycles) {
            try {
              ctx.abortSignal?.throwIfAborted();
              await bounded(() => entry.hooks.start?.(ctx), ctx.abortSignal);
            } catch (error) {
              // Every runtime.starting is closed by runtime.stopped, even when start fails.
              const rollbackCtx = context(withAbortSignal(rollback.signal, withoutCancel(parent)));
              for (const stopError of await shutdown(up, rollbackCtx)) {
                logger.error("rollback after failed start", { error: stopError });
              }
              started = false;
              throw new Error(`component "${entry.name}" failed to start`, { cause: error });
            }
            up.push(entry);
          }
          running = up;
          await ctx.emit("runtime.ready", {});
        })();
        return { done, cancel, boundRollback: (signal) => follow(signal, rollback) };
      };

      let started = false;
      let running: typeof lifecycles = [];
      let starting: Boot | undefined;
      let stopping: Promise<void> | undefined;

      return {
        context,

        async start(parent = BACKGROUND_CONTEXT) {
          if (stopping) throw new Error("harness is stopping");
          if (started) throw new Error("harness already started");
          started = true;
          starting = boot(parent);
          try {
            await starting.done;
          } finally {
            starting = undefined;
          }
        },

        stop(parent = BACKGROUND_CONTEXT) {
          stopping ??= (async () => {
            if (starting) {
              // A SIGTERM during boot: cancel it and let it roll back within this stop's deadline.
              // Its error belongs to the caller of start().
              starting.boundRollback(parent.abortSignal);
              starting.cancel(new Error("harness is stopping"));
              await starting.done.catch(() => {});
            }
            if (!started) return;
            started = false;
            const errors = await shutdown(running, context(parent));
            running = [];
            if (errors.length) throw new AggregateError(errors, "harness stopped with errors");
          })().finally(() => {
            stopping = undefined;
          });
          return stopping;
        },

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

// ---- validation helpers ----

function checkUniqueNames(components: ComponentDefinition[]): void {
  const seen = new Set<string>();
  for (const { name } of components) {
    if (seen.has(name)) throw new Error(`component "${name}" is listed twice`);
    seen.add(name);
  }
}

/**
 * Awaits `work()` unless `signal` aborts first; then rejects with the abort reason. `work` is
 * always called. An abandoned promise keeps running, and its outcome is consumed here so it
 * cannot surface as an unhandled rejection.
 */
function bounded(work: () => unknown, signal: AbortSignal | undefined): Promise<void> {
  const pending = Promise.resolve().then(work);
  if (signal === undefined) return pending.then(() => {});
  return new Promise<void>((resolve, reject) => {
    const abandon = () => reject(signal.reason);
    signal.addEventListener("abort", abandon, { once: true });
    pending.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", abandon));
    if (signal.aborted) abandon();
  });
}

/** Abort `target` when `signal` aborts (now, if it already has). */
function follow(signal: AbortSignal | undefined, target: AbortController): void {
  if (signal === undefined) return;
  if (signal.aborted) target.abort(signal.reason);
  else signal.addEventListener("abort", () => target.abort(signal.reason), { once: true });
}

/** `parent`'s values without its cancellation (for work that must outlive it, like a rollback). */
function withoutCancel(parent: Context): Context {
  return {
    abortSignal: undefined,
    value: (key) => parent.value(key),
    toString: () => `${parent}.WithoutCancel`,
  };
}

/** One `use()` / `useOptional()` / `useKeyed()` a setup made. */
interface Use {
  name: string;
  mode: "single" | "keyed";
  /** May have no provider: `useOptional`, and every `useKeyed`. */
  optional: boolean;
}

/** What one component's setup did. */
interface SetupRecord {
  component: ComponentDefinition;
  provides: string[];
  uses: Use[];
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
 * cannot create a false cycle. A keyed use depends on every provider (possibly none); an
 * optional use on its provider when one is installed.
 */
function orderRecords(
  records: SetupRecord[],
  capabilities: CapabilityRegistry<HarnessCapabilities, HarnessKeyedCapabilities>,
  selection: Record<string, string>,
): SetupRecord[] {
  for (const [capability, chosen] of Object.entries(selection)) {
    if (capabilities.mode(capability) === "keyed") {
      throw new Error(
        `config.capabilities["${capability}"] cannot select a provider: "${capability}" is keyed and every provider is used`,
      );
    }
    const providers = capabilities.providers(capability);
    if (!providers.includes(chosen)) {
      throw new Error(
        `config.capabilities["${capability}"] selects "${chosen}", which does not provide it` +
          (providers.length ? ` (provided by ${providers.join(", ")})` : ""),
      );
    }
  }

  const byName = new Map(records.map((r) => [r.component.name, r]));
  /** The components a use depends on: none (optional, absent), all (keyed), or the chosen one. */
  const providersOf = (user: string, use: Use): string[] => {
    const capability = use.name;
    const mode = capabilities.mode(capability);
    if (mode === undefined) {
      if (use.optional) return [];
      throw new Error(`component "${user}" uses "${capability}" but no installed component provides it`);
    }
    if (mode !== use.mode) {
      throw new Error(
        mode === "keyed"
          ? `component "${user}" uses "${capability}" with use()/useOptional(), but it is keyed; use useKeyed()`
          : `component "${user}" uses "${capability}" with useKeyed(), but it is provided without a key`,
      );
    }
    const providers = capabilities.providers(capability);
    if (mode === "keyed") return providers;
    const chosen = selection[capability] ?? (providers.length === 1 ? providers[0] : undefined);
    if (chosen === undefined) {
      throw new Error(
        `capability "${capability}" has several providers (${providers.join(", ")}); ` +
          `select one with config.capabilities["${capability}"]`,
      );
    }
    return [chosen];
  };

  const state = new Map<string, "visiting" | "done">();
  const ordered: SetupRecord[] = [];
  const visit = (record: SetupRecord, path: string[]): void => {
    const name = record.component.name;
    const mark = state.get(name);
    if (mark === "done") return;
    if (mark === "visiting") throw new Error(`dependency cycle: ${[...path, name].join(" → ")}`);
    state.set(name, "visiting");
    for (const use of record.uses) {
      for (const provider of providersOf(name, use)) {
        if (provider === name) continue; // a component may consume what it provides
        visit(byName.get(provider) as SetupRecord, [...path, name]);
      }
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
