/**
 * What a component's `setup` declares, read without starting anything (setup is the
 * manifest).
 *
 * The answer comes from the app's own `describe()`, the function `pikit doctor` uses, so the
 * manifest and doctor cannot disagree on what `use`, `useOptional` and `useKeyed` mean. `describe()`
 * needs an app that composes, so two passes:
 * 1. a recording `Pikit` runs `setup` once to learn which single capabilities it uses (each gets a
 *    stub provider) and the tools it provides (their `replay`, which `describe()` does not report);
 * 2. an app of the component plus the stubs is created (every setup, no start) and described.
 *
 * Setups are synchronous and only register, so running them twice acquires nothing.
 *
 * A component whose declarations depend on its config (`tool-mcp` provides one `agent.tool` per
 * tool its config names, none by default) is also described with each config in the `examples` of
 * its root config schema (`Type.Object({ ... }, { examples: [config, ...] })`): the manifest says
 * what it can declare, the union of the default config's and every example's. The tools only an
 * example provides are not in `replay.tools`: their names are the example's, and `pikit new` gives
 * those names to the starter agent. Their replay is still checked.
 */

import { pathToFileURL } from "node:url";
import { type ComponentDefinition, defineApp, defineComponent, halt, type Pikit, silentLogger, systemClock, type Target } from "@pikit/core";
import type { TSchema } from "typebox";
import Value from "typebox/value";
import { type Generated, schemaProblems } from "./manifest.ts";

/**
 * The component a registry entry installs: the default export of `src/pikit/<name>/index.ts`.
 * `undefined` when `index.ts` has no default export at all: a component that is not an app
 * component (a `deployment-*`, which runs the app instead of running inside it) has no
 * `setup`, so it provides, requires and uses nothing. A default export that is not a component is
 * still an error.
 */
export async function loadComponent(entry: string): Promise<ComponentDefinition | undefined> {
  const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  if (!("default" in module)) return undefined;
  const component = module.default as Partial<ComponentDefinition> | undefined;
  if (typeof component?.name !== "string" || typeof component.setup !== "function") {
    throw new Error(`${entry} has no default export made with defineComponent({ name, setup })`);
  }
  return component as ComponentDefinition;
}

/**
 * The named export `name` of `entry`: the half of a two-App component that its `component.json`'s
 * `apps` names (SPEC §4.1, C1). Missing, or not a component, is an error.
 */
export async function loadExport(entry: string, name: string): Promise<ComponentDefinition> {
  const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const component = module[name] as Partial<ComponentDefinition> | undefined;
  if (typeof component?.name !== "string" || typeof component.setup !== "function") {
    throw new Error(`${entry} has no export "${name}" made with defineComponent({ name, setup }), which apps names`);
  }
  return component as ComponentDefinition;
}

/** What several halves declare together: each list in order, without repeats. */
export function mergeGenerated(halves: readonly Generated[]): Generated {
  const union = (lists: string[][]): string[] => [...new Set(lists.flat())];
  const merge = (pick: (half: Generated) => Record<string, string> | undefined) =>
    halves.reduce<Record<string, string> | undefined>((all, half) => (pick(half) === undefined ? all : { ...all, ...pick(half) }), undefined);
  const tools = merge((h) => h.tools);
  const exampleTools = merge((h) => h.exampleTools);
  const modelProviders = union(halves.map((h) => h.modelProviders ?? []));
  return {
    provides: union(halves.map((h) => h.provides)),
    requires: union(halves.map((h) => h.requires)),
    optional: union(halves.map((h) => h.optional)).filter((name) => !halves.some((h) => h.requires.includes(name))),
    ...(tools !== undefined && { tools }),
    ...(exampleTools !== undefined && { exampleTools }),
    ...(modelProviders.length > 0 && { modelProviders }),
  };
}

/**
 * The configs of the `examples` of the component's root config schema, each with the schema's
 * defaults applied, as the app would take it. An example that is not a valid config throws: it would
 * describe a component nobody can configure.
 */
export function configExamples(component: ComponentDefinition): unknown[] {
  const schema = component.config as (TSchema & { examples?: unknown }) | undefined;
  if (schema?.examples === undefined) return [];
  if (!Array.isArray(schema.examples)) throw new Error(`the examples of ${component.name}'s config schema are not an array of configs`);
  return schema.examples.map((example, i) => {
    const config = Value.Default(schema, Value.Clone(example));
    const problems = schemaProblems(schema, config);
    if (problems.length > 0) throw new Error(`examples[${i}] of ${component.name}'s config schema is not a valid config: ${problems.join("; ")}`);
    return config;
  });
}

/**
 * What `setup` declares with the default config and with each example config: every list in that
 * order, without repeats; `tools` and `modelProviders` only the default config's, the examples' other
 * tools in `exampleTools`.
 */
export async function describeComponent(component: ComponentDefinition, target: Target): Promise<Generated> {
  const own = await describeSetup(component, target);
  const examples = configExamples(component);
  if (examples.length === 0) return own;
  const described: Generated[] = [];
  for (const [i, config] of examples.entries()) {
    try {
      described.push(await describeSetup(component, target, config));
    } catch (error) {
      throw new Error(`with examples[${i}] of its config schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const { provides, requires, optional } = mergeGenerated([own, ...described]);
  const exampleTools = Object.fromEntries(
    described.flatMap((d) => Object.entries(d.tools ?? {})).filter(([tool]) => own.tools?.[tool] === undefined),
  );
  return {
    provides,
    requires,
    optional,
    ...(own.tools !== undefined && { tools: own.tools }),
    ...(Object.keys(exampleTools).length > 0 && { exampleTools }),
    ...(own.modelProviders !== undefined && { modelProviders: own.modelProviders }),
  };
}

/** What `setup` declares with `componentConfig`, by default a placeholder made from the schema. */
export async function describeSetup(component: ComponentDefinition, target: Target, componentConfig?: unknown): Promise<Generated> {
  // A placeholder config only for describing: defaults where the schema has them, typebox's
  // minimal valid values for required fields (router-basic's `defaultAgent`).
  const config = component.config ? { [component.name]: componentConfig ?? Value.Create(component.config as TSchema) } : {};
  const recorded = record(component, target, config);

  const stubs = recorded.singleUses
    .filter((name) => !recorded.provides.has(name))
    .map((name, i) =>
      defineComponent({
        name: `describe-stub-${i}`,
        setup: (pikit) => pikit.provide(name as never, {} as never),
      }),
    );
  const app = await defineApp({ components: [component, ...stubs], config, target, logger: silentLogger }).create();
  const description = app.describe();
  const described = description.components.find((c) => c.name === component.name);
  if (described === undefined) throw new Error(`describe() does not list "${component.name}"`);
  // The keys agents name models by (`anthropic/…`), which `pikit new` checks its starter agent against.
  const modelProviders = Object.entries(description.capabilities["model.provider"]?.keys ?? {})
    .filter(([, owner]) => owner === component.name)
    .map(([key]) => key);

  return {
    provides: described.provides,
    requires: described.requires,
    optional: described.optional,
    ...(recorded.tools !== undefined && { tools: recorded.tools }),
    ...(modelProviders.length > 0 && { modelProviders }),
  };
}

interface Recorded {
  singleUses: string[];
  provides: Set<string>;
  tools?: Record<string, string>;
}

/** Runs `setup` against a `Pikit` that only writes down what it is asked. */
function record(component: ComponentDefinition, target: Target, config: Record<string, unknown>): Recorded {
  const recorded: Recorded = { singleUses: [], provides: new Set() };
  const unavailable = (name: string) => () => {
    throw new Error(`"${name}" is not available while describing: setup must not call get()`);
  };
  const useSingle = (name: string) => {
    if (!recorded.singleUses.includes(name)) recorded.singleUses.push(name);
    return { name, get: unavailable(name) };
  };
  const pikit: Pikit = {
    target,
    config,
    logger: silentLogger,
    clock: systemClock,
    on: () => {},
    pipeline: () => {},
    provide: (name) => void recorded.provides.add(name),
    provideKeyed: (name, key, impl) => {
      recorded.provides.add(name);
      if (name !== "agent.tool") return;
      // Every tool states whether a resumed run may call it again. A missing or unknown value
      // is written as-is so `validate` can name it.
      const replay = (impl as { replay?: unknown }).replay;
      recorded.tools = { ...recorded.tools, [key]: typeof replay === "string" ? replay : String(replay) };
    },
    use: useSingle,
    useOptional: useSingle,
    useKeyed: (name) => ({ name, get: unavailable(name), keys: unavailable(name) }),
    halt,
  };
  component.setup(pikit, config[component.name] as never);
  return recorded;
}
