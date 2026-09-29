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
  `workspace-r2-snapshot` (a tar in `storage.blob`), `workspace-container` (a Cloudflare
  Container's filesystem with checkpoints). Each needs an `execution` with a real filesystem.
- `/reset` honours `workspace: preserve | recreate`.
- An idle conversation holds no workspace open.
- Absent: `workspace-local`'s directories on one disk, as today.

## Pi first
Session is not workspace: Pi's transcript records that a file changed, not the file.
Pi's durable documents are JSON state, not files. Nothing to take from Pi.

## Open questions
- When to checkpoint: after each run, on idle, or on the agent's request.
- Conflicts when two agents share a git remote.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components". The registry is built (`conversations-file`,
`conversations-kv`); what it did not build is the workspace ref:

| Component | What it encodes |
|---|---|
| `conversations.registry` | Conversation key → active session + workspace ref, with TTL eviction of memory that never drops the pointer, and explicit `/reset` semantics. |
