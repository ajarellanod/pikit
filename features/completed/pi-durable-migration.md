# Moving the kit to Pi's durable runtime (done)

**Public appeal:** —

**Specified:** decided (below, and SPEC P1, §4.1 C5); the adapter's side is described in
`packages/pi-adapter/src/README.md` and `tools/README.md`.

**Needed by:** everything. Pi 1.0 removed the 0.99 `AgentHarness` pikit was built on, so the kit
runs on `@earendil-works/pi-durable` or on nothing.

## What it gives
Less pikit: conversations, the record of admitted messages and their answers, the inbox, compaction,
tasks, subagents and the resume after a crash become Pi's own, as SPEC P1 asks ("when Pi ships
something pikit built, pikit deletes its own").

## Kit, not framework
Pi owns the agent runtime: durability, resume, request-id deduplication, the inbox and steering,
compaction, subagents and tasks. pikit owns what Pi does not: channels, routing, delivery to
platforms, deployment (a Bun server, Cloudflare Workers with one Durable Object per chat), the
CLI and installer (zero friction from installer to a running agent), and, later, an operator UI
built on pi-durable's `watch()` and `taskGraph()`. Where pikit had built something that pi-durable
now does, pikit's goes.

## Where Pi stands (checked against Pi 1.0.3)
- `@earendil-works/pi-durable` 1.0.3 is marked **experimental**: its API changes without notice
  between releases (1.0.3 added required `ExecutionEnv` methods). pikit pins it and re-checks on
  each bump.
- It is a durable harness: `Harness.open()` over a storage, conversations (`root()`,
  `createConversation()`), `submit()` with request-id deduplication, an inbox for a busy
  conversation (steers, follow-ups, writes; `steeringMode` / `followUpMode`), `resume()` after a
  reopen, compaction, durable tasks and child tasks (subagents), documents, per-conversation agents
  (`configure()`), extensions (`defineExtension`, a registry), a usage ledger, and live views
  (`watch()`, `taskGraph()`).
- Storage: memory, JSONL, and a SQLite core over a small `SqliteDatabase` facade. pikit's facade over
  `storage.sql` passes pi-durable's storage conformance on storage-sqlite (Bun) and storage-do
  (workerd).
- Execution: `ExecutionEnv` (files, positional and directory readers, `watch`, a shell taking a
  string or an argv) with its own conformance suite since 1.0.3, which execution-local,
  workspace-local and execution-do pass (execution-do without `watch`).
- pi-ai 1.0 (`createModels`, providers by subpath) and Chord 1.0 come with it. `pi-agent-core`'s
  `AgentHarness` is gone.

## Done
- pi-durable's storage over `storage.sql` on both targets; models, providers and credentials on
  pi-ai 1.0; tools, MCP and execution on pi-durable; wake-ups for hosts that are evicted (a next due time derived from the Harness); a
  runtime implementing `agent.runtime` on pi-durable. Before them, unmodified Pi coding-agent
  extensions stopped running: pi-durable's own extensions are the extension model from now on.
- The switch-over: the components run on those pieces (`runtime-pi`, `deployment-cloudflare` and
  the Durable Object hosts, the conversation registries, the tools and providers), and the contracts
  followed.

## What moves to Pi, and what goes
- **Pi's now:** sessions (pi-durable conversations), resume after a crash or eviction, request-id
  deduplication, queueing behind a busy conversation, compaction, retries of model calls.
- **Removed:** `sessions.store` and its providers `sessions-sql` and `sessions-jsonl`, with the
  adapter's `@pikit/pi-adapter/sql`. pi-durable's storage over `storage.sql` serves both a server
  and a Durable Object.
- **Kept, read from pi-durable:** `agent.submissions`, which channels read answers from and which
  resumes conversations at start. runtime-pi provides it from pi-durable's own submissions; the
  `answers` feed is a log derived from them (pi-durable has no feed). `submissions-sql`, the second
  record that bridged them, is removed.
- **Kept, pikit's:** `agent.runtime` as the contract components use, `conversations.registry`
  (keys to conversations), `wakeups` (how an object is woken), channels, delivery, deployment.

## Decisions of the switch-over
- **Messages that arrive during a run are batched into the next run** (`followUpMode: "all"`): the
  next run takes every message queued behind the current one.
- **`sessionId` is renamed `conversationId`** in the contracts (`ConversationRef` and what carries
  it): it is the pi-durable conversation's id.
- **`sessions.store`, `sessions-sql` and `sessions-jsonl` are removed** (above).
- **`agent.submissions` stays, provided by runtime-pi from pi-durable** (above).
- **No code hot reload; a reload is a restart** ([kit follow-ups](../kit-follow-ups.md)).

## Open problems (pi-durable gaps, to propose upstream)
Each has, or will have, a proposal in [`docs/upstream/`](../../docs/upstream/):
- **No API for the next due time.** A host that is evicted cannot know when sleeping work is due;
  pikit derives it from the built-in tasks' checkpoints
  ([proposal](../../docs/upstream/pi-durable-next-wake.md); open upstream as
  [#10325](https://github.com/earendil-works/pi/issues/10325)).
- **A failed run leaves queued inputs stuck** in the inbox until the next submission; pikit kicks the
  inbox with an invisible `pikit.inbox-kick` write
  ([proposal](../../docs/upstream/pi-durable-inbox-after-failure.md)).
- **The scheduler is global:** opening a Harness resumes every conversation's work, not one's
  ([proposal](../../docs/upstream/pi-durable-scheduling-scope.md)).
- **Table names are unprefixed** (`conversations`, `entries`, `tasks`…), against `storage.sql`'s
  "prefix your tables" rule, so one database holds one pi-durable Session
  ([proposal](../../docs/upstream/pi-durable-table-prefix.md)).
- **One process per storage:** the next id is cached in memory and there is no cross-process lock,
  so two processes over one SQLite file are unsupported ([replicas](../replicas.md)).
- **A caller's context values (tenant, trace) do not reach tools:** tasks run in the Harness's
  context, so only the run's events see them.

Closed upstream: the provider session id (pi-durable 1.0.2,
[#10424](https://github.com/earendil-works/pi/issues/10424)): each conversation sends its own,
persisted, so prompt caches keyed on it hit.

## Open questions
- Whether `pi-durable` ships its own Durable Object facade, or pikit keeps its few lines over
  `storage.sql`.
- How its tasks and documents map onto pikit's features (approvals, the scheduler) when they are
  built.
- When the `answers` log can go: when pi-durable records which inputs a run took with its end, and
  offers a feed of settlements (docs/upstream, proposal 13).
