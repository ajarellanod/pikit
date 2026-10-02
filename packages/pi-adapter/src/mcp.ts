/**
 * @pikit/pi-adapter/mcp: remote MCP tools as pi-durable tools, for `tool-mcp`. The client is Pi's
 * (`@earendil-works/pi-mcp`), with the two settings every pikit target needs (`mcpHttpTransport`) and
 * pikit's naming (`mcpToolName`: `<server>_<tool>`).
 *
 * pi-mcp 1.0.0 exists; from 0.99.0 it changes only OAuth (new options, fixes), list pagination
 * ending on `""`/`null`, and calls `fetch` without a receiver (pikit's wrapper already does). No API
 * this file uses changed.
 *
 * What changes with pi-durable:
 * - **A result with `isError`** is returned as an error result (`isError: true`) with the server's
 *   content, which pi-durable records as a failure. Pi 0.99's harness took a failure only from a throw.
 * - **`replay`** takes pi-durable's words: `"safe"` (the server marks the tool read-only) or `"unsafe"`.
 * - **No label**: pi-ai 1.0's `Tool` has none.
 *
 * `mcpTool` is provided at setup and described at start, as today: pi-durable reads a tool's
 * `description`, `parameters` and `replay` from the registered object at each use, so `describe`
 * changes the same object the registry holds (or a later one: it reads through a getter).
 */

import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { type CallToolResult, type McpFetch, StreamableHttpTransport, type StreamableHttpTransportOptions, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import { type TSchema, Type } from "@earendil-works/pi-ai";

export {
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
export type {
  AuthProvider,
  CallToolResult,
  ContentBlock,
  LlmContent,
  McpClientOptions,
  McpFetch,
  McpRequestOptions,
  StreamableHttpTransportOptions,
  Tool,
  ToolAnnotations,
} from "@earendil-works/pi-mcp";

/** What `mcpHttpTransport` takes: Pi's options, but the GET stream is never opened. */
export type McpHttpTransportOptions = Omit<StreamableHttpTransportOptions, "openGetStream">;

/**
 * Pi's Streamable HTTP transport to `options.url`, ready for every target: `fetch` (the global one, or
 * `options.fetch`) is called as a plain function (Workers reject the platform's `fetch` called as a
 * method), and the server-to-client GET stream stays closed (a Durable Object does not stay alive for
 * an outbound stream; requests' own responses still stream).
 */
export function mcpHttpTransport(options: McpHttpTransportOptions): StreamableHttpTransport {
  const own = options.fetch;
  const call: McpFetch = own === undefined ? (input, init) => fetch(input, init) : (input, init) => own(input, init);
  return new StreamableHttpTransport({ ...options, fetch: call, openGetStream: false });
}

/**
 * The name a model calls `tool` of the MCP server `server` by: `<server>_<tool>`, every character
 * outside `[A-Za-z0-9_-]` turned into `_`, at most 64 characters (what model providers accept).
 */
export function mcpToolName(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** A remote tool's `inputSchema` as the parameters pi-durable validates and sends: always an object with `properties`. */
export function mcpParameters(inputSchema: Record<string, unknown>): TSchema {
  const properties = (inputSchema.properties as Record<string, unknown> | undefined) ?? {};
  return Type.Unsafe({ ...inputSchema, type: "object", properties });
}

/**
 * A tool call's MCP result as pi-durable's: text and images (`toLlmContent`). A result that reports a
 * failure (`isError`) is an error result; with no text of its own it says so.
 */
export function mcpToolResult(result: CallToolResult, toolName: string): ToolExecutionResult {
  const content = toLlmContent(result);
  if (result.isError !== true) return { content };
  const hasText = content.some((part) => part.type === "text" && part.text.trim() !== "");
  return {
    content: hasText ? content : [{ type: "text", text: `${toolName}: the MCP server reported a failure without a message` }, ...content],
    isError: true,
  };
}

export interface McpToolOptions {
  /** The name the model calls it by and agents name it by (`mcpToolName`). */
  name: string;
  /** The description until `describe`: the model never sees it once the component has started. */
  label: string;
  /** Calls the remote tool, with the call's cancellation. */
  call(args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult>;
}

export interface McpTool {
  /** Provide it as `agent.tool` under `options.name`, at setup. */
  readonly tool: ToolRegistration;
  /**
   * Fills what only the server knows, from its `tools/list`: description and parameters; and the
   * `replay` the component chose. Call it in `start`, and again when a new connection lists the tools.
   */
  describe(remote: Pick<Tool, "name" | "title" | "description" | "inputSchema" | "annotations">, replay: "safe" | "unsafe"): void;
}

/** One remote MCP tool as a pi-durable tool, provided at setup and described at start. */
export function mcpTool(options: McpToolOptions): McpTool {
  let description = `${options.label} (an MCP tool, described when its component starts)`;
  let parameters: TSchema = Type.Object({});
  let replay: "safe" | "unsafe" = "unsafe";
  const tool: ToolRegistration = {
    name: options.name,
    get description() {
      return description;
    },
    get parameters() {
      return parameters;
    },
    get replay() {
      return replay;
    },
    async execute(args: unknown, _api: unknown, context: Context) {
      return mcpToolResult(await options.call((args ?? {}) as Record<string, unknown>, context.abortSignal), options.name);
    },
  };
  return {
    tool,
    describe(remote, chosen) {
      description = remote.description ?? remote.title ?? remote.annotations?.title ?? remote.name;
      parameters = mcpParameters(remote.inputSchema);
      replay = chosen;
    },
  };
}
