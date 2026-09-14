/**
 * Composition root and lifecycle (SPEC §4.1, §4.2, §4.6).
 *
 *   defineHarness({ components, config })   validates the composition (sync, throws)
 *     .create()                              runs every component's setup in dependency order
 *     .start() / .stop()                     emits runtime.* events
 *     .describe()                            what `pikit doctor` prints
 *
 * Validation happens as early as possible: unsatisfied `requires`, ambiguous providers, bad
 * selections, dependency cycles and invalid config all fail in `defineHarness`, before any
 * component code runs.
 */

import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { type CapabilityRegistry, createCapabilityRegistry, type HarnessCapabilities } from "./capabilities.ts";
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
export interface HarnessContext {
  target: Target;
  /** Resolved, validated global config. Component config lives under `config[name]`. */
  config: Readonly<Record<string, unknown>>;
  logger: Logger;
  clock: Clock;
  require<K extends keyof HarnessCapabilities & string>(name: K): HarnessCapabilities[K];
  /** For optional capabilities. Meaningful after `create()`; setup order only covers `requires`. */
  has(name: string): boolean;
  emit<K extends keyof HarnessEvents & string>(name: K, payload: HarnessEvents[K]): Promise<void>;
  run<K extends keyof HarnessPipelines & string>(
    name: K,
    input: HarnessPipelines[K],
  ): Promise<HarnessPipelines[K] | Halt>;
  /** Present during an agent run. */
  signal?: AbortSignal;
}

/** What a component's `setup` receives: the context plus registration. */
export interface Pikit extends HarnessContext {
  on: EventBus<HarnessEvents, HarnessContext>["on"];
  pipeline: PipelineRegistry<HarnessPipelines, HarnessContext>["register"];
  /** Only capabilities declared in the component's `provides`. */
  provide<K extends keyof HarnessCapabilities & string>(name: K, impl: HarnessCapabilities[K]): void;
  halt: typeof halt;
}

export interface ComponentDefinition<Schema extends TSchema = TSchema> {
  /** kebab-case, prefixed by kind (`channel-telegram`). */
  name: string;
  version?: string;
  provides?: readonly string[];
  requires?: readonly string[];
  /** typebox schema for `config[name]`. Absent = the component takes no config. */
  config?: Schema;
  // Method syntax on purpose: keeps heterogeneous component lists assignable.
  setup(pikit: Pikit, config: Static<Schema>): void | Promise<void>;
}

const COMPONENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function defineComponent<Schema extends TSchema = TSchema>(
  definition: ComponentDefinition<Schema>,
): ComponentDefinition<Schema> {
  if (!COMPONENT_NAME.test(definition.name)) {
    throw new Error(`component name "${definition.name}" must be kebab-case (e.g. "channel-http")`);
  }
  return definition;
}

export interface HarnessOptions {
  components: ComponentDefinition[];
  /** Sugar: components without `provides`. Concatenated after `components`. */
  extensions?: ComponentDefinition[];
  /** Values, never a path. `config.capabilities[name]` selects among several providers. */
  config?: Record<string, unknown>;
  target?: Target;
  logger?: Logger;
  clock?: Clock;
}

export interface HarnessDescription {
  target: Target;
  /** In setup order. */
  components: { name: string; version?: string; provides: string[]; requires: string[] }[];
  capabilities: Record<string, { providers: string[]; selected?: string }>;
  pipelines: Record<string, ResolvedStage[]>;
  config: Readonly<Record<string, unknown>>;
}

export interface Harness {
  /** Base context, or one extended for a run (`signal`). */
  context(extra?: Pick<HarnessContext, "signal">): HarnessContext;
  start(): Promise<void>;
  stop(): Promise<void>;
  describe(): HarnessDescription;
}

export interface HarnessDefinition {
  /** Components in setup (dependency) order. */
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
  const providersOf = indexProviders(all);
  const selection = readSelection(options.config, providersOf);
  checkRequires(all, providersOf, selection);
  const ordered = topologicalOrder(all, providersOf);
  const config = validateConfig(all, options.config ?? {});

  return {
    components: ordered,
    config,

    async create() {
      const events = createEventBus<HarnessEvents, HarnessContext>((error, event) =>
        logger.error("event listener failed", { event, error }),
      );
      const pipelines = createPipelineRegistry<HarnessPipelines, HarnessContext>((info, ctx) =>
        ctx.emit("pipeline.halted", info),
      );
      const capabilities: CapabilityRegistry<HarnessCapabilities> = createCapabilityRegistry(selection);

      const context = (extra: Pick<HarnessContext, "signal"> = {}): HarnessContext => {
        const ctx: HarnessContext = {
          target,
          config,
          logger,
          clock,
          require: (name) => capabilities.require(name),
          has: (name) => capabilities.has(name),
          emit: (name, payload) => events.emit(name, payload, ctx),
          run: (name, input) => pipelines.run(name, input, ctx),
          ...extra,
        };
        return ctx;
      };
      const base = context();

      for (const component of ordered) {
        const declared = component.provides ?? [];
        const pikit: Pikit = {
          ...base,
          on: (name, listener) => events.on(name, listener),
          pipeline: (name, stage, opts) => pipelines.register(name, stage, opts),
          provide: (name, impl) => {
            if (!declared.includes(name)) {
              throw new Error(`component "${component.name}" provides "${name}" but its manifest does not declare it`);
            }
            capabilities.provide(name, impl, component.name);
          },
          halt,
        };
        await component.setup(pikit, config[component.name]);
        for (const name of declared) {
          if (!capabilities.providers(name).includes(component.name)) {
            throw new Error(`component "${component.name}" declares "${name}" but its setup did not provide it`);
          }
        }
      }

      // Surface bad anchors now, not on the first message.
      for (const name of pipelines.names()) pipelines.chain(name);

      let started = false;
      return {
        context,

        async start() {
          if (started) throw new Error("harness already started");
          started = true;
          await base.emit("runtime.starting", {});
          await base.emit("runtime.ready", {});
        },

        async stop() {
          if (!started) return;
          started = false;
          await base.emit("runtime.stopping", {});
          await base.emit("runtime.stopped", {});
        },

        describe() {
          return {
            target,
            components: ordered.map((c) => ({
              name: c.name,
              ...(c.version !== undefined && { version: c.version }),
              provides: [...(c.provides ?? [])],
              requires: [...(c.requires ?? [])],
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

// ---- validation helpers (all run inside defineHarness, before any setup) ----

function checkUniqueNames(components: ComponentDefinition[]): void {
  const seen = new Set<string>();
  for (const { name } of components) {
    if (seen.has(name)) throw new Error(`component "${name}" is listed twice`);
    seen.add(name);
  }
}

/** capability → names of components declaring it in `provides`. */
function indexProviders(components: ComponentDefinition[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const component of components) {
    for (const capability of component.provides ?? []) {
      index.set(capability, [...(index.get(capability) ?? []), component.name]);
    }
  }
  return index;
}

function readSelection(config: Record<string, unknown> | undefined, providersOf: Map<string, string[]>) {
  const raw = config?.capabilities;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config.capabilities must be an object of capability → component name");
  }
  const selection: Record<string, string> = {};
  for (const [capability, chosen] of Object.entries(raw)) {
    if (typeof chosen !== "string") throw new Error(`config.capabilities["${capability}"] must be a component name`);
    const providers = providersOf.get(capability) ?? [];
    if (!providers.includes(chosen)) {
      throw new Error(
        `config.capabilities["${capability}"] selects "${chosen}", which does not declare it` +
          (providers.length ? ` (declared by ${providers.join(", ")})` : ""),
      );
    }
    selection[capability] = chosen;
  }
  return selection;
}

function checkRequires(
  components: ComponentDefinition[],
  providersOf: Map<string, string[]>,
  selection: Record<string, string>,
): void {
  for (const component of components) {
    for (const capability of component.requires ?? []) {
      const providers = providersOf.get(capability) ?? [];
      if (providers.length === 0) {
        throw new Error(`component "${component.name}" requires "${capability}" but no installed component provides it`);
      }
      if (providers.length > 1 && selection[capability] === undefined) {
        throw new Error(
          `capability "${capability}" has several providers (${providers.join(", ")}); ` +
            `select one with config.capabilities["${capability}"]`,
        );
      }
    }
  }
}

/** Providers before consumers; list order as tiebreaker. Depth-first with cycle detection. */
function topologicalOrder(components: ComponentDefinition[], providersOf: Map<string, string[]>) {
  const byName = new Map(components.map((c) => [c.name, c]));
  const state = new Map<string, "visiting" | "done">();
  const ordered: ComponentDefinition[] = [];

  const visit = (component: ComponentDefinition, path: string[]): void => {
    const mark = state.get(component.name);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new Error(`dependency cycle: ${[...path, component.name].join(" → ")}`);
    }
    state.set(component.name, "visiting");
    for (const capability of component.requires ?? []) {
      for (const providerName of providersOf.get(capability) ?? []) {
        if (providerName === component.name) continue; // a component may consume what it provides
        visit(byName.get(providerName) as ComponentDefinition, [...path, component.name]);
      }
    }
    state.set(component.name, "done");
    ordered.push(component);
  };

  for (const component of components) visit(component, []);
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
