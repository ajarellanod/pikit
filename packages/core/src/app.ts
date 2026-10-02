/**
 * Composition root and lifecycle (SPEC §3; K2, K4, K7).
 *
 *   defineApp({ components, config })   checks names and config (sync, throws)
 *     .create()                              runs every setup, derives the dependency graph
 *                                            from what they did, validates it
 *     .start()                               runtime.starting → start() in order → runtime.ready
 *     .stop()                                runtime.stopping → stop() in reverse → runtime.stopped
 *     .describe()                            what `pikit doctor` prints; every context the app
 *                                            creates carries it as `APP_DESCRIPTION` (K13)
 *
 * There is no `provides`/`requires` manifest: `setup` is the only truth. The app records
 * each `pikit.provide(name)` and `pikit.use(name)` and derives the graph from them (as Chord's
 * plugin host does). Missing and ambiguous providers, bad selections and cycles fail in
 * `create()`, after every setup and before any `start`.
 *
 * `setup` is synchronous and only registers; it must not open sockets, files or timers. That is
 * why running every setup before validating is safe, why a failed `create()` has nothing to
 * clean up, and why a failed `start()` can roll back exactly the components that did start.
 * `use()` returns a handle whose `get()` works only once the graph is valid, so no component can
 * reach a provider whose setup has not run. `runtime.*` events stay notifications: a listener
 * that throws is logged and cannot make the app look healthy or unhealthy.
 *
 * Definition-time checks live in `config.ts`, graph ordering in `graph.ts`, selection rules in
 * the capability registry, and start/stop (with their deadlines) in `lifecycle.ts`.
 */

import type { Static, TSchema } from "typebox";
import {
  type CapabilityRegistry,
  createCapabilityRegistry,
  type AppCapabilities,
  type AppKeyedCapabilities,
  type Keyed,
} from "./capabilities.ts";
import { checkUniqueNames, readSelection, validateConfig } from "./config.ts";
import { BACKGROUND_CONTEXT, type Context, createContextKey } from "./context.ts";
import { type Clock, systemClock } from "./clock.ts";
import { consoleLogger, type Logger } from "./logger.ts";
import { createEventBus, type EventBus, type AppEvents } from "./events.ts";
import { orderRecords, recordUse, type SetupRecord, type Use } from "./graph.ts";
import { createLifecycle } from "./lifecycle.ts";
import {
  createPipelineRegistry,
  type Halt,
  halt,
  type AppPipelines,
  type PipelineRegistry,
  type ResolvedStage,
} from "./pipeline.ts";

declare module "./events.ts" {
  interface AppEvents {
    "pipeline.halted": { pipeline: string; stage: string; reason: string };
  }
}

/**
 * Where an App runs: a runtime model, not a provider (SPEC §4). Providers are `deployment-*`
 * components on a target.
 * - `server`: a long-lived process. A process that stays up, a persistent local disk, in-process
 *   timers, one process per storage (Docker on a VPS, systemd, exe.dev, E2B, Modal, Fly…). A provider
 *   without a persistent disk supplies one (a volume), and its `deployment-*` checks it in `pikit doctor`.
 * - `durable`: one actor (a Durable Object) per conversation, with its own SQLite and one alarm,
 *   evicted between events; work is driven in slices (`driveSlice`). Cloudflare provides it today.
 *
 * A value is added only when a host of a new runtime model is built (stateless functions would be
 * `functions`).
 */
export type Target = "server" | "durable";

/**
 * What every handler receives (SPEC K5). `emit`/`run` propagate this same context.
 * It carries no app config, like `Pikit`: a component's config is `setup`'s second argument.
 */
export interface AppContext extends Context {
  target: Target;
  logger: Logger;
  clock: Clock;
  emit<K extends keyof AppEvents & string>(name: K, payload: AppEvents[K]): Promise<void>;
  run<K extends keyof AppPipelines & string>(
    name: K,
    input: AppPipelines[K],
  ): Promise<AppPipelines[K] | Halt>;
  /**
   * An app context over a derived invocation context, e.g.
   * `ctx.derive((c) => withContextValue(TENANT, "acme", c))`. Handlers reached through the
   * result's `emit`/`run` receive the result.
   */
  derive(change: (context: Context) => Context): AppContext;
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

type SingleName = keyof AppCapabilities & string;
type KeyedName = keyof AppKeyedCapabilities & string;

/**
 * What a component's `setup` receives: read-only app values plus registration. Not a
 * context: setup only registers, so it cannot emit, run a pipeline or see a cancellation. Work
 * happens in `start`/`stop` and in handlers, which receive a `AppContext`.
 *
 * No app config: a component gets its own as `setup`'s second argument and never another's.
 * Reading another component's config would couple the two outside the capability graph (P4),
 * where neither `registry validate` nor `pikit doctor` can see it; what a component needs from
 * another is a capability. The whole config is the host's (`AppDefinition.config`) and the
 * observers' (`describe()`, SPEC K13).
 */
export interface Pikit {
  readonly target: Target;
  readonly logger: Logger;
  readonly clock: Clock;
  on: EventBus<AppEvents, AppContext>["on"];
  pipeline: PipelineRegistry<AppPipelines, AppContext>["register"];
  /** Declare that this component provides the single capability `name`, and install it. */
  provide<K extends SingleName>(name: K, impl: AppCapabilities[K]): void;
  /** Declare that this component provides the keyed capability `name` under `key`, and install it. */
  provideKeyed<K extends KeyedName>(name: K, key: string, impl: AppKeyedCapabilities[K]): void;
  /** Depend on the single capability `name`. Its provider starts first; no provider is an error. */
  use<K extends SingleName>(name: K): Handle<AppCapabilities[K]>;
  /**
   * Depend on `name` if it is installed: `get()` returns `undefined` when nothing provides it.
   * When it is installed, its provider starts first. A separate verb rather than an option, so
   * whether a dependency is optional is written in code and cannot be switched from config.
   */
  useOptional<K extends SingleName>(name: K): Handle<AppCapabilities[K] | undefined>;
  /**
   * Depend on every implementation of the keyed capability `name`. All its providers start
   * first. No provider is not an error: an empty set is a normal state, and a consumer handles
   * a missing key per call anyway.
   */
  useKeyed<K extends KeyedName>(name: K): KeyedHandle<AppKeyedCapabilities[K]>;
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
   * app stops waiting: release what was acquired and throw.
   * `ctx` carries the start deadline: do not keep it for later work (a server's requests); derive
   * a context per invocation with `ctx.derive(...)`.
   */
  start?(ctx: AppContext): void | Promise<void>;
  /**
   * Runs in reverse dependency order. A throw is collected; the remaining components still stop.
   * When `ctx.abortSignal` fires (the stop deadline) the app moves on to the next component.
   */
  stop?(ctx: AppContext): void | Promise<void>;
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

export interface AppOptions {
  /** Registry and project-local components alike; list order is the tiebreaker for start order. */
  components: ComponentDefinition[];
  /** Values, never a path. `config.capabilities[name]` selects among several providers. */
  config?: Record<string, unknown>;
  target?: Target;
  logger?: Logger;
  clock?: Clock;
}

/**
 * What an App is made of, for observers (SPEC K13): `describe()`, and the frozen snapshot every
 * context the App creates carries under `APP_DESCRIPTION`. JSON. It changes additively; `version`
 * says which shape it is.
 */
export interface AppDescription {
  /** The shape of this description; a change that is not additive is a new version. */
  version: 1;
  /** The runtime model this App runs on (SPEC §4). */
  target: Target;
  /**
   * In start order. `provides`/`requires`/`optional` are derived from setup; `component.json` is
   * generated from them. `requires` are `use()`s; `optional` are `useOptional()`s and
   * `useKeyed()`s, which install fine with no provider.
   */
  components: { name: string; version?: string; provides: string[]; requires: string[]; optional: string[] }[];
  /** `selected` for single capabilities; `keys` (key → provider) for keyed ones. */
  capabilities: Record<string, { providers: string[]; selected?: string; keys?: Record<string, string> }>;
  /** Each pipeline's stages, in the order they run. */
  pipelines: Record<string, ResolvedStage[]>;
  /**
   * The validated config, under each component's name. It holds no secret: a component reads its
   * secrets through `secrets`, and its config names them at most (`tokenSecret: "GITHUB_TOKEN"`).
   */
  config: Readonly<Record<string, unknown>>;
}

/**
 * The App's description (SPEC K13), on every context it creates once its graph is valid (`start`,
 * `stop`, handlers, `app.context()`): `ctx.value(APP_DESCRIPTION)`. A frozen snapshot, the same
 * object for the App's whole life. For observation only: the dashboard (`admin-*`) and the agent's
 * self-knowledge read it; a component never changes its behaviour by what else is installed
 * (that is `useOptional`'s job).
 */
export const APP_DESCRIPTION = createContextKey<AppDescription>("pikit.app-description");

export interface App {
  /** App context over `parent` (its cancellation and values); `BACKGROUND_CONTEXT` if omitted. */
  context(parent?: Context): AppContext;
  /**
   * Rejects if a component fails to start, after stopping the ones that did. `parent` bounds the
   * start (e.g. `withAbortSignal(AbortSignal.timeout(ms), BACKGROUND_CONTEXT)`); the rollback is
   * not bounded by it, only by a `stop()` that interrupts the start. The rejection names the
   * component and has its failure as `cause`; if a rollback `stop` failed too, it is an
   * `AggregateError` whose `errors` are those failures.
   * Single-use: throws after `stop()` or a failed start. Restarting is `create()` again.
   */
  start(parent?: Context): Promise<void>;
  /**
   * Stops every started component; rejects with an `AggregateError` if any `stop` threw or was
   * abandoned when `parent` was cancelled. During a `start()` it cancels the start and waits for
   * its rollback, bounded by `parent`, and rejects if that rollback failed (the start's own error
   * stays with the caller of `start()`). Concurrent calls share the first call's shutdown; once it
   * has finished, `stop()` is a no-op.
   */
  stop(parent?: Context): Promise<void>;
  describe(): AppDescription;
}

export interface AppDefinition {
  /** Components as listed. Start order is known only after `create()` (see `describe()`). */
  readonly components: readonly ComponentDefinition[];
  /** Validated and defaulted, for whoever runs the app (a host recomposing it); never a component's. */
  readonly config: Readonly<Record<string, unknown>>;
  create(): Promise<App>;
}

export function defineApp(options: AppOptions): AppDefinition {
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
      const events = createEventBus<AppEvents, AppContext>((error, event) =>
        logger.error("event listener failed", { event, error }),
      );
      const pipelines = createPipelineRegistry<AppPipelines, AppContext>((info, ctx) =>
        ctx.emit("pipeline.halted", info),
      );
      const capabilities: CapabilityRegistry<AppCapabilities, AppKeyedCapabilities> =
        createCapabilityRegistry(selection);

      /** `describe()`, frozen once the graph is valid: what `APP_DESCRIPTION` carries (K13). */
      let description: AppDescription | undefined;

      // Reading `abortSignal` once is safe because a context never changes after derivation.
      const context = (inner: Context = BACKGROUND_CONTEXT): AppContext => {
        const ctx: AppContext = {
          abortSignal: inner.abortSignal,
          // This App's own description wins over one a parent context carries (another App's, K7).
          value: (key) => (key.token === APP_DESCRIPTION.token && description !== undefined ? (description as never) : inner.value(key)),
          toString: () => inner.toString(),
          target,
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
          logger,
          clock,
          on: (name, listener) => {
            open(`on("${name}")`);
            events.on(name, listener);
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

      const describe = (): AppDescription => ({
        version: 1,
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
      });
      // Registration is sealed, so the graph no longer changes: one snapshot serves the App's life.
      description = deepFreeze(describe());

      const lifecycle = createLifecycle({
        components: ordered.flatMap(({ component, hooks }) => (hooks ? [{ name: component.name, hooks }] : [])),
        context,
        logger,
      });

      return {
        context,
        start: (parent = BACKGROUND_CONTEXT) => lifecycle.start(parent),
        stop: (parent = BACKGROUND_CONTEXT) => lifecycle.stop(parent),

        describe,
      };
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
