# Codemode

**Public appeal:** —

**Specified:** idea. Pi's codemode is a pi-coding-agent extension on pi-agent-core; pi-durable, which
pikit runs, has none, so pikit would write it as a `tool-*` component over `@earendil-works/pi-codemode`.

**Needed by:** nothing required.

## What it gives
A `codemode` tool: the model writes a short JavaScript program that calls the agent's other tools,
and only what the program prints or returns reaches the model. Many tool calls, loops and filtering
cost one model turn and none of the intermediate results. Pi's coding agent pairs it with tools
reachable only from scripts or by search (`exposure: "codemode"`, `"deferred"`) and `tool_search`,
which matter once an agent has many tools, for example several MCP servers ([mcp](completed/mcp.md)).

## Pi first
Checked against Pi 1.0.3:
- **`@earendil-works/pi-codemode`**, standalone (one dependency, `quickjs-wasi` 3.6.2; no other Pi
  package). `CodemodeSandbox` runs each script in QuickJS compiled to WebAssembly, in a new
  `node:worker_threads` worker per `execute()`, with only injected tools (`tools.<name>(args)`),
  `ALL_TOOLS`, `globals`, `text`/`image`/`exit`, `console.*`, and `store`/`load` (values the caller
  passes in and persists from `result.storeWrites`). No timers, `fetch`, `process`, modules.
  `loadQuickJSWasm()` reads `quickjs.wasm` and compiles it at run time (`WebAssembly.compile`); a
  bundled host passes the compiled module and its own worker file (`@earendil-works/pi-codemode/worker`).
  `renderDeclarations()` turns the tools' JSON Schemas into TypeScript declarations for the tool's
  description; `./source` has the `// @options:` line parser and a Lark grammar for providers with
  grammar-constrained input. `result.calls` lists every nested call with its status.
- **pi-coding-agent's `codemode` and `tool_search` extensions** (`src/extensions/codemode/`,
  `src/extensions/tool-search/`) are pi-agent-core extensions: codemode runs nested calls through
  the agent loop's tool pipeline (`ctx.executeTool()`: its hooks and permission checks). Neither
  is a pi-durable extension, and pi-coding-agent's own pi-durable mode
  (`src/experimental/durable/`) runs no extensions yet. Nothing of it reaches a pikit agent.
- **pi-durable 1.0.3 has no codemode, no `exposure` and no `tool_search`.** What a tool written for
  it has (`ToolExecutionApi`): `api.agent(ctx)`, the calling conversation's resolved agent with its
  tools; `api.env`; `api.memo(name, …)`, values kept with the call across recovery; `api.commit` and
  documents; `api.createTask`/`waitForTask` for child tasks. A tool result has `content`, `details`,
  `diagnostics`, `usage` and `control`: no `structuredContent`.

## How it fits pikit
- **A `tool-codemode` component, server only**, providing `agent.tool` `codemode` over
  `CodemodeSandbox`, written with `defineTool` from `@pikit/pi-adapter/tools` (the adapter would
  re-export pi-codemode, as it does Pi's other packages). An agent that names it gets a script tool
  over the tools `api.agent(ctx)` resolves for it, minus `codemode` itself. Server only because the
  sandbox needs `node:worker_threads` (and, unbundled, compiles its wasm at run time), which a
  Cloudflare Worker has neither of.
- **Its replay is `unsafe`**, decided in its source: a script may call tools with effects. Nested
  calls are not durable tasks of their own, so a crash mid-script gives the model an `interrupted`
  result; `api.memo` could keep finished nested results so a rerun skips them, once replay is shown
  to matter.
- **Not `execution-do`'s `node`.** execution-do's `node` command is QuickJS too, but a different
  thing: a shell command over the conversation's workspace (`fs`, `path`, `process`), bundled as a
  compiled module because a Worker cannot compile WebAssembly, and stopped by an interrupt budget.
  It calls no tools. pi-codemode cannot replace it, and it is not a codemode.
- **Nested calls must meet the agent's policies.** The script's calls must meet the same
  `beforeTool`/`afterTool` hooks (the agent's `agent.extension`s) as the model's calls, or an
  extension like `extension-house-rules` is bypassed by wrapping a denied tool in a script.
- **Rule zero.** The sandbox, the declarations and the source format are Pi's; pikit writes the
  component and the nested-call path only.

## Open questions
- **The nested-call path.** pi-durable's `ToolTask` resolves a call, validates it, runs
  `beforeTool`, records its intent, executes, runs `afterTool` and appends the result to the
  transcript, all in one built-in task started by a generation; nothing public runs one call through
  those hooks from inside a tool without a transcript entry. Calling a resolved tool's `execute`
  directly skips the hooks. Ask Pi for a nested-call entry point (as pi-agent-core's `runToolCall`),
  or have the component run the selected extensions' `beforeTool`/`afterTool` hooks itself: the
  agent `api.agent(ctx)` resolves carries its `extensions`, with their hooks, but repeating
  `ToolTask`'s order and rules in pikit is what rule zero avoids.
- **Late tools** (`deferred`, `tool_search`). pi-durable fixes a request's offered tools when it is
  prepared, and a `configure({ tools })` applies from the next request: activating a found tool is a
  configure from the tool, at the cost of a positional system entry (prompt cache) per change.
- **Where scripts persist.** `store`/`load` values in a pi-durable document of the component's
  (committed with the call through `api.commit`), or in `storage.kv`.
- **`outputSchema` / `structuredContent`**: pi-durable results have no `structuredContent`, so a
  nested result reaches the script as text (or `details`).
- **On Cloudflare**, a codemode would need an in-process QuickJS over a bundled module, as
  execution-do's `node` does, which pi-codemode 1.0.3 does not offer.
