/**
 * @pikit/pi-adapter/tools: what a `tool-*` component writes its tool with, without importing Pi. A tool
 * is pi-durable's own `ToolRegistration` (`defineTool`): it carries its `replay`, learns its
 * conversation from `api.conversationId`, and works on `api.env`, the environment the Harness builds
 * for the call (`HarnessOptions.env`, see `harnessEnv` in `./execution`). So a component never binds
 * an environment to a tool: it provides the tool, by name, as it is.
 *
 * The tools pikit writes itself are in their components, as source the user owns: `tool-fetch`'s
 * `fetch.ts`, `tool-websearch-brave`'s `websearch.ts` (the references for a new tool). What stays
 * here is Pi's own, re-exported: its coding tools (`createReadTool`…), which `tool-read`, `tool-write`,
 * `tool-edit` and `tool-bash` provide, each with the replay it decides in its own source.
 *
 * Neutral.
 *
 * **Replay**: pi-durable runs an interrupted call again on recovery only when its tool is `"safe"`; a
 * property of the tool, fixed for every call, recorded with the call's intent. pi-durable's own tools
 * declare none (so `"unsafe"`: the model gets an `interrupted` error result with the output so far).
 * The kit decides no replay: each component writes its tools' in its source, and its manifest's
 * generated `replay.tools` lists them.
 */

export { defineExtension, defineTool, wrapTool } from "@earendil-works/pi-durable";
export type { Extension, ToolDiagnostic, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
export {
  type BashExecution,
  type BashPrepare,
  type BashToolInput,
  type BashToolOptions,
  CodingTools,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditToolDetails,
  type EditToolInput,
  type ReadToolDetails,
  type ReadToolInput,
  type WriteToolInput,
} from "@earendil-works/pi-durable/tools";
