# MCP

**Public appeal:** ⭐ Connect the agent to any MCP server (GitHub, Linear, a database) without writing
a tool. Hermes supports MCP, and users look for it in any agent's tool list.

**Specified:** partly (phase 1 built: `tool-mcp` and `@pikit/pi-adapter/mcp`, Streamable HTTP with a
bearer token from `secrets`, on both targets; strict at deploy (`pikit doctor` reaches each server),
tolerant at run time (tool listings kept in `storage.kv`, and a seed of them `pikit up` bundles);
OAuth and stdio are the open questions below)

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
  `<server>_<tool>`. An agent gets a tool only by naming it.
  - **Named in config, not a proxy.** Keyed capabilities' keys are fixed at `setup`, so
    tools are provided then and described at `start`, from the server's `tools/list`.
  - **Strict at deploy, tolerant at run time** (decided). On Cloudflare every conversation's Durable
    Object starts its App when it wakes: a start that reaches each server would make an MCP outage
    stop every conversation, and every cold start pay `initialize` + `tools/list`. So:
    - **Before a deploy**, `tool-mcp/doctor.ts` is the component's check of `pikit doctor`, which
      `pikit up` and `pikit dev` run first (and refuse on a problem). It reaches each server from the
      deploying machine, with the token from `.env` or the environment, and reports one that cannot be
      reached, refuses the token, or lacks a named tool; never the token's value. It writes nothing.
      `component.json` declares it (`"hooks": { "doctor": "doctor.ts" }`), `pikit add` records it in
      `pikit.json`, and the CLI runs the checks recorded there
      (`packages/cli/src/project/component-doctor.ts`, SPEC §3.2); a project without one starts no
      process and reaches no network. `add`, `remove` and `new` run doctor without these checks: they
      change the composition, not the servers.
    - **At each deploy, a seed** (built). `tool-mcp/deploy.ts` is the component's `beforeDeploy` hook
      (`"hooks": { "beforeDeploy": "deploy.ts" }`), which the deployment's `up` runs before it bundles
      (`deployment-cloudflare`) or builds (`deployment-docker`). It lists each server's tools again
      from the deploying machine and writes the named ones into `src/pikit/tool-mcp/seed.ts` through
      `io.write` (a file of the component's own directory, rewritten only when its text changes):
      by server name, the URL and, per tool, name, title, description, inputSchema and annotations.
      Never a token, a secret's name or a header, and no time, so a deploy changes it only when the
      servers' tools do. `index.ts` imports it statically, so the Worker's bundle and the Docker image
      carry it. A server that cannot be reached, or lacks a tool, fails `up` before anything is
      deployed, and `seed.ts` stays as it was. Installed, `seed.ts` is empty (the static import never
      breaks), and users commit it: a build without the CLI (Workers Builds, a Deploy to Cloudflare
      button) bundles what is committed. `pikit dev` does not rewrite it.
    - **With `storage.kv`** (optional capability; namespace `tool-mcp`, key `server/<name>`), the
      listing of each server's named tools (name, title, description, inputSchema, annotations) is
      kept with its URL and `listedAt`. A start that finds it complete for the same URL describes the
      tools from it and makes **no request**; a server that is down then fails only its tools'
      calls. Each connection (the first call after such a start, a call after a forgotten session)
      lists the tools again and updates the tool objects and the kept listing (Pi reads description
      and parameters per model call). A named tool the server no longer lists is logged as an error
      and its calls fail naming what the server has; its last description stays kept, so a later
      start does not stop the app over it.
    - **Start's precedence.** Each server's tools are described from the first listing for its URL
      that holds every named tool: this app's kept listing in `storage.kv` (the freshest: refreshed on
      each connection), else the bundled seed, else the server. With a seed, a new conversation's
      object on Cloudflare starts with **no request**, and a server that is down fails only calls.
    - **With neither** (an empty seed, or a URL or tool in config since the last `pikit up`, and
      nothing kept), start reaches the server as before, and a server that cannot be reached, or lacks
      a named tool, stops the start (P5): the model could get the tool's schema from nowhere.
  - **When Pi reads a tool.** runtime-pi resolves agents' tool names when a conversation opens, which
    is after every start (tool-mcp provides `agent.tool`, so it starts before runtime-pi); Pi reads
    `description` and `parameters` from that object at each model call (Pi 0.99 records them in the
    transcript as a system message's `toolsAdded`), and `replay` when a call runs or a run resumes.
    Filling the object at start is therefore what the model sees; a test proves it on a real run.
  - **Replay:** `never`, `safe` when the server marks the tool `annotations.readOnlyHint: true`.
  - **Failures:** Pi's `AgentHarness` (0.99) takes a tool's failure only from a throw; an `isError`
    it returns is recorded as a success. So `mcpToolResult` throws with the result's text.
  - **Connections:** one client per server, in memory, connected on first use (at start without a
    kept listing). A call whose session the server forgot (404) connects again and is sent once more
    (the server ran nothing); nothing else is retried. A server that cannot be reached fails the call
    with a clear error; the next call tries again. Calls honour the run's cancellation (`notifications/cancelled`); stop ends sessions.
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
- **Cold start** (measured against `https://mcp.deepwiki.com/mcp`, no auth, from a laptop in Europe;
  one `initialize`, one `notifications/initialized` (awaited: a full round trip) and one `tools/list`,
  about 175 ms each here):

  | | runs | median | min | max |
  |---|---|---|---|---|
  | Bun, a fresh process each (DNS + TLS included) | 10 | 882 ms | 862 ms | 1872 ms |
  | Bun, one process, pooled connection | 7 | 547 ms | 544 ms | 553 ms |
  | workerd (`wrangler dev`, pi-mcp's transport with `fetch: (i, init) => fetch(i, init)`, `openGetStream: false`) | 10 | 862 ms | 839 ms | 1213 ms |
  | tool-mcp `app.start()`, no kept listing, Bun | 5 | 968 ms | 948 ms | 1032 ms |
  | tool-mcp `app.start()` from the kept listing, Bun, 0 requests | 5 | 0.16 ms | 0.12 ms | 0.27 ms |
  | tool-mcp `app.start()`, workerd: no kept listing, then from it (0 requests) | 1 | 846 ms, then ≤ 1 ms | | |

  `tools/list` alone is 167–185 ms. Without a listing one server takes most of the 1 s budget. The
  seed `pikit up` bundles gives every object's start one (a start from it is the "from the kept
  listing" row: no request; the workerd lane checks it, `tests/workerd/test/tool-mcp.workerd.ts`),
  and a Cloudflare project with tool-mcp should also install `storage-kv-sql` (over `storage-do`), so
  that an object keeps what its connections list. The first call pays the connection instead (about
  0.9 s here, before `tools/call`).
  In `wrangler dev` every request paid about a fresh process's time (no reused connection showed);
  from Cloudflare's edge the round trips may be shorter (not measured deployed).

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
- **Pi's gaps (upstream issue pending the user's decision).** pi-mcp 0.99 calls `globalThis.fetch` as
  a method of its transport ("Illegal invocation" on Workers) and measures SSE events with
  `Buffer.byteLength` (needs `nodejs_compat`). Whether to report them to Pi is the user's call; until
  Pi fixes them, `mcpHttpTransport`'s wrapper and the workerd case that pins the gap stay.
- **On Cloudflare the kept listing is per conversation** (`storage-kv-sql` on the object's own
  SQLite). The seed `pikit up` bundles closes the cold start of a new conversation (built, above);
  what stays open:
  - a config change (a new server, URL or tool) deployed without `pikit up` (Workers Builds from a
    commit whose `seed.ts` is older) has no seed for it: every new conversation reaches the server
    at its first start, as before, until `pikit up` runs and its `seed.ts` is committed. It is said,
    not silent: `pikit doctor` gives a note when `seed.ts` does not hold what a server lists now, and
    such a start logs a warning;
  - the kept listing wins over the seed even when the seed is newer (an object last connected before
    the deploy): its first call fixes it, as a stale kept listing always was. Preferring the newer by
    `listedAt` would need a time in the seed, and the churn that comes with it;
  - `seed.ts` is declared `generated`: `pikit doctor` does not list it as modified and `pikit
    remove` deletes it without `--force`, and `pikit upgrade` keeps the project's copy (the hook
    rewrites it);
  - a project-wide `storage.kv` (a Workers KV binding) for listings was not needed.
- **The kept listing has no time to live.** It is refreshed on each connection, which every object
  makes on its first call; a schema that changed on the server and was never called since stays
  kept until then. A server that changed a tool's arguments fails that call (the server says why) and
  the next connection fixes the schema. A time to live, or a background refresh, was not needed.
- **The first call after a cached start pays the connection** (`initialize`, `notifications/initialized`,
  `tools/list`) before `tools/call`: about 0.9 s against deepwiki. Only calls pay it, not answers
  that use no MCP tool.
- **The doctor check and the seed run from the deploying machine**, with the token from `.env` or
  the environment: a server reachable only from Cloudflare's network, or a secret set in Cloudflare
  and not in `.env`, is reported as a problem and stops `up`. A way to skip them (a flag of `up`) was
  not added. `pikit up` reaches each server once: it leaves tool-mcp's doctor check to
  `beforeDeploy`, which checks the same right before the build (about 1 s per server here).
- **Components' CLI steps** (decided, SPEC §3.2): the doctor check is declared as `hooks.doctor`,
  like `hooks.beforeDeploy` and `hooks.afterDeploy`, so `registry validate` checks its export and
  only what `pikit.json` records runs. `configure.ts` is still found by its path; declaring it as
  `hooks.configure` is the same change, not made.
- **The manifest.** `registry generate` describes `setup` with an empty config, so `component.json`
  lists no `provides` for tool-mcp. The config schema now carries one full example (`examples`:
  deepwiki with `ask_wiki_question`, `read_wiki_structure`); `registry generate` learning to describe
  setup with each example is in progress separately, and will list those keys.
- **Per-agent server lists**, and servers per tenant ([multi-tenant isolation](multi-tenant-isolation.md)).
- **Resources, prompts and tool-list changes** (`notifications/tools/list_changed`) are not used: with
  tools named in config, a new server tool needs a config change anyway.
