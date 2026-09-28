# MCP

**Public appeal:** ⭐ Connect the agent to any MCP server (GitHub, Linear, a database) without writing
a tool. Hermes supports MCP, and users look for it in any agent's tool list.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
The tools of remote MCP servers, available to the agents that name them.

## How it fits pikit
- `tool-mcp` connects to the servers listed in its config (values) and provides their tools under
  `agent.tool`. An agent gets a tool only by naming it (SPEC §6.3).
- Keys of a keyed capability are fixed at `setup` (SPEC §4.5), but an MCP server reveals its tools
  when it is reached, in `start`. So either the tool names are listed in config, or one proxy tool
  per server takes the remote tool's name as an argument.
- Transport: Streamable HTTP over `network.fetch`, on both targets. A stdio server is a process:
  server only, through `execution.shell`, ideally [sandboxed](sandboxed-execution.md).
- Credentials from `secrets`, or a stored OAuth login; never in config.
- Replay: `never` unless the server marks a tool read-only (`readOnlyHint`), then `safe`.
- Absent: no connection, no tool.

## Pi first
Pi deliberately ships no MCP client: neither `pi-agent-core` nor `pi-coding-agent` 0.87.1 has one;
Pi's way is extensions, skills and CLIs. A Pi extension that registers MCP tools with
`registerTool` (tier A) and uses only `fetch` would run unmodified through `agent.extension`
(SPEC §6.2b): adopt one before writing `tool-mcp`.

## Open questions
- Named tools in config or a proxy per server.
- Per-agent server lists, and servers per tenant ([multi-tenant isolation](multi-tenant-isolation.md)).
- MCP's OAuth flow through `pikit configure`.
