# Codemode

**Public appeal:** —

**Specified:** idea. The extension host (SPEC §6.2b, `packages/pi-adapter/src/extensions`) loads
the Pi 0.99 fields codemode relies on and leaves them inert; the list is below.

**Needed by:** nothing required.

## What it gives
A `codemode` tool: the model writes a short JavaScript program that calls the agent's other tools,
and only what the program prints or returns reaches the model. Many tool calls, loops and filtering
cost one model turn and none of the intermediate results. With it come the tools that are reachable
only from scripts or by search (`exposure: "codemode"`, `"deferred"`) and `tool_search`, which
matter once an agent has many tools, for example several MCP servers ([mcp](mcp.md)).

## Pi first
Checked against Pi 0.99.0:
- **`@earendil-works/pi-codemode`**, standalone (one dependency, `quickjs-wasi` 3.6.2; no other Pi
  package). `CodemodeSandbox` runs each script in QuickJS compiled to WebAssembly, in a new
  `node:worker_threads` worker per `execute()`, with only injected tools (`tools.<name>(args)`),
  `ALL_TOOLS`, `text`/`image`/`exit`, `console.*`, and `store`/`load` (values the caller persists).
  No timers, `fetch`, `process`, modules. `loadQuickJSWasm()` reads `quickjs.wasm` and compiles it
  at run time (`WebAssembly.compile`); a bundled host passes the compiled module and its own worker
  file. `renderDeclarations()` turns the tools' JSON Schemas into TypeScript declarations for the
  tool's description; `./source` has the `// @options:` line parser and a Lark grammar for providers
  with grammar-constrained input.
- **A built-in `codemode` extension** in `pi-coding-agent` (`src/extensions/codemode/`,
  `createCodemodeExtension()`), registered inactive. Its tool is `exposure: "model-only"` (scripts do
  not start scripts), lists the callable tools in its description through `prepareLoadout`, asks for
  `constrainedSampling` (the grammar), and runs nested calls through `ctx.executeTool()`: Pi's own
  tool pipeline, so validation, `tool_call`/`tool_result` hooks and permission checks apply as for a
  direct call. A tool with `outputSchema` resolves to its `structuredContent` in the script. Store
  writes are appended to the session as `codemode-store` custom entries.
- **A built-in `tool_search` extension** (`src/extensions/tool-search/`): BM25 over the tools'
  metadata; it activates the `codemode` and `deferred` tools it finds for the next model call.
- Pi's `mcp` extension activates `codemode` when MCP tools are reachable only from scripts.

None of it reaches a pikit agent today: the shim does not export `createCodemodeExtension` or
`createToolSearchExtension`, and the fields they rely on are inert (below).

## How it fits pikit
- **A `tool-codemode` component, server only**, providing `agent.tool` `codemode` over
  `CodemodeSandbox`. An agent that names it gets a script tool over its other tools. Server only
  because the sandbox needs `node:worker_threads` (and, unbundled, compiles its wasm at run time),
  which a Cloudflare Worker has neither of.
- **Not `execution-do`'s `node`.** execution-do's `node` command is QuickJS too, but a different
  thing: a shell command over the conversation's workspace (`fs`, `path`, `process`), bundled as a
  compiled module because a Worker cannot compile WebAssembly, and stopped by an interrupt budget.
  It calls no tools. pi-codemode cannot replace it, and it is not a codemode.
- **Nested calls go through the harness.** The component's script calls must meet the same
  `before_tool`/`after_tool` hooks (extensions' `tool_call`, policies) and `replay` as the model's
  calls; the host's `ctx.executeTool()` would then run through the same path.
- **Rule zero.** The sandbox, the declarations, the description and the search are Pi's; pikit
  writes the component and the nested-call path only.

## What pikit leaves pending until then
Each is loaded without an error, so a Pi 0.99 extension that sets it runs:
- **`constrainedSampling`** on a tool: not in pikit's `ToolDefinition`, ignored at run time; the
  drift check leaves it out on purpose (`scripts/pi-extension-surface.test.ts`).
- **`exposure: "codemode"` and `"deferred"`**: such a tool is inactive, and reaches the model only if
  an extension activates it (`setActiveTools`); pikit warns once. **`tool_search`** does not exist.
  **`prepareLoadout`** is ignored with a warning.
- **`ctx.executeTool()`** in a tool: resolves to an `isError` outcome saying pikit runs no nested
  calls (it never rejects, as in Pi), and `ctx.tools` is empty.
- **`outputSchema` / `structuredContent`**: the schema reaches the harness tool, but pi-agent-core's
  harness (0.99.0) drops a result's `structuredContent` (only its `agent-loop` keeps it).
- **Tools registered after load**: a `pi.registerTool()` after the factories ran (from
  `session_start`, once a backend is connected) is ignored with a warning, once per name; the harness
  has the tools registered while the extensions load. `pikit doctor` says so for every extension
  that registers tools.

## Open questions
- **The nested-call path.** pi-agent-core exports `runToolCall` (the `agent-loop` pipeline), but the
  harness pikit drives exposes no way to run one call through its own hooks from inside a tool. Ask
  Pi for it, or wait for `pi-durable` ([pi-durable-migration](pi-durable-migration.md)).
- **Late tools.** Supporting them means changing a conversation's harness tools after it opened
  (`harness.setTools`) without breaking the provider's prompt cache or the agent's tool set.
- **Where scripts persist.** `store`/`load` values as `codemode-store` session entries, as Pi does,
  or in `storage.kv`.
- **On Cloudflare**, a codemode would need an in-process QuickJS over a bundled module, as
  execution-do's `node` does, which pi-codemode 0.99 does not offer.
