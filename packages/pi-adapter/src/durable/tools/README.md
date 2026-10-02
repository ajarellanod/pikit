# Tools, MCP and execution on pi-durable

Built alongside the Pi 0.99 versions (`src/tools`, `src/mcp`, `src/execution`, `src/node`), which
stay what the components use until the runtime moves to pi-durable.

| Export | File | What |
|---|---|---|
| `./durable/tools` | `tools/index.ts` | pi-durable's `read`/`write`/`edit`/`bash` (`codingTool(name)` adds pikit's replay), `createFetchTool`, `createBraveSearchTool` |
| `./durable/mcp` | `mcp.ts` | pi-mcp's client, `mcpHttpTransport`, `mcpToolName`, `mcpTool` (provided at setup, described at start) |
| `./durable/execution` | `execution.ts` | pi-durable's `ExecutionEnv` types and helpers; `harnessEnv` (`HarnessOptions.env`); `atCwd` |
| `./durable/node` | `node.ts` | `createLocalExecution` on pi-durable's `NodeExecutionEnv` (server only) |
| `./durable/execution/testing` | `execution-testing.ts` | the `ExecutionEnv` conformance on pi-durable; `callTool`; `runToolCalls` (a Harness with the faux model) |

execution-do's environment on pi-durable: `registry/components/execution-do/files/src/pikit/execution-do/durable-env.ts`.

## Replay

A tool's replay is one value for all its calls, recorded with the call's intent before `execute`.

| tool | replay | why |
|---|---|---|
| `read`, `websearch` | `safe` | they only read |
| `write`, `edit`, `bash` | `unsafe` | they change things; edit twice is not edit once |
| `fetch` | `unsafe` | POST/PUT/PATCH/DELETE may have had their effect; replay cannot depend on the method |
| MCP tools | `safe` only with `annotations.readOnlyHint` | as today |

The words change: pikit's `"never"` is pi-durable's `"unsafe"`.

## The switch-over

- `tool-read`/`tool-write`/`tool-edit`/`tool-bash`: provide `codingTool("read")` (…) as `agent.tool`
  under its name; drop `bindTool` and the per-call `workspace`/`execution` lookup (the Harness's `env`
  does it). Keep `use("execution")` / `use("execution.shell")` and `useOptional("workspace")` as
  install-time requirements. `component.json` `replay`: `"never"` → `"unsafe"` (schema too).
- `tool-fetch`: `export default` a component providing `createFetchTool()`; keep `createFetchTool`'s
  re-export for its tests. `tool-websearch-brave`: provide `createBraveSearchTool({ apiKey: () =>
  secrets.get().get(BRAVE_KEY_SECRET), apiBase: config.apiBase })`.
- `tool-mcp`: `mcpAgentTool` → `mcpTool`, `describeTool` passes `"unsafe"` for `"never"`; imports from
  `@pikit/pi-adapter/durable/mcp`. Its calls take `context.abortSignal`.
- `execution-local`, `workspace-local`: `createLocalExecution` from `@pikit/pi-adapter/durable/node`.
- `execution-do`: `index.ts` provides `createDurableExecutionEnv(files, shell, config.root, { id })`,
  `id` returning `execution-do:<object id>` (the id from `WORKERS_HOST` at start); `env.ts` is deleted.
- `types.ts`: the `execution`, `execution.shell` and `Workspace.env` capabilities become pi-durable's
  `ExecutionEnv`; `AgentPayloads.tool` becomes `ToolRegistration`.
- The runtime: `HarnessOptions.env = harnessEnv({ execution: () => execution.get(), workspace })`, its
  `workspace` mapping pi-durable's `conversationId` to the pikit conversation for `workspace.resolve`.
- Then delete `src/tools`, `src/mcp`, `src/execution`, `src/node/local.ts`, the 0.99 `createExecutionConformance`,
  and move these files out of `durable/` (or re-export them from the old paths).
