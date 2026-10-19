# execution-remote

The agent's files and a real shell in a sandbox on another machine: a host running
`execution-serve` (a micro-VM per sandbox with execution-gondolin), reached over HTTP with plain
`fetch`. A Cloudflare Durable Object cannot run a VM; with this component its conversation still gets
a real Linux, as a server's does. pi-durable's own `read`, `write`, `edit` and `bash` tools (the
`tool-*` components) work on it unchanged.

- **Provides:** `execution` and `execution.shell` (pi-durable's `ExecutionEnv`, `env.ts`) and
  `workspace` (a sandbox per conversation).
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

A sandbox id has an agent name's grammar (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 100 characters);
the host makes the sandbox on its first request and keeps it. On the host, execution-serve resolves
it as the conversation `remote-<id>` (its `conversationId`, which execution-gondolin keys its VMs by
alone), so a remote sandbox never shares one with the host App's own conversations (execution-serve's
README).

- **In a Durable Object** (`WORKERS_HOST`, which deployment-cloudflare puts in the start context, has
  an object): `o-<object id>`, for `execution` and every conversation `workspace` is asked for. The
  object is `idFromName(key)` of the conversation: one sandbox for its whole life, through
  evictions, deploys and resets, as execution-do's files are the object's. A delegated child
  conversation, which lives in the parent's object, works in the parent's sandbox.
- **On a server:** `workspace` gives each conversation key its own sandbox, `k-<SHA-256 of the key, in
  hex>` (one key, one sandbox, through resets, as an object on Cloudflare; whatever the agent).
  `execution` alone, which a conversation's tools never use while `workspace` is installed, is the
  sandbox `sandbox` (`shared`).

## The protocol

`protocol.ts`, an identical copy in execution-serve (change both together; the registry's test fails
while they differ): `POST <endpoint>/execution/v1/sandboxes/<sandbox>/<operation>`, a JSON body,
`Authorization: Bearer <token>`. Every `ExecutionEnv` operation is one request; the environment's
failures come back as its own `FileError` / `ExecutionError` codes, and nothing throws:

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
(`k-<hash>`) and in a Durable Object (`o-<id>`); paths sent absolute; the token only in the
`Authorization` header and a command's variables the caller's (C7); the protocol's failures as
results; output chunk by chunk from the cursor, with `skipped`; a read retried, a command lost;
cancellation stopping the command by its id, during its start too, and a throwing `onOutput`; a
small file whole, a large one in pieces; stop.

In the registry (`app.test.ts`, beside `files/`): against a real execution-serve (server-bun,
workspace-local over execution-local) on `Bun.serve`, pi-durable's `ExecutionEnv` suite and the
`workspace` suite pass end to end; pi-durable's own tools in a Harness turn (a long `bash` output
through the window, its spill file read back); a sandbox per key, per object; a quick command and a
small read cost one request each; a cancelled command's process does not run on; a wrong token.
pikit also runs the suite in workerd, in a real Durable Object reaching a real host
(`tests/workerd/test/execution-remote.workerd.ts`).
