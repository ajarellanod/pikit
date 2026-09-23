/**
 * What `defineHarness` checks synchronously, before any setup runs (SPEC §4.1, §4.6): unique
 * component names, the shape of `config.capabilities`, and the config against the merged
 * schema. Whether a selection names a provider is known only after setup, so the capability
 * registry checks it (`validateSelection`).
 */

import Type, { type TSchema } from "typebox";
import Value from "typebox/value";
import type { ComponentDefinition } from "./harness.ts";

export function checkUniqueNames(components: readonly ComponentDefinition[]): void {
  const seen = new Set<string>();
  for (const { name } of components) {
    if (seen.has(name)) throw new Error(`component "${name}" is listed twice`);
    seen.add(name);
  }
}

/** Shape only; whether the chosen component provides the capability is known after setup. */
export function readSelection(
  config: Record<string, unknown> | undefined,
  components: readonly ComponentDefinition[],
): Record<string, string> {
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
 * Merged schema: `capabilities` plus one property per component that declares `config`,
 * with `additionalProperties: false` so a typo in a component name is an error, not silence.
 */
export function validateConfig(
  components: readonly ComponentDefinition[],
  raw: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const properties: Record<string, TSchema> = {
    capabilities: Type.Optional(Type.Record(Type.String(), Type.String())),
  };
  // A deep copy: defaults and freezing must never touch the caller's objects.
  const value = Value.Clone(raw) as Record<string, unknown>;
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
  // `ctx.config` is shared by every component: a mutation would be a hidden coupling between
  // them (and leak into the next `create()`). Frozen, it throws at the line that tries.
  return deepFreeze(defaulted);
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
