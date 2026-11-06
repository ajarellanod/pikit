# Parallel tasks in one workspace: forked and merged behind the scenes

**Public appeal:** —

**Specified:** idea (owner's discussion, 2026-11-05). Not urgent: in daily use a chat has one owner and
one workspace per agent, so two people in a chat, two threads, or two different agents never collide.
Kept to be evaluated before it is built: the engine is open between three candidates (below).

**Needed by:** nothing required.

## The problem
A workspace is per chat and agent (`(originOf(ref).key, agent)`, [agent sandboxes](agent-sandboxes.md),
decision 1). Every delegated child of an agent works in that agent's workspace of the chat, so when an
orchestrator starts two background tasks for the same agent in one chat ("adapt the banners to
300x250" and "change the banners' logo", both to the designer), both tasks, and the designer's own
conversation in that chat if someone talks to it, write in one `/workspace`, in one VM, with commands
not serialized. Today only a convention avoids it (each task in a subfolder of its own).

Not this note's: two different agents never share a workspace; what they share goes through
`tool-space-files` (whose missing piece is an optimistic check, below) or a delegation's answer.

## What it gives
Parallel tasks of one agent in one chat each get their own view of the workspace, and their work is
merged back automatically. The engine is infrastructure: the model never runs a VCS command, never
sees a repository, and never has to remember a convention.

```
task A ─┐                          ┌─► no conflict: merged, nobody notices
        ├─► fork(base) ... join() ─┤
task B ─┘                          └─► a conflict: a policy (below); only if it must, the agent is asked
                                       with the CONTENT of the three versions, never with commands
```

- **Fork only when needed:** a background task forks when its agent's workspace is in use; a lone task
  or tasks in sequence work in place, at no cost.
- **Never blocks:** a conflict is recorded, the work goes on, the parent's report says what happened.
- **Invisible:** the internal history lives outside `/workspace` (e.g. a separate git dir on the host
  with the workspace as its work tree); repositories the agent clones itself stay its own, excluded.
- **Where it runs:** on a Gondolin host, host-side (the workspace is a host directory; the VM never
  knows); on Cloudflare Sandbox and boat.dev, inside the container or VM, driven by the host/gateway.
- **With [workspace snapshots](workspace-snapshots.md):** the internal history travels in the snapshot,
  so a pending conflict survives a host that goes away.

### Conflict policies, by file pattern (LayerFS's `.lww` idea)
| Policy | For | What happens |
|---|---|---|
| `lww` (last writer wins) | logs, caches, regenerable files | the last version kept, silently |
| `keep-both` (default for binaries) | png, psd, xlsx, mp4 | both kept (`banner.png`, `banner (task X).png`), the report says so |
| `resolve` (default for text) | html, css, md, csv, code | the agent is given base, A and B as content and returns the merged file |

## The engine: three candidates to evaluate
Behind one small internal interface, `fork(workspace, task) -> view` and
`join(task) -> { merged } | { conflicts }`, so the engine can change without touching providers.

| | git (worktrees, `merge`, `merge-file`) | Jujutsu (`jj`) | LayerFS (`Ephemeral-AI-Lab/layerfs`) |
|---|---|---|---|
| What it is | The standard VCS; a worktree per task, a branch per task, merged on join | A VCS over git's storage: changes, not branches; conflicts are first-class | A filesystem for agents: a Workspace per agent over shared committed history, a commit per Bash call, branches, merges |
| Merge what does not collide | yes | yes | yes |
| A conflict without blocking | to build: the branch left unmerged and recorded | **native**: the conflict is stored in the commit, work continues | refused (`Conflict`) unless a `.lww` rule says the newest wins |
| Undo | reflog (awkward) | **operation log**, `jj undo` | every step a checkpoint; rewind to any commit |
| Storage cost | full files per version (packs help) | as git | **deduplicated chunks** (157 snapshots in 100 MB, its benchmark) |
| Where it runs | everywhere; **isomorphic-git** (already a dependency of execution-do) also inside a Worker | a Rust binary (~30 MB) in every image or host; pre-1.0, its CLI changes | FUSE plus a daemon per container; Linux (macOS through its DSH) |
| Fit with S3 snapshots | the git dir is a directory: snapshotted as is | as git | its Store is **one local SQLite file**; its S3 backend was deleted; "Disposable profile", **no crash durability** (checked 2026-11-05, v1.1.0) |
| Maturity | decades | young, active, used in production by some | 1.1.0 broke 1.0's API; an open unmount wedge (#426); 2.0 on a branch |

Leaning, to confirm by evaluating: **git first** (everywhere today, Workers included), **jj** as a
replacement if native conflicts and undo justify one more binary, **LayerFS** to revisit when it has a
durable remote Store (the source is at `/Users/alex/Projects/Personal/layerfs`, AGENTS.md references).

### How to evaluate them
One scenario for each: two tasks of one agent in one workspace, (1) editing different files, (2) the
same text file in different places, (3) the same lines, (4) the same binary, (5) one task cut mid-way
(host stopped) and resumed, (6) a snapshot to S3 and a restore on another host with a conflict pending.
Measure: merged correctly, conflicts reported, time and disk per fork and per join, what it takes to
install it on Gondolin, Cloudflare Sandbox and boat.

## Related, smaller: an optimistic check in tool-space-files
Two different agents editing one saved file (`files_get`, edit, `files_save`) make two versions today;
the last saved becomes the current one and the other's changes are not combined (nothing is lost:
`files_get { version }`). `files_save { name, basedOn: <version> }` would refuse a save over a newer
version, naming it and who saved it, so the agent reads again and combines. One transaction in the
space's actor, which already serializes saves.

## Pi first
Nothing in Pi: pi-durable's tasks and subagents run in conversations; files are the workspace's.

## Open questions
- Which engine (above), after the evaluation.
- Whether the designer's own conversation, when it runs beside its delegated tasks, should also work in
  a fork, or keep the base and be merged into.
- The `resolve` policy's prompt and who runs it: the task's own agent at join, or the orchestrator.
