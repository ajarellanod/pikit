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
- **Hooks** (`component.json`): `doctor` (`doctor.ts`), its step of `pikit doctor`; `beforeDeploy`
  (`deploy.ts`), which `pikit up` runs before it builds and which writes `seed.ts` (below).
- **Targets:** `server` and `cloudflare`: Streamable HTTP over `fetch`. A server run as a local
  process (stdio) is not this component's (see `features/completed/mcp.md`).
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
  described. It takes them from the freshest listing it has, for the server's URL and holding every
  tool named here: the one kept in `storage.kv`, else the seed `pikit up` bundled (`seed.ts`), else
  the server itself.
  - **With `storage.kv`**, each server's listing of the named tools is kept (namespace `tool-mcp`,
    key `server/<name>`, with its URL and when it was listed). A start that finds it complete, for
    the same URL, describes the tools from it and **reaches no server**: a cold start makes no MCP
    request, and a server that is down does not stop the app; only calls to its tools fail.
  - **With a seed** and nothing kept (no `storage.kv`, a new conversation's object on Cloudflare),
    the start describes the tools from `seed.ts` and **reaches no server** either. The first
    connection keeps its listing in `storage.kv`.
  - **Otherwise** (no kept listing and no seed for it: a new URL or a new tool in config since the
    last `pikit up`, an empty seed), each server is reached (`initialize`, `tools/list`), and the listing is kept. A server that cannot be
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
  there, not the app once deployed. The token's value is never printed. It writes nothing.
- **The seed, at each deploy**: `deploy.ts`'s `beforeDeploy` is run by the deployment's `up`
  (`deployment-cloudflare`, `deployment-docker`) before it bundles or builds. It lists each server's
  tools again, from this machine, and writes the named ones into `seed.ts` (below); a server that
  cannot be reached, or lacks a tool, stops `up` before anything is deployed.
- **A call** sends `tools/call` and gives the model the result's text and images. A failure the
  server reports (a result with `isError`) fails the call with its text; a server that cannot be
  reached fails the call (the app keeps answering, and the next call tries again); a cancelled run
  cancels the call and tells the server.
- **One client per server**, kept in memory. When the server forgets the session (it restarted, or
  it expires idle ones), the call connects again and is sent once more: the server ran nothing. Any
  other failure is not retried: the tool may have run.
- **At stop** each session is ended (`DELETE`).

On Cloudflare the component goes in the conversation's Durable Object App, and every conversation's
object starts its App when it wakes. The seed `pikit up` bundles is every object's: a new
conversation's first start describes the tools from it, with no MCP request and no stop when a
server is down. Install `storage.kv` there too (`storage-kv-sql` over `storage-do`): an object then
keeps the listing in its own storage, refreshed on each connection, and each later wake starts from
it. With neither (an empty seed, no `storage.kv`), each object's start makes one `initialize`, one
`notifications/initialized` and one `tools/list` per server (about 0.9 s against
`mcp.deepwiki.com`, measured in `features/completed/mcp.md`). No stream stays open between requests: the
server-to-client stream of MCP is not opened, since an object does not stay alive for it (SPEC
§4.1, C4).

## The seed: `seed.ts`

`src/pikit/tool-mcp/seed.ts` is generated: `pikit up` rewrites it (`beforeDeploy`, above), and
`index.ts` imports it, so the Worker's bundle and the Docker image carry it. It holds, by server name,
the server's URL and, of each tool named in config, what a start needs: name, title, description,
`inputSchema` and `annotations`. Never a token, a secret's name or a header. It holds no time either,
so a deploy changes it only when a server's tools changed.

- **Commit it.** A build without the CLI (Workers Builds, a "Deploy to Cloudflare" button,
  `docker build` by hand) bundles whatever `seed.ts` holds; one committed after a `pikit up` gives
  those builds a start with no request too. Installed, it is empty, and a start without a kept
  listing reaches the servers, as before.
- **A seed for another URL, or without a tool config names, is not used**: after such a config
  change and before the next `pikit up`, a start reaches the server (and is stopped by one that is
  down, as without a seed).
- **The kept listing wins** over the seed: it is refreshed on each connection, so it is at least as
  recent unless the object has not connected since the deploy. Either way, the first call connects
  and updates the tools.
- It is declared `generated` (`component.json`): `pikit doctor` never lists it as modified, and
  `pikit remove tool-mcp` deletes it without `--force`. `pikit dev` does not rewrite it.
- **Out of date:** `pikit doctor` compares what each server lists with `seed.ts` and gives a note
  (never a problem) when they differ: run `pikit up`, or commit the `seed.ts` it writes, before a
  deploy without the CLI. A start whose seed holds other servers but not this one's listing logs a
  warning, and reaches that server.

## Replay

`never`, unless the server marks the tool read-only (`annotations.readOnlyHint: true`): then `safe`,
and a run resumed after a crash calls it again. The hint is the server's word: a tool
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
longer lists failing its calls. With a seed: a start from it with no request (with `storage.kv`
empty, and without it), the kept listing winning over it, and a seed for another URL or without
every named tool not used. `doctor.test.ts` covers the doctor step, `deploy.test.ts` the seed
`beforeDeploy` writes (only the named tools, nothing secret, unchanged when the tools are) and the
problems that stop a deploy.
