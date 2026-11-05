# Workspace snapshots

**Public appeal:** —

**Specified:** partly (the former SPEC §8.1 `WorkspaceRef`; its §8.2 `ref`, `checkpoint`, `release`
and the implementations table, `[planned]`).
**Built** (2026-11-05): snapshots in an S3-compatible bucket, below: `storage.blob` streams
(storage-blob-fs, storage-blob-s3 multipart), the shared format (`@pikit/contracts`), the server's
helper (`@pikit/contracts/snapshots`), `snapshots` in workspace-local and execution-gondolin. Not built:
`workspace-git`, `/reset` semantics, a `WorkspaceRef` in the registry (not needed: below).

**Needed by:** nothing required directly. Self-improvement works in "a git checkout of its project"
(SPEC §6): if that becomes a `workspace-git` provider, that provider belongs to SPEC §6.

## What it gives
A workspace that survives the machine: committed to git or saved as a snapshot, restored when its
conversation comes back, and reset or kept on `/reset`.

## How it fits pikit
- `Workspace` gains `ref`, `checkpoint()` and `release()` with the providers that need them, and the
  conversation registry (`packages/contracts/src/conversations.ts`) keeps the `WorkspaceRef`.
- Providers of `workspace`: `workspace-git` (a clone per session, pushed on checkpoint),
  `workspace-snapshot` (a compressed tar in `storage.blob`: S3, MinIO, R2; the first one, below),
  `workspace-container` (a Cloudflare Container's filesystem with checkpoints). Each needs an
  `execution` with a real filesystem.
- `/reset` honours `workspace: preserve | recreate`.
- An idle conversation holds no workspace open.
- Absent: `workspace-local`'s directories on one disk, as today.

## Built (2026-11-05): what it is now

The owner's picture (2026-11-05): agents run on small machines fitted to them; execution-remote
routes each to a sandbox host (a Gondolin host, a Cloudflare Sandbox Worker, a boat.dev gateway);
workspaces go to a bucket after ten minutes idle and come back on first use, so hosts are disposable.

- **The unit is the workspace as it is keyed today**, a chat's and an agent's
  (`(originOf(ref).key, agent)`, [agent sandboxes](agent-sandboxes.md), [spaces](spaces.md)), not a
  new per-conversation one: a reset and a same-agent delegated child share it, and one process holds
  it, so the "one writer" rule holds for it as it would for a conversation. Shared workspaces
  (execution-gondolin's `workspace: "agent"`, workspace-local's `per: "agent"` and `per: "channel"`)
  are never released.
- **No `WorkspaceRef` in the conversation registry**: the bucket's key is computed from the chat and
  the agent (the hex SHA-256 of `"<chat key>\n<agent>"`), so any host finds a workspace's snapshot
  with nothing but the `ConversationRef` it resolves, and the manifest is the ref.
- **Config** (workspace-local, execution-gondolin):
  `snapshots: { idleMinutes: 10, maxBytes?, namespace? }`, with a `storage.blob` required at start.

### The shared format (every backend, exactly)
In `storage.blob` namespace `workspace-snapshots`, keys under `<sha256 hex of "<chat key>\n<agent>">/`:
- the archive `snapshot-<createdAt ms>-<first 16 hex of its sha256>.tar.gz`: a gzip'd POSIX ustar or
  pax tar of the workspace root's contents, paths relative, no absolute path, no `..`; regular files,
  directories, and symbolic links that stay inside (a relative target whose `..` are only leading and
  climb no higher than the root);
- then `manifest.json`, written LAST: `{ "version": 1, "object": "<archive key>", "sha256": "<hex of
  the archive>", "size": <bytes>, "createdAt": <ms>, "agent": "<agent>" }` (no chat key).
- Restore: the manifest, then the archive, its SHA-256 and size checked, extracted into an empty
  directory, swapped in. Superseded archives are deleted after the new manifest is written.
- Exported for every backend from `@pikit/contracts` (neutral, Web Crypto): `SNAPSHOT_NAMESPACE`,
  `SNAPSHOT_MANIFEST`, `SNAPSHOT_VERSION`, `SNAPSHOT_CONTENT_TYPE`, `snapshotId`, `snapshotArchiveKey`,
  `parseSnapshotArchiveKey`, `snapshotManifestKey`, `snapshotManifestJson`, `parseSnapshotManifest`,
  `openSnapshotStore`, `deleteSupersededSnapshots`, `deleteSnapshotsBefore`; for a backend whose
  archive is made in a container or a VM, the entries checked as they stream (`SnapshotTarCheck`,
  `checkSnapshotArchive`, `snapshotLinkStaysInside`: the server restore's rules, strict wherever a tar
  program could read an entry otherwise) and its steps (`putSnapshotArchive`, `commitSnapshotManifest`,
  `readSnapshotArchive`).
- **One implementation**: every backend uses these (the server helper, execution-cloudflare-sandbox,
  execution-boat); none has a copy of its own. Behind a sandbox host all key a workspace by
  execution-serve's chat key and agent (`execution-serve:<sandbox>`, the agent or `_<sandbox>`), so
  they compute one id. `tests/acceptance/workspace-snapshots.test.ts` proves it: a workspace the server
  helper checkpointed is restored by Cloudflare's and boat's restore, what each checkpoints then by the
  server's, byte for byte, and another agent's manifest is refused by all three.

### The flow, as built
```
resolve (every tool call, every execution-serve request) -> use(): noted at once
    a release in progress: wait for its rename
    the directory there:               use it
    not there, a manifest:             archive streamed from getStream, hashed, extracted into
                                       <state>/tmp/restore-*, size and SHA-256 checked, renamed in
    not there, no manifest:            the caller makes an empty directory
    a restore fails:                   the tool call fails, nothing at the directory
every minute, each workspace unused for idleMinutes and not busy:
    execution-gondolin: close its VM if no command holds it
    tar + gzip into <state>/tmp (hashed) -> putStream(archive, sha256) -> the provider checks it
    used meanwhile (a resolve, a call, a VM booted)? -> the archive deleted, kept here
    put manifest.json -> read back, equal -> superseded archives deleted
    used meanwhile? -> kept here (the snapshot stays a copy)
    else, in one synchronous step with that check: rename the directory into <state>/tmp, delete it
```

### Guarantees (each enforced once, tested, mutation-checked)
- **The local directory is the truth until the manifest is read back**: a failure at any step
  (archive, upload, manifest, read back) leaves it, and at worst an archive no manifest names, which
  the next checkpoint deletes (`snapshots.test.ts`, each step).
- **Never released while in use**: a call of an environment given for it running, a use or a call
  during the checkpoint, a VM up or booted meanwhile (execution-gondolin).
- **A restore swaps in only what its manifest says**: another archive under its key, a size or a
  SHA-256 that differ, a manifest of another agent or version, or an archive missing refuse it, with
  no directory made.
- **No entry leaves the directory**: `..`, absolute paths, NUL, entries under a link, links leading
  out, hard links and devices refuse the whole archive; links are made last, files exclusively.
- **Streaming end to end**: tar and gzip over `node:zlib` into a file, `putStream` from it (S3
  multipart, one part in memory), `getStream` through gunzip into the files.
- **System tar reads ours, and ours restores system tar's** (`tar -czf`, bsdtar's pax records).

### Decisions (taken here; the owner may revise)
- **When**: after `idleMinutes` (10) unused, swept every minute. Not at stop: a stop releases nothing,
  and the index of the workspaces on disk (`<state>/index/`) is read at the next start, each counting
  as used then.
- **Retention with snapshots**: `retentionDays` deletes the bucket's snapshots whose newest archive is
  older than N days (hourly, manifest first, re-read before deleting), and the local sweep is off (the
  directories are released anyway; a local one never uploaded is never deleted). Without
  `retentionDays`, the bucket keeps everything; an expiration lifecycle rule on the namespace is
  discouraged (it may delete an archive before its manifest; a restore then fails, naming it).
- **Too large**: `maxBytes` of archive; a larger one stays on the host, a warning logged, not retried
  until its next use.
- **Two hosts, one workspace**: not coordinated. One process holds a (chat, agent) on a host; when two
  hosts hold copies (execution-remote's endpoint changed mid-flight), each checkpoint replaces the
  manifest, the last wins, and a checkpoint whose manifest read back is another host's fails (kept
  locally). Switch hosts after the old one released, or stop it first.
- **What is kept**: bytes, permission bits (no setuid, setgid, sticky), mtimes, links inside. Not
  owners, links that lead out (absolute ones included: write `/workspace/x` links relative), sockets,
  fifos, devices (counted, logged).
- **The helper's layer**: the format in `@pikit/contracts` (neutral: a Worker computes the same keys);
  the directories in `@pikit/contracts/snapshots` (server only, Pi-free: no Pi shape in it, so not the
  adapter; `SERVER_ONLY_EXPORTS` names it). workspace-local needs execution-local (a host directory).
- **The namespace** is the format's (`workspace-snapshots`), the one exception to "a component opens
  the namespace named after it": a snapshot one backend saved is restored by another.

## Snapshots in an S3 bucket (the first provider, proposed 2026-10-19)
The goal: a server's disk holds only the workspaces of active conversations. An idle
conversation's files go to a bucket the operator owns (AWS S3, MinIO, or R2 through its S3 API)
and are deleted from the disk; the conversation's next message brings them back, and the agent
works with them as if they never left. It scales a `server` on disk, as
[sandboxed execution](sandboxed-execution.md) scales it on isolation.

### What is missing today
- **A workspace per conversation.** `workspace-local` gives one directory per chat and agent (its
  default, `per: "chat"`, kept through `/new` and shared with same-agent delegated children), per
  agent or per channel, each shared by several conversations: it cannot be released while another
  conversation still uses it. `per: "conversation"` adds a directory per conversation id, the unit a
  snapshot saves and restores.
- **A `storage.blob` contract**: built (2026-10-21) with its first consumer, `tool-space-files`
  ([spaces](spaces.md)): `put`, `get`, `delete` and `list` by prefix of whole values (up to the
  provider's `maxBytes`, at least 25 MiB); storage-blob-s3 checks the signed SHA-256 of each `put`.
  Providers: storage-blob-fs (server) and storage-blob-s3 (both targets; R2 through its S3 API); one
  over R2's binding would be a third. Streams built with snapshots (2026-11-05): `putStream`
  (S3 multipart, checked by SHA-256, nothing visible until complete) and `getStream`, up to the
  provider's `maxStreamBytes`.

### The flow
```
message arrives -> the run's first workspace access
                   - local directory there:              use it
                   - none, the registry holds a ref:     download the tar, check its checksum,
                                                         extract, use it
                   - none and no ref:                    a new, empty directory
run ends -> conversation idle for N minutes -> checkpoint():
                   compressed tar of the directory -> put in the bucket -> checksum matches
                   -> WorkspaceRef (key, checksum, size, time) recorded in the registry
                   -> release(): the local directory deleted
```
- **The local directory is the truth until the upload is confirmed.** `release` deletes it only
  once the object's checksum matches and the `WorkspaceRef` is recorded. A crash at any earlier
  point loses nothing: the directory is still there and the next checkpoint uploads it again.
- **Restored lazily**, on the first workspace access of a run (a tool call), not on every message:
  a run that uses no tool downloads nothing.
- **One writer per conversation** holds on a server (one process owns its conversations), so a
  checkpoint never races a restore of the same workspace.
- **Any `execution` with a real filesystem**: `execution-local`, or a sandbox's, where it fits
  naturally: with Gondolin (sandboxed execution) the VM is disposable and `/workspace` is a VFS
  mount the host backs with the local directory, so a checkpoint is the host's alone.
- **On `durable`** most of it exists already: `execution-do`'s files are rows of the object's
  SQLite, and celld hibernates idle objects to a bucket. `storage.blob` over R2 would serve there
  only files larger than a row allows (2 MB).

### Alternatives considered
| | How | For | Against |
|---|---|---|---|
| **Whole snapshot** (chosen first) | a compressed tar on idle, restored whole | simple, consistent, any `execution` | a large workspace is slow to restore; a small change uploads everything |
| **Lazy filesystem** | `/workspace` mounted over the bucket, files fetched on demand (a Gondolin VFS provider, agentOS's `chunked_s3`, JuiceFS) | no restore wait; releasing is trivial | far more complex; git and many small files perform badly over S3 |
| **git** (`workspace-git`) | pushed on checkpoint, cloned on return | code projects, with history | repositories only, not arbitrary files |

The natural next step after the whole snapshot is an incremental one: files split into
content-addressed chunks (as restic does), only new chunks uploaded.

## Pi first
Session is not workspace: Pi's transcript records that a file changed, not the file.
Pi's durable documents are JSON state, not files. Nothing to take from Pi.

## Open questions
- When to checkpoint, beyond idle: after each run, at the process's stop (a graceful replacement of
  a host would release everything first), or on the agent's request.
- What happens to the snapshot of a conversation the operator deletes in the dashboard (the chat's
  workspace outlives one conversation; nothing deletes it but `retentionDays`).
- Encryption at rest (the bucket's SSE, or client-side): a workspace can hold sensitive data
  (credentials never land in it, SPEC C7).
- Coordination of two hosts holding one workspace (a lease in the bucket, a conditional put of the
  manifest where the store has one).
- Incremental snapshots (content-addressed chunks), when restores get slow.
- Conflicts when two agents share a git remote.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components". The registry is built (`conversations-file`,
`conversations-kv`); what it did not build is the workspace ref:

| Component | What it encodes |
|---|---|
| `conversations.registry` | Conversation key → active session + workspace ref, with TTL eviction of memory that never drops the pointer, and explicit `/reset` semantics. |
