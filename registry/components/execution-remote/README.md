# execution-remote

The agent's files and a real shell in a sandbox on another machine: a host running
`execution-serve` (a micro-VM per sandbox with execution-gondolin), reached over HTTP with plain
`fetch`. A Cloudflare Durable Object cannot run a VM; with this component its conversation still gets
a real Linux, as a server's does. pi-durable's own `read`, `write`, `edit` and `bash` tools (the
`tool-*` components) work on it unchanged.

- **Provides:** `execution` and `execution.shell` (pi-durable's `ExecutionEnv`, `env.ts`) and
  `workspace` (a sandbox per chat and agent).
- **Requires:** `secrets` (the token).
- **Targets:** `server` and `durable` (only `fetch` and Web Crypto). On Cloudflare it belongs in the
  conversation object's App (the default export of `pikit.config.ts`), not the Worker's.
- **Installs to:** `src/pikit/execution-remote/`.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter` (pinned with Pi), `typebox`.
- **Secret:** `PIKIT_SANDBOX_TOKEN`: the host's token, at least 32 characters.

```sh
pikit add execution-remote tool-bash tool-read tool-write tool-edit
```

```ts
"execution-remote": {
  endpoint: "https://sandbox.example.com", // required: where execution-serve is served
  tokenSecret: "PIKIT_SANDBOX_TOKEN",       // default: the secret's name, never the token
  sandbox: "shared",                        // default: on a server, the sandbox `execution` alone works in
}
```

`endpoint` is `https://`, or `http://` to the machine itself (`localhost`, `127.0.0.1`, `[::1]`); the
app does not start otherwise, nor without the token. How to run the host: execution-serve's README.
Replace `execution-do` (Cloudflare) or `execution-local` (server) with it; with `workspace-local`
installed too, remove that one (this component is the `workspace`). Two providers of `execution` do
not compose, so the old one goes with `--force` once this one is in:

```sh
pikit add execution-remote --yes      # then set "execution-remote": { endpoint } in pikit.config.ts
pikit remove execution-do --force     # execution-local on a server; workspace-local too, if installed
pikit doctor                          # execution, execution.shell, workspace: execution-remote
```

## Which sandbox

A conversation's sandbox is its chat's and its agent's (`ConversationRef.agent`, which the runtime
gives `workspace.resolve`). The chat is the conversation a person or a channel opened (`originOf`):
**a reset (`/new`) works in the same sandbox**, and finds what the agent wrote before it, and **a
delegated child of the same agent works in its parent's**, on a server as in a Durable Object. Two
agents never share one, so a delegated child of another agent works in that agent's sandbox of the
chat, not its parent's (results pass through the delegation's answer, or git). Several conversations
may then run commands in one sandbox at once (a parent and its background tasks): parallel tasks of
one agent keep to a subfolder or a git worktree each (execution-gondolin's README). Every request to
a conversation's sandbox carries the
header `Pikit-Agent: <agent>`, and the host resolves the sandbox for that agent: execution-gondolin
there gives it the agent's machine (its packages, hosts, secrets; its README). `execution`'s own
sandbox has no conversation and names no agent: the host gives it the base machine.

A sandbox id is kebab-case, lowercase (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 100 characters);
the host makes the sandbox on its first request and keeps it. On the host, execution-serve resolves
it as the conversation `remote-<id>`, so a remote sandbox never shares one with the host App's own
conversations (execution-serve's README).

- **In a Durable Object** (`WORKERS_HOST`, which deployment-cloudflare puts in the start context, has
  an object): each agent of the object works in `o-<hex SHA-256 of "<object id>\n<agent>">`, with an
  environment of its own kept for the App's life. This already is the chat's: the object is
  `idFromName(key)` of the chat's key, a reset keeps the key (so the object), and its delegated
  children live in it too. One sandbox per agent for the chat's whole life, through evictions,
  deploys and resets, as execution-do's files are the object's. `execution` alone works in
  `o-<object id>`.
- **On a server:** `workspace` gives each chat and agent its own sandbox,
  `k-<hex SHA-256 of "<chat key>\n<agent>">`, the chat key the origin's (`originOf(ref).key`): the same
  through resets, and a delegated child's own key (`delegate:<depth>:<chain>:<task>`) chooses
  nothing. `execution` alone, which a conversation's tools never use while `workspace` is installed,
  is the sandbox `sandbox` (`shared`).

The host gives each sandbox id its own workspace, unless its provider shares an agent's across them
(execution-gondolin's `workspace: "agent"`: one per agent for every chat, decided on the host).

The ids are hashes of the chat and the agent: sandboxes made before that (`o-<object id>` of a
conversation, `k-<hash of the key>`, and `k-<hash>` of a delegated child's own key) are orphaned on the
host, never migrated.

## The protocol

`protocol.ts`, an identical copy in execution-serve (change both together; the registry's test fails
while they differ): `POST <endpoint>/execution/v1/sandboxes/<sandbox>/<operation>`, a JSON body,
`Authorization: Bearer <token>`, and `Pikit-Agent: <agent>` for a conversation's sandbox (an agent's
name, at most 100 characters; a malformed one is `400`; a header because every body is strict). The
100-character bound is these components' own, not pikit's (`defineAgent` has none): a conversation
of an agent with a longer name is refused at `workspace.resolve`, saying so, before any request.
Every `ExecutionEnv` operation is one request; the environment's failures come back as its own
`FileError` / `ExecutionError` codes, and nothing throws:

| What fails | The result |
|---|---|
| The host refuses the token (`401`) | `permission_denied` (files), `unknown` (commands) |
| A reader closed or unknown on the host, an invalid request | `invalid` |
| No answer: the network, the host down, a request's own time limit (60 s past what the host may hold it) | `unknown`, saying so |
| A command the host lost (it restarted, or nobody read it for its lease) | `unknown`, saying so |
| The caller's context cancelled | `aborted` |

- **`open`, once per sandbox and App.** The first operation asks for the sandbox's working directory
  and home; after it every path is resolved here (relative, `..`, `~`, `file://`, as pi-durable's
  local environment does) and sent absolute, so `absolutePath` and `joinPath` cost no request.
  `workspace` hands out an environment opened already; reading `cwd` of `execution` before its first
  operation throws.
- **`id`** is `execution-remote:<endpoint>#<sandbox>`: each sandbox its own file namespace.
- **Readers.** A file of up to 1 MiB comes whole with `openBinaryReader`'s answer and is read from
  memory (as it was opened, through a rename); a larger one is read on the host behind a handle, in
  requests of at most 4 MiB. Directory readers are the host's (an entry removed meanwhile is skipped).
  `openTextLineReader` reads the whole file once.
- **Commands never ride one long request** (a Durable Object works in alarm slices of 60 s and can be
  evicted between events). `exec` starts the command under an id it chose (`execStart`), then reads
  its output from a cursor (`execRead`) until it ended: each request is held by the host at most
  10 s, and answers at once when the command ends. Output reaches `onOutput` as it arrives, chunk by
  chunk, with its stream; the host sends at most every `linger` ms, which starts at the caller's
  `window.minIntervalMs` (at least 200 ms) and doubles to 5 s. With `window` (pi-durable's `bash`
  passes it), the host leaves out what the caller would drop and says so (`info.skipped`). `timeout`
  and `spill` are the sandbox's (the spill file is in the sandbox, readable here). A cancelled
  context, or an `onOutput` that throws, stops the command on the host (`execKill`), during its start
  too; a read that got no answer is retried three times (250 ms, 1 s, 2 s).
- **`watch`** is `not_supported` (changes would be polled across the network), as on execution-do.

**What it costs in requests** (Cloudflare counts subrequests per event: 50 on the Free plan, shared
by everything in the event, `docs/targets.md`): a command that ends within 10 s, one; a silent long
command, one per 10 s; a chatty one, about a dozen a minute once `linger` reached 5 s; a file of up to
1 MiB read with pi-durable's `read`, one; any other file operation, one; the first operation of an
object's App, one more (`open`).

## Credentials (SPEC C7)

Nothing secret goes to the sandbox through this component. The token is read through `secrets`,
kept in memory, and sent only in the `Authorization` header to `endpoint`: no variable, file,
command or output of the sandbox carries it, nor any other secret of the App. A command's variables
are the calling tool's own. A sandbox that needs a credential (a model key, a git token) gets it from
its host's provider, injected outside the sandbox: execution-gondolin does it at its network layer.

## Limits

- **The host's state is in its memory.** A host restart loses the commands running (their result is
  `unknown`); the sandboxes' files are the provider's and stay.
- **A command whose start was cut** (the caller cancelled before the host answered) is stopped by its
  id; if that stop is lost too, it runs until it ends or the host's lease (120 s unread) stops it.
- **An evicted Durable Object** stops reading its command: the host's lease stops it, and pi-durable
  gives the model an `interrupted` result (`tool-bash` is `replay: "unsafe"`).
- **On a server, an environment per chat and agent**, kept for the App's life and never
  forgotten (as it was per key before): small objects (an id, a working directory), but their number
  grows with every chat and agent the App ever resolved, until it restarts. The sandboxes
  themselves are the host's and stay until its provider removes them.
- **Each request is HTTP**, a round trip to the host: a tool call that reads many files is slower
  than on a local disk. Keep the host near the Workers that use it.
- Isolation, resources and network policy are the sandbox provider's (execution-gondolin's README).

## Removing it

`pikit remove execution-remote` refuses while a component requires `execution` or
`execution.shell` (the `tool-*` components). The sandboxes stay on the host until its provider
removes them.

## Tests

Copied with the component (`execution-remote.test.ts`), against a fake host speaking the protocol
on a local `Bun.serve`: what setup declares; the start refused without the token, with a short one,
over http to another machine, or in the Worker's App; the sandbox of a conversation on a server
(`k-<SHA-256 of the chat's key and agent>`, the same through a reset; a delegated child, and
grandchild, of the same agent in its parent's, of another agent in its own of the chat, of another
chat in that chat's) and in a Durable Object (`o-<SHA-256 of object id and agent>`;
`execution` alone `o-<object id>`); paths sent absolute; the token only in the
`Authorization` header and a command's variables the caller's (C7); `Pikit-Agent` on every request of
a conversation's sandbox and never on `execution`'s, two agents of one key or object in two sandboxes
(a delegated child of another agent), the same agent always in the same, an agent that is not an
agent's name refused before any request (101 characters too, saying so); the protocol's failures as results; output chunk by chunk from the cursor, with `skipped`; a read retried, a command lost;
cancellation stopping the command by its id, during its start too, and a throwing `onOutput`; a
small file whole, a large one in pieces; stop.

In the registry (`app.test.ts`, beside `files/`): against a real execution-serve (server-bun, a
provider keyed by conversation and agent as execution-gondolin's is, over execution-local) on
`Bun.serve`, pi-durable's `ExecutionEnv` suite and the `workspace` suite pass end to end; pi-durable's
own tools in a Harness turn (a long `bash` output through the window, its spill file read back); a
sandbox per chat and agent (a delegated child of the same agent in its parent's, of another agent in
that agent's of the chat), per object and agent (a child of the same agent in its parent's), each
resolved on the host for its agent and `execution`'s for none; behind workspace-local, a directory per
chat and agent (a reset in the same); a quick command and a small
read cost one request each; a cancelled command's process does not run on; a wrong token.
`gondolin.test.ts` runs remote, serve and execution-gondolin together on real micro-VMs (skipped
without QEMU), a reset of the chat and a same-agent child finding a file, another agent's child not.
pikit also runs the suite in workerd, in a real Durable Object reaching a real host, with two agents
of one object in two sandboxes, each found again by a same-agent child and, in a new App, by a reset
(`tests/workerd/test/execution-remote.workerd.ts`).
