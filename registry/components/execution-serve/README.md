# execution-serve

A sandbox host: the sandboxes of this server App, served over HTTP to `execution-remote`, so an
agent anywhere (another server, a Cloudflare Durable Object, which cannot run a VM) gets a real
shell. Each sandbox is one environment of this App's `workspace` provider: in production
execution-gondolin's micro-VMs; for a trial, workspace-local over execution-local (a directory each,
not a sandbox).

- **Provides:** `http.route`, under `POST /execution/v1/sandboxes/:sandbox/:operation`.
- **Requires:** `secrets` (the token) and `workspace` (the sandboxes). Served by `server-bun`.
- **Target:** `server`.
- **Installs to:** `src/pikit/execution-serve/`.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter` (pinned with Pi), `typebox`.
- **Secret:** `PIKIT_SANDBOX_TOKEN`, at least 32 characters (`pikit configure --generate
  PIKIT_SANDBOX_TOKEN`, or `openssl rand -hex 32`); the same value in every client project.

```sh
pikit add execution-serve
```

## A sandbox host

A project of its own (`pikit new --target server`), whose `pikit.config.ts` has nothing but the
server, the token, the sandboxes and this component: no runtime, no agents, no channels.

```ts
import { defineApp } from "@pikit/core";
import executionGondolin from "./src/pikit/execution-gondolin/index.ts"; // provides `workspace`: a micro-VM per sandbox
import executionServe from "./src/pikit/execution-serve/index.ts";
import logEvents from "./src/pikit/log-events/index.ts";
import secretsEnv from "./src/pikit/secrets-env/index.ts";
import serverBun from "./src/pikit/server-bun/index.ts";

export const config = {
  "server-bun": { port: 3000 },
  "execution-serve": { leaseSeconds: 120 }, // default
  // "execution-gondolin": { ... }          // its README: images, sizes, the hosts a sandbox may reach
};

export default defineApp({
  components: [logEvents, secretsEnv, executionGondolin, executionServe, serverBun],
  config,
});
```

For a trial on one machine, `execution-local` and `workspace-local` take execution-gondolin's place.
workspace-local keys its directories by the agent alone, so each agent then works in
`<execution-local root>/<workspace-local root>/<agent>`, shared by every conversation and client of
that agent (as on a server); an agentless sandbox's agent is `_<sandbox id>`, a directory of its own
(workspace-local takes one leading `_`). Commands run as the server's user:
**not a sandbox**, see their READMEs.

Deploy it like any server project (`pikit up`: deployment-docker publishes the port on
`127.0.0.1` only). Clients require `https://`, so put TLS in front: `expose-cloudflare-tunnel` (no
open port), or a reverse proxy. The clients' config is then
`"execution-remote": { endpoint: "https://sandbox.example.com" }` with the same `PIKIT_SANDBOX_TOKEN`
(execution-remote's README).

## What it does

- **One route, one sandbox per request.** The sandbox id is the URL's, checked as sent (no
  percent-decoding) against the protocol's grammar (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 100
  characters): `..`, `%2e%2e`, `%2F`, capitals and extra segments are `400` before any sandbox is
  asked for.
- **The token first.** `Authorization: Bearer <PIKIT_SANDBOX_TOKEN>`, compared in constant time as
  SHA-256 digests (as admin-auth-token does); only the digest is kept. Anything else is `401`
  before the URL's sandbox or the body are looked at.
- **The agent.** A request may name the agent its sandbox is for, `Pikit-Agent: <agent>` (an
  agent's name, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 100 characters): execution-remote sends it
  for a conversation's sandbox, never for `execution`'s own. A malformed one is `400
  invalid_request` before any sandbox is asked for. The 100-character bound is these components'
  own (`defineAgent` has none): execution-remote refuses a longer agent at `resolve`, saying so, and
  this host answers it `400`. The agent is the client's word: the token holder
  is trusted to name it (a logical boundary, not a wall against the client's own code).
- **A sandbox is `workspace.resolve`** of the `ConversationRef` built from its id and the agent
  (`sandboxConversation`, `host.ts`):

  | Field | With `Pikit-Agent` | Without | Who keys by it |
  |---|---|---|---|
  | `conversationId` | `remote-<id>` | `remote-<id>` | execution-gondolin, with `agent` (a VM and a directory each) |
  | `agent` | the header's agent | `_<id>` | execution-gondolin (and chooses the agent's machine by it); workspace-local (a directory per agent) |
  | `key` | `execution-serve:<id>` | `execution-serve:<id>` | |

  `_<id>` is outside the agent grammar: an agentless sandbox never matches a machine profile (it gets
  the base) and still has an `agent` of its own. `remote-` keeps a sandbox apart from the host App's own conversations, whose ids its runtime
  numbers (`1`, `2` and on): a remote id can never be one of them. `conversationId` is held to
  `^[A-Za-z0-9_-]{1,128}$` (execution-gondolin's rule, a safe directory name): an id that cannot
  make one is `400 invalid_request` at the door, never cleaned up into another (the protocol's
  100-character bound keeps every valid id within it). The provider is asked on each request that
  needs the environment and keeps or makes its sandboxes. Its failure is `503`, its message only in
  this host's log.
- **Every `ExecutionEnv` operation** (protocol.ts): files (`fileInfo`, `readTextFile`, `writeFile`,
  `truncateFile`, `renameFile`, `remove`, `createTempFile`…), readers (`openBinaryReader` sends a file
  of up to `prefetch` bytes whole and keeps nothing open; a larger one, and every directory reader,
  is a handle), and commands. The environment's failures are `200 { ok: false, error }` with its
  own code; the protocol's are their status (`400`, `401`, `404`, `413`, `429`, `503`).
- **Commands never ride one long request.** `execStart` (under the client's id) starts the command in
  a context of its own, which outlives the request; `execRead` reads the output after a cursor;
  `execKill` stops it. Each holds the request at most `wait` ms (30 s at most), answering at once when
  the command ends, or once it has output and `linger` ms passed. Output is kept until a later cursor
  acknowledges it, so a lost answer is read again and nothing twice. With the caller's `window`, the
  output the client was never sent is folded into one skip once more than the window follows it
  (pi-durable's `ShellOutputSkip`, counted exactly). `timeout` and `spill` are the sandbox
  environment's own (the spill file is in the sandbox).
- **Handles are their sandbox's and agent's.** A reader or a command of one sandbox, asked for from
  another, is `404` as one that never existed; so is one asked for under the same sandbox id with
  another `Pikit-Agent`, or none (another environment of the provider). The client's ids already
  carry the agent; scoping by both keeps a token holder that sent one id under two agents from
  crossing their handles.
- **The lease.** A command nobody reads for `leaseSeconds` is stopped (its result says so), then
  forgotten; a reader unused as long is closed. A client that went away (a Durable Object evicted in
  the middle of a command) leaves nothing running for long.

## Guarantees and their limits

- **Isolation is the provider's.** This layer routes each request to its sandbox's environment and
  keeps handles apart; it does not confine paths (a VM's root is the wall, and a shell would step
  over any check made here). Behind workspace-local, one sandbox can read another's files, and two
  sandboxes of one agent are one directory.
- **Credentials (SPEC C7).** The token authenticates the client to this host and goes no further: no
  variable, file or command of a sandbox receives it. Nothing secret arrives through the protocol (a
  command's variables are the calling tool's). A sandbox that needs a credential (a model key, a git
  token) gets it from its provider, injected outside the sandbox: execution-gondolin does it at its
  network layer, so the secret never exists inside the VM.
- **Commands and readers live in this process.** A restart forgets them (their processes stop with
  it); clients then get an `unknown` error for a command they were reading. The sandboxes' files are
  the provider's, and stay.

## Config

```ts
"execution-serve": {
  tokenSecret: "PIKIT_SANDBOX_TOKEN", // default: the secret's name, never the token
  leaseSeconds: 120,                  // default: 10 to 3600
  maxRequestBytes: 33554432,          // default (32 MiB): server-bun's own bound applies first
}
```

## Limits

Per sandbox and agent (one environment: the same id under two agents counts twice): 16 running
commands and 64 open readers (`429`). A command without a window whose unread
output passes 64 MiB is stopped, saying so. An answer carries at most 4 MiB of output (a backlog is
read in several), a read at most 4 MiB, a whole file sent with its opening at most 1 MiB. `watch` and
`listFiles` are not in the protocol: execution-remote answers `not_supported` for `watch`, and
pi-durable walks directories itself without `listFiles`. No network policy here: the provider's.

## Tests

Copied with the component (`execution-serve.test.ts`), over a double of a `workspace` provider keyed
as execution-gondolin's is (a directory per `conversationId` and `agent`, each
`^[A-Za-z0-9_-]{1,128}$` or it throws, over pi-durable's local environment) and the route itself:
what setup declares, the ref a sandbox is resolved as (`remote-<id>`, the longest id included; the
header's agent, `_<id>` without one), two agents' sandboxes apart, a malformed `Pikit-Agent` (`400`,
nothing resolved; the longest name taken),
the lifecycle suite, the token (missing, another, too short, another scheme: `401` before anything is
read), sandbox ids that are not one (`..`, encoded traversals, capitals, too long, extra segments),
paths (relative refused; an absolute one reaches only the URL's sandbox), readers and commands of
another sandbox, of the same sandbox id under another agent or none, or unknown (`404`), the limits
counted per sandbox and agent, `execKill`, two sandboxes running at once, the cursor (a lost
answer read again, an acknowledged cursor refused), the per-sandbox limit, the lease (on a manual
clock), stopping the host, and the output log (every chunk, a window's skip counted exactly, sent
output never folded).

The registry also runs the protocol end to end (`execution-remote/app.test.ts`): a real host
(server-bun, this component, a provider keyed as execution-gondolin's over execution-local, and
workspace-local for its own case) on `Bun.serve`, with execution-remote passing pi-durable's
`ExecutionEnv` suite through it, and from a Durable Object in the workerd lane
(`tests/workerd/test/execution-remote.workerd.ts`), two agents of one object in two sandboxes.
