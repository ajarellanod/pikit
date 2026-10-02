# pi-durable on `storage.sql` (spike)

De-risks the move from Pi 0.99's `AgentHarness` to `@earendil-works/pi-durable@1.0.0`. Hypothesis:
pi-durable's portable `SqliteStorage` runs over a thin facade on pikit's `storage.sql`, so one
implementation serves a server (storage-sqlite) and a Durable Object (storage-do). **It holds.**

| File | What |
|---|---|
| `sql.ts` | `sqliteDatabaseFrom(db)`: `storage.sql` as pi-durable's `SqliteDatabase`; `openDurableStorage(db)`: `SqliteStorage.open` over it (pi-durable's opener takes no `Context`) |
| `testing.ts` | Runner-independent Harness smoke phases (`answerOnce`, `checkReopened`, `interruptGeneration`, `pendingWork`, `resumeInterrupted`, `answerWithTool`) on pi-ai 1.0's faux provider |
| `sql.test.ts` | Bun: pi-durable's storage conformance on storage-sqlite, and on a database held to Durable Object SQL limits; facade semantics; the Harness smoke |
| `tests/workerd/test/durable-storage.workerd.ts` | workerd: the same conformance on storage-do in a real SQLite-backed object; the Harness smoke, after an eviction, and across the object's events |

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
