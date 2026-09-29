/**
 * The kernel's public surface, held (SPEC §3, §3.2). The kernel is what `createApp` runs itself, with
 * no word of the domain; it should hardly ever change. A change to this list is a [decision]: record
 * it in SPEC.md, then update the list. A name the components share belongs in @pikit/contracts.
 *
 * Read from `index.ts` as text, so type-only exports count too.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KERNEL = [
  // Composition: define, compose, describe.
  "App",
  "AppCapabilities",
  "AppContext",
  "AppDefinition",
  "AppDescription",
  "AppEvents",
  "AppKeyedCapabilities",
  "AppOptions",
  "AppPipelines",
  "CapabilityMode",
  "ComponentDefinition",
  "ComponentLifecycle",
  "Handle",
  "Keyed",
  "KeyedHandle",
  "Pikit",
  "Target",
  "defineApp",
  "defineComponent",
  // Pipelines.
  "Halt",
  "ResolvedStage",
  "Stage",
  "StageOptions",
  "halt",
  // Context.
  "BACKGROUND_CONTEXT",
  "Context",
  "ContextKey",
  "createContextKey",
  "withAbortSignal",
  "withCancel",
  "withContextValue",
  // What the app needs before any component runs.
  "Clock",
  "Logger",
  "consoleLogger",
  "silentLogger",
  "systemClock",
];

function exported(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const name of (match[1] ?? "").split(",")) {
      const trimmed = name.trim().replace(/^type\s+/, "");
      if (trimmed !== "") names.push(trimmed);
    }
  }
  return names;
}

test("the kernel exports exactly its list: a change is a [decision] (SPEC §3.2)", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source).not.toMatch(/export\s+\*/);
  expect(exported(source).sort()).toEqual([...KERNEL].sort());
});
