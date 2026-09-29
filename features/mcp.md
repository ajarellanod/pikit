# MCP

**Public appeal:** ⭐ Connect the agent to any MCP server (GitHub, Linear, a database) without writing
a tool. Hermes supports MCP, and users look for it in any agent's tool list.

**Specified:** partly (phase 1 built: `tool-mcp` and `@pikit/pi-adapter/mcp`, Streamable HTTP with a
bearer token from `secrets`, on both targets; OAuth and stdio are the open questions below)

**Needed by:** nothing required.

## What it gives
The tools of remote MCP servers, available to the agents that name them.

## Pi first
Pi now ships an MCP client: `@earendil-works/pi-mcp` (0.99), standalone (no other Pi package, no
official SDK; one dependency, `cross-spawn`, for stdio), `sideEffects: false`. Exports: `.` (the
client core, Streamable HTTP and stdio transports, `toLlmContent`), `./oauth` (discovery, PKCE flow,
dynamic registration, refresh, a provider with an injectable state store, and a Node callback
server), `./testing` (an in-memory transport pair). pikit uses it and writes no MCP client (P1). Only
`transports/stdio.ts` (`node:child_process`) and `oauth/callback.ts` (`node:http`) need Node; the rest
uses `fetch`.

## How it fits pikit (built)
- **`@pikit/pi-adapter/mcp`**, a neutral export: pi-mcp's client, its HTTP transport, `toLlmContent`
  and their types, never `StdioTransport` nor the OAuth callback server. It adds:
  - `mcpHttpTransport(options)`: Pi's transport with `fetch` called unbound and `openGetStream: false`
    (below);
  - `mcpAgentTool({ name, label, call })`: one remote tool as the `agent.tool` object, provided at
    setup and described at start (`describe(tool, replay)` fills label, description, parameters and
    replay on the same object);
  - `mcpToolName` (`<server>_<tool>`, `[A-Za-z0-9_-]`, 64 characters), `mcpParameters` (an object
    schema with `properties`, as pi-mcp's README advises), `mcpToolResult` (below);
  - `@pikit/pi-adapter/mcp/testing`: a fake Streamable HTTP server as a `fetch` handler, for the
    component's tests, the adapter's and the workerd lane's.
- **`tool-mcp`** (targets server and cloudflare). Config names each server (`url`, `tools`, and
  optionally `secret`, `headers`, `timeoutMs`); each tool named becomes the `agent.tool`
  `<server>_<tool>`. An agent gets a tool only by naming it (SPEC §6.3).
  - **Named in config, not a proxy.** Keyed capabilities' keys are fixed at `setup` (SPEC §4.5), so
    tools are provided then and described at `start` (`initialize`, `tools/list`). A server that cannot
    be reached, or lacks a named tool, stops the start (P5), naming the tools it has.
  - **When Pi reads a tool.** runtime-pi resolves agents' tool names when a conversation opens, which
    is after every start (tool-mcp provides `agent.tool`, so it starts before runtime-pi); Pi reads
    `description` and `parameters` from that object at each model call (Pi 0.99 records them in the
    transcript as a system message's `toolsAdded`), and `replay` when a call runs or a run resumes.
    Filling the object at start is therefore what the model sees; a test proves it on a real run.
  - **Replay:** `never`, `safe` when the server marks the tool `annotations.readOnlyHint: true`.
  - **Failures:** Pi's `AgentHarness` (0.99) takes a tool's failure only from a throw; an `isError`
    it returns is recorded as a success. So `mcpToolResult` throws with the result's text.
  - **Connections:** one client per server, in memory, connected at start. A call whose session the
    server forgot (404) connects again and is sent once more (the server ran nothing); nothing else
    is retried. Calls honour the run's cancellation (`notifications/cancelled`); stop ends sessions.
  - **Credentials:** `secret` names a secret read through `secrets` (optional capability) before each
    request and sent as a bearer token; never a token in config. Absent: no server, no tool.

## On Cloudflare
- **Tree-shaking.** The root export re-exports `StdioTransport`, but with `sideEffects: false` a bundle
  keeps only what is imported: tool-mcp adds 48 KiB (11 KiB gzip) to a conversation object's bundle,
  with no Node module (`tests/workerd/README.md`; `mcp.test.ts` bundles the adapter export to hold it).
- **"Illegal invocation".** pi-mcp 0.99 stores `options.fetch ?? globalThis.fetch` and calls
  `this.fetch(...)`; Workers refuse the platform `fetch` called on another object.
  `mcpHttpTransport` passes `(input, init) => fetch(input, init)`. The workerd lane pins the gap (it
  fails the day Pi fixes it upstream, and the wrapper may go).
- **No server-to-client stream.** `openGetStream: false` always: a Durable Object does not stay alive
  for an outbound stream (C4), and each held stream takes one of its six outbound connections. A
  request's own response may still stream (SSE).
- **`nodejs_compat`.** pi-mcp's SSE parser measures events with `Buffer.byteLength`, a Node global:
  `deployment-cloudflare`'s `wrangler.jsonc` enables `nodejs_compat`, so it works; a Worker without it
  would fail on the first SSE answer.
- **Cold start.** Each object's start connects each server and lists its tools: one `initialize`, one
  `notifications/initialized` and one `tools/list` per server, before the first message. Measure it
  against the 1 s budget with real servers; see below.

## Open questions
- **OAuth (phase 2).** pi-mcp's `./oauth` provider is neutral (the callback server is not): a
  `tool-mcp-oauth` (or an option of tool-mcp) would take the redirect through an `http.route` (Worker
  half on Cloudflare), keep tokens and client registration in `storage.kv` through pi-mcp's
  `McpOAuthStateStore`, and start the login from `pikit configure` or the dashboard. Where a token
  lives across a project's Durable Objects (per tenant, per server) is to decide with
  [multi-tenant isolation](multi-tenant-isolation.md).
- **stdio** is a process: a separate, server-only `tool-mcp-stdio` component over pi-mcp's
  `StdioTransport` (it may import it from the adapter's `./node` export), ideally through
  [sandboxed execution](sandboxed-execution.md). Never a flag of `tool-mcp`.
- **The cost of `tools/list` per object start.** If it threatens the 1 s cold start, cache each
  server's listing in `storage.kv` (with a time to live) and refresh it in the background; a stale
  schema then fails a call, not the start.
- **The manifest.** `registry generate` describes `setup` with an empty config, so `component.json`
  lists no `provides` for tool-mcp; `registry capabilities` does not show it as an `agent.tool`
  provider. Describing with the schema's `examples` would fix it (a CLI change).
- **Per-agent server lists**, and servers per tenant ([multi-tenant isolation](multi-tenant-isolation.md)).
- **Resources, prompts and tool-list changes** (`notifications/tools/list_changed`) are not used: with
  tools named in config, a new server tool needs a config change anyway.
