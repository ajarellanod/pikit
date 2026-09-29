# tool-mcp

The tools of remote MCP servers, for the agents that name them. You list each server and the tools
you want from it; each becomes the agent tool `<server>_<tool>`. Pi's own MCP client
(`@earendil-works/pi-mcp`, through `@pikit/pi-adapter/mcp`) talks to the servers.

- **Provides:** `agent.tool`, one key per tool named in config (`deepwiki_ask_wiki_question`). Without
  servers in config it provides nothing, so its `component.json` lists no `provides`: the keys come
  from your config.
- **Uses, if installed:** `secrets`, for a server that needs a bearer token (`secrets-env`,
  `secrets-cloudflare`). A server with a `secret` and no `secrets` provider stops the start.
  `storage.kv`, to keep each server's tool listing: a start then reaches no server (below).
- **Targets:** `server` and `cloudflare`: Streamable HTTP over `fetch`. A server run as a local
  process (stdio) is not this component's (see `features/mcp.md`).
- **Installs to:** `src/pikit/tool-mcp/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

```sh
pikit add tool-mcp
```

## Config

```ts
config: {
  "tool-mcp": {
    servers: {
      // Public, no token: https://mcp.deepwiki.com
      deepwiki: { url: "https://mcp.deepwiki.com/mcp", tools: ["ask_wiki_question", "read_wiki_structure"] },
      // A token, read through `secrets` from the secret GITHUB_MCP_TOKEN (never the token itself here).
      github: { url: "https://api.githubcopilot.com/mcp/", secret: "GITHUB_MCP_TOKEN", tools: ["search_issues"] },
    },
  },
}
```

Each server:

- `url`: its Streamable HTTP endpoint.
- `tools`: the server's tools to give agents, by their MCP names (at least one).
- `secret` (optional): the **name** of a secret holding a bearer token, sent as
  `Authorization: Bearer …`. Read through `secrets` before each request, so a rotated token is used at
  once. Set it like any secret: in `.env` with `secrets-env`, a Worker secret with
  `secrets-cloudflare` (`pikit up` uploads `.env`'s).
- `headers` (optional): extra request headers. Config is not secret: never a credential here.
- `timeoutMs` (optional): how long one request may take, 60 000 ms by default.

A server's name holds letters, digits, `_` and `-`. A tool's name is `<server>_<tool>`, with any
character outside `[A-Za-z0-9_-]` turned into `_` and cut at 64 characters (what model providers
accept); two tools that would share a name stop the setup.

## What it does

An agent gets a tool only when it names it:

```ts
defineAgent({ name: "research", model: "openrouter/z-ai/glm-5.3-flash", tools: ["deepwiki_ask_wiki_question"] })
```

- **At setup** each tool named in config is provided, under its name: a keyed capability's keys are
  fixed then, before any server is reached.
- **At start** each tool takes what only the server knows: its title, description and parameters
  (its `inputSchema`), from the server's `tools/list`. The tools are the same objects runtime-pi
  hands to Pi when a conversation opens, after every start, so the model sees what the server
  described.
  - **With `storage.kv`**, each server's listing of the named tools is kept (namespace `tool-mcp`,
    key `server/<name>`, with its URL and when it was listed). A start that finds it complete, for
    the same URL, describes the tools from it and **reaches no server**: a cold start makes no MCP
    request, and a server that is down does not stop the app; only calls to its tools fail.
  - **Otherwise** (no `storage.kv`, the first start, a new URL or a new tool in config), each server
    is reached (`initialize`, `tools/list`), and the listing is kept. A server that cannot be
    reached, refuses the token, or lacks a tool named here **stops the app** (P5), naming the tools
    it has: the model could get the tool's description from nowhere.
- **Each connection lists the tools again**: the first call after a start from the kept listing,
  and a call after the server forgot the session. The tools and the kept listing follow what the
  server says now (Pi reads description and parameters at each model call). A named tool the server
  no longer lists is logged as an error, and its calls fail naming the tools the server has; its
  last description stays kept, so the next start does not stop the app over it.
- **Strict before a deploy**: `doctor.ts` is this component's step of `pikit doctor`, which `pikit up`
  and `pikit dev` run first. It reaches each server with the token from `.env` (or the environment)
  and reports one that cannot be reached, or lacks a named tool, as a problem: the deploy stops
  there, not the app once deployed. The token's value is never printed.
- **A call** sends `tools/call` and gives the model the result's text and images. A failure the
  server reports (a result with `isError`) fails the call with its text; a server that cannot be
  reached fails the call (the app keeps answering, and the next call tries again); a cancelled run
  cancels the call and tells the server.
- **One client per server**, kept in memory. When the server forgets the session (it restarted, or
  it expires idle ones), the call connects again and is sent once more: the server ran nothing. Any
  other failure is not retried: the tool may have run.
- **At stop** each session is ended (`DELETE`).

On Cloudflare the component goes in the conversation's Durable Object App, and every conversation's
object starts its App when it wakes. Install `storage.kv` there (`storage-kv-sql` over
`storage-do`): an object then keeps the listing in its own storage, and each later wake starts from
it, with no MCP request in its cold start and no stop when a server is down, and connects on its
first call. The listing is the object's: a new conversation's first start still reaches the
servers (and a server down stops that one start). Without it each object's start makes one `initialize`, one
`notifications/initialized` and one `tools/list` per server (about 0.9 s against
`mcp.deepwiki.com`, measured in `features/mcp.md`). No stream stays open between requests: the
server-to-client stream of MCP is not opened, since an object does not stay alive for it (SPEC
§4.1, C4).

## Replay

`never`, unless the server marks the tool read-only (`annotations.readOnlyHint: true`): then `safe`,
and a run resumed after a crash (SPEC §8.4) calls it again. The hint is the server's word: a tool
that changes something, from a server you do not trust to mark it right, is better left out.

## Tests

`tool-mcp.test.ts` is copied with the component and runs in your project. Each MCP server is a local
stand-in on a free port (`Bun.serve` over `createFakeMcpServer` from `@pikit/pi-adapter/mcp/testing`),
speaking Streamable HTTP: no test reaches the network or needs a real token. It covers the tools
provided under the right keys, their description, parameters and replay filled at start, calls and
their results, a reported failure, a tool the server lacks and a server that cannot be reached
stopping the start, a forgotten session reconnected, the token read from `secrets` (and missing, or
without `secrets`), config headers, cancellation, stop, and a real run where the model sees what the
server described and a reported failure is recorded as a failed call. With `storage.kv` (in memory):
the listing kept at start, a start from it with no request, a server down that fails its calls but
not the start, the tools and the listing refreshed on each connection, and a tool the server no
longer lists failing its calls. `doctor.test.ts` covers the doctor step.
