/**
 * @pikit/pi-adapter/tools: Pi's own `read`, `write`, `edit` and `bash` tools (SPEC §6.3), for the
 * `tool-*` components. pikit does not reimplement them; a component adds only what the kit owns:
 * - the environment the tool works on: the agent's `workspace` when one is installed, otherwise the
 *   capability it declares (`execution`, or `execution.shell` for `bash`);
 * - its `replay`, which Pi applies when a run is resumed after a crash (SPEC §8.4). Pi's tools
 *   declare none, so they would default to `"never"`.
 *
 * Pi's tools read their environment from the harness's `toolContext.env`. A bound tool ignores the
 * harness's context and asks its own `env` for one on every call instead, with the run's context, so
 * the runtime passes none, and each tool works on exactly what its component chose for that run.
 *
 * `toolComponent` is the short way to a tool of your own: one written as Pi's `defineTool` writes it,
 * provided as `agent.tool` by a component, with the `replay` pikit needs. `agentTool` is the same tool
 * without the component, for a `defineComponent` of your own that needs config or a capability.
 */

import type { AgentHarnessTool, AgentToolResult, AgentToolUpdateCallback, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { type ComponentDefinition, type Context, defineComponent } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";

export { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";

export interface BindOptions {
  /**
   * The environment of one call, asked for when the tool runs (from `start` on). It receives the
   * context Pi gives the call: in a run, it carries the run's conversation (`CONVERSATION`), so a
   * component can pick the agent's workspace. `() => execution.get()` when it does not care.
   */
  env: (context: Context) => ExecutionEnv | Promise<ExecutionEnv>;
  /** `"safe"`: run again when a run is resumed after a crash. `"never"`: report it interrupted instead. */
  replay: "safe" | "never";
}

/**
 * A tool in the shape of Pi's `defineTool` (`@earendil-works/pi-coding-agent`), for `toolComponent`:
 * the same fields and the same `execute` order. Only its fifth argument differs: the run's context
 * (its conversation, `context.value(CONVERSATION)`; its cancellation), not Pi's `ExtensionContext`,
 * which only an extension's host has. So a Pi tool's object moves in as it is, written inside
 * `toolComponent`; one typed by Pi's `defineTool` promises that context and does not compile here,
 * and a tool that uses it stays an extension's tool.
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** The name the model calls it by, and the one agents name in `tools`. */
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  prepareArguments?: (args: unknown) => Static<TParams>;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    context: Context,
  ): Promise<AgentToolResult<TDetails>>;
}

/**
 * A component that provides `tool` as `agent.tool` under its name, so an agent names it in `tools`:
 * the short way to add a tool of your own, in the shape Pi's `defineTool` uses. Its component is
 * `tool-<name>` (`_` becomes `-`: `web_search` is `tool-web-search`).
 *
 * `replay` is required, because pikit resumes runs after a crash (SPEC §8.4): `"safe"` runs it again
 * (it only reads), `"never"` tells the model it was interrupted (it changes something; derive an
 * idempotency key from the run's conversation and `toolCallId`). A Pi extension's tools are always
 * `"never"`.
 *
 * A tool that needs a capability (an environment, a secret) or config is a `defineComponent` of its
 * own that `use`s it and provides `agentTool(tool, { replay })`; this one declares none.
 */
export function toolComponent<TParams extends TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>, options: { replay: "safe" | "never" }): ComponentDefinition {
  const agentToolObject = agentTool(tool, options);
  return defineComponent({
    name: `tool-${tool.name.replaceAll("_", "-")}`,
    setup(pikit) {
      pikit.provideKeyed("agent.tool", tool.name, agentToolObject);
    },
  });
}

/**
 * `tool`, in the shape of Pi's `defineTool`, as the object a component provides as `agent.tool`
 * (under `tool.name`), with its `replay`. `toolComponent` is this plus the component; use it directly
 * in a `defineComponent` of your own when the tool needs config or a capability (a secret):
 *
 * ```ts
 * setup(pikit, config) {
 *   const secrets = pikit.use("secrets");
 *   pikit.provideKeyed("agent.tool", "websearch", agentTool({ name: "websearch", … }, { replay: "safe" }));
 * }
 * ```
 */
export function agentTool<TParams extends TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>, options: { replay: "safe" | "never" }): AgentTool {
  const harnessTool: AgentHarnessTool<undefined, TParams, TDetails> = {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.prepareArguments !== undefined && { prepareArguments: tool.prepareArguments }),
    replay: options.replay,
    execute: (toolCallId, params, onUpdate, _toolContext, _invocation, context) =>
      tool.execute(toolCallId, params, context.abortSignal, (partial) => onUpdate(partial), context),
  };
  return harnessTool as unknown as AgentTool;
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool types vary by parameters and details
export function bindTool(tool: AgentHarnessTool<{ env: ExecutionEnv }, any, any>, options: BindOptions): AgentTool {
  return {
    ...tool,
    replay: options.replay,
    execute: async (toolCallId, params, onUpdate, _toolContext, invocation, context) =>
      tool.execute(toolCallId, params, onUpdate, { env: await options.env(context) }, invocation, context),
  };
}
