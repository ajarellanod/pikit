# A conversation index on Cloudflare

**Public appeal:** —

**Specified:** partly (moved from the former SPEC §16)

**Needed by:** possibly required work on Cloudflare: the dashboard lists conversations (SPEC §5),
and resuming at start relies on `agent.submissions.pending()` across conversations
(`packages/contracts/src/submissions.ts`), which a store inside each Durable Object cannot answer. To
decide with the dashboard on Cloudflare.

## What it gives
A global list of the conversations of a Cloudflare deployment, when each one lives in its own
Durable Object.

## Where it stands
Not built. `agent.observe` (`packages/contracts/src/observe.ts`, provided by runtime-pi from
pi-durable's records, `packages/pi-adapter/src/observe.ts`) lists the conversations of the storage it
runs on: on a server, all of them; in a Durable Object, **only that object's own** (its root
conversation, and those a reset made). That is the stub the dashboard starts from on Cloudflare:
listing every conversation needs this index; reading or watching one conversation needs only the
Worker to reach its object (an RPC to `idFromName(key)`, as `actor.mailbox` does), which comes with the
dashboard's Cloudflare half.

The smallest index that would do: the object, in the commit path of its first message, upserts
`(key, agent, conversationId, lastActivity)` into D1 (`conversations-d1-index`), and the Worker's
`agent.observe` lists from D1 and asks each object for the rest. Events can be missed (K3), so the
upsert is part of the object's own work (a wakeup or the runtime's settle), not an `agent.*` listener.

## How it fits pikit
- On Cloudflare each Durable Object holds its own conversation pointer (`conversations-kv` on its
  storage, C1, C5); nothing lists them all.
- An index component (`conversations-d1-index`) keeps key, agent, session and last activity in D1.
- Events can be missed (SPEC K3), so the index is written in the Durable Object's own commit
  path or fed from a feed with a cursor (`Feed`, K3), never from events alone.
- Pending work may not need it: an evicted Durable Object resumes on its next request or alarm
  (SPEC §4). A conversation that gets neither is what the index would find.
- Absent: per-object state only.

## Pi first
Nothing in Pi: one Pi session knows nothing of the others.

## Open questions
- Is it required for the dashboard on Cloudflare, or does the dashboard list from something else?
- Can every Durable Object with unanswered work set an alarm for itself, so that no index is
  needed for resuming?

## Moved from the former SPEC
The former SPEC §16, "Open questions":

- Where the conversation registry lives on Cloudflare when a *global* view is needed (list
  all conversations): D1 index vs per-DO only. Probably per-DO + optional D1 index component.
