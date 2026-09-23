/**
 * The dependency graph derived from setup (SPEC §4.2, §4.5). There is no manifest: each setup
 * records what it provides and uses, and the graph is derived from those records. Which
 * provider a use reaches is the capability registry's decision (`resolveProvider`); this file
 * only orders components by it.
 */

import type { CapabilityRegistry, HarnessCapabilities, HarnessKeyedCapabilities } from "./capabilities.ts";
import type { ComponentDefinition, ComponentLifecycle } from "./harness.ts";

/** One `use()` / `useOptional()` / `useKeyed()` a setup made. */
export interface Use {
  name: string;
  mode: "single" | "keyed";
  /** May have no provider: `useOptional`, and every `useKeyed`. */
  optional: boolean;
}

/** What one component's setup did. */
export interface SetupRecord {
  component: ComponentDefinition;
  provides: string[];
  uses: Use[];
  hooks?: ComponentLifecycle;
}

/** Record a use once per name and mode; a required use wins over an optional one. */
export function recordUse(record: SetupRecord, use: Use): Use {
  const existing = record.uses.find((u) => u.name === use.name && u.mode === use.mode);
  if (!existing) {
    record.uses.push(use);
    return use;
  }
  existing.optional &&= use.optional;
  return existing;
}

/**
 * Validates the uses recorded by setup and returns records in start order: providers before
 * consumers, list order as tiebreaker, depth-first with cycle detection. A consumer depends only
 * on the provider `get()` will return (the selected one), so an installed-but-unselected provider
 * cannot create a false cycle. A keyed use depends on every provider (possibly none); an
 * optional use on its provider when one is installed.
 */
export function orderRecords(
  records: SetupRecord[],
  capabilities: CapabilityRegistry<HarnessCapabilities, HarnessKeyedCapabilities>,
): SetupRecord[] {
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
    if (mode === "keyed") return capabilities.providers(capability);
    const chosen = capabilities.resolveProvider(capability);
    if (chosen instanceof Error) throw chosen;
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
