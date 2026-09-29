# Moving the adapter to Pi's durable runtime

**Public appeal:** —

**Specified:** partly (SPEC P1; §4.1 C5; `packages/contracts/src/submissions.ts`, which is shaped like
`pi-durable`'s submissions so the move is the adapter's)

**Needed by:** nothing today; it removes pikit code once Pi carries it.

## What it gives
Less pikit: sessions, the record of admitted messages and their answers, and the resume after a crash
become Pi's own, as SPEC P1 asks ("when Pi ships something pikit built, pikit deletes its own").

## Where Pi stands (checked September 2026, Pi 0.87.1)
- `@earendil-works/pi-durable` is published. Its public API today is durable record contracts
  (conversations, entries, submissions, tasks, documents) and storage: memory, JSONL and SQLite, with a
  storage conformance suite. Its handoff notes: packages 1–15 are done; hooks, owned run APIs and
  the first input-to-answer path (packages 16–18) are not.
- `@earendil-works/pi-agent-core` 0.87.1, whose harness `runtime-pi` drives, does not depend on
  `pi-durable`: the harness still has its own session `Storage`.
- `pi-durable`'s SQLite core takes a **synchronous** database facade. Its README names Bun's SQLite and
  a Cloudflare Durable Object's SQLite as environments that can implement it without Node APIs, and
  says an asynchronous API such as D1 cannot.

## What changes when it moves
- **Removed:** `sessions-sql` and the adapter's `@pikit/pi-adapter/sql`, with the two Pi helpers they
  copy. `submissions-sql`'s per-session half, since `admitted` and `settled` become Pi's records (the
  index across sessions and the answers feed may stay: `submissions.ts` says which).
- **Sessions on a server:** `pi-durable`'s own Node adapters (SQLite or JSONL).
- **Sessions on Cloudflare:** `pi-durable`'s SQLite core over the object's SQL directly, through a
  small synchronous facade reached by `WORKERS_HOST` (C5). Not over `storage.sql`, which is
  asynchronous so that Postgres fits and stays the store of components' own records.
- **The runtime:** `runtime-pi`'s drive, resume and slices (C4) sit on `pi-durable`'s run control;
  `wakeups` stays the way an object is woken.

## When
A bounded spike of the adapter on `pi-durable` once packages 16–18 land (a message in, an answer out,
through its own run control) and a Pi release makes it the harness's storage or offers it alongside.
Until then, build nothing that duplicates `pi-durable`; shape new work so that it can drop in.

## Open questions
- Whether `pi-durable` ships its own Durable Object facade, or pikit keeps a few lines for it.
- How its tasks and documents map onto pikit's features (approvals, the scheduler) before they are
  built.
