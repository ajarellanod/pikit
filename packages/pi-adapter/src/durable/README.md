# pi-durable on `storage.sql`, and `agent.runtime` on it

De-risks the move from Pi 0.99's `AgentHarness` to `@earendil-works/pi-durable@1.0.0`. Hypothesis:
pi-durable's portable `SqliteStorage` runs over a thin facade on pikit's `storage.sql`, so one
implementation serves a server (storage-sqlite) and a Durable Object (storage-do). **It holds.**

| File | What |
|---|---|
| `sql.ts` | `sqliteDatabaseFrom(db)`: `storage.sql` as pi-durable's `SqliteDatabase`; `openDurableStorage(db)`: `SqliteStorage.open` over it (pi-durable's opener takes no `Context`) |
| `testing.ts` | Runner-independent Harness smoke phases (`answerOnce`, `checkReopened`, `interruptGeneration`, `pendingWork`, `resumeInterrupted`, `answerWithTool`) on pi-ai 1.0's faux provider |
| `sql.test.ts` | Bun: pi-durable's storage conformance on storage-sqlite, and on a database held to Durable Object SQL limits; facade semantics; the Harness smoke |
| `tests/workerd/test/durable-storage.workerd.ts` | workerd: the same conformance on storage-do in a real SQLite-backed object; the Harness smoke, after an eviction, and across the object's events |
| `runtime.ts` | `createDurableRuntime(options)`: `agent.runtime` (`dispatch`, `abort`, `resume`) plus what hosts use of `PiRuntime` (`recover`, `abandon`, `holds`, `whenIdle`, `close`), and `createConversation`, `state`, `inspect` |
| `agent.ts` | `AgentDefinition` → registry extension and per-conversation `pi.agent`; the `pikit.conversation` and `pikit.agent-state` documents |
| `result.ts` | a settled input submission → `AgentResult` (text, messages, usage, error) and its `RunSettlement` |
| `context.ts` | pikit `Context` → Chord 1.0 `Context` (`toChord`), as `../context.ts` does for 0.99 |
| `test-support.ts` | not exported: the scripted agent on pi-ai 1.0's faux provider, a worker over a SQLite file |
| `*.test.ts` | `runtime` (answers, busy, duplicates, abort, contexts), `recovery` (restarts, `agent.submissions`, retries), `prepare` (and `agent.state`'s conformance), `usage`, `conformance` (`agent.runtime`'s suite), `pi-facts` (pi-durable behaviours relied on) |

`pi-ai-v1` (`npm:@earendil-works/pi-ai@1.0.0`) is a **temporary** dependency, for the faux provider
and `createModels` in `testing.ts`, until the adapter moves to pi-ai 1.0. It is a dependency, not a
devDependency, because `./durable/testing` is an export (the workerd lane imports it) and
`scripts/boundaries.ts` holds exported files to `dependencies`. The adapter still runs on pi-ai 0.99;
pi-durable resolves its own pi-ai 1.0 (the same copy as `pi-ai-v1`).

## What works

- pi-durable's own storage conformance (23 cases) passes on storage-sqlite, within Durable Object
  limits on Bun, and on storage-do in workerd.
- A `Harness` answers an input; the same `requestId` returns the same submission, also after reopen;
  a new app over the same data (Bun) and an evicted object (workerd) find the same root, transcript and
  settled submission; a tool call is validated (TypeBox), run and answered, in workerd too.
- A run interrupted mid-generation (Harness closed while the model call waits) is left as a `placed`
  submission and a `pending` `pi.generation` at checkpoint `request`; reopened, `resume()` answers it.
- A Harness kept by the object runs a submission on after the event that submitted it returned.
- workerd: pi-durable, chord and pi-ai 1.0 bundle with no `node:` import; wrangler's dry run of
  storage-do + `openDurableStorage` + `Harness` is 822 KiB, 149 KiB gzip.

## Facade semantics

- **Queueing**: both providers already run statements and transactions on one line (`serial`), so a
  call outside a running transaction waits, as `SqliteDatabase` requires. Transaction handles refuse
  statements once their callback settled.
- **Rollback**: the provider's. storage-sqlite rolls back and rethrows the same error; a failing
  ROLLBACK surfaces as its own error. storage-do delegates to `DurableObjectStorage.transaction`,
  which held across `await`s in every conformance case. `storage.sql`'s contract does not yet say
  that a failed rollback must reject with a different error; it should.
- **bigint**: pi-durable 1.0 never binds one (ids are numbers; `next_id` is TEXT, see its
  `migrations.ts`). A safe-integer bigint binds as a number, a larger one throws.
- **exec**: pi-durable only `exec`s single statements (one per migration statement, no triggers).
  Several statements are split (strings, quoted identifiers, comments, trigger bodies respected) and,
  outside a transaction, run in one. PRAGMA/VACUUM-like statements cannot be batched that way.
- **close** waits for the facade's operations and never closes the app's database.

## Limits and open questions

- **Table names** are fixed and unprefixed: `durable_schema`, `durable_metadata`, `record_ids`,
  `conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions`. That breaks
  `storage.sql`'s "prefix your tables" rule; no registry component collides today, and one
  `storage.sql` holds one pi-durable Session. On a server that means one Harness (many pi-durable
  conversations) per app; in a Durable Object, one Harness (its root) per object.
- **One owner**: `SqliteStorage` caches the next id in memory and pi-durable has no cross-process
  locking: two processes over one storage-sqlite file are unsupported.
- **Timers**: `runtime.sleep()` (scheduler `#sleep`, `delay` with `setTimeout`) is in-process. Nothing
  reports a next due time. `harness.inspect()` lists live tasks with their records: a `ready` or
  `running` task is due now; the built-in tasks keep their due time in the checkpoint (`pi.generation`
  phase `retry` `until`, phase `poll` `pollAt`; `pi.compaction` phase `retry` `until`), mirrored in
  `pi.live` (`generation.retry.at`, `generation.deferred.pollAt`, `compactions[].retry.at`). A custom
  task's `sleep(until)` is not persisted unless it checkpoints it. So an alarm can be derived for the
  built-ins, but a generic "next wake-up" needs a pi-durable API.
- **Clock**: workerd freezes `Date.now()` between I/O; `HarnessOptions.now` can take the app's clock.
- **Event lifetime**: the Harness runs work in background promises. Whether an object keeps them alive
  between events (a long model stream with no event in flight) is untested here; driving runs inside
  the alarm (`await harness.waitForIdle()`), as runtime-pi does today, is the safe shape.
- **pi-ai 1.0**: the adapter's providers (`providers/*.ts`) are written for 0.99 and must move to
  `createModels`/`Provider`; `@pikit/core`'s `Context` and chord's are separate types.

## The runtime (`runtime.ts`)

Built beside the 0.99 runtime; nothing uses it yet. It keeps the contracts and the events exactly as
consumers see them: `Admission` (`started`/`queued`/`duplicate`), `agent.dispatched`, `agent.started`
(`resumed` for a run a previous worker left open), `agent.settled`/`agent.failed` with `AgentResult`.

- **One Harness per storage**, opened at first use (`storage` is a `Storage` or an opener) and owned
  until `close`. Opening reconfigures every conversation with live work, resumes the scheduler (it is
  global: every conversation's work runs, not one's), announces the runs it resumes, and starts runs
  for inputs a failed run left queued.
- **Conversation ids.** `ConversationRef.sessionId` carries the pi-durable conversation id (a number,
  as a string); renaming the field is a later contract change. `createConversation(ctx)` makes one:
  `conversations: "ownerless"` (default, a server's storage holding many) creates an ownerless
  conversation each call; `"root"` (a per-chat Durable Object) returns the root the first time, then
  ownerless ones. A reset is a new conversation (`conversations.registry` keeps pointing keys at ids);
  pi-durable's own `reset()` (a `pi.reset` entry in the same conversation) is not used, so `agent.state`
  starts fresh exactly as before. A key/agent pair is recorded in the conversation's
  `pikit.conversation` document at each admission, so a settlement found later has its `ConversationRef`.
- **Admission.** `dispatch` runs in the conversation's line: a read-only commit looks the request id up
  (`duplicate` if pi-durable has it) and, in the same commit, applies `prepare`; then
  `submit({ type: "input", requestId })`. The status the creating commit published (`queued` in the
  inbox, or `placed`) gives `queued` or `started`. Every input is a **follow-up**, with queue modes
  `one-at-a-time`, so a run takes exactly one input: a message queued behind a run gets a run of its
  own (its `agent.started` when pi-durable places it), and `requestIds` is always `[requestId]`. The old
  runtime steered it into the run in progress; the contract's comment on `queued` and three cases of the
  `agent.runtime` conformance suite describe that and change at the switch-over (`conformance.test.ts`).
- **Settlement.** Read from pi-durable's commits (`subscribeCommits`): `done` → `agent.settled`
  `completed` with the answer's text; `unanswered`/`aborted` → `agent.settled` `aborted`; any other
  reason (`model_error`, `no_model`, `faulted`, `orphaned`, `reset`) → `agent.failed` with
  `{ code: reason, message: detail }`. `messages` are the model messages of the entries from the input's
  `pi.user` to its answer (system entries excluded); `usage` sums their assistant and tool-result usage,
  which is what pi-durable adds to `pi.usage`. An input withdrawn while queued (an abort) is recorded
  aborted in `agent.submissions` and not announced, as before. Events wait for the admission's
  `agent.dispatched`/`agent.started`, so the order is kept.
- **`agent.submissions` bridge** (transitional, kept): `admitted` before `dispatch` resolves, `settled`
  before the event (retried in the background on failure). `recover(conversation, requestIds)` settles
  what pi-durable finished while nobody recorded it (skipping what `agent.submissions` holds settled),
  and waits for those still queued or running. A redelivered duplicate whose end was never recorded is
  settled the same way. `abandon` skips requests pi-durable still holds.
- **Agents and state** (`agent.ts`). Tools live in the registry, one extension per agent
  (`pikit.agent.<name>`, every tool its turns used); each conversation's `pi.agent` selects only that
  extension, offers the turn's tools by name, and holds the model and `instructions` (the system
  prompt). `agent.state` is the conversation-scoped document `pikit.agent-state` (updates only, merged
  over the definition's initial state). `prepare(state)` is applied where its inputs change: at each
  admission (a deploy may have changed the definition), in the same commit as every state update, and
  before a reopened Harness resumes a conversation. So the agent pi-durable reads when it prepares each
  model request is always `prepare` of the state at that moment: equivalent to running `prepare` before
  each request (pi-durable has no hook where model and tools could still change), done at the writes
  instead. Difference from 0.99: a tool's state update applies from the run's next model request, not
  the next run. pi-durable's positional `pi.system` entries replace the old `pikit.turn` entries.
  Tools run wrapped so their context carries `CONVERSATION` and `AGENT_STATE`.
- **Tools and models.** `tool(name)` returns a pi-durable tool (`defineTool`); a tool object in a
  definition must be one too (the contracts' `AgentTool` is still typed as 0.99's). `models` is a pi-ai
  1.0 `Models`.
- **Hosts that live per event.** `whenIdle` resolves once no task is driven and nothing is being
  recorded or announced; work that only waits for a time (a generation's `retry`/`poll`, a compaction's
  `retry`: in-process sleeps) does not count, and `onIdleWithPendingWork(inspection, ctx)` is called so
  the host schedules a wake-up (`wakeups.ts` computes when). A reopened Harness continues the wait from
  its checkpoint, on the Harness clock (`now`). This replaces the old `retryAt`.
- **Contexts.** `toChord` re-attaches a pikit context's signal for Chord 1.0. Tasks run in the
  Harness's context (the app's values); a dispatching caller's values no longer reach tools, only the
  run's events.

## Gaps bridged (asserted in `pi-facts.test.ts`)

- A run that ends unanswered leaves follow-ups queued in the inbox until the next submission. The
  runtime submits a write of kind `pikit.inbox-kick` (an entry without model messages) to an idle
  conversation with queued inputs: the admission boundary places the oldest and starts its run.
- pi-durable passes the provider no session id, so prompt-cache keys keyed on it (and the faux
  provider's cache simulation) get none.

## Switch-over (wave 3)

- `runtime-pi`: build the runtime with `createDurableRuntime` (storage from `storage.sql` via
  `openDurableStorage`, `models` from pi-ai 1.0 providers, `tool` from the ported tools); drop
  `sessions.store`; replace the driver's `retryAt` with `onIdleWithPendingWork` + `wakeups.ts`;
  `resume.ts` keeps calling `recover`/`abandon`.
- `deployment-cloudflare` / storage-do hosts: `conversations: "root"` (one chat per object), the
  object's clock as `now`; runs still driven inside the wakeup handler (`whenIdle`).
- `conversations-file` / `conversations-kv`: create conversations with `runtime.createConversation`
  (an `agent.conversations` capability or similar) instead of `sessions.store.create`; existing
  pointers hold 0.99 session ids, which the durable runtime refuses (`session_missing`), so they need a
  migration or a reset.
- `sessions-jsonl` / `sessions-sql`: no longer used by the runtime; pi-durable's tables live in
  `storage.sql` (unprefixed, one Harness per database).
- Contracts: `AgentPayloads` to pi-ai 1.0 messages/usage and pi-durable tools; `ConversationRef.sessionId`
  renamed; the `queued` comment and the conformance suite's three steering cases updated.
