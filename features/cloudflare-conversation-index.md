# A conversation index on Cloudflare

**Public appeal:** —

**Specified:** partly (moved from SPEC §16)

**Needed by:** possibly required work on Cloudflare: the dashboard lists conversations (SPEC-CORE §5,
track D), and resuming at start relies on `agent.submissions.pending()` across sessions (SPEC §6.1),
which a store inside each Durable Object cannot answer. To decide with M4 and D.

## What it gives
A global list of the conversations of a Cloudflare deployment, when each one lives in its own
Durable Object.

## How it fits pikit
- On Cloudflare each Durable Object holds its own conversation pointer (SPEC §7.4, §9.2); nothing
  lists them all.
- An index component (`conversations-d1-index`) keeps key, agent, session and last activity in D1.
- Events can be missed (SPEC-CORE K3), so the index is written in the Durable Object's own commit
  path or fed from a feed with a cursor (SPEC §4.8), never from events alone.
- Pending work may not need it: an evicted Durable Object resumes on its next request or alarm
  (SPEC-CORE §4). A conversation that gets neither is what the index would find.
- Absent: per-object state only.

## Pi first
Nothing in Pi: one Pi session knows nothing of the others.

## Open questions
- Is it required for track D on Cloudflare, or does the dashboard list from something else?
- Can every Durable Object with unanswered work set an alarm for itself, so that no index is
  needed for resuming?

## Moved from SPEC
SPEC §16, "Open questions":

- Where the conversation registry lives on Cloudflare when a *global* view is needed (list
  all conversations): D1 index vs per-DO only. Probably per-DO + optional D1 index component.
