# execution-gondolin

Each conversation's tools work in a Linux micro-VM of its own ([Gondolin](https://github.com/earendil-works/gondolin),
over QEMU): a real shell that cannot read the server's files or another conversation's, with its files
on the host, no network but the hosts you allow, and secrets the guest never sees.

- **Provides:** `workspace` (a sandbox per conversation), and `execution` and `execution.shell` (one
  more sandbox, `default`, for a tool called outside a conversation). All are pi-durable's `ExecutionEnv`.
- **Uses if present:** `secrets` (required once `secrets` is configured: start refuses without it).
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
runs as root of a VM that holds only its conversation's files: the host's are not mounted, and its
network reaches only what you allow.

## How a sandbox is keyed

**By `ConversationRef.conversationId` alone.** `key`, `agent` and `channel` do not choose the sandbox:
the same `conversationId` resolved under another key or agent is the same sandbox (`agent` only names
the VM in `gondolin list`). For a component that builds a `ConversationRef` itself (`execution-serve`,
from a remote sandbox id), `conversationId` must be:

- **unique** among everything that resolves a workspace through this App, including pikit's own
  conversations, whose ids the runtime numbers (`"1"`, `"2"`…): prefix a remote id (`remote-<id>`);
- **a safe directory name**: `^[A-Za-z0-9_-]{1,128}$`. Anything else is refused: `resolve` throws, so
  the tool call fails, and nothing is made on disk.

Why `conversationId` and not `key`: pikit's runtime gives a reset conversation (`/new`) a new
`conversationId` under the same key, so a new conversation starts with a new, empty workspace, as it
starts with a new transcript. The previous conversation's files stay on the host under its id.

## What a sandbox is

```
<root>/conversations/<conversationId>/                           /workspace in the guest: the conversation's files
<root>/.execution-gondolin-tmp/conversations/<conversationId>/   /tmp/pikit in the guest: temporary files, spilled output
<root>/default/                                                  /workspace of `execution`'s sandbox
<root>/.execution-gondolin-tmp/default/                          its /tmp/pikit
```

`root` is `.pikit/gondolin` by default (in `pikit-state` on Docker). `/workspace` is a Gondolin VFS
mount (`RealFSProvider`) over the host directory, so the files outlive the VM, and a snapshot of a
conversation is the host's alone
([features/workspace-snapshots.md](https://github.com/ajarellanod/pikit/blob/main/features/workspace-snapshots.md)).
`<root>/.execution-gondolin-tmp` is emptied at start (no VM and no tool refers to an earlier
process's): the only directory this component deletes. Start refuses a `root` that is the working
directory, one of its ancestors, or `/`.

The process keeps the sandboxes of at most 64 idle conversations built (and every one with a VM or a
command running); an idle one past that is dropped, least recently resolved first, and rebuilt at its
next `resolve`, its files untouched.

- **Files without a VM.** `read`, `write`, `edit` and every `FileSystem` method work on the host
  directories directly, with Pi's own `NodeExecutionEnv` underneath: a conversation that never runs a
  command never boots a VM. Paths are the guest's (`cwd` is `/workspace`, results say
  `/workspace/...`), so the file tools and the shell agree; errors never show host paths.
- **Confined.** A file tool reaches `/workspace` and `/tmp/pikit` only. A path, or a symbolic link the
  guest made, that leads elsewhere is refused (`permission_denied`): links are resolved as the guest
  resolves them (an absolute target is a guest path), so `ln -s / root` or a guessed host path gives
  the file tools nothing. In the guest, the kernel resolves links in the guest's own filesystem, and
  Gondolin's `RealFSProvider` refuses those that lead outside the mount on the host.
- **A VM per sandbox, only while it is used.** It boots at the first command (about a second once the
  image is cached), serves the next ones, and is closed after `idleSeconds` with no command running.
  What a command wrote outside `/workspace` and `/tmp/pikit` (`apk add`, `/root`) goes with it.
- **Bounded.** At most `maxVms` VMs run at once. A new one closes the VM idle the longest; when all
  are running commands, the command waits up to `queueSeconds`, then fails with `spawn_error`, saying
  all `maxVms` were busy. A VM that fails to boot is not kept (the command answers
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

## Network and secrets (SPEC C7)

- **Denied by default.** The guest reaches, over HTTP and HTTPS only, the hosts in `allowedHosts`
  (Gondolin's patterns: `api.github.com`, `*.npmjs.org`) and those of its secrets. Gondolin is the
  guest's whole network: no raw TCP, no UDP but DNS (answered by the host, synthetic), no SSH, private
  ranges blocked; a host not allowed is answered `403` by the host itself. TLS is intercepted by the
  host (its CA is trusted in the guest) so it can apply the policy.
- **Secrets the guest never holds.** For each `{ name, hosts }` in `secrets`, the guest's `$NAME` is a
  placeholder. The host replaces it with the real value in the headers (also `Authorization: Basic`) of
  requests to `hosts`, and refuses a request that sends it elsewhere. Request bodies, URLs and
  responses are not rewritten. The value is read through the `secrets` capability when a VM boots and
  again at each command: a rotated value is used from the next command on, and requests that still
  carry the old one are refused. A secret not set when the VM boots is left out of that VM until its
  next boot (a warning names it); one unset later is removed from the running VM. No value is logged:
  messages name secrets, never their values.

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

- **Per conversation, not per agent**: isolation between conversations is what closes the hole
  (another conversation's files); the VM is cheap and only up while commands run.
- **`execution` is a sandbox too** (`default`): a tool called outside a conversation (a test, a
  command of the operator) gets a VM of its own, never the host's shell.
- **Files from the host, guest paths everywhere**: no VM for a file tool, and one namespace for the
  tools and the shell. Paths outside the two mounts are refused for the file tools (a command sees the
  whole VM): serving them would need the VM up.
- **Evict the idlest, then queue**: a burst of conversations never fails while some VM is idle; when
  none is, the wait is bounded and the error says what to change.
- **Secret hosts are reachable** without repeating them in `allowedHosts`: a secret whose host is
  blocked would be useless.
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
- **The guest image is Gondolin's default** (Alpine with bash, curl, wget, python3 and node; no
  `git`). `apk add` needs the Alpine mirrors in `allowedHosts`, and is lost when the VM closes; `git`
  over HTTPS would need its host there too (and a token in `secrets`). So the steward's git flow
  (`createWorkspaceGitConformance`) is not run here. A custom image is Gondolin's
  (`GONDOLIN_DEFAULT_IMAGE`, `gondolin build`), not configured here.
- **A crash leaves QEMU running**: after a `kill -9` of the server, its QEMU processes may outlive it
  (stop closes them; a container restart ends them all).
- **Disk**: a conversation's files stay after its VM closes, until you remove them (or
  `workspace-snapshot` moves them, once built).
- **Bun**: Gondolin targets Node 22; the server runs it on Bun, which the tests below exercise.

## Tests

`execution-gondolin.test.ts` runs without QEMU, over a fake VM layer (`fake-guest.test-support.ts`):
- the `execution` conformance suite on a conversation's environment, files only (`exec` answering
  `shell_unavailable` when no VM boots), the `workspace` suite, and the lifecycle suite;
- files on the host, in the conversation's directory, at `/workspace`; no VM for file tools; keyed by
  `conversationId` alone; unsafe ids refused; the sandbox cache bounded (idle ones dropped and rebuilt
  with their files, one with a VM kept);
- confinement: absolute paths, `..`, links to host paths, to `/etc`, up and out, loops; writes and
  renames through them refused; a link removed, not its target; no host path in errors;
- `/tmp/pikit` and spill on the host, in `.execution-gondolin-tmp`, emptied at the next start while a
  `tmp` beside it stays; a `root` that is the working directory, holds it, or is `/` refused at start;
- boot at the first command with the right mounts and spec; output per stream across chunk
  boundaries; spawn errors; timeout, cancellation and a throwing `onOutput` kill the command;
  `cleanup`; stop closes every VM; idle close and reboot; eviction at `maxVms`, the bounded queue and
  its message; a failed boot not kept; a cancelled boot;
- network and secrets wiring: none by default, `allowedHosts` plus the secrets' hosts, values read at
  boot and at each command, an unset secret left out with a warning, no value in any log;
- start refuses without QEMU or without `secrets`, warns without KVM; doctor's check.

`gondolin.test.ts` runs over real VMs where QEMU is installed (skipped, saying so, elsewhere): the
whole `execution` conformance suite with a real shell (pi-durable's cases too: argv, streams,
timeouts, symbolic links), a conversation's shell seeing none of another's files nor the host's, the
network closed (403), a secret's placeholder in the guest, a timeout killing what the command started,
and an idle VM closed while its files stay for the next one.

`component.json` is generated from `setup` by `pikit registry generate`; the test "what setup
declares" pins it.
