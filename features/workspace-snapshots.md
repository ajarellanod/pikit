# Workspace snapshots

**Public appeal:** —

**Specified:** partly (the former SPEC §8.1 `WorkspaceRef`; its §8.2 `ref`, `checkpoint`, `release`
and the implementations table, `[planned]`)

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

## Snapshots in an S3 bucket (the first provider, proposed 2026-10-19)
The goal: a server's disk holds only the workspaces of active conversations. An idle
conversation's files go to a bucket the operator owns (AWS S3, MinIO, or R2 through its S3 API)
and are deleted from the disk; the conversation's next message brings them back, and the agent
works with them as if they never left. It scales a `server` on disk, as
[sandboxed execution](sandboxed-execution.md) scales it on isolation.

### What is missing today
- **A workspace per conversation.** `workspace-local` gives one directory per agent (or per
  channel, `per: "channel"`), shared by every conversation of that agent: it cannot be released
  while another conversation still uses it. `per: "conversation"` adds a directory per
  conversation id, the unit a snapshot saves and restores.
- **A `storage.blob` contract**: `put`, `get` and `delete` of large objects by key, streamed, with
  a checksum on `put`. The catalogue has only `storage.sql`, `storage.sqlite` and `storage.kv`.
  Providers: `storage-blob-s3` (any S3 API: AWS, MinIO, R2), later one over R2's binding on
  Cloudflare. As the contract rules say, it comes with `workspace-snapshot`, its first consumer.

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
- When to checkpoint: on idle (aligned with pi-durable's ten-minute context retention), after
  each run, at the process's stop, or on the agent's request.
- Retention: bucket lifecycle rules for old snapshots, and what happens to the snapshot of a
  conversation the operator deletes in the dashboard.
- Encryption at rest (the bucket's SSE, or client-side): a workspace can hold sensitive data
  (credentials never land in it, SPEC C7).
- A size limit per workspace: refused at checkpoint, the operator told.
- Conflicts when two agents share a git remote.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components". The registry is built (`conversations-file`,
`conversations-kv`); what it did not build is the workspace ref:

| Component | What it encodes |
|---|---|
| `conversations.registry` | Conversation key → active session + workspace ref, with TTL eviction of memory that never drops the pointer, and explicit `/reset` semantics. |
