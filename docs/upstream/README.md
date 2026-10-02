# Upstream proposals

Everything pikit works around in Pi's packages, written down so that none is lost. Each entry says
what is wrong, how we know, what pikit does meanwhile, and what we would ask for. Nothing here has
been sent yet: each is opened upstream (`earendil-works/pi`) only when the owner decides.

When Pi ships one, delete its workaround in pikit (MANIFESTO, principle 1) and mark it **shipped**
here with the Pi version.

| # | Package | Proposal | Hurts pikit | Priority | Status |
|---|---|---|---|---|---|
| 1 | pi-durable | [Next due time of sleeping work](#1-next-due-time-of-sleeping-work) | Durable Objects stall after eviction | **high** | draft ([file](pi-durable-next-wake.md)) |
| 2 | pi-durable | [Queued inputs stuck after a failed run](#2-queued-inputs-stuck-after-a-failed-run) | A message is never answered until the user writes again | **high** | draft ([file](pi-durable-inbox-after-failure.md)) |
| 3 | pi-durable | [Caller context values reach tools](#3-caller-context-values-reach-tools) | Multi-tenant isolation, tracing | medium (high for multi-tenant) | draft (here) |
| 4 | pi-durable | [Several writers per storage](#4-several-writers-per-storage) | Replicas, Postgres as a shared store | medium | draft (here) |
| 5 | pi-durable | [Per-conversation scheduling scope](#5-per-conversation-scheduling-scope) | Servers holding many conversations | medium | draft ([file](pi-durable-scheduling-scope.md)) |
| 6 | pi-durable | [Provider session id](#6-provider-session-id) | Prompt-cache cost on long chats | medium | draft ([file](pi-durable-provider-session-id.md)) |
| 7 | pi-durable | [Table prefix for `SqliteStorage`](#7-table-prefix-for-sqlitestorage) | Generic table names in a shared database | low | draft ([file](pi-durable-table-prefix.md)) |
| 8 | chord | [Foreign parent's `abortSignal`](#8-chord-foreign-parents-abortsignal) | A bridge (`toChord`) in the adapter | low | draft (here) |
| 9 | chord | [`esbuild` only for the bundler](#9-chord-esbuild-only-for-the-bundler) | An unused dependency installed everywhere | low | draft (here) |
| 10 | chord | [A stability statement](#10-chord-a-stability-statement) | Why Chord stays out of `@pikit/core` | low | draft (here) |
| 11 | pi-mcp | [`StreamableHttpTransport` on Workers](#11-pi-mcp-streamablehttptransport-on-workers) | A `fetch` wrapper in the adapter | low | draft (here) |
| 12 | pi-ai | [A default for `select` login prompts](#12-pi-ai-a-default-for-select-login-prompts) | Non-interactive logins broke on 1.0 | low | note (here) |
| 13 | pi-durable | [Settlement order and run identity on submissions](#13-settlement-order-and-run-identity-on-submissions) | Delivering answers exactly once after a crash | **high** | draft (here) |

Contributions we could offer instead of asking: a Postgres backend of pi-durable's `Storage`
([storage-postgres](../../features/storage-postgres.md)), an `ExecutionEnv` conformance suite (pikit
ported one: `packages/pi-adapter/src/durable/execution-testing.ts`), and a Durable Object example
(pikit's `storage-do` + `openDurableStorage`, proven with pi-durable's storage conformance).

---

## 1. Next due time of sleeping work
- **Problem.** Task sleeps (`runtime.sleep(until)`: model retry backoff, deferred-response polling,
  compaction retry, custom tasks) wait on an in-process `setTimeout`. A host that lives only during
  an event (a Durable Object, a function) is evicted while a task sleeps, and nothing wakes it: the
  run stalls until an unrelated event reopens the Harness.
- **Evidence.** `scheduler.ts` `#sleep` / `delay`; there is no API returning when work is next due.
- **pikit meanwhile.** `nextWakeAt(harness)` / `driveSlice` (`packages/pi-adapter/src/durable/wakeups.ts`)
  derive the time from `harness.inspect()` and the private checkpoints of `pi.generation` and
  `pi.compaction`; the object's alarm is set from it. Custom task sleeps are invisible unless the task
  checkpoints `until`.
- **Ask.** `harness.nextDueAt()`, sleeps recorded durably (`wakeAt` on the task record), and an
  `onScheduled(at)` hook so hosts need no polling. Full text: [pi-durable-next-wake.md](pi-durable-next-wake.md).

## 2. Queued inputs stuck after a failed run
- **Problem.** Follow-ups queued while a run goes are placed only when it answers. If it ends
  unanswered (`model_error`, `faulted`, `orphaned`), they stay in the inbox until someone submits
  again; nothing reports the conversation as stuck.
- **Evidence.** pi-durable's README says so; `pi-facts.test.ts`, "a run that fails leaves follow-ups
  in the inbox".
- **pikit meanwhile.** The runtime's `reconcileInbox` submits an invisible `pikit.inbox-kick` write
  after a failure and after opening the Harness.
- **Ask.** Place queued follow-ups after a failure (`afterFailure: "continue" | "hold"`), do the same
  on `resume()`, optionally `conversation.drain()`. Full text:
  [pi-durable-inbox-after-failure.md](pi-durable-inbox-after-failure.md).

## 3. Caller context values reach tools
- **Problem.** pikit passes invocation-scoped values in its `Context` (the tenant a message belongs
  to, a trace id, the operator who sent a command). On pi-durable, the run is a set of durable tasks
  the scheduler starts with its own invocation context: the `Context` given to `submit()` carries
  cancellation for that call only, and its values never reach the generation, hooks or tools. They
  still reach pikit's own events (emitted by the adapter around the run).
- **Why it matters.** Multi-tenant isolation needs every tool call to know its tenant (which
  workspace, which secrets, which quota) without trusting the model; tracing needs one trace id
  across a run. After a restart the original caller is gone, so the values must be durable, not
  in-memory.
- **Evidence.** The durable runtime's README (`packages/pi-adapter/src/durable/README.md`, "a
  dispatching caller's values no longer reach tools"): a tool's context is built from the Harness's
  context plus the conversation. `runtime.test.ts` ("contexts") dispatches with a `tenant` value
  and checks what the tool sees; a test asserting the tenant's absence should pin it before this is
  sent.
- **pikit meanwhile.** None general. A value that belongs to the whole conversation can live in a
  conversation document (as `agent.state` does) and tools read it through their `api`; per-message
  values (trace id) are lost.
- **Ask.** Durable submission attributes: `submit({ type: "input", content, requestId, attributes })`
  where `attributes` is a small JSON object stored with the submission, exposed to the run's tasks,
  hooks and tools (`api.attributes`, the union or the latest of the inputs a run places), and kept
  across restarts. Optionally `HarnessOptions.contextFor(invocation)` so a host can turn attributes
  back into its own context values.
- **Compatibility.** Additive.

## 4. Several writers per storage
- **Problem.** pi-durable assumes one process owns a storage. `SqliteStorage` keeps the next id and
  sequence in memory (`storage/sqlite/storage.ts`: `durable_metadata.next_id`, read at open and
  written back), and there is no cross-process locking. Two processes on one database corrupt ids
  and race tasks.
- **Why it matters.** A shared database (Postgres, a networked SQLite) gives backups and management,
  but not replicas sharing conversations; on servers, horizontal scaling needs each conversation
  owned by one process at a time. Cloudflare avoids it by giving each chat its own Durable Object.
- **pikit meanwhile.** One process per storage: one replica on a server, one object per chat on
  Cloudflare. [Replicas](../../features/replicas.md) and [Postgres](../../features/storage-postgres.md)
  record the limit.
- **Ask.** (a) Ids and sequences minted atomically by the storage when a `multiWriter` option is set
  (e.g. `UPDATE … RETURNING`), (b) a lease per ownership scope with a fencing token every commit
  checks, and (c) together with proposal 5 (`scheduling: "explicit"`), a process schedules only the
  conversations it leases. The conformance suite gains a two-writer case.
- **Compatibility.** Additive behind an option; single-writer stays the fast default.

## 5. Per-conversation scheduling scope
- **Problem.** `resume()` and every progress call enable scheduling for the whole Session, so the
  first message after a reopen resumes every conversation's leftover work at once.
- **pikit meanwhile.** Accepted: on Cloudflare one conversation per storage; on a server, a burst
  after restart.
- **Ask.** `scheduling: "all" | "explicit"`, `resume({ conversations })`, `suspend(scope)`, optional
  `maxConcurrentRuns`. Full text: [pi-durable-scheduling-scope.md](pi-durable-scheduling-scope.md).

## 6. Provider session id
- **Problem.** pi-durable never sets pi-ai's `sessionId` stream option, so providers that key prompt
  caching or affinity on it (OpenAI/Azure Responses, Anthropic, Codex) get no key per conversation.
- **Evidence.** `pi-facts.test.ts`, "pi-durable sends the provider no session id".
- **pikit meanwhile.** None possible (settings are harness-wide).
- **Ask.** Default to the conversation id; settable per conversation through `configure()`. Full
  text: [pi-durable-provider-session-id.md](pi-durable-provider-session-id.md).

## 7. Table prefix for `SqliteStorage`
- **Problem.** Fixed generic table names (`conversations`, `entries`, `tasks`, `submissions`,
  `documents`, …); one database holds one Session.
- **pikit meanwhile.** An exception to `storage.sql`'s prefix rule; nothing collides today.
- **Ask.** `SqliteStorage.open(db, { tablePrefix })`. Full text:
  [pi-durable-table-prefix.md](pi-durable-table-prefix.md).

## 8. Chord: foreign parent's `abortSignal`
- **Problem.** Chord's `withContextValue` reads cancellation through a private key
  (`context/index.ts`), so deriving from a context of another implementation (pikit's `Context`,
  same shape on purpose) drops its `abortSignal`.
- **pikit meanwhile.** `toChord` in `packages/pi-adapter/src/durable/context.ts` re-attaches it.
- **Ask.** `abortSignal` returns its own value when it holds the abort key, `parent.abortSignal`
  otherwise. A few lines and a test.

## 9. Chord: `esbuild` only for the bundler
- **Problem.** `esbuild` is a hard dependency of `@earendil-works/chord`, though only the `./bundler`
  subpath imports it; every pi-durable install pulls it (a nested copy next to pikit's own).
- **Ask.** An optional peer dependency, or the bundler in its own package.

## 10. Chord: a stability statement
- **Problem.** Chord is 1.0 by lockstep versioning with Pi, while its `PLANNING.md` says it is not a
  stable public contract yet (0.87 → 1.0 changed 49 files, +10k/−5k lines). Libraries cannot tell
  what they may build on.
- **Ask.** Say which entry points follow semver (at least `@earendil-works/chord/context` and the
  root service API), and mark the rest experimental. With it, pikit could reconsider building
  parts of `@pikit/core` on Chord (`features/kit-follow-ups.md`, "Chord").

## 11. pi-mcp: `StreamableHttpTransport` on Workers
- **Problem.** It stores `options.fetch ?? globalThis.fetch` and calls `this.fetch(...)`, which
  Workers reject ("Illegal invocation"), and its SSE parser uses `Buffer.byteLength`, which needs
  `nodejs_compat` ([mcp](../../features/completed/mcp.md), "On Cloudflare").
- **pikit meanwhile.** `mcpHttpTransport` wraps `fetch`; the workerd lane pins the gap.
- **Ask.** Call `fetch` unbound-safe (`(...a) => f(...a)`), measure with `TextEncoder`.

## 12. pi-ai: a default for `select` login prompts
- **Problem.** In 1.0 Anthropic's OAuth login first asks a `select` (browser or copy-code). An
  `AuthInteraction` that answered every prompt with typed text (pikit's CLI, scripts) fails with
  "Unknown Anthropic login method".
- **pikit meanwhile.** `loginInteraction` answers `select`; `pikit configure --login-method
  browser|code`.
- **Ask (minor).** A documented default option for `select` prompts (or a `prompt.default` field),
  so non-interactive callers keep working across new choices. A note rather than a request.

## 13. Settlement order and run identity on submissions
- **Problem.** A host that delivers answers outside the process (a chat channel) must know, durably
  and exactly, which runs ended and in what order, to deliver each once, even if it crashed right
  after pi-durable settled them. A terminal `SubmissionRecord` carries neither when it was settled
  nor which run settled it: `SubmissionRecordBase` is `{ id, conversationId, requestId? }`; `done`
  adds `entry` and `answer`, `unanswered` adds `entry?`, `reason`, `detail`. `scanSubmissions` filters
  by conversation and status and pages by submission id, not by settlement.
- **Consequences.** Live, a host groups inputs by the commit that settles them
  (`subscribeCommits`), which is exact. After a crash between that commit and the host's own record,
  it must rebuild:
  - `done` inputs are grouped exactly by their shared `answer`, and ordered by the answer entry's
    `commitSeq` (an extra read per run);
  - `unanswered` inputs of one failed run cannot be told apart from two consecutive failed runs (a
    heuristic: adjacent `pi.user` entries and the same reason);
  - a cross-conversation "answers in the order they ended" feed needs a second store the host keeps
    and reconciles.
  Before its fix, pikit even delivered one batched answer twice (a redelivered non-first input
  announced alone, the rest later).
- **pikit meanwhile.** pi-durable is the source of truth for state; pikit keeps only a derived
  answers index in `storage.sql`, idempotent by run key (the answer entry id, or the first input of
  an unanswered group), bounded by a per-conversation watermark document, and rebuilt by one
  per-conversation reconciliation used at start, on recover and on redelivery.
- **Ask** (additive; any one helps, (a)+(b) remove the workaround entirely):
  - (a) **`settledSeq`** on terminal submissions: the commit sequence that made them terminal (the
    storage knows it when it writes the record).
  - (b) **`runId`** (or `placedBy`: the generation task that placed the input) on `placed`, `done`
    and `unanswered` inputs, so inputs taken by one run are identified as one.
  - (c) **`scanSubmissions({ settledAfter: Seq, status: ["done", "unanswered"] })`** ordered by
    `settledSeq` across conversations, with a `Seq` cursor: the host's feed becomes a read of
    pi-durable's own storage.
  - Alternative shape they may prefer: a host hook that runs **inside the commit that settles a run**
    (e.g. `HarnessOptions.onRunSettled(tx, inputs, outcome)`), so a host appends its own outbox row
    atomically.
- **Will they accept it?** Likely, in some form. It is additive, small for the storage (one column or
  JSON field, written in the commit that settles), and matches pi-durable's own principle ("everything
  a UI needs is committed state"). Earendil announced Slack and GitHub bots on pi-durable: any bot
  that posts answers to an external platform hits this exactly-once delivery problem, so it serves
  their own use. They may prefer the in-commit hook or a different API to these fields; any of them
  removes pikit's reconciliation. Lead with the problem and the repro, not a fixed API.
- **Evidence to attach.** pikit's regression test for the duplicated batch, and the reconciliation
  code it needs today (`packages/pi-adapter/src/`, after the native `agent.submissions` lands).
