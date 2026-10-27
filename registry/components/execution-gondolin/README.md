# execution-gondolin

Each agent's tools work, in each chat, in a Linux micro-VM of its own ([Gondolin](https://github.com/earendil-works/gondolin),
over QEMU): a real shell that cannot read the server's files or another chat's, with its files on the
host, no network but the hosts you allow, and secrets the guest never sees.

- **Provides:** `workspace` (a sandbox per chat and agent, or per agent for every chat, each on its
  agent's machine), and
  `execution` and `execution.shell` (one more sandbox, `default`, for a tool called outside a
  conversation). All are pi-durable's `ExecutionEnv`.
- **Uses if present:** `secrets` (required once `secrets` is configured: start refuses without it),
  `proposals` (self-improvement on a server, proposals-local: the steward's `git` reaches the
  proposals repository, and nothing else of it; "Proposals" below), `agent.definition` (only to warn
  at start of a profile in `agents` that no agent has). Not `agent.directory` (live agents): "Machines
  per agent" says why.
- **Target:** `server`: QEMU processes beside the app.
- **Installs to:** `src/pikit/execution-gondolin/`.
- **npm dependencies:** `@earendil-works/gondolin` (0.13.0, Apache-2.0; Earendil Works' sandbox, not
  Pi: `registry validate` allows it, see below), `@pikit/contracts`, `@pikit/pi-adapter` (pinned with
  Pi), `typebox`.
- **Machine:** QEMU (`qemu-system-aarch64` on arm64, `qemu-system-x86_64` elsewhere) and `qemu-img`
  on `PATH`; on Linux, `/dev/kvm`. `pikit doctor` checks them (its `doctor` hook). The guest image
  (Alpine, about 200 MB) is downloaded on the first boot into `~/.cache/gondolin` (`$XDG_CACHE_HOME`).
- **Instead of:** `execution-local`, and `workspace-local` (both provide what this provides: install one
  set). `tool-read`, `tool-write`, `tool-edit` and `tool-bash` work unchanged. Two providers of
  `execution` do not compose, so the old ones go with `--force` once this one is in:
  `pikit add execution-gondolin --yes`, then `pikit remove execution-local --force` (and
  `workspace-local`, if installed), then `pikit doctor`.

## Why

With `execution-local`, `bash` runs as the server's OS user: it can read `.pikit/` (the SQLite with
every conversation, the credentials), `.env`, and every other conversation's workspace. Here a command
runs as root of a VM that holds only its chat's and agent's files: the host's are not mounted, and
its network reaches only what you allow.

## How a sandbox is keyed

**By chat and agent** (`workspace: "chat"`, the default). The chat is the key of the conversation a
person or a channel opened: `originOf(ref).key` (`@pikit/contracts`), the conversation's own key, or
its origin's when it is delegated (a Google Chat space, a Telegram chat). So:

- **A reset keeps the workspace.** pikit's runtime gives a reset conversation (`/new`) a new
  `conversationId` under the same key: the agent finds what its past self wrote in that chat (the
  transcript starts again, the files do not). `conversationId` and `channel` choose nothing.
- **A delegated child of the same agent works in its parent's sandbox** (tool-delegate's
  `delegate:<depth>:<chain>:<task>` key chooses nothing: its origin's does), on a server as in a
  Durable Object (execution-remote's README). A child of another agent works in that agent's sandbox
  of the chat: its own machine, its own files, never its parent's. Results pass through the
  delegation's answer, git, or files the same agent left.
- **Two chats, two sandboxes**, and two agents of one chat, two: two directories, two VMs, each on its
  own agent's machine ("Machines per agent" below).

**By agent alone** (`workspace: "agent"`, on the base or in an agent's profile): the agent has one
sandbox, `<root>/agents/<agent>/` and one VM, whatever the chat: an agent with the context of
everything (a librarian, a team's notebook). Not the default: every chat it is in sees and changes the
same files.

The chat key is any string, so the directory is its hex SHA-256 (64 characters): never a path of its
own, never two chats in one. An empty key is refused (`resolve` throws, the tool call fails, nothing
is made). `agent` must be a safe directory name, lowercase: `^[a-z0-9_-]{1,128}$` (refused the same
way), so two agents never share a directory on a case-insensitive filesystem (agent names, and
execution-serve's `_<sandbox>`, are lowercase). It also chooses the machine: the profile in `agents`
whose key is exactly `agent`, else the base. An agent name outside the agent grammar
(execution-serve's `_<sandbox>` for a request that names no agent) never matches a profile, so it gets
the base.

**Behind execution-serve** (a sandbox host), the ref has no origin: the chat is its key,
`execution-serve:<sandbox>`, so each remote sandbox is a chat of its own, and execution-remote already
chooses the sandbox per chat and agent (per Durable Object and agent on Cloudflare). With
`workspace: "agent"` in the host's config, the host gives that agent one workspace across every
sandbox: the decision lives in one place, the host's profiles.

**Several conversations in one sandbox.** A sandbox is shared by every conversation that resolves it:
a reset and the conversation before it, a parent and its same-agent children (running in parallel
with `delegate`'s background tasks), and with `workspace: "agent"` every chat. Their commands run at
once in the same VM and the same `/workspace`; nothing serializes them. Parallel tasks of one agent in
one chat should each work in a subfolder of their own, or a git worktree (`git worktree add
task-<id>`), never all at the top.

## What a sandbox is

```
<root>/chats/<chat>/<agent>/                           /workspace in the guest: that agent's files in that chat
<root>/.execution-gondolin-tmp/chats/<chat>/<agent>/   /tmp/pikit in the guest: temporary files, spilled output
<root>/agents/<agent>/                                 /workspace of an agent with workspace: "agent" (every chat)
<root>/.execution-gondolin-tmp/agents/<agent>/         its /tmp/pikit
<root>/default/                                        /workspace of `execution`'s sandbox
<root>/.execution-gondolin-tmp/default/                its /tmp/pikit
```

`<chat>` is the hex SHA-256 of the chat's key. Earlier versions kept `<root>/conversations/...`: those
directories are left as they are, used by nothing (no migration).

`root` is `.pikit/gondolin` by default (in `pikit-state` on Docker). `/workspace` is a Gondolin VFS
mount (`RealFSProvider`) over the host directory, so the files outlive the VM, and a snapshot of a
chat is the host's alone
([features/workspace-snapshots.md](https://github.com/ajarellanod/pikit/blob/main/features/workspace-snapshots.md)).
`<root>/.execution-gondolin-tmp` is emptied at start (no VM and no tool refers to an earlier
process's), and `<root>/.execution-gondolin-image/` holds the images with `packages` (below), whose
checkpoints of an older Gondolin image are removed when a new one is made: the only things this
component deletes, unless `retentionDays` is set ("Retention" below). Start refuses a `root` that is the working directory, one of its ancestors, or `/`.

Each directory from `root` down to a sandbox's two (`chats`, `<chat>`, `<agent>`, or `agents`,
`<agent>`, and their counterparts under `.execution-gondolin-tmp`) must be a directory of its own,
checked with `lstat` at every `resolve` and made one at a time. A guest whose `/workspace` was one of
them (another layout, a directory the operator moved) may have left the next one as a link,
`developer -> /`: followed, the agent's VM (Gondolin resolves its mount's links) and the file tools
would work on the link's target. A link or a file on the way refuses the sandbox: `resolve` throws
naming the agent, the chat (or "one for every chat") and the path under `root`, nothing is mounted or
made through it. Move it away to use that sandbox; the chat's other agents are not affected. `root`
itself is yours, and may be a link.

The process keeps at most 64 idle sandboxes (one chat's agent each, or a shared agent's) built (and every one with
a VM or a command running); an idle one past that is dropped, least recently resolved first, and
rebuilt at its next `resolve`, its files untouched.

- **Files without a VM.** `read`, `write`, `edit` and every `FileSystem` method work on the host
  directories directly, with Pi's own `NodeExecutionEnv` underneath: a sandbox that never runs a
  command never boots a VM. Paths are the guest's (`cwd` is `/workspace`, results say
  `/workspace/...`), so the file tools and the shell agree; errors never show host paths.
- **What the file tools change, the next command sees.** Gondolin's mount caches what the guest saw:
  entries and attributes for about a second in the guest, and directory listings in the host for five
  seconds (longer while the guest keeps listing), cleared only by the guest's own changes. So each
  directory a file method changed (the path, and its directories up to the mount) is synced before the
  sandbox's next command: a directory made and removed in it clears Gondolin's listing, and the guest
  kernel drops its cached entries (a few milliseconds, only after a change). Without it, `git add -A`
  right after the `write` tool could miss the new file, or commit an old size of an edited one.
- **Confined.** A file tool reaches `/workspace` and `/tmp/pikit` only. A path, or a symbolic link the
  guest made, that leads elsewhere is refused (`permission_denied`): links are resolved as the guest
  resolves them (an absolute target is a guest path), so `ln -s / root` or a guessed host path gives
  the file tools nothing. In the guest, the kernel resolves links in the guest's own filesystem, and
  Gondolin's `RealFSProvider` refuses those that lead outside the mount on the host.
- **A VM per sandbox, only while it is used.** It boots at the first command (about a second once the
  image is cached), serves the next ones, and is closed after `idleSeconds` with no command running.
  What a command wrote outside `/workspace` and `/tmp/pikit` (`apk add`, `/root`) goes with it.
- **The image.** Gondolin's (Alpine with bash, curl, wget, python3 and node), or, with `packages`, a
  checkpoint of it with those Alpine packages added: made at the first boot that needs it (a VM whose
  only reachable host is `dl-cdn.alpinelinux.org` runs `apk add`, a few seconds), kept in
  `<root>/.execution-gondolin-image/` by the image's build id and the packages, and every VM starts
  from it (copy-on-write: nothing a VM writes reaches it). Each machine (the base, an agent's profile)
  with its own packages has its own checkpoint; making one removes the files of another Gondolin
  build and every partial one of another process, never another machine's checkpoint. A partial one
  is removed even while a live process writes it (two servers sharing a `root`): that build then
  fails, and is made again at its next command. The VM that makes an image is not the pool's: it does
  not count against `maxVms` (one per distinct set of packages, once). `git` is added whenever
  `proposals` is installed. If `apk add` fails (no route to the mirror), the command answers
  `shell_unavailable` saying why, and the next one tries again; the image's root disk has about 80 MB
  free once git is in.
- **Bounded.** At most `maxVms` VMs run at once, every agent's together (an image build's VM, above,
  is not counted). A new one closes the VM idle
  the longest; when all are running commands, the command waits up to `queueSeconds`, then fails with
  `spawn_error`, saying all `maxVms` were busy. A VM that fails to boot is not kept (the command answers
  `shell_unavailable`, with the reason); the next command tries again.
- **Commands.** A string runs in the guest's `bash` (sh if the image had none), an argv as its program
  with its arguments unparsed. The output streams to `onOutput` as it comes, per stream, all of it
  (`window` is not used: nothing is skipped); past `spill`'s thresholds the whole output also goes to
  a file in `/tmp/pikit`, readable by the tools and the shell. A missing working directory or program
  is a `spawn_error`. A timeout, the call's cancellation, a throwing `onOutput` or `cleanup` kill the
  command and every process it started (its process group, `setsid`). The VM's boot does not count
  against `timeout`; cancelling the call stops waiting for it. No method throws.
- **Variables.** A command starts with the guest's own (`HOME`, `PATH`, Gondolin's CA bundle
  variables, the secrets' placeholders) plus its `env`; with `inheritEnv: false`, only its `env`. No
  variable of the server reaches the guest.
- `watch` is `not_supported`, as in execution-do: the agent's own tools and commands change these
  files, and pikit reloads nothing from them.
- `stop()` closes every VM; a command still running then fails.

## Retention

A chat's workspace is ephemeral: what must last is saved on purpose elsewhere. With
`retentionDays: N`, a chat's sandboxes (`<root>/chats/<chat>/`, every agent's in that chat, with
their temporary files) are deleted once nothing has worked in them for N days. Absent (the
default), nothing is ever deleted: deleting what agents wrote must be asked for.

- **What counts as use**: a `resolve` of one of the chat's sandboxes, which the runtime makes for
  every tool call (a command, a file read or written) and execution-serve for every request. It is
  noted in memory at once, and in a marker, `<root>/.execution-gondolin-used/<chat>`, holding the
  time on the app's clock, written at most once an hour per chat. The marker outlives restarts, is
  out of every guest's reach (a guest can change its own directory's times: `touch /workspace`), and
  is on the app's clock, not the filesystem's (a restore or a copy that resets file times changes
  nothing). A chat with no marker (from before `retentionDays` was set) starts its count when a sweep
  first sees it.
- **When**: a sweep at start (in the background: start does not wait for it), then every hour.
  `stop` ends it.
- **Never in use**: a chat is kept while one of its sandboxes has a VM up (until `idleSeconds` after
  its last command), a command running, or a file operation in flight, and while this process used
  it within the period. The check and the retirement's mark are one synchronous step, and so are a
  `resolve`'s note of its use and its look for a retirement: a `resolve` either comes first (the
  chat is kept) or waits for the retirement, which renames the directories away, and then works in a
  new, empty workspace; never in a half-deleted one. The renamed directories are measured and
  removed in `<root>/.execution-gondolin-tmp/retired/` (emptied at start too, so a crash in the
  middle leaves nothing).
- **Never swept**: `workspace: "agent"` sandboxes (`<root>/agents/<agent>/`, an agent's long-lived
  files across chats) and `default` (`execution`'s).
- **Logged** at `info` when something was deleted: how many chats, how many bytes; never a chat's
  key, hash or a file's name. Every sweep logs its counts at `debug`.
- **Behind execution-serve**, each remote sandbox id is a chat (`execution-serve:<id>`), so
  `retentionDays` in the sandbox host's config deletes the remote sandboxes nobody used for N days;
  the client (execution-remote) finds an empty workspace at its next use.

The live state is this process's: two servers sharing a `root` do not see each other's commands,
only each other's markers (at most an hour late).

## Machines per agent

Each agent may get its own machine: `agents` maps an agent's name (`ConversationRef.agent`, in the
agent grammar `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 100 characters; any other key is refused at
start) to a profile of `packages`, `allowedHosts`, `secrets`, `memory`, `cpus` and `workspace`. The 100-character
limit is this component's own: `defineAgent` in `@pikit/contracts` has none, so an agent with a
longer name cannot have a profile (it gets the base, and past 128 characters `resolve` refuses it,
above). A secret's name is a variable name, never
`__proto__`, `constructor` or `prototype` (refused at start).

- **Field by field.** A field the profile sets replaces the base's (its `allowedHosts` are not added to
  the base's); a field it leaves out is the base's. What the configuration shows is what the agent gets.
  Its reachable hosts are its `allowedHosts` plus its own secrets' hosts; its packages, its `packages`
  plus `git` with `proposals`. `root`, `idleSeconds`, `maxVms`, `queueSeconds` and `retentionDays`
  are global only (a profile with one is refused).
- **The base for anyone else.** An agent `agents` does not name (a misspelled key too) gets the base:
  with the default base, no secret and no network. It fails closed. `execution`'s own sandbox
  (`default`) always gets the base.
- **A misspelled key** is warned of at start in an App that provides `agent.definition`s (a profile no
  agent has). A sandbox host (`execution-serve`'s App) knows no agents, so it cannot warn. Live agents
  (`agent.directory`, agents-live: made in the dashboard) are not checked: this component cannot use
  `agent.directory` without a dependency cycle (agents-live uses every `agent.tool`, and tool-bash uses
  `execution.shell`, this component's). So the warning says the profile may be a live agent's: a
  profile for one is warned of, and still works.

## Network and secrets (SPEC C7)

- **Denied by default.** The guest reaches, over HTTP and HTTPS only, the hosts in its machine's
  `allowedHosts` (Gondolin's patterns: `api.github.com`, `*.npmjs.org`) and those of its machine's
  secrets. Gondolin is the guest's whole network: no raw TCP, no UDP but DNS (answered by the host,
  synthetic), no SSH, private ranges blocked; a host not allowed is answered `403` by the host itself. TLS is intercepted by the
  host (its CA is trusted in the guest) so it can apply the policy.
- **Secrets the guest never holds.** For each `{ name, hosts }` in its machine's `secrets`, the
  guest's `$NAME` is a placeholder. The host replaces it with the real value in the headers (also
  `Authorization: Basic`) of requests to `hosts`, and refuses a request that sends it elsewhere. Request bodies, URLs and
  responses are not rewritten. The value is read through the `secrets` capability when a VM boots and
  again at each command: a rotated value is used from the next command on, and requests that still
  carry the old one are refused. A secret not set when the VM boots is left out of that VM until its
  next boot (a warning names it); one unset later is removed from the running VM. No value is logged:
  messages name secrets, never their values.
- **Only its machine's secrets.** The values of every configured secret (the base's and every
  profile's) are read through `secrets`, but a VM boots with its machine's alone, and a rotation only
  updates or removes the ones it booted with: a VM never gains a secret, so an agent never holds
  another agent's, not even through a delegation (the child works in a VM of its own). The warning for
  an unset secret names only the VM's own. Start refuses when any secret, the base's or a profile's,
  is configured without a `secrets` provider.

## Proposals (self-improvement on a server)

With `proposals` installed (proposals-local), the steward proposes from a VM as from any shell:
`git clone file://<the repository's path> project`, a branch `pikit/self/<topic>`, `git push`. The path
is not in the VM: the guest's `/etc/gitconfig` rewrites that URL to `http://proposals.pikit.internal/project.git`,
a host that exists only in the guest's network, and this component answers its requests in the host,
with the repository's `serve` (proposals-local's `serve.ts`): they never leave the machine, and need no
entry in `allowedHosts`. The guest can clone and fetch, and push branches under the prefix; a push to
main, another ref or a deletion is refused (`remote: pushing to main is refused: …`). The repository
and the operator's decisions (`.pikit/self/`) are not mounted, so the approval in the dashboard is the
operator's alone: a lock (proposals-local's README, "Security"). The same gitconfig gives git an
identity (`pikit agent <agent@pikit.invalid>`) and takes the workspace's files (the host user's) as
the guest's own. A VM that booted before the repository existed (before the deployer's first run) gets
the rewrite at its next boot.

## Config

```ts
"execution-gondolin": {
  root: ".pikit/gondolin",   // default; relative to the server's working directory
  idleSeconds: 300,          // default: a VM with no command for this long is closed
  maxVms: 4,                 // default: VMs running at once
  queueSeconds: 60,          // default: how long a command waits when maxVms are all busy
  allowedHosts: [],          // default: no network. ["api.github.com", "*.npmjs.org"]
  secrets: [],               // [{ name: "GITHUB_TOKEN", hosts: ["api.github.com"] }]; values in `secrets` (.env)
  memory: "1G",              // default: each VM's memory (QEMU syntax: "512M", "2G")
  cpus: 2,                   // default: each VM's CPUs
  packages: [],              // Alpine packages added to the image, once (git comes with `proposals`)
  workspace: "chat",         // default: a sandbox per chat and agent; "agent": one per agent, every chat
  agents: {},                // default: a machine per agent, each field replacing the base's
  // retentionDays: 30,      // absent by default (kept forever): delete a chat's sandboxes unused this many days
}
```

`allowedHosts`, `secrets`, `memory`, `cpus`, `packages` and `workspace` are the base machine. A team where the
developer has `gh` and a GitHub token, the analyst Python and Google's APIs, and no other agent either:

```ts
"execution-gondolin": {
  agents: {
    developer: {
      packages: ["github-cli"],
      secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }],
      allowedHosts: ["objects.githubusercontent.com"],
    },
    analyst: { packages: ["py3-pandas"], allowedHosts: ["*.googleapis.com"], memory: "2G" },
    librarian: { workspace: "agent" }, // one workspace for every chat: the context of everything
  },
}
```

## Docker

deployment-docker's image has no QEMU, and its container no KVM: both are yours to add, in the
project's `Dockerfile` and `compose.yaml`.

- **QEMU in the image**: in the final stage, before `USER bun`, install
  `qemu-system-x86 qemu-utils` (amd64) or `qemu-system-arm qemu-utils` (arm64) with `apt-get`.
- **KVM in the container**: `devices: ["/dev/kvm:/dev/kvm"]` (`docker run --device /dev/kvm`), and,
  since the app runs as `bun`, `group_add: ["<the kvm group's id on the host>"]` (`getent group kvm`).
- **The guest image in the state volume**: `XDG_CACHE_HOME=/app/.pikit/cache` (in `.env` or
  `environment:`), so it is downloaded once, not after every rebuild.

**Without KVM** (no `/dev/kvm`: most cloud VMs without nested virtualization, Docker Desktop on a
Mac), QEMU emulates the VM (TCG): it works, many times slower (boots in tens of seconds, commands
slow). Start logs a warning; `pikit doctor` notes it on a Linux machine. On a Mac, run `pikit dev` on
the Mac itself (HVF) rather than in Docker.

`pikit doctor` checks the machine it runs on: QEMU missing is a problem there, since `pikit dev` would
run no command. A container's QEMU is checked only when the app starts in it (start refuses).

## Decisions

- **Per chat and agent** (the owner's decision, 2026-10-20): the workspace is the agent's in the chat a
  person or a channel opened, so it survives `/new` (the agent sees what its past self wrote there),
  and a delegated child of the same agent works in it on every target, as it already did in a Durable
  Object. Isolation between chats is what closes the hole (another chat's files), and a VM boots with
  its agent's machine, its secrets included, so two agents never share one: a child of another agent
  works in that agent's sandbox of the chat. The VM is cheap and only up while commands run.
- **Shared across chats only when asked** (`workspace: "agent"`): an agent that must know everything
  gets it, at the price of every chat seeing and changing the same files.
- **The chat's key hashed**: keys are arbitrary strings (`telegram:12345`, `gchat:spaces/AAA`), the
  hash is one safe name for any of them.
- **A profile replaces the base field by field**, and an agent with none gets the base: what the
  configuration shows is what the agent gets, and a misspelled name fails closed.
- **`execution` is a sandbox too** (`default`): a tool called outside a conversation (a test, a
  command of the operator) gets a VM of its own, never the host's shell.
- **Files from the host, guest paths everywhere**: no VM for a file tool, and one namespace for the
  tools and the shell. Paths outside the two mounts are refused for the file tools (a command sees the
  whole VM): serving them would need the VM up.
- **Evict the idlest, then queue**: a burst of conversations never fails while some VM is idle; when
  none is, the wait is bounded and the error says what to change.
- **Secret hosts are reachable** without repeating them in `allowedHosts`: a secret whose host is
  blocked would be useless.
- **One image per build and packages**: two machines with different packages each keep their own
  checkpoint; only a newer Gondolin image makes the older ones stale.
- **Gondolin's import.** `registry validate` refuses `@earendil-works/*` outside the adapter, since
  only the adapter imports Pi. Gondolin is Earendil Works' but not Pi (no Pi inside), so the CLI's
  `isPiImport` (`packages/cli/src/registry/imports.ts`) names it as not Pi; the component declares it
  as an npm dependency, as any other.

## Limits and risks

- **Check, then use.** A file tool checks a path, then uses it. A process the guest left running
  (`sleep 9 &` survives its command) could swap a checked directory for a link in between: a narrow
  race, also open to the guest through the mount itself (Gondolin's `RealFSProvider` checks the same
  way). The guest has no host path to aim at but those it guesses.
- **The guest is root in its VM**, and Gondolin's network allows only HTTP(S): SSH, raw TCP and UDP do
  not work.
- **The image with `packages` is made over the network**: its first boot needs
  `dl-cdn.alpinelinux.org` (that VM reaches nothing else). A machine without it boots no VM while
  `packages` (or `proposals`) asks for one: set `packages: []` and leave `proposals` out, or use a
  custom image of Gondolin's (`GONDOLIN_DEFAULT_IMAGE`, `gondolin build`), not configured here.
- **The sync after the file tools' changes** covers the guest's next command, not one already running:
  a command running while the `write` tool changes a file may see the old one.
- **Proposals over `serve` are bounded**: a request (a push's pack) at most 64 MB, and Gondolin keeps
  a response (a clone) in memory, at most 64 MB.
- **A crash leaves QEMU running**: after a `kill -9` of the server, its QEMU processes may outlive it
  (stop closes them; a container restart ends them all).
- **Disk**: a chat's files stay after its VM closes and after a reset, until you remove them, until
  `retentionDays` deletes them ("Retention"), or `workspace-snapshot` moves them, once built. An
  agent's `workspace: "agent"` files are never deleted.
- **One sandbox, several conversations at once**: a reset and the conversation before it, a parent and
  its same-agent children, and with `workspace: "agent"` every chat run commands in one VM and one
  `/workspace`, unserialized ("How a sandbox is keyed" says how parallel tasks keep apart).
- **Bun**: Gondolin targets Node 22; the server runs it on Bun, which the tests below exercise.

## Tests

`execution-gondolin.test.ts` runs without QEMU, over a fake VM layer (`fake-guest.test-support.ts`):
- the `execution` conformance suite on a conversation's environment, files only (`exec` answering
  `shell_unavailable` when no VM boots), the `workspace` suite, and the lifecycle suite;
- files on the host, in the chat's directory, at `/workspace`; no VM for file tools; keyed by chat
  (the origin's key, hashed) and agent: `conversationId` and `channel` choose nothing, a reset
  (`/new`) finds the files and the VM, two chats are apart, two agents of one chat get two directories
  and two VMs; a delegated child (and grandchild) of the same agent in its parent's sandbox, a child of
  another agent in that agent's own of the chat, a child of another chat in that chat's;
  `workspace: "agent"` (a profile's, the base's, a profile's `chat` over the base's) one sandbox at
  `agents/<agent>` for every chat; unsafe agent names (uppercase too) and empty chat keys refused,
  nothing made, and an odd key (`../..`) only a hash; a link or a file on the way from `root` (a
  chat's directory, an agent's, a shared agent's, the temporary ones) refused, nothing made through
  it; the sandbox cache bounded (idle ones dropped and rebuilt with their files, one with a VM kept);
- confinement: absolute paths, `..`, links to host paths, to `/etc`, up and out, loops; writes and
  renames through them refused; a link removed, not its target; no host path in errors;
- `/tmp/pikit` and spill on the host, in `.execution-gondolin-tmp`, emptied at the next start while a
  `tmp` beside it stays; a `root` that is the working directory, holds it, or is `/` refused at start;
- boot at the first command with the right mounts and spec; output per stream across chunk
  boundaries; spawn errors; timeout, cancellation and a throwing `onOutput` kill the command;
  `cleanup`; stop closes every VM; idle close and reboot; eviction at `maxVms`, the bounded queue and
  its message, every profile's VMs counted together; a failed boot not kept; a cancelled boot;
- network and secrets wiring: none by default, `allowedHosts` plus the secrets' hosts, values read at
  boot and at each command, an unset secret left out with a warning, no value in any log;
- machines per agent: the profile chosen by agent, field by field (its `allowedHosts` replacing the
  base's); an agent with none, a misspelled one, `constructor` and `default` on the base (no secret, no
  host); a profile's secret only in its agent's VMs, also after a rotation, and the unset warning only
  for a VM's own; `GondolinGuest.refreshSecrets` (over Gondolin's real secret manager) never adding a
  secret; bad profile keys, global-only fields and secrets named `__proto__`, `constructor` or
  `prototype` refused; the warning for a profile no agent has, only where agents are defined, and no
  cycle with an `agent.directory` provider that uses a tool on `execution.shell`; images of two machines kept side by side (`imageFile`, `staleImages`);
- retention: at start, a chat unused for `retentionDays` loses every agent's sandbox (counts and
  bytes logged, no chat), a fresh one, a shared agent's, `default` and one never noted (its count
  starting) stay, across a restart; without it nothing is noted or deleted, however old; a use
  refreshes the count, the sweep runs hourly on the app's clock and takes the temporary files; a
  chat with a command running or a VM up is kept, and goes once neither; a command issued during the
  start sweep works; a use and a retirement of one chat never overlap (either order); bad values
  and a profile's `retentionDays` refused;
- packages (none by default, `git` first with `proposals`, names refused when not Alpine's), the
  proposals wiring (a `path` remote read at each use), the guest's gitconfig, and the proposals host
  answered by `serve` alone; the sync of what the file tools changed, before the next command, once;
- start refuses without QEMU or without `secrets` (a profile's secret too), warns without KVM;
  doctor's check.

`gondolin.test.ts` runs over real VMs where QEMU is installed (skipped, saying so, elsewhere): the
whole `execution` conformance suite with a real shell (pi-durable's cases too: argv, streams,
timeouts, symbolic links), a chat's shell seeing none of another's files nor the host's, the
network closed (403), a secret's placeholder in the guest, a timeout killing what the command started,
and an idle VM closed while its files stay for the next one, and for a reset of the chat.

`proposals.test.ts` (a repository test, not copied: it composes proposals-local) runs over real VMs
too: `createWorkspaceGitConformance`, the steward's git flow against proposals-local's repository
through `serve`, with git in the image; and the lock: a push to main or a deletion refused, main
unmoved, the repository and the decisions out of the guest's reach, and the pushed branch a proposal
the operator approves.

`component.json` is generated from `setup` by `pikit registry generate`; the test "what setup
declares" pins it.
