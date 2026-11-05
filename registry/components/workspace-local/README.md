# workspace-local

Each agent's tools work in a directory of their own in each chat, inside execution: order, not
isolation.

- **Provides:** `workspace`.
- **Requires:** `execution` (`execution-local`): the agents' directories are in it. With `snapshots`,
  a `storage.blob` too (storage-blob-s3, storage-blob-fs).
- **Target:** `server`.
- **Installs to:** `src/pikit/workspace-local/`.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

Without it, every agent's tools work in `execution`'s one directory. With it, each agent gets
`<root>/<agent>/` inside `execution`'s (`.pikit/workspace/agents/support/`,
`.pikit/workspace/agents/ops/` with `execution-local`'s defaults), and in it a directory per chat,
`_chats/<hex SHA-256 of the chat's key>/` (`per: "chat"`, the default):
- A tool call in a run asks for the workspace of the run's conversation, and gets `execution`
  itself, working in its agent's directory of the conversation's chat. The chat is the key of the
  conversation a person or a channel opened (`originOf(ref).key`): a reset (`/new`, a new
  conversation under the same key) works in the same directory and sees what the agent wrote there
  before, and so does a delegated child of the same agent (its origin's chat, not its own
  `delegate:...` key). A child of another agent works in that agent's directory of the chat. Two
  agents never share one; two chats never do.
- The key is hashed (any string makes one safe name); an empty one is refused, nothing created.
  `_chats` starts with `_`, which no channel's directory does (`per: "channel"`, below), so the two
  layouts never meet.
- Several conversations may work in one directory at once (a reset and the conversation before it, a
  parent and its background tasks): parallel tasks of one agent keep to a subfolder or a git worktree
  each.
- A directory is made on the agent's calls. It stays until you remove it, or `retentionDays`
  deletes it ("Retention" below). Removing the component leaves them on disk; the tools
  go back to `execution`'s directory. Before `per: "chat"` was the default, the files were in
  `<root>/<agent>/`: they stay there, out of the chats' directories (set `per: "agent"` to keep
  using them; there is no migration).
- An agent name that is not kebab-case (`..`, `a/b`, empty) is refused: the tool call fails, and
  nothing is created outside `root`. One leading `_` is allowed: behind execution-serve, an
  agentless sandbox is `_<sandbox id>`, and gets a directory of its own.
- Everything else is `execution`'s: its shell (so `bash` works when `execution` has one), its
  variables (`execution-local`'s `variables`: a `GITHUB_TOKEN` added there reaches every agent's
  commands), and its stop, which kills the commands still running.
- It refuses to start when `root` cannot be created.

A tool called outside a run (a test calling it directly) has no conversation, and works in
`execution`'s directory.

## A directory per agent

With `per: "agent"`, every chat of an agent shares `<root>/<agent>/`: an agent with the context of
everything, whose chats see and change the same files.

## A directory per channel

With `per: "channel"`, each channel of an agent has a directory of its own inside the agent's:

```
.pikit/workspace/agents/support/telegram/
.pikit/workspace/agents/support/telegram.ops/   # the instance telegram:ops
.pikit/workspace/agents/support/dashboard/
.pikit/workspace/agents/support/delegate/       # tasks other agents gave it (tool-delegate)
```

- The channel is the conversation's (`ConversationRef.channel`): the one it was created on, for good.
  The runtime gives it to every run, so an operator's message from the dashboard into a Telegram
  conversation works in `telegram/`, not in `dashboard/`.
- A channel instance's `:` becomes `.` (`telegram:ops` → `telegram.ops`). A channel whose parts are
  not lowercase names (`..`, `a/b`, `tele.gram`) is refused: the tool call fails, and nothing is
  created.
- A conversation with no channel recorded (a ref made by hand, in a test) works in the agent's
  directory.
- It is still order, not isolation (below): `bash` can `cd ..` into another channel's directory.

## Retention

A chat's directory is ephemeral: what must last is saved on purpose elsewhere. With
`retentionDays: N`, a chat's directories (`<root>/<agent>/_chats/<chat>/`, every agent's in that chat)
are deleted once nothing has worked in them for N days. Absent (the default), nothing is ever
deleted: deleting what agents wrote must be asked for. Everything goes through `execution`'s files.

- **What counts as use**: a `resolve` of the chat's workspace, which the runtime makes for every tool
  call (a command, a file read or written) and execution-serve for every request. It is noted in
  memory at once, and in a marker, `<root>/.workspace-local-used/<chat>`, holding the time on the
  app's clock, written at most once an hour per chat: it outlives restarts, and is the app's clock,
  not the filesystem's (a restore or a copy that resets file times changes nothing). A chat with no
  marker (from before `retentionDays` was set) starts its count when a sweep first sees it. Since the
  marker may lag the last use by up to an hour, a chat whose process restarted meanwhile may go up
  to an hour before N days have passed.
- **When**: a sweep at start (in the background: start does not wait for it), then every hour.
  `stop` ends it.
- **Never in use**: a chat is kept while a call of an environment this component gave for it runs (a
  command until it ends, a file operation), and while this process used it within the period. The
  check and the retirement's mark are one synchronous step, and so are a `resolve`'s note of its use
  and its look for a retirement: a `resolve` either comes first (the chat is kept) or waits for the
  retirement, which renames the directories away, and then works in a new, empty directory; never in
  a half-deleted one. The renamed directories are measured and removed in
  `<root>/.workspace-local-retired/` (what a crash left there goes at the next sweep).
- **Never swept**: an agent's own directory (`per: "agent"`) and a channel's (`per: "channel"`):
  only `_chats/` is looked at, whatever `per` is now (directories left from an earlier `per: "chat"`
  are chats' too).
- **Logged** at `info` when something was deleted: how many chats, how many bytes; never a chat's
  key, hash or a file's name. Every sweep logs its counts at `debug`.
- **Behind execution-serve** (a sandbox host for a trial), each remote sandbox id is a chat
  (`execution-serve:<id>`), so `retentionDays` in the host's config deletes the remote sandboxes
  nobody used for N days.

The live state is this process's: two servers sharing a directory do not see each other's commands,
only each other's markers (at most an hour late).

## Snapshots

With `snapshots` (and a `storage.blob`), a chat's directory of an agent
(`<root>/<agent>/_chats/<chat>/`) unused for `idleMinutes` (10) is saved to the bucket and deleted
here; the next `resolve` of that chat and agent (the runtime's next tool call, execution-serve's next
request) restores it before the tool runs. The disk holds only the workspaces in use.

- **The shared format** ([features/workspace-snapshots.md](https://github.com/ajarellanod/pikit/blob/main/features/workspace-snapshots.md)): namespace `workspace-snapshots`, keys under
  the hex SHA-256 of `"<chat key>\n<agent>"`, a gzip'd tar, then `manifest.json` written last. What
  execution-gondolin (or another backend) saved, this restores, and the other way round.
- **What counts as use** is what retention counts: a `resolve`, noted in memory at once. **Never in
  use**: a call of an environment given for the directory running (a command until it ends, a file
  operation) keeps it; so does a use or a call that starts during the checkpoint. Commands left
  running in the background (`nohup ... &`) are not seen: they may write while it is archived.
- **Nothing lost on the way**: the directory is deleted only after the manifest naming the new archive
  is written and read back; a failure leaves it, tried again after `idleMinutes`. A restore checks the
  archive's SHA-256 and size, extracts into a directory of its own and swaps it in; an archive with an
  entry that would leave the directory is refused whole, and the tool call fails with nothing made.
  Files (bytes, modes, times), directories and links that stay inside are kept; links that lead out,
  owners and special files are not.
- **Only `per: "chat"`**: an agent's or a channel's directory is shared, never released (`snapshots`
  with another `per` is refused). Only on this host's disk: `execution` must be execution-local.
- **With `retentionDays`**, the bucket's snapshots whose newest archive is older than N days are
  deleted (hourly, the manifest first) instead of the local directories, which are released anyway.
- **`maxBytes`**: an archive larger stays here, a warning logged, until its next use.
- Its own files are in `<root>/.workspace-local-snapshots/` (archives on their way, restores, the index
  of the directories on disk, which a restart reads: each counts as used at start). A stop releases
  nothing.
- **One writer per chat and agent**: two processes serving the same chat and agent (a host changed
  while the old one still holds an unreleased copy) are not coordinated; the last checkpoint's
  manifest wins.

## Order, not isolation

A directory per agent keeps the agents' files apart when they behave. It is not a wall:
- Paths are not confined. A file tool given `../ops/notes.md` or an absolute path reads it.
- `bash` runs as `execution` runs it: with `execution-local`, as the server's OS user. It can
  `cd ..`, read another agent's files, and read this app's `.pikit/credentials.json`.

Real isolation needs each agent's tools in a sandbox of their own: an `execution-*` component that
runs them in a container (`execution-docker`, a planned feature: [features/sandboxed-execution.md](https://github.com/ajarellanod/pikit/blob/main/features/sandboxed-execution.md)).
Until then, give `bash` only to the agents that need it, and see `execution-local`'s README.

## Config

```ts
"workspace-local": {
  root: "agents", // default; relative to execution's working directory, or absolute
  per: "chat",    // default; "agent" for one directory per agent, "channel" for one per channel of each agent
  // retentionDays: 30, // absent by default (kept forever): delete a chat's directories unused this many days
  // snapshots: { idleMinutes: 10, maxBytes: 10e9 }, // absent by default: idle chat directories to storage.blob
}
```

## Tests

`workspace-local.test.ts` is copied with the component and runs in your project, in temporary
directories. It covers:
- the `workspace` conformance suite (per chat, per agent, per channel), and the `execution` one on an
  agent's directory (with a shell);
- one directory per agent and chat under `root`, relative to `execution`'s directory or absolute;
- per chat: a reset (`/new`) and a delegated child (and grandchild) of the same agent in the chat's
  directory, a child of another agent in that agent's, another chat apart; an empty chat key refused,
  an odd one (`../..`) only a hash; in real runs, a reset of the chat writes beside what the
  conversation before it wrote, and another chat does not see it;
- per agent: every chat of an agent in one directory, two agents apart;
- `per: "channel"`: a directory per channel inside the agent's (`telegram:ops` as `telegram.ops`), the
  agent's own without a channel, unsafe channels refused, and in real runs a later message whose ref
  has no channel still in its conversation's channel directory; the `workspace` suite again with it;
- `execution`'s variables in an agent's commands, which run in its directory;
- in real runs (scripted model), a file agent A writes is in A's directory and not in B's;
- unsafe agent names refused;
- the lifecycle conformance suite and the start failure;
- retention: the `execution` suite on a chat's directory with it on; at start, a chat unused for
  `retentionDays` loses every agent's directory (counts and bytes logged, no chat), a fresh one, an
  agent's and a channel's own directories and one never noted (its count starting) stay, across a
  restart; without it nothing is noted or deleted, however old; a use refreshes the count, the sweep
  runs hourly on the app's clock; a chat with a command running is kept, and goes once it ended; a
  command issued during the start sweep works; a use and a retirement of one chat never overlap
  (either order), nor a call in flight and a retirement; bad values refused;
- snapshots: the `workspace` and `execution` suites with them on; a chat's directories (every agent's)
  idle 10 minutes on a manual clock go to the bucket (a manifest and an archive each) and are deleted
  here, and the next use restores the same bytes, modes and links; a chat never saved starts empty;
  a command running keeps a directory, which goes once it ended; another host restores a chat from the
  bucket; `retentionDays` deletes the bucket's old snapshots; refused without `storage.blob`, with
  `per` other than `chat`, with `idleMinutes` 0. Mutation-checked: without waiting for the restore, a
  case fails. The helper's own cases (crash points, path tricks, checksums) are in
  `@pikit/contracts`' `snapshots.test.ts`.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
