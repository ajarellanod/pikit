# Moving the adapter to Pi's durable runtime

**Public appeal:** —

**Specified:** partly (SPEC P1; §4.1 C5; `packages/contracts/src/submissions.ts`, which is shaped like
`pi-durable`'s submissions so the move is the adapter's)

**Needed by:** nothing today; it removes pikit code once Pi carries it.

## What it gives
Less pikit: sessions, the record of admitted messages and their answers, and the resume after a crash
become Pi's own, as SPEC P1 asks ("when Pi ships something pikit built, pikit deletes its own").

## Where Pi stands (checked September 2026, Pi 0.99.0)
- `@earendil-works/pi-durable` 0.99.0 runs a first input-to-answer path, not only records and
  storage: `Harness.open()` over a storage, `Conversation.submit()` with request-id deduplication,
  `Submission` handles (`status()`, `wait()`, `abort()`), `Harness.submission()` to reacquire one
  after a reopen, and `Harness.resume()` to start scheduling. The built-in `pi.generation` task calls
  the model and settles its inputs with `Tx.settleSubmission()`; a run the scheduler ends `faulted`
  or `orphaned` settles them `unanswered`. `Storage.scanSubmissions()` lists submissions by
  conversation and status.
- Also new: durable tasks (`defineTask()`: phases, an `abort` handler, memos, `sleep()`, and
  `getTask()`, `waitForTask()`, `abortTask()` on the harness); a registry (`createRegistry()`) for
  tools, tool wrappers, hooks, tasks and system prompt sections; typed entries (`defineEntry()`) and
  documents; the JSONL backend (`@earendil-works/pi-durable/storage/jsonl`, and
  `openNodeJsonlStorage()` from `/storage/jsonl/node`); an execution environment for files and shell
  (`/env`, and `NodeExecutionEnv` from `/env/node`); and the storage conformance suite and benchmarks,
  exported from `/testing`.
- That path is not yet what pikit's runtime needs. Its handoff (`pico-v5-handoff.md`) has packages
  1–15 implemented; 16 (tool turns and hook dispatch), 17 (the inbox: steer, follow-up and passive
  writes to a busy conversation) and 18 (owned conversations and subagents) are not. In 0.99.0 a
  tool call settles as the answer, and a submission to a busy conversation rejects with
  `ConversationBusy` and writes nothing.
- `@earendil-works/pi-agent-core` 0.99.0, whose `AgentHarness` `runtime-pi` drives, does not depend
  on `pi-durable`: the harness still has its own session `Storage`.
- `pi-durable`'s SQLite core takes a **synchronous** database facade. Its README names Bun's SQLite and
  a Cloudflare Durable Object's SQLite as environments that can implement it without Node APIs, and
  says an asynchronous API such as D1 cannot. Pi ships no Durable Object adapter for it.

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
A bounded spike of the adapter on `pi-durable` once packages 16–18 land (a message in, tool calls and
an answer out, messages to a busy conversation queued, and owned runs, through its own run control)
and a Pi release makes it the harness's storage or offers it alongside. Until then, build nothing that
duplicates `pi-durable`; shape new work so that it can drop in.

## Open questions
- Whether `pi-durable` ships its own Durable Object facade, or pikit keeps a few lines for it (0.99.0
  ships none).
- How its tasks and documents map onto pikit's features (approvals, the scheduler) before they are
  built.
