/**
 * Run as `bun probe.ts <project-dir> <output-file>` in the project's directory: loads the project's
 * `pikit.config.ts`, creates the app (every setup, no start) and writes its `describe()`
 * as JSON to `<output-file>`.
 *
 * It runs in its own process so that the project's code, and the `@pikit/core` it resolves from
 * the project's `node_modules`, never load into the CLI, and so that every call sees the file as it
 * is now (a module is imported once per process). The result goes to a file, not stdout, because
 * a component may log while it is set up.
 *
 * A project on Cloudflare has a second App, `export const worker` (SPEC C1): it is created too, so a
 * Worker that does not compose fails here and not at deploy. `description` is the default export's,
 * `worker` the Worker's; `listed` names the components of both.
 *
 * It also reports what each agent names by key (tools, extensions, model), read from the
 * `agent.definition`s provided during setup: the names the runtime resolves only at start, which
 * `doctor` and `remove` check against the installed keys (`references.ts`); and, per App, which
 * component registered each pipeline stage, which `describe()` names by id only (`serving.ts`).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** An App's `describe()`, the parts the CLI reads. */
export interface AppDescription {
  components: { name: string; provides: string[]; requires: string[]; optional: string[] }[];
  capabilities: Record<string, { providers: string[]; selected?: string; keys?: Record<string, string> }>;
  pipelines: Record<string, { id: string; priority: number }[]>;
  config: Record<string, unknown>;
  /**
   * Not `describe()`'s, the probe's: per pipeline, the component that registered each of its stages,
   * in registration order.
   */
  stagesBy: Record<string, string[]>;
}

export type ProbeResult =
  | {
      ok: true;
      /** The names in `components`, as listed, of every App. */
      listed: string[];
      /** The default export's App. */
      description: AppDescription;
      /** The Worker's App (`export const worker`), in a project that has one. */
      worker?: AppDescription;
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
  /** The agent extensions it names (`agent.extension`). */
  extensions: string[];
}

interface PikitLike {
  provideKeyed(name: string, key: string, impl: unknown): void;
  pipeline(name: string, stage: unknown, options?: unknown): void;
}

interface ComponentLike {
  name: string;
  setup: (pikit: PikitLike, config: unknown) => unknown;
}

/** What the setups of the App being created register, as `record` notes it. */
interface Recorded {
  /** Undefined for an App whose agents are not read (the Worker's). */
  agents: AgentReferences[] | undefined;
  stagesBy: Record<string, string[]>;
}

/**
 * Records what the components register when their setup runs, into `recording()`: the
 * `agent.definition`s they provide, and the component of each pipeline stage. `App` gives no way to
 * read a provided value without starting, and starting is what doctor must not do, so each setup gets
 * a `pikit` that notes them before registering them as usual. A component listed in both Apps is
 * wrapped once; each App's setups record into its own `Recorded`. Only this child process sees the
 * wrapped setups; it exits right after.
 */
function record(components: ComponentLike[], recording: () => Recorded): void {
  for (const component of new Set(components)) {
    const setup = component.setup;
    component.setup = (pikit, config) =>
      setup.call(component, {
        ...pikit,
        provideKeyed(name, key, impl) {
          if (name === "agent.definition") recording().agents?.push(referencesOf(key, component.name, impl));
          pikit.provideKeyed(name, key, impl);
        },
        pipeline(name, stage, options) {
          const { stagesBy } = recording();
          (stagesBy[name] ??= []).push(component.name);
          pikit.pipeline(name, stage, options);
        },
      }, config);
  }
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
    const main: Recorded = { agents: [], stagesBy: {} };
    const workers: Recorded = { agents: undefined, stagesBy: {} };
    let recording = main;
    record([...definition.components, ...(worker?.components ?? [])], () => recording);
    const app = await definition.create();
    recording = workers;
    let workerApp: { describe(): unknown } | undefined;
    try {
      workerApp = await worker?.create?.();
    } catch (error) {
      throw new Error(`the Worker's App (export const worker): ${error instanceof Error ? error.message : String(error)}`);
    }
    const described = (created: { describe(): unknown }, { stagesBy }: Recorded): AppDescription => ({ ...(created.describe() as Omit<AppDescription, "stagesBy">), stagesBy });
    result = {
      ok: true,
      listed: [...definition.components, ...(worker?.components ?? [])].map((c) => c.name),
      description: described(app, main),
      ...(workerApp !== undefined && { worker: described(workerApp, workers) }),
      agents: main.agents ?? [],
    };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
