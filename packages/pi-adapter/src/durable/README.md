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

## pi-ai 1.0: models, providers and credentials

New, beside the 0.99 code (which stays as it is until the switch):

| File (export) | What |
|---|---|
| `models.ts` (`./durable/models`) | `modelsFrom(providers, { credentials, authContext })`: a 1.0 `Models`, same semantics as `../models.ts`; `modelRefOf(models, agent, "provider/modelId")`: pi-durable's `ModelRef`, split at the first slash (`openrouter/z-ai/glm-5.3-flash`), failing on a bad name, an unknown provider (listing the installed ones) or an unknown model |
| `providers/anthropic.ts`, `providers/openrouter.ts` (`./durable/providers/*`) | 1.0 providers by subpath; `openrouterProvider({ apiBase })` takes over provider-openrouter's `at()`, and also moves image/classifier models |
| `credentials.ts` (`./durable/credentials`) | the 1.0 credential types; `loginInteraction(terminal)`: an `AuthInteraction` that answers every prompt type, `select` included |

0.99.0 → 1.0.0 differences that touch pikit (the `.d.ts` files differ only in `env-api-keys` and
`constrained-sampling`; the rest is behaviour):

| Area | 0.99 → 1.0 | For pikit |
|---|---|---|
| Entry points | new `@earendil-works/pi-ai/models`: `createModels`, `createProvider`, `Provider`/`Models`, `ModelsError`, without TypeBox or catalogs. Auth types stay on the root (`import type`) | `durable/models.ts` uses it (Workers bundle size) |
| Providers | `anthropicProvider()`, `openrouterProvider()`: same ids, signatures, credential order; catalogue data refreshed. Anthropic adds workload identity federation (`ANTHROPIC_FEDERATION_RULE_ID` + `ANTHROPIC_ORGANIZATION_ID` + `ANTHROPIC_IDENTITY_TOKEN_FILE`), after the keys | `checkAuth("anthropic")` also reports configured with those set |
| Models | `createModels`/`setProvider`/`getModel`/`checkAuth`/`getAuth`/`login`/`logout` unchanged (0.99 already had them). pi-durable takes `Models` plus a `ModelRef {provider, modelId}` instead of a resolved `Model` | `modelRefOf` replaces `turns.ts`'s `resolveModel` |
| Credentials | `CredentialStore`, `Credential`, `OAuthCredential` unchanged; refresh still runs inside `modify` and is written back; a failed refresh (`ModelsError` code `oauth`) keeps the stored credential | credentials-file works as is, file format unchanged: **no migration** of existing `.pikit/credentials.json` (tested on a 0.99-format file) |
| Auth/OAuth | Anthropic's OAuth `login` first asks a `select` prompt (`browser` or `copy_code`; copy-code shows a code on Anthropic's page, no localhost callback). The `select` prompt type existed in 0.99, no flow used it | an interaction that answers free text fails ("Unknown Anthropic login method"): use `loginInteraction` |
| Usage/cost | `Usage`, `calculateCost` unchanged. pi-durable keeps a per-conversation `pi.usage` ledger keyed `provider/modelId` (pikit's names) plus per-tool buckets | usage accounting can read pi-durable's ledger |
| `Context` | pi-ai's request `Context` unchanged. pi-durable's calls take chord's `Context` (cancellation, deadline), a third type besides `@pikit/core`'s | name imports apart (`ChordContext`) |
| Type identity | 0.99 and 1.0 declarations are structurally the same, so TypeScript accepts a 0.99 `Provider` in a 1.0 `Models` (it would run 0.99 code) | import each module's providers from one version |

What the switch must change:

- **provider-anthropic**: import `anthropicProvider` from the 1.0 module; README: federation variables.
- **provider-openrouter**: `openrouterProvider({ apiBase: config.apiBase })` replaces its `at()`.
- **credentials-file**: no code change (its `CredentialStore` type comes from the 1.0 adapter);
  `testing/credentials.ts` (its conformance) moves to 1.0's `createProvider` and `modelsFrom`.
- **`pikit configure`** (`packages/cli/src/project/credentials.ts`) and `samples/http/scripts/login.ts`:
  their `prompt` returns the typed line for every prompt, so `--login anthropic` would fail at the
  method question. Build the interaction with the adapter's `loginInteraction` (secret prompts
  without echo); the `AuthInteraction` described in the CLI script gains `select`. Where the app runs
  (`pikit up`, Docker), copy-code needs no localhost callback (browser login still accepts the pasted
  redirect URL); configure's hint ("paste the page's address back") should name both. `check` is
  unchanged.
- Drop the `pi-ai-v1` alias: pin `@earendil-works/pi-ai@1.0.0` and rewrite `pi-ai-v1` imports.
