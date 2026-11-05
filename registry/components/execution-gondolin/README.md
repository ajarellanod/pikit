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
  An `image: { packages }` ("The image") is built on this machine: e2fsprogs (`mke2fs`), `lz4` and
  `cpio` too (`brew install e2fsprogs lz4`; `apt install e2fsprogs lz4 cpio`).
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
process's), and `<root>/.execution-gondolin-image/` holds the images built here and the checkpoints
with `packages` ("The image"), of which those no machine of the configuration uses are removed when
a new one is made: the only things this component deletes, unless `retentionDays` is set
("Retention" below). Start refuses a `root` that is the working directory, one of its ancestors, or `/`.

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
- **The image.** The machine's ("The image" below: Gondolin's, one you built, or one built here from
  a list of Alpine packages), or, with `packages`, a checkpoint of it with those Alpine packages
  added: made at the first boot that needs it (a VM whose only reachable host is
  `dl-cdn.alpinelinux.org` runs `apk add`, a few seconds), kept in
  `<root>/.execution-gondolin-image/` by the image's build id, the packages and `rootfsSize`, and
  every VM starts from it (copy-on-write: nothing a VM writes reaches it). Each machine (the base, an
  agent's profile) with its own packages has its own checkpoint; making one removes the checkpoints
  of a build no machine of the configuration boots (an older Gondolin image, an image you replaced)
  and every partial one of another process, never another machine's checkpoint. A partial one
  is removed even while a live process writes it (two servers sharing a `root`): that build then
  fails, and is made again at its next command. The VM that makes an image is not the pool's: it does
  not count against `maxVms` (one per distinct set of packages, once). `git` is added whenever
  `proposals` is installed. If `apk add` fails (no route to the mirror), the command answers
  `shell_unavailable` saying why, and the next one tries again. Gondolin's image leaves about 80 MB
  free on its root disk once git is in: `rootfsSize` gives more.
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

## The image

Each machine (the base, or an agent's profile, field by field) boots the image its `image` names,
with its `packages` over it, on a root disk of at least `rootfsSize`:

| `image` | What boots | Made by |
|---|---|---|
| absent (the default) | Gondolin's (`alpine-base:latest`, or `GONDOLIN_DEFAULT_IMAGE`): Alpine 3.23 with bash, curl, python3, uv, node and npm | Gondolin: downloaded at the first boot |
| a string, `"designer:1"` | an image you built with Gondolin, by its selector: a `name:tag` of its local store (`gondolin build --config designer.json --tag designer:1`), a build id, or an asset directory (relative to the server's working directory) | you: any build config Gondolin takes (an OCI image as the base, `postBuild` commands, its own `rootfs.sizeMb`) |
| `{ packages: [...] }` | Gondolin's default build with those Alpine packages added to its rootfs | this component, on the host, at the first start that needs it |

- **Built once, by its content.** An `image: { packages }` is built by Gondolin's builder
  (`buildAssets`) in the server's process, without a VM: the packages come from
  `dl-cdn.alpinelinux.org`, Gondolin's guest helpers from its release, both cached in
  `~/.cache/gondolin/`. It is kept in `<root>/.execution-gondolin-image/build-<digest>/`, the digest of
  Gondolin's version and the whole build config (Gondolin's default for this architecture, the
  packages sorted, each once), written to `build-<digest>.<pid>.partial/` and renamed when complete.
  Every later start finds it and builds nothing; two machines with the same packages, in any order,
  share one. A changed list is another image, built at the next start; once it is built, the images
  no machine uses any more, and every partial build of another process, are removed. Reproducible as
  a config, not bit for bit: the same Gondolin and packages build the same image up to the Alpine
  branch's updates, under another build id.
- **Checked at start.** Every machine's image is found, or built, before the app starts. A selector
  that names no image, an image built for another architecture, a build that fails (a misspelled
  package: Alpine's own message), or an image without a build id under `packages` refuses the start
  with one error naming the machines that use it: `execution-gondolin: the image of agent "designer"
  ("designer:1") cannot be used: ...`. A start that builds waits for it, logged at `info` before and
  after (with the time). A selector is resolved at start: a retagged `designer:1` boots from the next
  start on.
- **`packages` over it** stay a checkpoint ("What a sandbox is"), now of the machine's image: for a
  few small packages. Put the big ones in `image: { packages }`: built on the host, no mirror at the
  first command, no checkpoint VM.
- **`rootfsSize`** (`"4G"`; M or G) is Gondolin's `rootfs.size`: each VM's copy-on-write root disk is
  made that large and the guest's filesystem grown at boot (`resize2fs`: Gondolin's images and those
  built here have it; an image of yours without it fails to boot, saying so). Sparse: the host keeps
  only what a VM writes, gone with the VM. The VM that makes a `packages` checkpoint gets it too, so
  packages larger than the image's free space fit (it is part of the checkpoint's name). Without it, a
  built image's disk is its content plus a fifth and 64 MB (Gondolin's sizing): little room for
  renders outside `/workspace`.
- **Gondolin's limits.** Alpine only for `{ packages }` (Gondolin builds Alpine rootfs; an OCI base
  or `postBuild` commands are `gondolin build`'s, so a selector's). An image of the host's
  architecture only (QEMU would emulate another: refused). The files of a built image belong to the
  user that built it (as in Gondolin's own image); commands run as root.

### A designer: Chromium, ffmpeg, ImageMagick

```ts
"execution-gondolin": {
  agents: {
    designer: {
      image: { packages: ["chromium", "ffmpeg", "imagemagick", "font-noto"] }, // node is Gondolin's
      rootfsSize: "4G", // room outside /workspace (Chromium's profiles, ffmpeg's temporary files)
      memory: "2G",     // two headless Chromiums at once; "4G" and cpus: 4 for four
      cpus: 2,
    },
  },
}
```

Its network stays closed: Chromium renders local files (its own attempts to reach Google are refused
by Gondolin, and harmless). The agent writes `banner.html`, a page that draws frame `#n` from its URL:

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 628px; overflow: hidden; }
  body { font-family: "Noto Sans", sans-serif; background: linear-gradient(135deg, #0f172a, #1e3a8a); color: white; }
  h1 { position: absolute; top: 220px; font-size: 96px; margin: 0; white-space: nowrap; }
  p { position: absolute; top: 360px; left: 80px; font-size: 40px; margin: 0; }
</style></head><body>
<h1 id="title">Launch day</h1><p id="tag">pikit, on small machines</p>
<script>
  // The frame comes in the URL (#0 to #23): every frame is rendered from its number alone.
  const t = Number(location.hash.slice(1) || 0) / 23;
  document.getElementById("title").style.left = `${-700 + t * 780}px`;
  document.getElementById("tag").style.opacity = String(Math.max(0, t * 2 - 1));
</script></body></html>
```

and runs `JOBS=2 sh render.sh` in its `/workspace`: 24 PNG frames, then an MP4 and a GIF.

```sh
#!/bin/sh
# banner.html -> 24 PNG frames (headless Chromium) -> banner.mp4 and banner.gif (ffmpeg).
set -e
mkdir -p frames
seq 0 23 | xargs -P "${JOBS:-2}" -I{} chromium-browser --headless --no-sandbox --disable-gpu \
  --disable-dev-shm-usage --disable-background-networking --disable-component-update --no-first-run \
  --user-data-dir=/tmp/chromium-{} --hide-scrollbars --window-size=1200,628 \
  --screenshot=frames/{}.png "file://$PWD/banner.html#{}" 2>/dev/null
ffmpeg -loglevel error -y -framerate 12 -i frames/%d.png -c:v libx264 -pix_fmt yuv420p banner.mp4
ffmpeg -loglevel error -y -framerate 12 -i frames/%d.png \
  -vf "scale=600:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" banner.gif
```

`--no-sandbox` because commands run as root (the VM is the sandbox); a `--user-data-dir` each, or
parallel Chromiums share one profile and fail. ImageMagick (`magick`) is there for stills
(`magick frames/23.png -resize 600x banner.jpg`).

**Measured** (2026-11-05, Apple M3, macOS 27 with HVF, QEMU 11.1.2, Gondolin 0.13.0, through this
component unless said):

| | |
|---|---|
| Build, first on the machine (Alpine's minirootfs, every package and Gondolin's helpers downloaded) | 42 s |
| Build, Gondolin's cache warm (another list, or another `root`) | 7.6 to 8.7 s |
| Start with the image built (found, nothing built) | 5 ms |
| The image | 857 MB on disk (`rootfs.ext4` 1.07 GB); Gondolin's own: 324 MB |
| First boot (the first command) | 0.6 to 0.7 s |
| The render above, 2 CPUs and 2G, `JOBS=2`, in `/workspace` | 9.5 s (7.7 s in `/root`: `/workspace` is a VFS mount) |
| The same in Gondolin directly, 4 CPUs and 4G, `JOBS=4`, in `/root` | 4.8 s |
| Memory in use after a render | 194 MB of 2G (the peak while the Chromiums run was not measured) |

**On Linux with KVM** the same build runs natively (no container: `{ packages }` has no `postBuild`)
and boots with KVM in about the same time; not measured here. Without KVM (most cloud VMs without
nested virtualization, Docker Desktop) QEMU emulates (TCG): boots take tens of seconds and Chromium
is many times slower, too slow for renders. In Docker, the image needs `e2fsprogs lz4 cpio` besides
QEMU ("Docker"), and `XDG_CACHE_HOME` in the state volume keeps Gondolin's build cache.

**Behind execution-serve** (a sandbox host): the same profile goes in the host's
`"execution-gondolin"` config (execution-serve's README, "A sandbox host"); the clients change
nothing: execution-remote names each request's agent (`Pikit-Agent: designer`), so the designer's
sandboxes boot the image and every other agent's the base. The host builds the image at its first
start (it needs the builder's tools and the two hosts above then; never afterwards) and refuses to
start without it. Budget the host's memory as `maxVms` times the largest `memory`: a 16 GB host with
`maxVms: 4` takes four designers at 2G with room for itself. The render's files stay in the sandbox's
`/workspace` on the host; the agent's file tools reach them through execution-remote (within
execution-serve's limits: a read of 4 MiB at most).

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
  first sees it. Since the marker may lag the last use by up to an hour, a chat whose process
  restarted meanwhile may go up to an hour before N days have passed.
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

## Snapshots (disposable hosts)

With `snapshots` and a `storage.blob` (storage-blob-s3: AWS S3, R2, GCS through its XML API with HMAC
keys, MinIO), a chat's sandbox of an agent (its `/workspace`) unused for `idleMinutes` (10) is saved
to the bucket and deleted here; the next `resolve` of that chat and agent (the runtime's next tool
call, execution-serve's next request) restores it before anything runs. A host then holds only the
workspaces in use: replace it, and the next host restores each chat's from the bucket.

- **The format is shared** ([features/workspace-snapshots.md](https://github.com/ajarellanod/pikit/blob/main/features/workspace-snapshots.md), `@pikit/contracts`' `workspace-snapshot.ts`):
  namespace `workspace-snapshots`, keys under the hex SHA-256 of `"<chat key>\n<agent>"`, a gzip'd
  tar `snapshot-<ms>-<sha16>.tar.gz`, then `manifest.json` written last. workspace-local and the
  other backends write the same, so one restores what another saved.
- **Never while a VM holds it.** The sandbox's VM is closed first if no command runs (a VM up only
  for `idleSeconds` would else keep it); a sandbox with a command or a file operation running is
  kept; a VM booted while the checkpoint runs keeps it too. `workspace: "agent"` sandboxes and
  `default` are never released: they are shared.
- **Nothing lost on the way**: the directory is deleted only after the manifest naming the new
  archive is written and read back; a failure at any step leaves it, and the next sweep (every
  minute) tries again after `idleMinutes`. A restore checks the archive's SHA-256 and size, extracts
  into a directory of its own, and swaps it in; an archive with a path that would leave the
  workspace (`..`, absolute, a link out) is refused whole, and the tool call fails with nothing
  made. What is kept: files (bytes, modes, times), directories, links that stay inside; not links
  that lead out (absolute ones too: `/workspace/x` is written relative to be kept), owners, sockets.
- **The temporary files go with it** (`/tmp/pikit`). Its own files are in
  `<root>/.execution-gondolin-snapshots/` (archives on their way, restores, the index of the
  workspaces on disk, which a restart reads: each counts as used at start).
- **With `retentionDays`**, the bucket's snapshots whose newest archive is older than N days are
  deleted (hourly, the manifest first), instead of the local directories, which are released anyway.
- **`maxBytes`**: an archive larger stays on the host, a warning logged, until its next use.
- **One writer per chat and agent.** One process holds a sandbox; a second host serving the same
  chat and agent at the same time (execution-remote's `endpoint` changed while the old host still
  holds an unreleased copy) is not coordinated: each host's checkpoint replaces the manifest, the
  last one wins, and the other's files since its restore are lost. Change hosts after the old one
  released its sandboxes (`idleMinutes` without use), or stop it first (a stop releases nothing:
  its unreleased workspaces stay on its disk).

A disposable sandbox host (execution-serve's App) with snapshots in a bucket:

```ts
import { defineApp } from "@pikit/core";
import executionGondolin from "./src/pikit/execution-gondolin/index.ts";
import executionServe from "./src/pikit/execution-serve/index.ts";
import secretsEnv from "./src/pikit/secrets-env/index.ts";
import serverBun from "./src/pikit/server-bun/index.ts";
import storageBlobS3 from "./src/pikit/storage-blob-s3/index.ts";

export default defineApp({
  components: [secretsEnv, storageBlobS3, executionGondolin, executionServe, serverBun],
  config: {
    "server-bun": { port: 3000 },
    // S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in .env. GCS: endpoint https://storage.googleapis.com,
    // region "auto", a service account's HMAC key; R2: https://<account>.r2.cloudflarestorage.com, "auto";
    // AWS: no endpoint, its region; MinIO: http://127.0.0.1:9000.
    "storage-blob-s3": { endpoint: "https://storage.googleapis.com", region: "auto", bucket: "my-sandboxes", prefix: "fleet-1/" },
    "execution-gondolin": { snapshots: { idleMinutes: 10 }, retentionDays: 30 },
  },
});
```

Give the bucket a lifecycle rule that aborts incomplete multipart uploads after a day (a host that
died mid-upload leaves its parts), and no expiration rule on `workspace-snapshots/`: `retentionDays`
deletes a snapshot's manifest before its archive, an expiration rule may not.

## Machines per agent

Each agent may get its own machine: `agents` maps an agent's name (`ConversationRef.agent`, in the
agent grammar `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 100 characters; any other key is refused at
start) to a profile of `packages`, `allowedHosts`, `secrets`, `memory`, `cpus`, `workspace`, `image`
and `rootfsSize`. The 100-character
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
  // image: "designer:1",    // absent by default (Gondolin's): a Gondolin selector you built, or
  //                         //   { packages: ["chromium"] }, built here at start, once ("The image")
  // rootfsSize: "4G",       // absent by default (the image's): each VM's root disk at least this
  workspace: "chat",         // default: a sandbox per chat and agent; "agent": one per agent, every chat
  agents: {},                // default: a machine per agent, each field replacing the base's
  // retentionDays: 30,      // absent by default (kept forever): delete a chat's sandboxes unused this many days
  // snapshots: { idleMinutes: 10, maxBytes: 10e9, namespace: "workspace-snapshots" }, // absent by default: idle chat sandboxes to storage.blob
}
```

`allowedHosts`, `secrets`, `memory`, `cpus`, `packages`, `image`, `rootfsSize` and `workspace` are the base machine. A team where the
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
  checkpoint; only an image no machine boots any more (a newer Gondolin image, one you replaced)
  makes its checkpoints stale.
- **An image per machine, two ways** (2026-11-05): a selector, for whatever `gondolin build` can make
  (an OCI base, `postBuild`), and `{ packages }`, the common case in a few lines, built by Gondolin's
  own builder from its own default config, so the image is Gondolin's plus the packages, and keyed by
  that config and Gondolin's version: never rebuilt for a restart, always rebuilt for a change. Built
  and checked at start, where the operator is looking, rather than at a first command in a chat.
  `packages` stays the checkpoint it was, over either. Not a field per Gondolin option (`env`, `oci`,
  `postBuild`): those are a selector's.
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
  `packages` (or `proposals`) asks for one: set `packages: []` and leave `proposals` out, or put the
  packages in an `image` built where the network is (`gondolin build`, a selector).
- **An image built at start holds the start**: 42 s for the designer's on a cold machine, seconds
  once Gondolin's cache is warm; a start that cannot reach the mirror or Gondolin's release fails
  (once built, nothing is fetched again). Built images take disk under `root` (the designer's:
  857 MB); `gondolin image rm` is for the selectors' store, not these.
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
- images: a machine's `image` and `rootfsSize` in its VMs' spec, field by field (a profile's built
  image, the base's selector under another profile's `packages`, `default` on the base), every
  machine's image in each spec (what a checkpoint keeps); the build config (Gondolin's default plus
  the packages, sorted); two machines with two images side by side, a changed one rebuilt and the
  unused one removed, another machine's image and checkpoints kept, another process's partial
  build removed (`staleBuilds`); a built image found again by the next start and shared by two
  machines (never built twice); a missing selector, a failing build (nothing half-built kept), an
  image with no build id under `packages`, each refusing the start naming its machines; the fields'
  shapes; an image of another architecture refused (`archProblem`); checkpoints of every machine's
  build kept, and the disk size in their names. Each was checked against a mutation (the cache hit
  removed, `staleImages` and `staleBuilds` keeping too little, a profile's `image` or `rootfsSize`
  ignored, the build-id check, the partial's removal dropped): each makes a case fail;
- retention: at start, a chat unused for `retentionDays` loses every agent's sandbox (counts and
  bytes logged, no chat), a fresh one, a shared agent's, `default` and one never noted (its count
  starting) stay, across a restart; without it nothing is noted or deleted, however old; a use
  refreshes the count, the sweep runs hourly on the app's clock and takes the temporary files; a
  chat with a command running or a VM up is kept, and goes once neither; a command issued during the
  start sweep works; a use and a retirement of one chat never overlap (either order); bad values
  and a profile's `retentionDays` refused;
- snapshots (`snapshots.test.ts`): a chat's sandbox idle 10 minutes has its VM closed, its workspace
  in the bucket and deleted here with its temporary files, and the next use restores the same bytes,
  modes and links, the next VM mounting it; a command running keeps it however long, it goes once the
  command ended; a VM booted during the checkpoint keeps it; a shared (`workspace: "agent"`) one never
  goes; a new host (an empty root) restores a chat's from the bucket; refused without `storage.blob`.
  Mutation-checked: without closing the VM first, or without the VM check before the release, a case
  fails;
- packages (none by default, `git` first with `proposals`, names refused when not Alpine's), the
  proposals wiring (a `path` remote read at each use), the guest's gitconfig, and the proposals host
  answered by `serve` alone; the sync of what the file tools changed, before the next command, once;
- start refuses without QEMU or without `secrets` (a profile's secret too), warns without KVM;
  doctor's check.

`gondolin.test.ts` runs over real VMs where QEMU is installed (skipped, saying so, elsewhere): the
whole `execution` conformance suite with a real shell (pi-durable's cases too: argv, streams,
timeouts, symbolic links), a chat's shell seeing none of another's files nor the host's, the
network closed (403), a secret's placeholder in the guest, a timeout killing what the command started,
and an idle VM closed while its files stay for the next one, and for a reset of the chat. And, where
`mke2fs`, `lz4` and `cpio` are on `PATH` too (skipped, saying so, elsewhere), an agent's
`image: { packages: ["ffmpeg"] }` built at start: its VM runs `ffmpeg`, has the 2G root disk asked
for and `jq` from `packages` over the image (a checkpoint of it), the base agent has no ffmpeg, and
a second start on the same `root` builds nothing (7 s with Gondolin's cache warm; dropping
`rootfs.size` or the image's path from Gondolin's options fails it).

`proposals.test.ts` (a repository test, not copied: it composes proposals-local) runs over real VMs
too: `createWorkspaceGitConformance`, the steward's git flow against proposals-local's repository
through `serve`, with git in the image; and the lock: a push to main or a deletion refused, main
unmoved, the repository and the decisions out of the guest's reach, and the pushed branch a proposal
the operator approves.

`component.json` is generated from `setup` by `pikit registry generate`; the test "what setup
declares" pins it.
