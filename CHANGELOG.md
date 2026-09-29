# Changelog

What changed for someone who uses pikit, newest first. Components version on their own; each
line names its area (AGENTS.md, "Git and docs").

## Unreleased

- component/platform-cloudflare: new. `actor.mailbox`, `actor.inbox` and `wakeups` on Cloudflare, in both Apps: from the Worker, `send` is an RPC to the conversation's object (`env.CONVERSATION`, configurable; its `actor.inbox` and `wakeups` throw, saying they belong in the object); in the object, `deliver` calls the handler registered with `actor.inbox` for the type, `actor.mailbox` sends to its own key locally and to others by RPC, and `wakeups` are rows in `platform_cloudflare_wakeups` over the object's one alarm, run one at a time in slices (`sliceMs`, 60 s by default) with backoff rows. Target `cloudflare`; new kind `platform`. A slice leaves no timer longer than a second behind (a pending timer keeps an object from being evicted). Both suites also run in the workerd lane, by RPC and alarm to deployment-cloudflare's real `Conversation` class.
- component/runtime-pi: targets `cloudflare` too: in workerd, in a real Durable Object with sessions on `sessions-sql` over `storage-do`, a message sent from the Worker by RPC is answered by a run driven in `platform-cloudflare`'s alarm.
- docs: `sessions-sql` is transitional: when the adapter moves to Pi's durable runtime (`pi-durable`), sessions become its storage and `sessions-sql` goes (SPEC C5, `features/pi-durable-migration.md`). On Cloudflare they will sit on the object's SQL directly, since `pi-durable`'s SQLite core needs a synchronous database and `storage.sql` is asynchronous.
- registry: `component.json`'s `apps.worker` may be `"default"`: the component itself goes in both Apps of a Cloudflare project, under its own name and config key in each (SPEC C1). When it names a Worker half, `registry generate` writes what each half declares in `halves` (`default`, `worker`), and `registry validate` checks it and that the half is the component `<name>-worker`, its config key in `workerConfig`.
- cli: on Cloudflare, `pikit add` lists a component's Worker half in `export const worker` too (`import channelTelegramWebhook, { worker as channelTelegramWebhookWorker }`), or the component itself in both lists when `apps.worker` is `"default"`; what each half requires is warned about and offered in its own App; `pikit remove` takes its entries out of every list and its keys out of `config` and `workerConfig`, and refuses when something in either App requires what only it provides; `pikit doctor` prints the Worker's App too. Server projects are unchanged.
- registry: `component.json` may name an after-deploy hook, `"hooks": { "afterDeploy": "deploy.ts" }` (a file of the component exporting `afterDeploy({ url, config, get, say })` that resolves with its problems); `registry validate` checks the file exports it, and `pikit add` records it in `pikit.json` by project path.
- component/deployment-cloudflare: `up` runs the installed components' `afterDeploy` hooks once `/health` answers the new version (C8), with the deployed URL, each component's config and a reader of the environment and `.env`; it prints what they say and fails with all their problems, leaving the version deployed. `deployHooks(cwd)` lists them.
- component/channel-telegram-webhook: `component.json` names `deploy.ts` as its after-deploy hook, so `pikit up` registers each bot's webhook once the new version answers; `pikit add` puts each half in its App.
- component/secrets-cloudflare: `apps.worker` is `"default"`: `pikit add` lists it in both Apps.
- component/platform-cloudflare: `apps.worker` is `"default"`: `pikit add` lists it in both Apps (the mailbox in the Worker's; `wakeups`, `actor.inbox` and the mailbox in the object's).
- component/runtime-pi: uses `wakeups` when installed (SPEC C4): every run is driven inside the wakeup handler `runtime-pi.drive`, asked for by a dispatch or resume that leaves a run going, by start with `agent.submissions` (instead of resuming in the background) and by Pi's retry backoff; each run of it resumes what is due or pending, waits for the App's runs until its slice ends, and asks again at once while runs remain. Without `wakeups`, nothing changes. Its README has a Cloudflare section.
- adapter: `createPiRuntime({ retryAt })` continues a run past Pi's retry backoff from outside the process (the run stops being driven at the wait, and is resumed at or after `notBefore`) instead of a timer; `runtime.holds(conversation)` and `runtime.whenIdle(ctx)` tell a host whether this worker still drives runs, for one that must wait for them inside an event.
- cli: `pikit new <dir> --target cloudflare` records `targets: ["cloudflare"]` in `pikit.json` (components and offered providers are then those that run there), writes a two-App `pikit.config.ts` (the default export for each conversation's Durable Object, `export const worker` for the Worker, SPEC C1), `wrangler` in devDependencies and `.wrangler/`/`.dev.vars*` in `.gitignore`. `pikit add`/`remove` edit the default export's list in a file with several Apps; `pikit doctor` also composes `export const worker`; `pikit dev` runs the deployment's own `dev` when it exports one (`wrangler dev`); `pikit status` prints Cloudflare deployments; the guided `pikit new` offers only presets that run on a server. The server path is unchanged.
- preset/cloudflare-minimal: new. `pikit new <dir> --target cloudflare --preset cloudflare-minimal`: `storage-do`, `sessions-sql`, `conversations-kv` (with `storage-kv-sql`) and `deployment-cloudflare`; no channel or runtime yet.
- component/deployment-cloudflare: new. Runs a project on Cloudflare: `wrangler.jsonc` (one SQLite-backed `Conversation` Durable Object class, `nodejs_compat`, `version_metadata`, `.md`/`.wasm` rules) and an entrypoint that composes `pikit.config.ts`'s default export in each object (lazily, inside `blockConcurrencyWhile`, 20 s start and 5 s rollback deadlines, a failed start rethrown so the object resets) and `export const worker` in the Worker (its `http.route`s served), with `WORKERS_HOST` on each start context; `alarm()` and the RPC `deliver()` call the handlers registered with `onAlarm`/`onDeliver`; public `GET /health` answers `{ ok, version }`. Commands: `up` (`wrangler deploy --secrets-file` with `.env`'s secrets but `CLOUDFLARE_*`, then waits until `/health` answers the new version, rolling back one that answers its App does not start), `down` (`wrangler delete`, only at a terminal), `logs`, `status`, `dev`. Target `cloudflare`.
- repository: `wrangler` 4.143.0 in the root devDependencies (the version the workerd lane pins), for `deployment-cloudflare`'s bundle test and the Worker of new Cloudflare projects; the workerd lane runs `deployment-cloudflare`'s entrypoint on real Durable Objects.
- registry: a deployment component's `commands.ts` runs on the machine that deploys (the CLI loads it), so `registry validate` lets it import `node:*` whatever the component's targets, as it does tests; every other file stays held to them (S5).
- component/channel-telegram-webhook: its object half registers `telegram.update` with `actor.inbox`'s `handle` in its start: `actor.inbox` moves from its `provides` to its `requires`. It starts in one object App with `platform-cloudflare` and `runtime-pi`, and answers an update there.
- component/channel-telegram-webhook: new. Telegram by webhook for Cloudflare (SPEC §4.1, C6), in two halves: the Worker's (the export `worker`: `POST /telegram` and `/telegram/<name>`, the webhook's secret checked in constant time, private text messages from allowed users only, a stranger told their id, then `actor.mailbox.send("telegram:<chat>", "telegram.update", update)`, `200` once the conversation holds it and `500` otherwise) and the object's (the `actor.inbox` handler: `/start`, `/help`, `/new`, `admitInbound`; the wakeup `channel-telegram-webhook.deliver`: answers from `agent.submissions`' feed with a cursor in `storage.kv`, pieces marked `sending`/`sent` and one found `sending` sent again with `↻ `, "typing…" while a message waits, `outbound.queue` if installed). `pikit configure` checks the token, generates `TELEGRAM_WEBHOOK_SECRET` and allows you; `deploy.ts`'s `afterDeploy({ url, config, get, say })` registers and checks each bot's webhook once a deploy answers (C8). Target `cloudflare`.
- registry: `component.json` may name a half for another App, `"apps": { "worker": "<export>" }` (SPEC §4.1, C1): the named export of `index.ts` goes in the Worker's App, the default export in the default one; `registry generate` and `validate` describe both halves, so `provides`, `requires` and `optional` cover the component as a whole, and a named export that is missing or not a component is a problem.
- repository: the workerd lane also runs Pi's session conformance on `sessions-sql` over `storage-do`
  (the Durable Object session backend passes it, SPEC §4) and `agent.runtime` on `runtime-pi` over
  those sessions, and `execution-do` with Pi's own tools on it; `bun run --cwd tests/workerd bundle`
  measures a conversation object's bundle (1,002 KiB gzip with `execution-do`, 216 KiB without).
- component/execution-do: new. `execution` and `execution.shell` in the conversation's Durable
  Object: files in its SQL (`execution_do_*` tables, 1 MB chunks), a shell without processes
  (just-bash) with `git` (isomorphic-git: clone, status, diff, commit, log, push, pr), `node` (QuickJS
  in WebAssembly, with an interrupt budget and a heap limit) and `curl`. Only `git` writes inside
  `.git`; pushes go only to `git.pushRepositories`, on `pikit/self/` branches, with a token read
  through `secrets` that never reaches the shell. Pi's `bash`, `read`, `write` and `edit` run on it
  unchanged. Target `cloudflare`; the Worker needs `nodejs_compat` and a `CompiledWasm` rule (README).
- adapter: `@pikit/pi-adapter/execution` gives an `execution` provider Pi's `ok`, `err`, `FileError`,
  `ExecutionError`, `truncateTail` and `truncateHead` without importing Pi; `@pikit/pi-adapter/testing/neutral`
  is the part of the test kit that runs in workerd too (Pi's session and execution suites, the scripted
  agent, `createRuntimeFixture` over records of your own, and `interruptInProcess`).

- cli: `pikit add` and `pikit new` also offer the provider of a capability a component requires when the catalogue marks it `offer`: `pikit add conversations-kv` offers `storage-kv-sql` (and `storage-sqlite`).
- component/conversations-kv: new. `conversations.registry` on `storage.kv` (namespace `conversations-kv`) and `sessions.store`; targets `server` and `cloudflare`. A first pointer is written with `setIfAbsent`, a reset emits `conversation.reset` once its pointer is stored, and its README says what holds when resets and resolves race across processes.
- component/tool-websearch-brave: new. The `websearch` tool on the Brave Search API; its key,
  `BRAVE_API_KEY`, is read through `secrets` and never reaches the model, and a search without it
  fails saying so. `replay: "safe"`, `apiBase` in config; targets `server` and `cloudflare`.
- component/tool-fetch: new. The `fetch` tool: one HTTP(S) request, GET by default (HEAD, POST, PUT,
  PATCH, DELETE allowed; the model is asked to confirm any but GET and HEAD with the user), 20 s,
  2 MB read, HTML as readable text with its links, JSON pretty-printed, binary refused, no
  credentials of its own; `replay: "never"`; targets `server` and `cloudflare`.
- component/provider-openrouter: new. OpenRouter's models for your agents, named
  `openrouter/<vendor>/<model>` (`openrouter/z-ai/glm-5.3-flash`), with `OPENROUTER_API_KEY` or a key
  in `model.credentials`; targets `server` and `cloudflare`. Your OpenRouter account's guardrails
  may refuse some models at their first request.
- adapter: `agentTool(tool, { replay })` in `@pikit/pi-adapter/tools`: the tool `toolComponent`
  provides, without the component, for a `defineComponent` of your own that needs config or a
  capability (a secret) and names itself (`tool-websearch-brave` provides `websearch`).
- adapter: `@pikit/pi-adapter/providers/openrouter` exposes pi-ai's OpenRouter provider by
  subpath, so a bundle carries only the providers it installs. Its module imports nothing node-only.
- component/submissions-sql: targets `cloudflare` too: unmodified, over `storage-do`, it passes its
  `agent.submissions` suite (with the feed, pruning and restarts) in workerd. On Cloudflare its
  records are the conversation object's.
- repository: the workerd lane (`bun run test:workerd`, `tests/workerd/`, a CI job): Vitest with
  `@cloudflare/vitest-plugin` runs, offline in workerd on a real SQLite-backed Durable Object, the
  `storage.sql` suite on `storage-do`, `storage.kv` on `storage-kv-sql` and `agent.submissions` (with
  its feed) on `submissions-sql` over it, and `secrets` on `secrets-cloudflare`, and typechecks them
  against Workers' runtime types.
- contracts: the agent runtime and HTTP route suites compile against Workers' runtime types too.
- component/secrets-cloudflare: new. `secrets` from the Worker's `env` (its secrets and variables;
  bindings and empty strings read `undefined`), in either App of a Cloudflare project. Target
  `cloudflare`.
- component/storage-do: new. `storage.sql` in a Durable Object's own SQLite (`ctx.storage.sql`), for
  the conversation object's App on Cloudflare; its README lists the object's SQL limits (2 MB per
  row, short `LIKE` patterns, 10 GB per object, 1 GB on Free). Target `cloudflare`.
- cli: `pikit add` and `pikit new` offer only providers that run on the project's targets, so a
  Cloudflare provider in the registry (`storage-do`) does not stop `storage-sqlite` from being
  offered on a server.
- contracts: the context key `WORKERS_HOST` (SPEC C5): on Cloudflare, each App's start context carries
  the Worker's `env` and, in a Durable Object's App, the object (its id, its storage, and hooks for
  its alarm and RPC deliveries), typed structurally. `withWorkersHost` in `@pikit/contracts/testing`
  puts it in the context of components under test.
- component/sessions-sql: new. `sessions.store` on `storage.sql` (the adapter's SQL store), so
  sessions live in the app's database on a server and in a Durable Object alike; tables
  `sessions_sql_*`, versioned and migrated at start; targets `server` and `cloudflare`. Optional
  `cwd` config.
- component/runtime-pi: its tests also run the `agent.runtime` conformance on sessions in
  `storage.sql`, including a worker killed mid-run.
- adapter: `createSqlSessionStore(db, { cwd })` in `@pikit/pi-adapter/sql` (neutral: server and
  Cloudflare): Pi sessions on `storage.sql`, a `sessions.store` with `find(id)` and `migrate()`. It
  passes Pi's session suites (repository, forks, storage) on SQLite held to a Durable Object's limits;
  a record over 256 Ki characters is stored in parts. In `@pikit/pi-adapter/testing`:
  `createPiRuntimeFixture(runtime, { sessions: "sql" })` and `killMidRun(…, "sql")` run the runtime
  and its killed workers on it, `openSqliteDatabase(path, { durableObjectLimits })` is a `storage.sql`
  for tests, and `createSessionRepoStreamingForkConformance` is Pi's fork cases the repository suite
  does not include yet.
- contracts: `actor.mailbox` and `actor.inbox` (experimental, SPEC C2): the component that handles a
  type of message registers its handler with `actor.inbox`'s `handle(type, handler)` in its `start`
  (one handler per type, dropped at stop), as `wakeups` registers its own, so it may also send, wake
  itself or use the runtime with no dependency cycle. `send(key, type, message, ctx)` resolves once
  the actor owning `key` holds the JSON message durably (its handler for `type` resolved), and
  rejects otherwise, with an error naming the type when nothing handles it. The handler gets a copy
  and a context of its own. Its conformance suite (with `wakeups: true`, an actor that also wakes
  itself) and a memory mailbox for tests are in `@pikit/contracts/testing`.
- contracts: `wakeups` (experimental, SPEC C3, C4): the component that owns the work registers a
  handler with `handle(name, handler)` in its `start` (one owner per name, dropped at stop) and asks
  with `at(name, time, ctx)`, replacing its earlier request; `cancel(name, ctx)` drops it. A request
  may come before its handler and waits for it. At least once, never early, one run per name at a
  time; a handler that rejects runs again with the provider's backoff, and its context may be
  cancelled at a slice deadline, after which it asks again. Its conformance suite (on a manual clock)
  and a memory wakeups for tests, forgetful or durable, are in `@pikit/contracts/testing`.
- component/mailbox-local: new. `actor.mailbox` and `actor.inbox` on a server: `send` calls the
  handler registered for the type in the same app with a JSON copy and resolves when it does; `stop`
  cancels the handlers still running and drops them. Targets `server`. `mailbox` is a new component kind.
- component/wakeups-timers: new. `wakeups` on a server as in-process timers on the app's clock: a
  failed handler runs again after 1 s, 5 s, 30 s, then every 60 s, logged each time; optional
  `sliceMs` cancels a running handler's context as Cloudflare would, and no timer outlives a stop by
  more than a second. Nothing is persisted: components register and ask again at start. Targets
  `server`. `wakeups` is a new component kind.
- spec: the Cloudflare target's decisions (SPEC §4.1, C1–C8): a thin Worker and an App per conversation's Durable Object, `actor.mailbox`, `wakeups`, work in slices inside events (with the limits measured on the Free plan), neutral state providers and one platform context key (`WORKERS_HOST`), `channel-telegram-webhook`, `execution-do`, and a deploy that waits for its version to answer.
- adapter: `toolComponent(tool, { replay })` in `@pikit/pi-adapter/tools`: a tool of your own in the
  shape of Pi's `defineTool` becomes a component (`tool-<name>`) that provides `agent.tool`, so an
  agent names it in `tools`. Unlike a Pi extension's tool, it may be `replay: "safe"`, and `pikit
  doctor` lists it. Its fifth `execute` argument is the run's context (its conversation), not Pi's
  `ExtensionContext`: an object typed by Pi's `defineTool` does not compile there; write it inside
  `toolComponent`.
- contracts: `storage.kv` (experimental): small JSON values a component keeps across restarts, by
  key, in a namespace of its own (`get`, `set`, `setIfAbsent`, `delete`). Its conformance suite and a
  memory storage for tests are in `@pikit/contracts/testing`. `pikit add` offers its provider.
- component/storage-kv-sql: new. `storage.kv` on `storage.sql`, in one table
  (`storage_kv_sql_entries`); targets `server` and `cloudflare`.
- component/channel-telegram: its answers' cursor moves from its own `storage.sql` table
  (`channel_telegram_cursors`) to `storage.kv` (key `answers-cursor` of its namespace); answers come
  from the feed with `agent.submissions` and `storage.kv`. `pikit add channel-telegram` offers
  `storage-kv-sql`. The old table is not read: a project that upgrades starts its cursor at the
  feed's end, as on a first install, so an answer that ended during that one deploy is not sent.
- component/channel-telegram: an answer read from the feed that Telegram could not take, or whose
  send a stop aborted, is sent again later instead of being dropped; the cursor moves only past a
  delivered answer. Chats no longer wait for each other, a stuck answer is logged as an error, and
  every feed gap is logged. Installing it where `submissions-sql` already runs no longer resends old
  answers.
- component/channel-http: a malformed escape in a path id gets 400 instead of 500.
- adapter: a redelivered duplicate whose run's end `agent.submissions` never recorded (two crashes)
  is settled from the session. `recover` settles requests steered into another request's run and
  requests an abort withdrew (as `aborted`), never re-announces a settled request, and no longer
  waits for runs of new messages.
- component/runtime-pi: `stop` no longer waits on an `agent.submissions` whose `pending()` never
  answers.
- component/submissions-sql: `keepSettledDays` is at least 1 (0 pruned answers that ended during a
  deploy before the channels could deliver them); `migrate` reads the schema version inside each
  step's transaction, so two processes starting at once no longer both run migration 0.
- contracts: `agent.submissions`' settlement is idempotent within the provider's retention; the
  suite checks `pending`'s order by oldest pending request and re-settling after a restart.
- docs: features move out of SPEC.md into `features/`, one file each, with no order; ⭐ marks what
  makes OpenClaw or Hermes attractive.
- docs: SPEC-CORE adds a fourth required outcome, **the main agent knows and improves itself** (§6):
  a steward agent with a `pikit-self` skill and a read-only `pikit_self` tool changes its own
  project through git (a branch, `pikit doctor` and tests, a human's approval, a merge by a service
  identity it never holds, a deploy as a generation boundary, an automatic rollback), internally and
  in its dashboard, on the server and on Cloudflare (Sandbox workspace, Worker Previews, gradual
  deploys). K13: the kernel's `APP_DESCRIPTION` context key describes the running app, read only by
  the dashboard and the self-knowledge component. `ROADMAP.md` gains track S.
- samples: the http sample has the storage and submissions `runtime-pi` brings; a POST sent again
  answers with its outcome instead of `409 duplicate`.
- component/channel-http: `GET /v1/conversations/:id/messages/:messageId` returns what became of a
  message (`200` / `202` / `502` / `409 aborted`, `404` unknown), and a POST whose `messageId` is
  already in the conversation answers with its outcome, with `agent.submissions` installed. Without
  it, `GET` is `501` and a repeated POST is `409 duplicate`, as before.
- component/channel-telegram: with `agent.submissions` and `storage.sql`, answers are delivered from
  the `answers` feed with a cursor of the channel's own, so an answer that ends while the channel is
  stopped (a deploy) reaches the chat at the next start, and one the outbox could not store is tried
  again. Without them, every answer the channel cannot send is logged; before, it was dropped
  silently.
- component/runtime-pi: records in `agent.submissions` when installed, and resumes at start, in the
  background and four at a time, every conversation holding a message nobody answered. A message
  acknowledged to Telegram before a crash is answered with no new message. `pikit add runtime-pi`
  (and so `pikit new`) offers `submissions-sql`.
- adapter: with `submissions`, `createPiRuntime` records each message before `dispatch` resolves and
  each run's end before its event (retried when the record fails), and settles withdrawn messages as
  aborted. `PiRuntime.recover()` opens a conversation with pending requests and settles, from the
  result Pi stored, a run whose end was never recorded.
- component/submissions-sql: new, kind `submissions`. `agent.submissions` on `storage.sql`: pending
  requests, idempotent settlements, and the `answers` feed, kept 7 days (`keepSettledDays`). Passes
  the submissions, feed, lifecycle and convergence suites.
- contracts: `agent.submissions` (`AgentSubmissions`, `RunSettlement`, `SubmissionStatus`,
  `PendingConversation`), shaped like the submissions of Pi's durable runtime; its suite
  `createSubmissionsConformance` and its double `createMemorySubmissions`.
- docs: **`SPEC-CORE.md`**, what must hold whatever else pikit becomes, comes before every other
  document: the kernel's twelve decisions (no `Target` in the kernel, no persisted events, config as
  a plain object, a frozen `Context`, `stop()` never needed for correctness, several Apps per
  project, stability only after Node and Cloudflare prove it…), Cloudflare as a required target,
  and a required dashboard built with Beautiful UI. `ROADMAP.md` gains the required tracks K (the
  kernel is stable) and D (the service is visible). SPEC §12 no longer describes a
  `config/pikit.yaml` the CLI never read.
- cli: **`pikit.json` version 2.** The CLI's own registry is recorded as `builtin`, not as this
  machine's path, so a project cloned elsewhere keeps working; a registry inside the project is
  recorded relative to it, and any other `--registry` path draws a "not portable" warning. A version 1
  file is read and converted on the next write.
- cli: `pikit add` keeps the original of every file it installs in `pikit-bases/<sha256>` (committed
  with the project), the base M3's `upgrade` will merge from; `remove` deletes the ones nothing uses.
  The plan warns when the registry has uncommitted changes.
- cli: `pikit.json` records the commit of the kit in `vendor/`; `pikit add` refuses to replace a newer
  kit with its own older one unless `--force`. A commit the CLI's checkout does not know is only
  warned about.
- component/deployment-docker: `.dockerignore` leaves `pikit-bases/` out of the image.
- spec, adapter: pikit promises the tested tier A of Pi's extension API (tool policy, the run's
  lifecycle and notifications, tools), not every extension; the rest is best-effort or absent
  (SPEC §6.2b). `bun scripts/pi-extension-drift.ts <tag>` lists how Pi's extension API differs from
  pikit's before a bump.
- cli: `pikit doctor` fails on a Pi extension importing a name the shim does not export, and notes
  what each extension uses that pikit does not provide (events it never fires, inert `ctx.*` and
  `pi.*` members, terminal UI).
- repository: **correction.** pikit runs on Bun only; no `package.json` lists `node` in `engines`
  any more. The kit ships TypeScript source that Node does not run. Node ≥ 22 is a 1.0 requirement
  (SPEC §9.1).
- adapter: a Pi extension whose `tool_call` handler throws now blocks the call (fail closed), as Pi
  does. Before, a failing permission check let the tool run. The error goes to the log, never to the
  model.
- adapter: a message queued behind a run that fails, steered after a run's last boundary, or left
  by a worker that died between `steer` and `accept` now gets a run of its own. Before, it waited in
  Pi's inbox until the user wrote again, and a redelivery was answered `duplicate`.
- adapter: fix a deadlock when an extension calls `ctx.abort()` as a run ends; the runtime no longer
  keeps one entry per session forever.
- adapter: `close()` waits for conversations still opening, so none is left driving a run after
  shutdown; `agent.started` always precedes the run's `agent.settled` or `agent.failed`.
- contracts: the agent-runtime suite has a case for a message queued behind a failing run; its
  fixture gains `failNext()`.
- core: a failed rollback is no longer only logged. `start()` rejects with it attached (the start's
  own failure stays the message and cause), and a `stop()` that interrupted the start rejects, so
  the process exits non-zero.
- contracts: the convergence suite also kills the process the instant each commit lands, and
  injects a storage failure the process survives (fixture option `retryAfterMs`,
  `SimulatedStorageFailure`). `outbound-durable` fails the second at the write of a delivery (a
  known bug), marked `test.failing` until it is fixed.
- cli: a refused or failed `pikit add` leaves the project as it was (`package.json`, `vendor/`,
  `bun.lock`, `pikit.json`, `pikit.config.ts`). Every check and confirmation, offers included, comes
  before the first write. `pikit.config.ts` edits work in files without semicolons, in `add` and
  `remove`.
- cli: `pikit add` lists every file a component writes outside `src/pikit/<name>/` and names them in
  its confirmation. A component that would write the project's own records (`package.json`,
  `pikit.json`, `bun.lock`, `.env`, `.git/`, `vendor/`, `node_modules/`, `.pikit/`…) is refused, even
  with `--force`; `pikit registry validate` reports it.
- cli: `pikit doctor` fails, and `pikit remove` refuses without `--force`, when an agent names a
  tool, an extension or a model provider that no installed component provides.
- installer: installs a pinned Bun (1.4.2, `PIKIT_BUN_VERSION` to change it) and accepts an existing
  Bun only from 1.4.0 up to, not including, 2.0.0; `bun upgrade` is no longer run.
- samples/http: the live Anthropic test runs only with `PIKIT_LIVE=1` and a credential, so a plain
  `bun test` never calls a paid API.
- repository: CI runs `bun test`, the typecheck and `registry validate` on every pull request and
  push to main; a nightly workflow runs the installer and the e2e suites with Docker.
- component/credentials-file: a write flushes the directory after its rename, as
  `conversations-file` does. Before, a crash right after a token refresh could bring the old file
  back, with a refresh token the provider had already revoked.
- core, contracts: **breaking.** `@pikit/core` is now only the kernel: `defineApp`,
  `defineComponent`, the capability, event and pipeline machinery, the context, clock and logger.
  The vocabulary the components share moved to a new package, `@pikit/contracts`, which versions on
  its own (SPEC §4.9):
  - `defineAgent` and the agent's types, `admitInbound` and `InboundMessage`, `answerKey`,
    `AGENT_STATE`, `CONVERSATION`, and the `storage.sql`, `secrets`, `http.route`,
    `conversations.registry`, `outbound.queue` and feed contracts;
  - their conformance suites, now in `@pikit/contracts/testing`. `@pikit/core/testing` keeps
    `createLifecycleConformance` and `createManualClock`.

  To migrate a project, import those names from `@pikit/contracts` and declare it in
  `package.json`. The kernel's export list is held by a test: adding to it is a decision.
- cli: `pikit new` vendors `@pikit/contracts` with the rest of the kit. `pikit add` on a project made
  before the split adds its tarball and its override. The project's own imports still have to be
  moved by hand.
- registry: every component that imports `@pikit/contracts` lists it in `component.json`'s
  `dependencies`, with its own version; `requires.pikit` covers the kernel only.
- component/channel-http: **breaking.** `inbound.authenticate` is now `http.authenticate`, and
  `channel-http`, its only user, declares it instead of the core. A component's own names carry its
  prefix (SPEC §4.3). Its value, its stage (`channel-http-bearer`) and failing closed are unchanged.
  A project extension that adds a stage to it changes the pipeline's name.
- contracts, component/outbound-durable: `createOutboundQueueConformance(fixture, { retry })` takes
  the provider's retry policy and holds it to it. The waits and the maximum age are no longer fixed
  by the suite, so a copy of `outbound-durable` can change them and still pass. `outbound-durable`'s
  policy is unchanged.
- cli: the capability catalogue gives each capability a level (`experimental` or `stable`), shown by
  `pikit registry capabilities`. A `stable` one needs two providers in the registry. Every capability
  is `experimental` except `agent.definition`, which the project provides and which is shown so.

- core, component/outbound-durable: the convergence suite, `createConvergenceConformance` in
  `@pikit/core/testing` (SPEC §14). It kills the process after each of its commits in turn (its
  `storage.sql` refuses the next commit and everything after it), starts a new one over the same
  records, repeats the scenario as a retrying world would, and checks an invariant. Its own test shows
  a consumer reading a feed passes and one reacting to events alone fails. `outbound-durable` passes
  it: after a crash at any of its commits, every piece is delivered in order with one receipt, and
  every repeated send is marked a possible duplicate.
- core, component/outbound-durable: delivery receipts. `OutboundQueue.receipts` is a feed of
  `DeliveryReceipt`s: one per piece that settled, delivered (with the platform's message id) or
  abandoned (with its reason), in the order they settled (SPEC §5). `outbound-durable` writes each in
  the same transaction as the piece's state (`outbound_receipts`), prunes them with their pieces, and
  now versions its tables (`outbound_meta`): an existing database gains the receipts table, and one
  written by a newer outbox is refused at start. The queue suite checks receipts, and runs the feed
  suite over them.
- core, component/channel-telegram: `answerKey(conversation, requestId)`, the one formula for a run's
  answer key (`${sessionId}:${requestId}`, SPEC §5). The channel enqueues answers under it; a tool finds
  its run's answer with `answerKey(context.value(CONVERSATION), invocation.operationId)`. Keys are
  unchanged.
- core: feeds (SPEC §4.8), for what must not be missed. `Feed<T>`, `FeedPage` and `FeedItem`: facts a
  component records in the same commit as the change they describe, read by others in commit order
  after a cursor of their own, with `gap` when facts were pruned before they were read. Events stay
  notices. `@pikit/core/testing` has the suite, `createFeedConformance`, and the in-memory double,
  `createMemoryFeed`.
- cli, registry: offered providers. A component brings the providers of what it can use when the
  catalogue marks the capability `offer` (today `outbound.queue`): `pikit add channel-telegram` offers
  `outbound-durable` and the `storage-sqlite` it needs, `pikit new` installs them, and `pikit remove`
  takes them away with it when nothing else uses them (`installedFor` in `pikit.json`). `pikit doctor`
  notes a component nothing uses. The base preset no longer installs a queue an HTTP project never uses.
- samples: scenario 8, many agents (`samples/http/test/scenario-8.test.ts`): `router-rules`, extensions
  named per agent and `workspace-local` together, with Pi's real `bash`; and the same project without
  `router-rules`.
- cli: `pikit add` brings a project made by an older checkout onto this CLI's kit (`@pikit/core`,
  `@pikit/pi-adapter`, the shim): vendored tarballs are named with a hash of their files, and a
  project on other ones gets new tarballs, `package.json` rewritten and `bun install`. Adding a
  component that needs a newer core used to fail with "Export named … not found".
- component/channel-telegram: several bots in one project. `accounts: ["ops"]` adds the bot
  `telegram:ops` (`TELEGRAM_OPS_BOT_TOKEN`, `TELEGRAM_OPS_ALLOWED_USERS`), with its own users,
  conversations (`telegram:ops:<chat>`) and transport; `router-rules` can give it its own agent.
  `pikit configure` sets up each bot. The default bot and its keys are unchanged.
- component/workspace-local: each agent's tools work in a directory of their own, `<root>/<agent>/`
  (default root `.pikit/workspaces`), created on the agent's first call; commands start from an
  allowlist of variables, as with `execution-local`. An agent name that could leave the root is
  refused. Order, not isolation: `bash` can still `cd ..` and read `.pikit/credentials.json`
  (SPEC §8.2). Not in any preset.
- component/tool-read, tool-write, tool-edit, tool-bash: in a run, they work in the agent's
  `workspace` when one is installed (`useOptional("workspace")`); without one, or outside a run, on
  `execution` / `execution.shell` as before.
- adapter: the `workspace` capability (`WorkspaceProvider`, `Workspace { env }`; `ref`, `checkpoint`
  and `release` stay planned) and its suite, `createWorkspaceConformance`. `bindTool`'s `env` is now
  `(context) => ExecutionEnv | Promise<ExecutionEnv>`, asked on every call with the call's context.
  Every run's context carries its conversation.
- core: the context key `CONVERSATION`: the runtime puts the run's `ConversationRef` in every run's
  context, and tools read it with `context.value(CONVERSATION)` (SPEC §6.3).
- component/channel-telegram: answers go through `outbound.queue` when it is installed: the channel
  attaches its transport (`transport.ts`: HTML or plain text, failures classified for the queue) and
  enqueues each answer once per run. A piece sent again after a crash starts with `↻ `. Without a
  queue it sends directly, as before.
- component/outbound-durable: every answer is stored before it is sent (`outbound.queue` on
  `storage.sql`), then delivered in order per conversation. Transient failures are retried after 5 s,
  30 s, 2 min and 10 min and abandoned at the fifth; rate limits wait what the platform asked; permanent
  failures and anything older than 24 hours are abandoned. A send the process died during is sent
  again as a possible duplicate. A test kills a process with SIGKILL mid-send (SPEC §5).
- core: the outbound contracts (`OutboundMessage`, `ChannelTransport`, `DeliveryError`,
  `outbound.queue`, the `outbound.delivered` / `outbound.abandoned` events), their conformance suite, and
  `createManualClock` for tests of components that wait.
- registry: the `outbound` kind, and `*.test-support.ts` for a component's shared test fakes and
  fixtures (held like tests for S5, never imported by a shipped file).
- core, component/storage-sqlite: the `storage.sql` contract, an async `SqlDatabase` (`query`, `run`,
  `transaction`), and its conformance suite (`createSqlDatabaseConformance`). `storage-sqlite`
  provides it in one SQLite file (`.pikit/pikit.db`) through `node:sqlite`, in WAL mode, one statement
  at a time (SPEC §4.5, §16).
- component/router-rules: routes each conversation to an agent by an ordered list of rules in
  config, matching the channel (an instance, or a kind for all its accounts), the conversation and
  the sender; a rule can also deny. What no rule matches goes to `router-basic`'s `defaultAgent`, and
  removing it sends everything there. It refuses to start when a rule names an unknown agent.
- core, adapter, component/runtime-pi: an agent names the Pi extensions it uses,
  `defineAgent({ extensions: ["permission-gate"] })`, and a component provides each one under the keyed
  capability `agent.extension` (SPEC §6.2b). A conversation loads the extensions given to
  `createRuntimePi({ extensions })` for every agent, then the ones its agent names, each factory once;
  a name nothing provides fails the conversation's open, and `runtime-pi` refuses to start with it.
- core: `admitInbound` runs the inbound path every channel takes (`inbound.normalize`,
  `route.resolve`, the conversation, `dispatch`) and returns what happened (`admitted`, `duplicate`,
  `halted`, `denied`, `no_route`); a stage that changes which message or conversation it is now
  fails the path in every channel. `@pikit/core/testing` adds `createChannelConformance`, which
  `channel-http` and `channel-telegram` pass.
- component/channel-telegram: a message a stage stops (a policy in `inbound.normalize`, a rule in
  `route.resolve`) is answered "I can't take that message." instead of nothing, and a stage that
  moves a message to another conversation no longer gets it dispatched to the original one.
- component/channel-http: runs the inbound path through `admitInbound`; its responses are unchanged.
- repo: the packages' import boundaries are checked on every `bun test` (`scripts/boundaries.test.ts`):
  core and every package export not marked server-only run on every target (no `node:*`, `bun:*`,
  `cloudflare:*` or Pi's Node subpath, through everything they import), only the adapter imports
  Pi, and a package imports only what its `package.json` declares.
- registry: `registry validate` no longer mistakes a method named `require` (`capabilities.require("x")`)
  for an import.
- adapter, component/sessions-jsonl: a message to an idle conversation no longer reads every
  session file. The runtime opens a conversation's session with the store's new `find(id)`, which
  `sessions-jsonl` answers from an index (one listing after a restart, then about 0.02 ms instead
  of 350 ms at 5,000 sessions). A store without `find` is listed, as before.
- cli, registry: presets ask, instead of multiplying. A base preset lists its components and may
  `choose` one per kind: `pikit new` asks "Where do you want to talk to your agent?" and offers every
  `channel-*` component in the registry that runs on the new project, by the new `title` in its
  `component.json`; a new channel shows up there without editing any preset. `--with <component>`
  answers in a script (`pikit new my-bot --preset http --with channel-telegram`), and the guided
  path prints that command. `telegram` is now an alias (`extends: http`, `with: [channel-telegram]`),
  so `--preset telegram` works as before. `pikit new` checks every component against the project's
  target before writing anything.
- registry: `component.json` and presets have JSON Schemas (`registry/schema/`), generated from the
  CLI's own definitions. Every `component.json` names its schema in `$schema` and each preset in a
  `yaml-language-server` comment, so editors complete and check them. `registry validate` checks both
  against them, and now rejects fields it does not know (a typo was silently ignored);
  `pikit add` checks a component's manifest before installing it.
- cli: `pikit registry capabilities` prints each capability (single or keyed, who defines its
  contract, what it is) and the components that provide and use it. A capability defined without an
  entry in the catalogue fails the type check, and `registry validate` rejects a component that uses
  one.

- cli: the guided path and `pikit configure` look like a modern installer (`@clack/prompts`): menus
  you move through with the arrow keys, yes/no questions, text with a default, a spinner while the
  project is created, and every line on one rail. A secret shows one ▪ per character. Components'
  `configure` steps get `choose` and `confirm`; `channel-telegram` asks "Allow them?" as a yes/no.
- component/channel-telegram: pasting the bot token no longer ends the setup with `getMe: 404`. The
  token is taken out of whatever is pasted (BotFather's whole message, quotes, spaces), something
  that is not a token is asked again without calling Telegram, and a 404 (a malformed token) is asked
  again like a 401. The fake Bot API answers 404 to a malformed token, as Telegram does.
- cli: a secret prompt drops the terminal's escape sequences (bracketed-paste markers, arrow keys),
  and a line break inside a paste no longer ends the answer.
- cli, installer, registry: the guided path. The installer, on a terminal, goes straight into `pikit
  new`, which asks the agent's name and where to talk to it (the presets, by their new `title`), then
  sets up the channel, logs in to the model and starts it. Ctrl-C stops it; `pikit new` with the same
  name continues. The installer also adds you to the `docker` group when it installs Docker (with the
  same consent), and ends with the lines to paste. Ctrl-C at any prompt now exits with 130.
- cli, component/deployment-docker: an OAuth login made by `pikit configure` now reaches `pikit up`.
  `deployment-docker` exports `exec()` (`docker compose run --rm` of the app), and `configure` logs in
  through it, into the app's volume; `--login <provider> --local` logs in on this machine for `pikit
  dev`. `pikit up` checks the credentials where the app runs and refuses to start without them. It
  used to start an agent that failed at its first message.
- cli: `pikit configure` runs the steps components ship in `src/pikit/<name>/configure.ts`, before
  asking for the other variables; a component's variables are then its own. `channel-telegram`'s
  step checks the bot and allows you by asking you to message it. An end-to-end test covers
  `new --preset telegram` → `configure` → `dev` → an answer in the chat (SPEC §11).
- cli: a secret prompt turns echo off before it shows, so a value pasted the moment it appears is not
  echoed.
- registry: the `telegram` preset (`pikit new my-bot --preset telegram`), the `http` preset with
  `channel-telegram` instead of `channel-http` (SPEC §11).
- component/channel-telegram: talk to the agent in Telegram. It receives by long polling (no public
  URL), lets only `TELEGRAM_ALLOWED_USERS` reach the agent, and handles `/new`. It shows "typing…",
  formats Markdown, splits long answers and retries sends. It ships its own `pikit configure` step,
  which checks the token and allows whoever messages the bot (SPEC §5, §13).
- installer: `installer/install.sh` (`curl -fsSL <url> | sh`) puts `pikit` on a clean Debian/Ubuntu
  VPS or macOS: git, curl and unzip through apt-get after asking, Bun >= 1.4 from bun.sh, a Git
  checkout of pikit in `~/.pikit/pikit`, and `~/.pikit/bin/pikit`. It prints the PATH line instead
  of editing shell files, and installs Docker (Linux, official script) only with `--install-docker`
  or a "y". Idempotent; `PIKIT_SOURCE` installs from a local checkout.
- cli: the `pikit` CLI (`packages/cli`, M1 commands of SPEC §11). `pikit new <dir> --preset <name>`
  writes a project (its agent, `pikit.config.ts`, `package.json`, README), vendors `@pikit/core`,
  `@pikit/pi-adapter` and `@pikit/pi-extension-shim` into `vendor/`, adds every component of the
  preset, runs `bun install` and `doctor`. `pikit add` / `pikit remove` follow the install flow
  (files, npm dependencies, `pikit.config.ts`, `.env.example`, hashes in `pikit.json`) and removing
  what was added leaves no trace; `remove` refuses to leave a required capability without a provider
  and never deletes a file you modified without `--force`. `pikit doctor` prints the graph and checks
  providers, required variables and the Pi import rule, and lists modified files. `pikit configure`
  fills `.env` (0600) and logs in to model providers through pi-ai, also without a terminal
  (`--yes`, `--generate`). `pikit dev` runs the deployment's entrypoint with `bun --watch`;
  `up | down | restart | logs | status` delegate to the installed `deployment-*` component.
- registry: the `generate` / `validate` code moved into the CLI package (`packages/cli/src/registry/`);
  `bun run registry` is now a thin caller of `pikit registry`, so both run the same checks.
- adapter: a Pi extension's `pi.getActiveTools()` returns the tools an agent's `prepare` gave the
  run, in `before_agent_start` and after, and in a run resumed after a crash. It returned the tools
  the conversation opened with.
- component/deployment-docker: the `Dockerfile` copies `vendor/` before `bun install`, so a project
  whose `@pikit/*` packages are vendored tarballs (M1, until they are published) builds in Docker.
- component/deployment-docker: the JSON logger compares field names word by word, so token counts
  (`totalTokens`, `tokenCount`) are logged while tokens (`accessToken`, `PIKIT_HTTP_TOKEN`) stay redacted.
- samples: `samples/http` installs `log-events`, so it is exactly the `http` preset plus its own agents.
- registry: every component has a `component.json` and the registry a `registry.json` index.
  `bun run registry generate` writes the fields `setup` declares (`provides`, `requires.capabilities`,
  `optional.capabilities`, the tools' `replay`) from `describe()`; `bun run registry validate` fails on
  drift, naming, layout, install scripts, sibling or Pi imports, runtime imports outside a
  server-only component, `dependencies` that differ from the files' imports, and a `files` entry that
  maps a directory other than `files/src` (files outside `src/` are listed one by one).
- component/runtime-pi: documents and tests agents with `state` and `prepare`: a tool moves the
  conversation's state on and the next run gets the tools `prepare` gives for it. No new wiring:
  the state lives in the Pi session (SPEC §6.2a).
- adapter: runs an agent's `prepare(state)` in Pi's `before_run`, once per run, and gives the run
  the model, system prompt and tools it returns; each run's configuration is a `pikit.turn` custom
  entry in the session. A resumed run is prepared again with the current state; a failing `prepare`
  gives the run the static definition, logged. Every run's context carries its conversation's
  `AGENT_STATE`, so tools update the state. The scripted test provider calls any tool on
  `call: <tool> <json>` (SPEC §6.2a).
- adapter: `agent.state` stored in the conversation's Pi session as the session value
  `pikit` / `agent.state`; it passes `createAgentStateConformance` on memory and JSONL sessions
  (SPEC §6.4).
- core: `defineAgent({ state, prepare })`. `state` is each conversation's initial JSON state;
  `prepare(state, ctx)` returns what changes for a run (model, system prompt, tools) and is a plain
  function in tests. New export: `PrepareContext` (SPEC §6.2a).
- core: `AgentState` (`get` / `update(patch)`), the per-conversation JSON state of an agent, and the
  context key `AGENT_STATE` through which a tool reaches the state of the conversation it runs in;
  `createAgentStateConformance` in `@pikit/core/testing`, passed by an in-memory double (SPEC §6.2a).
- samples: `samples/http` runs through `deployment-docker`'s entrypoint (JSON-lines logs, deadlines,
  signals) and in Docker (`docker compose up` from `samples/http/`, built from the repository's root).
  `registry/presets/http.yaml` lists its components plus `log-events` and `deployment-docker`.
- component/deployment-docker: runs a project in Docker. Its entrypoint starts with a deadline, stops
  on SIGTERM/SIGINT within `stop_grace_period` and exits non-zero on failure; logs are JSON lines
  with secrets redacted by name; `Dockerfile`, `compose.yaml` and `.dockerignore` at the project root
  (non-root, `.pikit/` on a volume, `.env` at run time, healthcheck on `/health`); `up`, `down`,
  `restart`, `logs` and `status` for the CLI to delegate to (SPEC §9.1, §10.2, §11).
- component/log-events: one structured log line per `agent.*`, `conversation.reset`,
  `pipeline.halted` and `runtime.*` event, with the conversation, agent, request ids, admission and
  run kinds, duration, tokens, cost and error code; never a message's text (SPEC §9.1, §13).
- adapter: every `agent.settled` / `agent.failed` carries `usage`, the run's tokens and cost as Pi
  recorded them on the run's entries; the runs of a session add up to Pi's session totals (SPEC §6.1).
- samples: `samples/http`'s agent has Pi's `read`, `write`, `edit` and `bash` tools in its workspace,
  with `permission-gate` loaded; scenario 7 runs against the real `bash`.
- component/tool-bash: provides Pi's `bash` tool as `agent.tool` `bash`, working on `execution.shell`,
  with replay `never`; an agent gets it by naming it (SPEC §6.3).
- component/tool-edit: provides Pi's `edit` tool as `agent.tool` `edit`, working on `execution`,
  with replay `never`; an agent gets it by naming it (SPEC §6.3).
- component/tool-write: provides Pi's `write` tool as `agent.tool` `write`, working on `execution`,
  with replay `never`; an agent gets it by naming it (SPEC §6.3).
- component/tool-read: provides Pi's `read` tool as `agent.tool` `read`, working on `execution`,
  with replay `safe`; an agent gets it by naming it (SPEC §6.3).
- adapter: `@pikit/pi-adapter/tools` exposes Pi's `read`, `write`, `edit` and `bash` tools and
  `bindTool(tool, { env, replay })`, which binds a tool to its environment and sets its replay (SPEC §6.3).
- component/execution-local: provides `execution` and `execution.shell` on the server's filesystem
  and shell, in a working directory; commands start from an allowlist of variables. Not a sandbox
  (SPEC §8.3).
- adapter: `createLocalExecution({ cwd, env })` in `@pikit/pi-adapter/node` is Pi's `NodeExecutionEnv`
  whose commands start from the variables given, not from the server's environment (SPEC §8.3).
- component/runtime-pi: gives each agent the installed tools it names (`agent.tool`), and refuses to
  start when a named tool has no provider (SPEC §6.3).
- core: an agent names installed tools in `AgentDefinition.tools` (`["read", "bash", myTool]`),
  resolved through the keyed capability `agent.tool`; the adapter resolves them when a conversation
  opens (SPEC §6.3).
- adapter: `@pikit/pi-adapter` types `execution` and `execution.shell` (Pi's `ExecutionEnv`), and
  `createExecutionConformance` in `@pikit/pi-adapter/testing` checks them (SPEC §8.3, §14).
- spec: every component installs to `src/pikit/<name>/`, under its exact name, instead of a path by
  kind (`src/pikit/secrets-env/`, not `src/pikit/secrets/env/`) (SPEC §10.1).
- samples: `samples/http` talks to Claude over HTTP (SPEC §15 scenario 1), with an OAuth login
  script and end-to-end tests for scenario 1 and the HTTP half of scenario 7.
- component/channel-http: `POST /v1/messages` answers in the response (`200`, or `202` past
  `replyTimeoutMs`), including messages steered into a busy run; `POST /v1/conversations/:id/reset`;
  bearer token from `PIKIT_HTTP_TOKEN` (SPEC §5).
- component/server-bun: serves every `http.route` with Hono on `Bun.serve`, plus `GET /health` and an
  honest `GET /ready`. Stopping cancels the requests in flight (SPEC §9.1).
- component/router-basic: a `route.resolve` stage that sends every message no earlier stage routed
  to `defaultAgent` (SPEC §5).
- component/provider-anthropic: provides pi-ai's Anthropic provider as `model.provider` `anthropic`,
  signing in with a stored OAuth login or API key, or `ANTHROPIC_API_KEY` (SPEC §4.5).
- component/runtime-pi: builds its models with `model.credentials` when installed, and refuses to
  start when an agent's provider has no credentials at all (SPEC §6.2).
- adapter: the scripted test provider answers `bash: <command>` with a `bash` tool call and can
  require a stored API key (`scriptedProvider({ apiKey })`); `recordingBash` stands in for Pi's `bash`.
- component/credentials-file: provides `model.credentials` in a JSON file with mode 0600. Tokens
  that pi-ai refreshes are written back (SPEC §4.5).
- component/conversations-file: provides `conversations.registry` in one JSON file written
  atomically. It creates sessions through `sessions.store`, and a reset keeps the old session (SPEC §7.4, §7.6).
- component/sessions-jsonl: provides `sessions.store` as Pi's JSONL files on the server's disk, and
  passes Pi's session suites (SPEC §7.5).
- component/secrets-env: provides `secrets` from the process environment. An empty variable is not
  set, and it never reads a `.env` file itself (SPEC §4.5, §13).
- adapter: `@pikit/pi-adapter/providers/anthropic` exposes pi-ai's Anthropic provider by subpath
  (SPEC §6.2).
- adapter: `@pikit/pi-adapter` types `model.credentials` (pi-ai's `CredentialStore`),
  `modelsFrom(providers, { credentials })` builds models with it, and
  `createCredentialStoreConformance` in `@pikit/pi-adapter/testing` checks a store, including
  refreshed OAuth tokens written back (SPEC §4.5, §14).
- adapter: `@pikit/pi-adapter/node` exposes Pi's JSONL session store (`createJsonlSessionStore`),
  and `@pikit/pi-adapter/testing` Pi's session conformance suites with `storageOf` (SPEC §7.5).
- core: `http.route` contract (`HttpRoute`, keyed by `"METHOD /path"`) and its conformance suite
  (SPEC §9.1, §14).
- core: `conversations.registry` contract (`ConversationRegistry`), the `conversation.reset` event
  and its conformance suite (SPEC §7.4, §7.6, §14).
- core: `secrets` contract (`SecretStore`) and its conformance suite (SPEC §4.5, §14).
- core: `InboundMessage`, `RouteDecision` and the `inbound.authenticate`, `inbound.normalize` and
  `route.resolve` pipelines (SPEC §4.4, §5).
- adapter: Pi extensions see `agent_start` for a run resumed after a crash, and a closing
  conversation waits for their handlers and actions in flight, so an `agent_end` handler's
  `appendEntry` is not lost (SPEC §6.2b).
- adapter: existing Pi extensions run unmodified, except for their terminal UI. A vendored
  subset of `ExtensionAPI` lives in `@pikit/pi-adapter/extensions`, and
  `@pikit/pi-extension-shim` is installed as `@earendil-works/pi-coding-agent` so their imports
  resolve (SPEC §6.2b).
- component/runtime-pi: `createRuntimePi({ extensions })` loads Pi extensions for every
  conversation.
- core: `AgentResult.requestIds` lists every request a run answered, so a channel that replies per
  message answers the ones queued into a run too (SPEC §6.1).
- component/runtime-pi: the agent runtime component. Pi runs the agents through `@pikit/pi-adapter`;
  it provides `agent.runtime` over `sessions.store`, `agent.definition` and `model.provider`, and
  ships the `agent.runtime` and lifecycle conformance tests (SPEC §6).
- adapter: `@pikit/pi-adapter` implements `agent.runtime` on Pi 0.87.1, bridging four gaps of
  `pi-agent-core` until Pi's durable runtime ships (SPEC §6.4). `@pikit/pi-adapter/testing` runs
  a scripted model for component tests.
- core: the agent contracts (`defineAgent`, `AgentRuntime`, `agent.*` events, `agent.definition`)
  and the `agent.runtime` conformance suite in `@pikit/core/testing` (SPEC §6.1, §14).
