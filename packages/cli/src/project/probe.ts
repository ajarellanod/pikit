/**
 * Run as `bun probe.ts <project-dir> <output-file>` in the project's directory: loads the project's
 * `pikit.config.ts`, creates the app (every setup, no start, SPEC §4.6) and writes its `describe()`
 * as JSON to `<output-file>`.
 *
 * It runs in its own process so that the project's code, and the `@pikit/core` it resolves from
 * the project's `node_modules`, never load into the CLI, and so that every call sees the file as it
 * is now (a module is imported once per process). The result goes to a file, not stdout, because
 * a component may log while it is set up.
 *
 * A project on Cloudflare has a second App, `export const worker` (SPEC C1): it is created too, so a
 * Worker that does not compose fails here and not at deploy. The description is the default export's;
 * `listed` names the components of both.
 *
 * It also reports what each agent names by key (tools, extensions, model), read from the
 * `agent.definition`s provided during setup: the names the runtime resolves only at start, which
 * `doctor` and `remove` check against the installed keys (`references.ts`).
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
      /** Every `agent.definition` provided during setup: its static fields, never `prepare`'s. */
      agents: AgentReferences[];
    }
  | { ok: false; error: string };

/** What one agent names by key. `prepare(state)` may name others per run: those cannot be checked. */
export interface AgentReferences {
  /** Its `agent.definition` key, the name the runtime and the routers find it by. */
  agent: string;
  /** The component that provides it. */
  component: string;
  /** `provider/modelId`, or "" when it has none. */
  model: string;
  /** Tools named by string; a tool object of the project's own is no reference. */
  tools: string[];
  extensions: string[];
}

interface ComponentLike {
  name: string;
  setup: (pikit: { provideKeyed(name: string, key: string, impl: unknown): void }, config: unknown) => unknown;
}

/**
 * Records the `agent.definition`s the components provide when their setup runs. `App` gives no way
 * to read a provided value without starting, and starting is what doctor must not do, so each
 * setup gets a `pikit` whose `provideKeyed` notes the definition before registering it as usual.
 * Only this child process sees the wrapped setups; it exits right after.
 */
function recordAgents(components: ComponentLike[]): AgentReferences[] {
  const agents: AgentReferences[] = [];
  for (const component of components) {
    const setup = component.setup;
    component.setup = (pikit, config) =>
      setup.call(component, {
        ...pikit,
        provideKeyed(name, key, impl) {
          if (name === "agent.definition") agents.push(referencesOf(key, component.name, impl));
          pikit.provideKeyed(name, key, impl);
        },
      }, config);
  }
  return agents;
}

function referencesOf(agent: string, component: string, definition: unknown): AgentReferences {
  const { model, tools, extensions } = (definition ?? {}) as { model?: unknown; tools?: unknown; extensions?: unknown };
  const names = (list: unknown): string[] => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  return { agent, component, model: typeof model === "string" ? model : "", tools: names(tools), extensions: names(extensions) };
}

if (import.meta.main) {
  const [projectDir = ".", output = ""] = process.argv.slice(2);
  let result: ProbeResult;
  try {
    const module = (await import(pathToFileURL(join(projectDir, "pikit.config.ts")).href)) as { default?: unknown; worker?: unknown };
    type Definition = { components?: ComponentLike[]; create?: () => Promise<{ describe(): unknown }> } | undefined;
    const definition = module.default as Definition;
    if (typeof definition?.create !== "function" || !Array.isArray(definition.components)) {
      throw new Error("pikit.config.ts has no default export made with defineApp({ components, config })");
    }
    const worker = module.worker as Definition;
    if (worker !== undefined && (typeof worker.create !== "function" || !Array.isArray(worker.components))) {
      throw new Error("pikit.config.ts exports a `worker` that is not made with defineApp({ components, config })");
    }
    const agents = recordAgents(definition.components);
    const app = await definition.create();
    try {
      await worker?.create?.();
    } catch (error) {
      throw new Error(`the Worker's App (export const worker): ${error instanceof Error ? error.message : String(error)}`);
    }
    result = {
      ok: true,
      listed: [...definition.components, ...(worker?.components ?? [])].map((c) => c.name),
      description: app.describe() as Extract<ProbeResult, { ok: true }>["description"],
      agents,
    };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
