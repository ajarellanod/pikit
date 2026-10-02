# Proposal for pi-durable: resume one conversation, not every one

Status: draft for upstream (`@earendil-works/pi-durable`, against 1.0.0). From pikit, which keeps
many conversations in one storage on a server, and one per Durable Object on Cloudflare.

## Problem

`Harness.resume()` enables task scheduling for the whole Session. Calls that ask for progress enable
it too: `Conversation.submit()`, `compact()`, `abort()`, `Submission.wait()`, `waitForTask()`,
`waitForIdle()` (their doc comments in `harness/types.d.ts`). So the first message to any
conversation after a reopen resumes **every** conversation's live work at once.

That is fine for one conversation per storage (pikit's Durable Objects). For a server holding many,
it means:

- **No ownership by subset.** A process cannot open a storage and drive only the conversations it
  owns (a lease, a shard): once anything is submitted, it runs everyone's tasks. Several owners per
  storage, the way to several replicas, are impossible even before locking.
- **A burst after a restart.** Every run a crash left open resumes together, with no way to order or
  bound them (model rate limits, memory).
- **Reading is not inert enough.** A host that only wants to answer one conversation, or to inspect
  it, must avoid every progress call to avoid starting the others.

## Evidence

`resume()`'s doc comment ("Enable task scheduling. Idempotent… Calls that ask for progress enable it
too"); `Harness.waitForIdle()` waits for "every ownerless conversation". pikit's runtime notes it:
"pi-durable's scheduler is global: it runs every conversation's work, not one conversation's"
(`packages/pi-adapter/src/runtime.ts`).

## pikit's workaround

It accepts the global scheduler. The runtime opens one Harness per storage, reconfigures every
conversation with live work before calling `resume()`, and announces every run it resumes. On a
server, one process owns the storage; on Cloudflare, one object owns one conversation (its root), so
the scope is already one. Replicas and per-conversation ownership on a server wait for this.

## Proposal

### 1. A scheduling scope

```ts
type HarnessOptions = {
  // …
  /** "all" (today): progress anywhere schedules everything. "explicit": only resumed scopes run. */
  readonly scheduling?: "all" | "explicit";
};

interface Harness {
  /** With no argument: everything (today). With conversations: their ownership scopes only. */
  resume(scope?: { readonly conversations: readonly ConversationId[] }): void;
  /** Stop scheduling a scope; its tasks stay pending, durably. */
  suspend(scope: { readonly conversations: readonly ConversationId[] }): Promise<void>;
}
```

Under `"explicit"`, `Conversation.submit()` and the other progress calls resume their own
conversation's ownership scope (with its task-owned conversations), never the Session's. Session
tasks without a conversation stay under `resume()` with no argument.

### 2. Optional: a concurrency bound

`settings.maxConcurrentRuns?: number` bounds how many conversations' generations run at once, so a
resume after a crash is ordered (oldest due first) rather than simultaneous.

## Compatibility

Additive: the default stays `"all"`. One process per storage is a separate limit (the in-memory next
id, no cross-process lock); this proposal does not lift it, but it is the first step towards it.
