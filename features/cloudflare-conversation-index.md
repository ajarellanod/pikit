# A conversation index on Cloudflare

**Public appeal:** —

**Specified:** yes, for the dashboard (SPEC §5; moved from the former SPEC §16)

**Needed by:** the dashboard on Cloudflare, which lists conversations (SPEC §5). Resuming at start
relies on `agent.submissions.pending()` across conversations (`packages/contracts/src/submissions.ts`),
which a store inside each Durable Object cannot answer: still open, below.

## What it gives
A global list of the conversations of a Cloudflare deployment, when each one lives in its own
Durable Object.

## Where it stands
Built, inside `admin-api` (its README, "The conversation index", "On Cloudflare"), as an actor
instead of D1. A server keeps the same index in its own `storage.sql`, so the list is newest activity
first, paged, on every host.

- **The index is an object**, `admin-api:index`, of the conversations' own class: it runs the same App
  and keeps the index in its own `storage.sql` (`admin_api_conversations`: one row per conversation,
  its key, its id, its agent, its last activity). It holds no conversation; nothing in the App makes
  one for it.
- **Each conversation's object tells it**: admin-api's object half sends `admin-api.seen`
  `{ entries: [{ key, conversationId, agent, at }] }` (`actor.mailbox.send`) when a message is
  dispatched (once it is durable), when a resumed run starts, when a run settles or fails, on a reset,
  and when the object's App starts (every conversation it holds); the index upserts each, keeping the
  newest time.
- **The Worker lists** by asking the index for a page of conversations, newest activity first
  (`admin-api.list`), then each one's object for it, and names each `<key>~<the object's id>`.
  Reading, acting on and following one conversation is a call to its object (`actor.mailbox.call`).

**Why an actor and not D1.** A component cannot add a wrangler binding (`wrangler.jsonc` is
deployment-cloudflare's, the same for every project), and a D1 database is one more thing to create
and bind per deployment. An object of the existing class needs neither: the index is reached as any
actor is (C2), on the same SQL contract, and is gone with the component. Its cost is that every list
is one call to the index and one per conversation (a page is at most 20, within a request's subrequests),
and that one object takes every `seen`: fine for an operator's dashboard, not a global query engine.

**What it may miss, honestly.** `seen` is sent from the runtime's events, and events can be missed
(SPEC K3): an object evicted between the commit and the send, or an index that did not answer (the
send is logged, the run goes on). The conversation is then missing, or its time old, until its next
activity, or its object's next start, sends again. Any conversation can still be read by its id. Writing the index in the runtime's commit path, or from a feed with a cursor,
would close that gap; it is not needed by a dashboard that refreshes.

## How it fits pikit
- On Cloudflare each Durable Object holds its own conversation pointer (`conversations-kv` on its
  storage, C1, C5); the index lists the keys, never the pointers: each object says which conversation
  is current.
- Absent (`admin-api` not installed): per-object state only.

## Pi first
Nothing in Pi: one Pi session knows nothing of the others.

## Open questions
- Pending work: an evicted Durable Object resumes on its next request or alarm (SPEC §4). Can every
  object with unanswered work set an alarm for itself (runtime-pi asks for a wakeup at start and when
  idle with pending work), so that no index is needed for resuming? A conversation that gets neither
  is what an index of pending work would find.

## Moved from the former SPEC
The former SPEC §16, "Open questions":

- Where the conversation registry lives on Cloudflare when a *global* view is needed (list
  all conversations): D1 index vs per-DO only. Answered: per-DO, and an index actor (above).
