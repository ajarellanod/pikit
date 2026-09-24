/**
 * Run as `bun probe.ts <project-dir> <output-file>` in the project's directory: loads the project's
 * `pikit.config.ts`, creates the app (every setup, no start, SPEC §4.6) and writes its `describe()`
 * as JSON to `<output-file>`.
 *
 * It runs in its own process so that the project's code, and the `@pikit/core` it resolves from
 * the project's `node_modules`, never load into the CLI, and so that every call sees the file as it
 * is now (a module is imported once per process). The result goes to a file, not stdout, because
 * a component may log while it is set up.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type ProbeResult =
  | {
      ok: true;
      /** The names in `components`, as listed. */
      listed: string[];
      description: {
        components: { name: string; provides: string[]; requires: string[]; optional: string[] }[];
        capabilities: Record<string, { providers: string[]; selected?: string; keys?: Record<string, string> }>;
        pipelines: Record<string, { id: string; priority: number }[]>;
        config: Record<string, unknown>;
      };
    }
  | { ok: false; error: string };

if (import.meta.main) {
  const [projectDir = ".", output = ""] = process.argv.slice(2);
  let result: ProbeResult;
  try {
    const module = (await import(pathToFileURL(join(projectDir, "pikit.config.ts")).href)) as { default?: unknown };
    const definition = module.default as { components?: { name: string }[]; create?: () => Promise<{ describe(): unknown }> } | undefined;
    if (typeof definition?.create !== "function" || !Array.isArray(definition.components)) {
      throw new Error("pikit.config.ts has no default export made with defineApp({ components, config })");
    }
    const app = await definition.create();
    result = {
      ok: true,
      listed: definition.components.map((c) => c.name),
      description: app.describe() as Extract<ProbeResult, { ok: true }>["description"],
    };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
