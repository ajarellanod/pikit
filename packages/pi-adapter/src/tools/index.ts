/**
 * @pikit/pi-adapter/tools: Pi's own `read`, `write`, `edit` and `bash` tools (SPEC §6.3), for the
 * `tool-*` components. pikit does not reimplement them; a component adds only what the kit owns:
 * - the environment the tool works on, from the capability it declares (`execution`, or
 *   `execution.shell` for `bash`);
 * - its `replay`, which Pi applies when a run is resumed after a crash (SPEC §8.4). Pi's tools
 *   declare none, so they would default to `"never"`.
 *
 * Pi's tools read their environment from the harness's `toolContext.env`. A bound tool ignores the
 * harness's context and uses its own environment instead, so the runtime passes none, and each
 * tool works on exactly the capability its component declared.
 */

import type { AgentHarnessTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@pikit/core";

export { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";

export interface BindOptions {
  /** The environment, read when the tool runs (from `start` on): `() => execution.get()`. */
  env: () => ExecutionEnv;
  /** `"safe"`: run again when a run is resumed after a crash. `"never"`: report it interrupted instead. */
  replay: "safe" | "never";
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool types vary by parameters and details
export function bindTool(tool: AgentHarnessTool<{ env: ExecutionEnv }, any, any>, options: BindOptions): AgentTool {
  return {
    ...tool,
    replay: options.replay,
    execute: (toolCallId, params, onUpdate, _toolContext, invocation, context) =>
      tool.execute(toolCallId, params, onUpdate, { env: options.env() }, invocation, context),
  };
}
