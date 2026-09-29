/**
 * @pikit/pi-adapter/mcp: Pi's MCP client (`@earendil-works/pi-mcp`), for the `tool-mcp` components.
 * pikit does not write an MCP client (P1); this subpath adds only what the kit needs around Pi's:
 *
 * - **Neutral.** It re-exports the client core and the Streamable HTTP transport, never
 *   `StdioTransport` (a process: `node:child_process`) nor the OAuth callback server (`node:http`).
 *   pi-mcp is `sideEffects: false`, so a bundle keeps only what is imported: on Cloudflare the
 *   Node-only transports are tree-shaken away (`mcp.test.ts` bundles this file to prove it).
 * - **`mcpHttpTransport`**: Pi's transport with the two settings every pikit target needs. Its own
 *   `fetch` is called through a wrapper, since pi-mcp 0.99 calls `globalThis.fetch` as a method of
 *   the transport, which Cloudflare Workers reject ("Illegal invocation"). And no server-to-client
 *   GET stream: a Durable Object does not stay alive for an outbound stream (SPEC §4.1, C4), and
 *   each one holds one of its six outbound connections.
 * - **`mcpAgentTool`**: one remote tool as the object a component provides as `agent.tool`, named at
 *   `setup` and described at `start` from the server's `tools/list`. An MCP result with `isError`
 *   throws: Pi's harness takes a tool's failure only from a throw (an `isError` it returns is
 *   recorded as a success).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  type CallToolResult,
  type McpFetch,
  type StreamableHttpTransportOptions,
  StreamableHttpTransport,
  type Tool,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type { AgentTool } from "@pikit/contracts";
import { agentTool } from "../tools/index.ts";

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
 * `options.fetch`) is called as a plain function, and the server-to-client GET stream stays closed
 * (requests' own responses still stream).
 */
export function mcpHttpTransport(options: McpHttpTransportOptions): StreamableHttpTransport {
  const own = options.fetch;
  // Never `this.fetch(...)` on the platform's function: Workers throw "Illegal invocation".
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

/** A remote tool's `inputSchema` as the parameters Pi sends: always an object with `properties`. */
export function mcpParameters(inputSchema: Record<string, unknown>): TSchema {
  const properties = (inputSchema.properties as Record<string, unknown> | undefined) ?? {};
  return Type.Unsafe({ ...inputSchema, type: "object", properties });
}

/**
 * A tool call's MCP result as the result Pi records: text and images (`toLlmContent`). A result that
 * reports a failure (`isError`) throws an Error with its text, so Pi records the call as failed.
 */
export function mcpToolResult(result: CallToolResult, toolName: string): AgentToolResult<undefined> {
  const content = toLlmContent(result);
  if (result.isError === true) {
    const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    throw new Error(text === "" ? `${toolName}: the MCP server reported a failure without a message` : text);
  }
  return { content, details: undefined };
}

export interface McpAgentToolOptions {
  /** The name the model calls it by and agents name it by (`mcpToolName`). */
  name: string;
  /** Shown until `describe`: the model never sees it once the component has started. */
  label: string;
  /** Calls the remote tool, with the call's cancellation. */
  call(params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult>;
}

export interface McpAgentTool {
  /** Provide it as `agent.tool` under `options.name`, at setup. */
  readonly tool: AgentTool;
  /**
   * Fills what only the server knows, from its `tools/list`: title, description and parameters; and
   * the `replay` the component chose. Call it in `start`: Pi reads these fields from this same object
   * when a conversation opens and at each model call, and `replay` when a run is resumed.
   */
  describe(remote: Tool, replay: "safe" | "never"): void;
}

/** One remote MCP tool as an `agent.tool`, provided at setup and described at start. */
export function mcpAgentTool(options: McpAgentToolOptions): McpAgentTool {
  const tool = agentTool<TSchema>(
    {
      name: options.name,
      label: options.label,
      description: `${options.label} (an MCP tool, described when its component starts)`,
      parameters: Type.Object({}),
      execute: async (_toolCallId, params, signal) =>
        mcpToolResult(await options.call((params ?? {}) as Record<string, unknown>, signal), options.name),
    },
    { replay: "never" },
  );
  return {
    tool,
    describe(remote, replay) {
      tool.label = remote.title ?? remote.annotations?.title ?? remote.name;
      tool.description = remote.description ?? tool.label;
      tool.parameters = mcpParameters(remote.inputSchema);
      tool.replay = replay;
    },
  };
}
