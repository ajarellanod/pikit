# Several server replicas

**Public appeal:** —

**Specified:** partly (the former SPEC §7.2 and §4.5: `conversations.ownership`, `[planned]`)

**Needed by:** nothing required. One server replica needs no ownership component, and Cloudflare gets
it from the platform (`idFromName`, C1, C2), as celld does on your own machines
([deployment-celld](deployment-celld.md)): the self-hosted way to scale out.

## What it gives
Several server processes behind one address, for availability or load, with each conversation's
session open in exactly one of them.

## How it fits pikit
- `conversations-lease` provides `conversations.ownership` (`ConversationOwnership`): a lease per
  conversation in a database the replicas share ([Postgres](storage-postgres.md)); a replica that
  does not own a conversation forwards the message or waits.
- Everything that assumes one process gets an owner too: resuming `agent.submissions.pending()` at
  start, the outbox's per-conversation order, a [scheduler](scheduler.md) tick.
- Absent: the server runs one replica.

## Pi first
Pi opens a session exclusively inside one process and calls a second process "unsupported"; keeping
that true across processes is exactly pikit's job. `pi-durable` 1.0 makes it one process per storage
(the next id is cached in memory, with no cross-process lock), and its scheduler is global: a
process cannot drive only the conversations it owns
(`docs/upstream/pi-durable-scheduling-scope.md`). Pi's `packages/server` routes sessions to
workers: check it before building forwarding between replicas.

## Open questions
- Fenced writes (below).
- Forward or wait, and how a replica finds the owner.

## Moved from the former SPEC and ROADMAP
The former SPEC §7.2:

`[open]` Several replicas need fenced writes: a worker that stalls past its lease must not
write over the next owner. Pi's `Storage.commit` has no expected-sequence check, so the
fencing belongs in the session store or the lease; decide when the component is built.

The former ROADMAP, "Later, only if demanded":

> - Several server replicas, with `conversations.ownership` (a lease per conversation and
>   fenced writes).
