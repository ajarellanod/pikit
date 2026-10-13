# Codemode

**Public appeal:** —

**Specified:** idea. Since Pi 1.2.0, pi-durable ships the codemode tool and `tool_search` as its own
extensions (`@earendil-works/pi-durable/codemode`, `/tool-search`): pikit would provide them as
`agent.extension` components, writing no sandbox and no nested-call path of its own.

**Needed by:** nothing required.

## What it gives
A `codemode` tool: the model writes a short JavaScript program that calls the agent's other tools,
and only what the program prints or returns reaches the model. Many tool calls, loops and filtering
cost one model turn and none of the intermediate results. pi-durable pairs it with tools the model
is not offered until it loads them (`deferred`) and `tool_search`, which matter once an agent has
many tools, for example several MCP servers ([mcp](completed/mcp.md)).

## Pi first
Checked against Pi 1.2.0 (pi-durable's README, "Code mode" and "Deferred tools"; its CHANGELOG):
- **`createCodemodeExtension({ sandbox })`** (`@earendil-works/pi-durable/codemode`) adds the
  `codemode` tool and a prompt section listing the tools scripts can call (TypeScript declarations
  within a token budget, `namespaces` by name prefix, such as an MCP server's). Scripts call
  `tools.<name>(args)`, find others with `searchTools()`/`describeTool()`/`describeNamespace()`, get
  `models.*`, and keep `store()`/`load()` values per conversation. The sandbox is pi-codemode's
  QuickJS: `CodemodeSandbox` (Node worker threads) on a server, `RemoteCodemodeSandbox`
  (`@earendil-works/pi-codemode/portable`) on Cloudflare, which runs each script in a Durable Object
  of a separate Worker (`@earendil-works/pi-codemode/cloudflare`), limited by an interrupt budget.
- **Nested calls are pi-durable's** (`api.executeTool`): each script call is its own `pi.tool` task,
  with validation, the `beforeTool`/`afterTool` hooks (`ToolHookCall.parent` names the caller),
  output limits and its replay policy. So an extension like `extension-house-rules` sees a script's
  calls as it sees the model's.
- **Durable.** A script survives a restart: it reruns deterministically from a journal of the results
  it got, reattaching to its nested calls; a divergence, a changed sandbox or a passed deadline ends
  the call with an error.
- **Structured output.** A tool may declare `structuredOutputSchema` and return `structuredOutput`,
  which scripts receive; without one, scripts get its text. `tools.bash` gives
  `{ output, exitCode, ... }`, also for a nonzero exit.
- **Who calls what.** `ToolRegistration.callers` (`model`, `tools` or both) and the agent's
  `modelTools` say which tools the model is offered; `deferred: true` tools wait for `tool_search`
  (`createToolSearchExtension()`, BM25), which loads matches with `control.addTools`.

## How it fits pikit
- **An `extension-codemode` component** providing `agent.extension` `codemode` over
  `createCodemodeExtension`, with the sandbox its target allows: `CodemodeSandbox` on a server;
  on Cloudflare a `RemoteCodemodeSandbox` over a sandbox Worker the deployment adds (a second Worker
  and a Durable Object binding, which `deployment-cloudflare` does not make today). The adapter
  re-exports both subpaths, as it does Pi's other packages.
- **An `extension-tool-search` component**, likewise, once an agent has tools worth deferring: which
  tools are deferred is the agent's choice (`AgentDefinition`), not the tool's component's.
- **Not `execution-do`'s `node`.** execution-do's `node` command is QuickJS too, but a shell command
  over the conversation's workspace (`fs`, `path`, `process`) that calls no tools. It stays.
- **Rule zero.** The sandbox, the declarations, the journal and the nested-call path are Pi's; pikit
  writes the components and their wiring only.

## Open questions
- **The sandbox Worker on Cloudflare.** Who deploys it (the component's `deploy` contribution, a
  separate `pikit up` target) and how its Durable Object is named (per conversation or per call).
- **Agent configuration.** How an agent definition names `modelTools`, `deferred` and
  `namespaces` without leaking pi-durable's shapes into `@pikit/contracts`.
- **Cost.** Each nested call is a durable task with its own commits: measure a script of many calls
  on storage-do before recommending it on Cloudflare.
