# Tools, MCP and execution on pi-durable

| Export | File | What |
|---|---|---|
| `./tools` | `tools/index.ts` | `defineTool` and its types, for a component's own tool; pi-durable's `read`/`write`/`edit`/`bash` factories, as Pi ships them (no replay) |
| `./mcp` | `mcp.ts` | pi-mcp's client, `mcpHttpTransport`, `mcpToolName`, `mcpTool` (provided at setup, described at start) |
| `./execution` | `execution.ts` | pi-durable's `ExecutionEnv` types and helpers; `harnessEnv` (`HarnessOptions.env`); `atCwd` |
| `./node` | `node.ts` | `createLocalExecution` on pi-durable's `NodeExecutionEnv` (server only) |
| `./execution/testing` | `testing/execution.ts` | the `ExecutionEnv` conformance on pi-durable; `callTool`; `runToolCalls` (a Harness with the faux model) |

execution-do's environment on pi-durable: `registry/components/execution-do/files/src/pikit/execution-do/env.ts`.

The tools pikit writes itself are source in their components, not here: `tool-fetch` (`fetch.ts`, the
reference for a tool) and `tool-websearch-brave` (`websearch.ts`, the reference for a tool with a
secret). Only Pi's own coding tools are re-exported here; `tool-read`, `tool-write`, `tool-edit` and
`tool-bash` provide them, each with the replay it decides in its own `index.ts`.

A tool is pi-durable's own `ToolRegistration` (`defineTool`): it carries its `replay`, learns its
conversation from `api.conversationId`, and works on `api.env`, the environment the runtime builds for
the call (`harnessEnv`: the conversation's `workspace` when one is installed, otherwise `execution`).
So a component never binds an environment to a tool: it provides the tool, by name, as it is, and
`use`s what it needs installed (`tool-bash`: `execution.shell`).

## Replay

A tool's replay is one value for all its calls, recorded with the call's intent before `execute`.
`safe`: an interrupted call runs again on recovery. `unsafe` (pi-durable's default, and what its own
coding tools declare by omission): the model gets an `interrupted` error result with the output so
far, and decides.

The kit decides none. Each component writes its tools' replay in its source (`tool-read`: `safe`;
`tool-write`, `tool-edit`, `tool-bash`, `tool-fetch`: `unsafe`; `tool-mcp`: `safe` only with the
server's `annotations.readOnlyHint`), and `pikit registry generate` records it in the component's
manifest (`replay.tools`), where `registry validate` checks every tool states one.

## MCP

`mcpTool({ name, label, call })` is provided at setup and described at start (`describe(remote,
replay)`): pi-durable reads a tool's `description`, `parameters` and `replay` from the registered object
at each use. A result with `isError` is an error result with the server's content. pi-mcp 1.0 calls
`fetch` without a receiver, so its own transport works in workerd; `mcpHttpTransport` only makes sure it never opens the server-to-client GET stream.
