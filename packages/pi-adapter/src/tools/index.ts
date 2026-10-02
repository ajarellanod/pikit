/**
 * @pikit/pi-adapter/tools: pikit's tools on pi-durable, for the `tool-*` components. A tool is pi-durable's own `ToolRegistration` (`defineTool`): it carries its `replay`,
 * learns its conversation from `api.conversationId`, and works on `api.env`, the environment the
 * Harness builds for the call (`HarnessOptions.env`, see `harnessEnv` in `./execution`). So a
 * component no longer binds an environment to a tool: it provides the tool, by name, as it is.
 *
 * Neutral: every tool here uses only its environment, `fetch`, streams and `HTMLRewriter`.
 *
 * **Replay** (pi-durable runs an interrupted call again on recovery only when it is `"safe"`; it is
 * a property of the tool, fixed for every call, recorded with the call's intent):
 *
 * | tool        | replay   | why |
 * |-------------|----------|-----|
 * | `read`      | `safe`   | it only reads |
 * | `write`     | `unsafe` | it changes files: rerunning it could undo a change made since |
 * | `edit`      | `unsafe` | applying an edit twice is not applying it once |
 * | `bash`      | `unsafe` | a command can do anything |
 * | `fetch`     | `unsafe` | POST, PUT, PATCH and DELETE may have had their effect; replay cannot depend on the method |
 * | `websearch` | `safe`   | a search only reads |
 * | MCP tools   | `safe` only when the server marks the tool read-only (`./mcp`) |
 *
 * pi-durable's own tools declare no replay (so `unsafe`); `codingTool` sets pikit's. An `unsafe`
 * tool's interrupted call gives the model an `interrupted` error result with the output so far.
 */

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

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
export { createFetchTool, FETCH_MAX_BYTES, FETCH_MAX_OUTPUT, FETCH_METHODS, FETCH_TIMEOUT_MS, type FetchToolOptions } from "./fetch.ts";
export { BRAVE_KEY_SECRET, BRAVE_SEARCH_PATH, BRAVE_TIMEOUT_MS, type BraveSearchToolOptions, createBraveSearchTool } from "./websearch-brave.ts";

/** The names of pi-durable's coding tools, as agents name them in `tools`. */
export type CodingToolName = "read" | "write" | "edit" | "bash";

/** The replay pikit declares for each coding tool (see the table above). */
export const CODING_TOOL_REPLAY: Readonly<Record<CodingToolName, "safe" | "unsafe">> = { read: "safe", write: "unsafe", edit: "unsafe", bash: "unsafe" };

const CREATE: Readonly<Record<CodingToolName, () => ToolRegistration>> = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
};

/**
 * pi-durable's own coding tool `name`, unmodified but for its `replay` (`CODING_TOOL_REPLAY`): what the
 * `tool-read`, `tool-write`, `tool-edit` and `tool-bash` components provide as `agent.tool` under
 * `name`. A new object each call.
 */
export function codingTool(name: CodingToolName): ToolRegistration {
  const create = CREATE[name];
  if (create === undefined) throw new Error(`codingTool: no coding tool named ${JSON.stringify(name)} (read, write, edit, bash)`);
  return { ...create(), replay: CODING_TOOL_REPLAY[name] };
}
