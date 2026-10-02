# Tools, MCP and execution on pi-durable

| Export | File | What |
|---|---|---|
| `./tools` | `tools/index.ts` | pi-durable's `read`/`write`/`edit`/`bash` (`codingTool(name)` adds pikit's replay), `createFetchTool`, `createBraveSearchTool`, `defineTool` |
| `./mcp` | `mcp.ts` | pi-mcp's client, `mcpHttpTransport`, `mcpToolName`, `mcpTool` (provided at setup, described at start) |
| `./execution` | `execution.ts` | pi-durable's `ExecutionEnv` types and helpers; `harnessEnv` (`HarnessOptions.env`); `atCwd` |
| `./node` | `node.ts` | `createLocalExecution` on pi-durable's `NodeExecutionEnv` (server only) |
| `./execution/testing` | `testing/execution.ts` | the `ExecutionEnv` conformance on pi-durable; `callTool`; `runToolCalls` (a Harness with the faux model) |

execution-do's environment on pi-durable: `registry/components/execution-do/files/src/pikit/execution-do/env.ts`.

A tool is pi-durable's own `ToolRegistration` (`defineTool`): it carries its `replay`, learns its
conversation from `api.conversationId`, and works on `api.env`, the environment the runtime builds for
the call (`harnessEnv`: the conversation's `workspace` when one is installed, otherwise `execution`).
So a component never binds an environment to a tool: it provides the tool, by name, as it is, and
`use`s what it needs installed (`tool-bash`: `execution.shell`).

## Replay

A tool's replay is one value for all its calls, recorded with the call's intent before `execute`.

| tool | replay | why |
|---|---|---|
| `read`, `websearch` | `safe` | they only read |
| `write`, `edit`, `bash` | `unsafe` | they change things; edit twice is not edit once |
| `fetch` | `unsafe` | POST/PUT/PATCH/DELETE may have had their effect; replay cannot depend on the method |
| MCP tools | `safe` only with `annotations.readOnlyHint` | the server says the tool only reads |

`safe`: an interrupted call runs again on recovery. `unsafe` (pi-durable's default): the model gets an
`interrupted` error result with the output so far, and decides. pikit's former word for it was
`"never"`; `component.json`'s `replay.tools` now says `"unsafe"`.

## MCP

`mcpTool({ name, label, call })` is provided at setup and described at start (`describe(remote,
replay)`): pi-durable reads a tool's `description`, `parameters` and `replay` from the registered object
at each use. A result with `isError` is an error result with the server's content. pi-mcp 1.0 calls
`fetch` without a receiver, so its own transport works in workerd; `mcpHttpTransport` only makes sure it never opens the server-to-client GET stream.
