/**
 * What a component's `setup` declares, read without starting anything (SPEC §4.2: setup is the
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
 */

import { pathToFileURL } from "node:url";
import { type ComponentDefinition, defineApp, defineComponent, halt, type Pikit, silentLogger, systemClock, type Target } from "@pikit/core";
import type { TSchema } from "typebox";
import Value from "typebox/value";
import type { Generated } from "./manifest.ts";

/**
 * The component a registry entry installs: the default export of `src/pikit/<name>/index.ts`.
 * `undefined` when `index.ts` has no default export at all: a component that is not an app
 * component (a `deployment-*`, which runs the app instead of running inside it, SPEC §9.1) has no
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

export async function describeSetup(component: ComponentDefinition, target: Target): Promise<Generated> {
  // A placeholder config only for describing: defaults where the schema has them, typebox's
  // minimal valid values for required fields (router-basic's `defaultAgent`).
  const config = component.config ? { [component.name]: Value.Create(component.config as TSchema) } : {};
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
  const described = app.describe().components.find((c) => c.name === component.name);
  if (described === undefined) throw new Error(`describe() does not list "${component.name}"`);

  return {
    provides: described.provides,
    requires: described.requires,
    optional: described.optional,
    ...(recorded.tools !== undefined && { tools: recorded.tools }),
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
      // S10: every tool states whether a resumed run may call it again. A missing or unknown value
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
