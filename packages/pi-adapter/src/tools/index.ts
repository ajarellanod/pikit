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
 */

import type { AgentHarnessTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { AgentTool, Context } from "@pikit/core";

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

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool types vary by parameters and details
export function bindTool(tool: AgentHarnessTool<{ env: ExecutionEnv }, any, any>, options: BindOptions): AgentTool {
  return {
    ...tool,
    replay: options.replay,
    execute: async (toolCallId, params, onUpdate, _toolContext, invocation, context) =>
      tool.execute(toolCallId, params, onUpdate, { env: await options.env(context) }, invocation, context),
  };
}
