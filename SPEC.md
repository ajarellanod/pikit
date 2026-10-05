# pikit

What must hold, whatever else pikit becomes. Everything in this file is required; everything
else is a feature (a component, a preset, a CLI command) described in `features/` (one file each,
with no order); 

---

## 1. What pikit must be

**Your Pi agents running as a reliable service on your own infrastructure in five minutes, with
all the code around the agent in your repository, so you can reshape it.**

Four outcomes are required. Without any one of them, pikit is not what it set out to be:

1. **A reliable, source-owned service.** One command from an empty server to an agent that
   answers; every harness piece is source the user owns; nothing is lost or pretended (§2).
2. **The same agents, routing and contracts run on a server and on Cloudflare** (§4).
3. **The service is visible and operable from a base dashboard** built with shadcn/ui, small on
   purpose and made to be extended (§5).
4. **The main agent knows what it is and can improve itself**, internally (its components) and
   visually (its dashboard), through a gated path that nothing it controls can bypass (§6).

## 2. The properties that must hold

A change that breaks one is not done.

| # | Property |
|---|---|
| P1 | **Pi is the agent; pikit is the kit.** A kit, not a framework: Pi's durable runtime (`pi-durable`) owns the agent runtime (durability, resume, request-id deduplication, the inbox and steering, compaction, subagents, tasks). pikit builds only what one Pi process cannot give itself (channels, routing between agents, conversation ownership across processes, durable delivery to platforms, scheduling, approvals, deployment, the CLI and installer, the dashboard, the path by which an agent
changes its own service). When Pi ships something pikit built, pikit deletes its own. pikit gives the bases; the assistant is the user's to build: the features that make assistants like OpenClaw or Hermes attractive are components a user builds on the bases (with their AI, from a feature's design note and its contract's conformance suite) or installs from someone's registry, not a list pikit chases. |
| P2 | **Five minutes, then it's yours.** One command sequence from an empty server to a reachable agent, leaving a project the user owns. The CLI and installer exist for this: zero friction from installer to a running agent. |
| P3 | **Components are source you own.** Copied into the project, readable, editable, removable; removing one leaves a clean, working project. |
| P4 | **A small, stable kernel; contracts are the only coupling; no magic; absence, not flags.** |
| P5 | **Fail loudly, recover honestly.** A part that cannot start stops the app. Delivery is at-least-once and says so. A restart, crash or eviction never loses a conversation and never pretends a message was answered. |
| P6 | **Copied code does not rot.** A user who edited a component still takes upstream fixes, with a three-way merge from the base kept at install. |
| P7 | **Boring on purpose.** The model learned for 1.0 holds for all of 1.x (K8, K10). |
| P8 | **Runs where you want:** server and Cloudflare (§4). |
| P9 | **Self-improvement is gated.** An agent changes the service only through the source of its own project, with tests, a human's approval and an automatic rollback; nothing it can edit can open that gate (§6). |

## 3. The kernel

The kernel is `@pikit/core`: what the app runs itself (composition, capabilities, events,
pipelines, lifecycle, config validation, context, clock, logger), with no word of the domain.
Its exports, and those of `@pikit/core/testing` that components' tests import, are held by
`packages/core/src/exports.test.ts`; its only runtime dependency is
`typebox`. The shared vocabulary lives in `@pikit/contracts` and versions apart (K8).

### 3.1 Decisions

Each decision states what the kernel promises and why it keeps holding as pikit grows. Status
(built or not) is not tracked here: the code and its tests say what is built.

- **K1. The kernel names the runtime model, and nothing branches on it.** `Target`
  (`"server" | "durable"`), `pikit.target` and `ctx.target` stay in the kernel: they name the runtime
  model an App runs on (§4), never a provider, and the CLI, the component schema's `targets` enum and
  `defineApp({ target })` share that one closed list. A component's targets are declared in its
  `component.json`; a component that needs something different per target gets it through a
  capability (or `WORKERS_HOST`, C5), never by branching on `pikit.target` in `setup`. *Why:* a target
  is part of the composition (a deployment recomposes the App on its own), so the kernel carries it;
  `setup` that branches on it would make the generated manifest depend on the target it was generated
  for. A third value (`functions`) is a kernel change recorded here, made only when a host of that
  runtime model is built (`features/deployment-targets.md`).
- **K2. Whoever runs the app bounds the rollback.** The kernel keeps no timeouts.
  A failed start's rollback is bounded by a `stop(ctx)` with a deadline, which the host calls while
  `start()` is pending or after it rejects. Every `deployment-*` component's entrypoint does so, and
  a conformance case for deployment components hangs a rollback on purpose and requires the process
  to exit. *Why:* no new kernel API, and the rule is checked, not only written.
- **K3. Events are never persisted.** An event is a notification and may be missed. A fact that
  must not be lost is a feed (`Feed`, `packages/contracts/src/feed.ts`). There is no runtime schema for events and no
  `registerEvent`. *Why:* one pattern for durability instead of two, and less kernel surface.
- **K4. The kernel takes a plain, validated object as config.** It merges the components' TypeBox
  schemas under their names, validates, and deep-freezes. Where the object comes from (TypeScript
  in `pikit.config.ts` today, YAML or a wizard later) is the project's or the CLI's business, never
  the kernel's. A component's `setup` receives only its own part, under its name; neither `pikit`
  nor `ctx` carries the whole object, which belongs to whoever runs the app (`AppDefinition.config`)
  and to observers (K13). *Why:* formats change; the kernel's contract does not; and a component
  that read another's config would depend on it outside the capability graph, where `registry
  validate`, `pikit doctor` and `pikit remove` cannot see it (P4).
- **K5. `Context` is pikit's own, and frozen.** Its shape is `abortSignal`, `value(key)`,
  `toString()`, with `createContextKey`, `withAbortSignal`, `withCancel`, `withContextValue` and
  `BACKGROUND_CONTEXT`. It grows only through context keys, never by changing the interface. It
  matches Chord's shape today; when Chord changes, the adapter bridges it. Chord itself stays out of
  the kernel, re-checked at Chord 1.0 (`features/kit-follow-ups.md`). *Why:* users are isolated
  from Pi's weekly churn, and new needs (tracing, deadlines) fit as keys.
- **K6. `stop()` may never run.** A `kill -9`, an out-of-memory kill or a Durable Object eviction
  ends the app with no `stop()`. `stop()` is for tidiness, never for correctness: whatever must
  survive is committed as it happens. *Why:* it is physically true, it is what Pi's durable
  runtime assumes (its `close()` writes no outcome), and designs that rely on `stop()` break on
  the first crash.
- **K7. An App is one composition; a project may have several.** `defineApp` composes one App. A
  project may define more than one (on Cloudflare, one for the Worker and one for each Durable
  Object); how components are split between them is the target's and the components' design
  (§4, C1), never the kernel's. *Why:* the kernel already supports it, so no answer Cloudflare's
  design reaches changes the kernel.
- **K8. The kernel is declared stable only after it is proven.** `@pikit/core` 1.0 requires K1–K13
  applied, the kernel running on Node from a JavaScript build, and the Cloudflare proof (a run that
  survives eviction, §4). The contracts stay 0.x and `experimental` on their own schedule. *Why:*
  declaring stable a kernel that Cloudflare could still force to change is the surest way to break
  the promise.
- **K9. Kernel stability is its own track.** K1–K13 stand apart from the features. No 1.0 of pikit
  ships without them done.
- **K10. Deprecation exists before publishing.** A removal from the kernel is announced by a runtime
  warning and a `pikit doctor` hint for at least one minor. The mechanism is
  internal: no new export. *Why:* it is the only way to change something later without breaking
  anyone.
- **K11. The kernel owns its TypeBox range.** `defineComponent`'s config schema is TypeBox
  (`TSchema`, `Static`), so TypeBox is part of the kernel's public API. The kernel declares its own
  compatible range; only the adapter follows Pi's exact TypeBox version. *Why:* a TypeBox major
  chosen by Pi must not change pikit's kernel without pikit deciding it. A schema-neutral API
  (Standard Schema) is considered only if TypeBox becomes a problem.
- **K12. Typing by declaration merging stays, and is tested as shipped.** Events, capabilities and
  pipelines are typed by augmenting `@pikit/core`'s interfaces, as Pi types its messages. A type test
  builds a project against the packed `@pikit/core` tarball and declares its own augmentations, so
  a TypeScript or packaging change that breaks them fails in CI before a user sees it. *Why:*
  TypeScript 7 already lost relative augmentations once.
- **K13. The app can describe itself, for observation only.** The kernel exports one context key,
  `APP_DESCRIPTION`, and puts on every context it creates a frozen snapshot of `describe()`: the
  components in start order, what each provides and requires, the selected providers and keys, the
  resolved pipelines and the config. `AppDescription` carries a `version` and changes additively.
  Only `admin-*` components (the dashboard, §5) and the self-knowledge component (§6) may read it,
  and `registry validate` rejects any other component that does: a component never changes its
  behavior by looking at what else is installed (that is `useOptional`'s job). What the app does not
  know (installed versions, modified files, bases) stays in `pikit.json`, read from the project.
  *Why:* it is the truth of what runs, on both targets and for each App (K7), with no build step and
  no entrypoint to remember, and it grows by a key, as K5 requires. The other ways were weighed: a
  method on `AppContext` changes the interface; a generated file goes stale and needs a build that
  does not exist; an entrypoint that injects it depends on discipline; reading the source misses what
  was actually composed.

### 3.2 What never enters the kernel

Scheduling, approvals, health and degradation policy, deduplication, routing, storage, channels,
delivery, the dashboard, self-knowledge and self-change. Each is a capability in `@pikit/contracts` and a component (the dashboard's UI
is a project's choice over its component, `admin-api`, §5). A new kernel
export is a decision recorded here.

**What a component asks of the CLI** stays out of the kernel and out of the CLI too: the component
ships it as a file of its own directory, and the CLI (or the deployment component) calls it with a
plain structural `io` (the component's config in `pikit.config.ts`, a reader of the environment and
`.env`) and gets back its problems, one line each, never a secret's value (a `doctor` check may also
give notes, which stop nothing). These files run on the machine that configures or deploys, never in
the app:
- `configure.ts` exports `configure(io)`, the component's step of `pikit configure` (it may ask, and
  write `.env`). It is found by its path, as it was before the hooks; declaring it like them is the same
  change, not made yet.
- `component.json`'s `hooks` declare the others, each a file exporting a function of the hook's name;
  `pikit add` records them in `pikit.json` by project path, only what is recorded runs, and `registry
  validate` checks each export. `doctor`: its check in `pikit doctor` (so before `pikit dev`); it may
  reach the network and writes nothing. `beforeDeploy`: the deployment's `up` runs it before it
  bundles or builds; it may write files of its own directory (through `io.write`, never elsewhere),
  which the build then carries, and a problem deploys nothing. `up` runs it instead of the
  component's `doctor`, so it checks at least the same (one check per deploy). `afterDeploy`: `up`
  runs it once the new version answers (C8).
- `component.json`'s `generated` names the files of its own directory a hook rewrites (tool-mcp's
  `seed.ts`): shipped as a starting point, they are the hooks', never the user's edits, so `pikit
  doctor` does not list them as modified and `pikit remove` deletes them without `--force`.

Where no CLI deploys (a "Deploy to Cloudflare" button, Workers Builds), no hook runs: what
`beforeDeploy` writes is committed with the project, and what `afterDeploy` registers the app also
registers itself (C8).

## 4. Cloudflare is required

The same agents, routing and contracts run on Cloudflare Workers and Durable Objects as on a
server. This is not a feature: it is the proof that the contracts hide no server (Manifesto,
principle 11).

**The honest rule.** A project is made for one target (`pikit new --target`, recorded in
`pikit.json`'s `targets`). Most components declare both targets and are the same code on each. The
few that touch how code lives come one per runtime model and say so in their `targets`:
`channel-telegram` (long polling) and `channel-telegram-webhook` (C6), `channel-http` and
`execution-local` (a process) and `execution-do` (C7), `storage-sqlite` and `storage-do`,
`wakeups-timers` and `platform-cloudflare`. The required set (below) has a provider on each target
for every capability it needs; a component outside it may exist for one target only (`channel-http`
has no Cloudflare twin yet). Moving a project to the other target is swapping those components,
never changing an agent, a route or a contract.

**A target is a runtime model; a provider is a `deployment-*` component.** A target (`targets` in a
`component.json`, `pikit.json`'s `targets`, `pikit new --target`) names how code lives, never whose
machine it is. There are two first-class targets:
- **`server`: a long-lived process.** A process that stays up, a persistent local disk, in-process
  timers, one process per storage. Docker on a VPS, systemd, exe.dev, E2B, Modal and Fly are its
  providers, each a `deployment-*` component. `server` guarantees a persistent disk: a provider without
  one supplies it (a volume) and its `deployment-*` checks it in `pikit doctor`; otherwise it is not
  `server`.
- **`durable`: an actor per conversation.** One actor (a Durable Object) per conversation, with its
  own SQLite and one alarm, evicted between events, its work driven in slices (`driveSlice`, C4).
  Cloudflare is its only provider today, so the pieces specific to it keep Cloudflare's name
  (`deployment-cloudflare`, `platform-cloudflare`, `secrets-cloudflare`, `@pikit/contracts/cloudflare`,
  `WORKERS_HOST`); only the target is `durable`.

A third value is a core change (`Target` in `@pikit/core`, the schema's enum, the CLI), made only when
a host of another runtime model is built: stateless functions would be `functions`
(`features/deployment-targets.md`). A new provider of an existing model changes no core.

What it requires:
- **Neutral layers.** The kernel, the contracts, the adapter's shipped exports and every component
  in the required set import no `node:*`, `bun:*` or `cloudflare:*` (checked by
  `scripts/boundaries.test.ts` and `registry validate`). A component may be server-only, but the
  required set has a Cloudflare provider for every capability it needs.
- **The required set.** At least a channel, the runtime (with pi-durable's storage), conversations, delivery,
  workspace and execution providers for Cloudflare, the dashboard (§5), and `deployment-cloudflare`.
- **The actor model holds there.** One conversation is owned by one Durable Object (C1). An
  evicted object loses nothing: the next request or alarm resumes the run (`resume()`), per K6.
- **The budgets hold.** Bundle ≤ 10 MB compressed, cold start ≤ 1 s, ≤ 128 MB per isolate,
  ≤ 6 concurrent outbound connections, measured, not estimated.
- **The proof runs.** The required set deploys and answers; a run killed by eviction mid-drive
  completes after `resume()`; pi-durable's storage on the object's SQL passes pi-durable's storage
  conformance.

### 4.1 Decisions

Each decision was proven by a spike on Cloudflare (September 2026, Workers Free plan) before it was
written here. Status (built or not) is not tracked here, as for the kernel.

- **C1. A thin Worker, and one Durable Object per conversation running the App.** A project on
  Cloudflare has two Apps (K7), both in `pikit.config.ts`: the default export is the Durable
  Object's App (the channel's other half, the router, the registry, the runtime, storage,
  delivery), and `export const worker` is the Worker's App (the ingress half of each channel, the
  mailbox, secrets). A component with a half for each exports the Worker's half by the name its
  `component.json` declares, and `pikit add` puts each half in its App. The Worker checks and routes;
  the object owns the conversation. *Why:* events, feeds and the outbox stay local to the object
  that owns the conversation, so nothing crosses objects but the message itself; two explicit Apps
  are composition, not magic.
- **C2. `actor.mailbox`: a channel reaches an actor without knowing where it runs.** A contract in
  `@pikit/contracts`: `send(key, type, message, ctx)` resolves once the actor owning `key` holds the
  message durably (the point where a channel acknowledges its platform), and rejects otherwise, so the
  platform retries. The actor handles it with the handler it registered for `type` on `actor.inbox`
  (`handle(type, (key, message, ctx) => …)`, in its `start`). A message is JSON. On a server the
  mailbox calls the inbox in the same App (`mailbox-local`); on Cloudflare it is an RPC to the object
  `idFromName(key)` (`platform-cloudflare`). A component may also **ask** an actor:
  `call(key, type, message, ctx)` resolves with the JSON its `answer(type, handler)` handler (on
  `actor.inbox`, registered in `start`) resolved with, or rejects with an `ActorCallError` whose
  `code` says why (`invalid`, `no_handler`, `cancelled`, `unreachable`, `failed`, or the handler's
  own); a call is neither retried nor deduplicated, so a handler that changes state is idempotent.
  Messages and calls of one type are apart. Calls are how a component reads or writes what another
  actor owns (a conversation's state from the Worker, a person's memory from a conversation; an
  actor key need not be a conversation's). *Why:* one channel component serves both targets, and no
  channel names a Durable Object. Handlers are registered by method, not provided as a keyed
  capability, because a keyed capability makes the mailbox depend on every handler's component: a
  handler admits to the runtime, which on Cloudflare wakes through `platform-cloudflare`, the
  mailbox's own component, so that was a dependency cycle.
- **C3. `wakeups`: durable timers, one alarm underneath.** A contract in `@pikit/contracts`:
  `at(name, time, ctx)` asks for the handler registered as `name` (`handle(name, handler)`, in the
  owner's `start`, as for `actor.inbox`, so the provider depends on no handler) to run at or after
  `time`, replacing an earlier request for that name; `cancel(name, ctx)` drops it. Delivery is
  at-least-once and may be late; a handler that fails runs again with backoff. On a server they are
  timers (`wakeups-timers`: a process that restarts reschedules at start, per K6); on Cloudflare they
  are rows in the object's SQL multiplexed onto its one alarm (`platform-cloudflare`). *Why:* the
  runtime, delivery and outbox all need to wake, and an object has a single alarm.
- **C4. Work happens inside an event, in slices.** On Cloudflare an object keeps running only while
  an event (a request, an RPC, an alarm) is in progress: a promise left running after it is killed
  within minutes of idleness, and outbound `fetch` does not keep the object alive (measured). So a run
  is driven by a wakeup whose handler waits for it, and stops at a slice deadline (its context is
  cancelled) to be woken again at once. Each invocation has its own budget; measured on the Free plan:
  30 s of CPU (waiting on the network does not count), 50 subrequests, about 200 MB of memory before
  the object is reset, 15 minutes of wall clock for an alarm (a cut alarm is retried), and a deploy
  cuts every alarm in progress (it is retried). Slices keep every one of these far away. *Why:* K6
  already makes a reset lose nothing; slices make a long conversation a sequence of short events.
- **C5. State through neutral contracts; the platform through one context key.** The runtime's
  state (pi-durable's storage on `storage.sql`) and conversations (`conversations-kv`, on
  `storage.kv`) have neutral providers that run on both targets; the only Cloudflare-specific storage
  is `storage-do` (`storage.sql` on the object's SQLite, whose transactions pass the `storage.sql`
  suite unchanged). Platform objects reach components through one context key in
  `@pikit/contracts/cloudflare`, `WORKERS_HOST`, which `deployment-cloudflare`'s entrypoints put on each App's
  start context: the Worker's `env` (and, in the Worker's App, the origin its first request reached),
  and in an object its id, its storage, and the hooks its alarm and RPC call. Its types are structural: no `cloudflare:*` import leaves the entrypoints. *Why:* the
  components that must touch the platform are few and say so by reading one key; everything else is
  the same code on both targets.
  Conversations are Pi's durable runtime's own storage (P1): there is no sessions contract.
  pi-durable 1.0's SQLite core runs over a thin facade on `storage.sql`, proven on storage-sqlite and
  on storage-do with pi-durable's own storage conformance, so one implementation serves a server and
  a Durable Object. That core speaks SQLite's dialect, so it needs a SQLite-backed `storage.sql`;
  `storage.sql` stays asynchronous so that a Postgres provider fits the kit's own records, but
  conversations in Postgres need a Postgres backend of pi-durable's `Storage`
  (`features/storage-postgres.md`). Its tables are not
  prefixed (an exception to `storage.sql`'s rule, proposed upstream), so one `storage.sql` holds one
  pi-durable Session.
- **C6. Telegram by webhook is its own component.** `channel-telegram-webhook` (Worker half: the
  route, the secret Telegram echoes, the allowed users, `actor.mailbox`; object half: the inbox
  handler and delivery from `agent.submissions`' answers) reuses `channel-telegram`'s client, format
  and transport as its own copied source; `channel-telegram` keeps long polling for servers. *Why:*
  absence, not flags (P4): a server project never carries a webhook, nor a Worker a poller.
- **C7. Execution on Cloudflare: a workspace in the object, a shell without processes.**
  `execution-do` provides `execution` and `execution.shell` over a filesystem in the object's SQL
  (binary files in chunks: a row holds at most 2 MB): a simulated shell (just-bash) with `git`
  (isomorphic-git), `curl` (`fetch`) and `node` (QuickJS compiled to WebAssembly, bundled: a Worker
  cannot compile at run time) as host commands. Pi's own `bash`, `read`, `write` and `edit` tools run
  on it unchanged. Files inside `.git` change only through `git`. There are no processes or native
  binaries; a real Linux is another `execution` provider (`features/sandboxed-execution.md`), not a
  flag of this one. *Why:* the agent keeps the tools it has on a server, at no cost beyond the
  object's own, within C4's budgets.
- **C8. A deploy is finished when the new version answers.** A new version takes seconds to reach
  every request (measured), so `deployment-cloudflare`'s `up` waits until `/health` answers with the
  version it deployed before it registers anything outside (a Telegram webhook). Where no `up` runs (a
  "Deploy to Cloudflare" button, Workers Builds), the new version registers itself: the Worker's App
  checks its webhook as it starts, once per isolate, and changes it only when Telegram has another
  (`channel-telegram-webhook`). *Why:* registering against the previous version fails for no reason a
  user can see; the version that registers itself is by definition the one answering.

## 5. The dashboard is required

A base dashboard to see and operate a running pikit service, built with
[shadcn/ui](https://ui.shadcn.com) (MIT): the most widely known copy-paste React components, which
every AI coding agent already writes well. It is a base, not the largest interface: what it
ships is enough to start, and everything else is a view the user (or their AI) adds. No platform
under pikit (Pi Durable, Cloudflare, Rivet) offers a user interface that is the user's to
extend; this is pikit's to give. AI-specific pieces (streaming and thinking states, tool-call
status, approval cards) may come from [Beautiful UI](https://github.com/slev12397/beautiful-ui)
(MIT, shadcn-compatible) where they fit.

**What the base ships** (the first version): conversations; one conversation live (its
transcript, the tools running), joinable while the user talks in their chat; steer and abort;
cost per conversation; health, once a `health` provider is installed (`features/health.md`). The
rest below comes as the components it needs are installed.

**What it shows and does.**
- The composition: components, capabilities and their providers, pipelines, the config without
  secrets.
- Conversations: their agent, their runs and tasks; a run's messages, tool calls and result.
- Delivery: what is queued, sent, retried, abandoned or possibly duplicated.
- Health: what is up, degraded or failing.
- Actions, each through an existing contract, never around one: abort a run, reset a
  conversation, answer an approval (when `approvals` exists), talk to an agent.

**How it fits pikit.**
- **It is a project's choice, not a component.** A project is made with a UI or without one
  (`pikit new --ui`, or the wizard's question), and `pikit ui on` / `pikit ui off` changes it later.
  With a UI the project has `src/dashboard/`, and that folder is all that says so (P4: absence, not
  flags): without it nothing is built or served. The UI is a frontend project with its own toolchain,
  not code that runs in the App, so a project that does not want it does not carry that toolchain. Its
  source, the shadcn/ui primitives included, is the user's to change; `pikit upgrade` merges the kit's
  fixes into it from the base kept when it was made, as for a component (P6), and `pikit ui off`
  removes it and leaves a clean, working project (P3).
- **It is a shadcn/ui project of its own.** `src/dashboard/` has its own `package.json` (Vite, React
  and Tailwind v4: shadcn/ui's stack, no Next.js server runtime) and `components.json`, with pikit's
  registry under the `@pikit` namespace, so `shadcn add button` and `shadcn add @pikit/<item>` work in
  it. The project's `tsconfig` and tests leave it out, as they leave out `registry/`. Its primitives are
  copied from pikit's registry and pinned (the pikit way: source owned, reproducible).
- **Its data comes from a component, `admin-api`.** The admin API (`/admin/api/*`, typed and
  documented) is a pikit component that `--ui` installs and that also stands without a UI (a script
  or an agent may read it). It registers its routes through `http.route`, asks `admin.auth` before
  every answer, and serves the dashboard's built assets under `GET /admin/*` when there are some.
- **It is made to be extended.** A view is a folder, `src/dashboard/src/views/<view>/`, found when the
  dashboard is built (nothing is loaded at run time) and shown only when the capability it declares is
  in `APP_DESCRIPTION`: a view whose capability is not installed does not appear. A component with a
  view (`memory-sqlite`, `approvals`) has two halves: its backend in `src/pikit/<name>/`, with its own
  admin API routes through `http.route`, and its view, a shadcn registry item that `pikit add` installs
  into `src/dashboard/` (through shadcn's installer) when the project has a UI. The same item installs
  alone with `shadcn add @pikit/<view>`. pikit's registry publishes its UI pieces (a transcript, a tool
  call, a cost, later an approval card) and its views as shadcn registry items. The repository carries
  a skill that teaches an AI agent to add a view.
- **It reads contracts and feeds, never internals.** The admin API is backed by the capabilities of
  the installed components. What must not be missed comes from feeds, not from events (K3). Live views
  of conversations and tasks build on pi-durable's `watch()` and `taskGraph()`, reached through the
  adapter, not on a copy of their state.
- **It runs wherever the app runs, and closes no deployment** (§4,
  `features/deployment-targets.md`). The built UI is static files and the API is standard fetch
  handlers, so any host that serves the app serves the dashboard: `server-bun`, a Worker, and later
  hosts (Vercel, E2B, exe.dev, Modal) with no dashboard change; the files may also be hosted apart,
  against the same API. Live updates are server-sent events (a plain streaming response every such
  host offers); commands are plain `POST`s. Host-specific shortcuts (Workers static assets, a Durable
  Object's hibernating WebSocket) are optional optimizations behind the same API, never requirements.
  Reading a conversation is location-transparent: on Cloudflare the Worker lists conversations from an
  index and streams one from its Durable Object.
- **Its build is its own.** `src/dashboard/`'s own `build` script makes the static files; `pikit up`
  and the deployment run it only in a project with a UI, so a project without one builds nothing more
  (no magic, principle 9). In development it runs with hot reload against a running app's API.
- **It is safe by default.** Authenticated; never shows a secret or a credential. Operational logs
  stay without message text; the transcript views are an explicit, authenticated read of the
  conversation.
- **No paid dependencies.** Free icon sets only (Beautiful UI's `SidebarNav` uses a commercial
  one, `@central-icons-react`, which the dashboard does not take). Every copied primitive is
  attributed in `NOTICE`.

The admin API reads the composition through `APP_DESCRIPTION` (K13), the runtime through
`agent.observe` (`packages/contracts/src/observe.ts`: conversations with their agent, busy state and
cost, a transcript, a live event stream, usage; runtime-pi provides it from pi-durable's records), and
asks `admin.auth` (`packages/contracts/src/admin.ts`; `admin-auth-token`, a bearer token from
`secrets`, on both targets) before every answer. Its routes and the UI's files are prefix routes
(`GET /admin/*`, `packages/contracts/src/http.ts`), which every server of `http.route` serves. On
Cloudflare `agent.observe` sees one object's conversations: the list across objects is
`features/cloudflare-conversation-index.md`.

## 6. The agent knows and improves itself

Pi can already improve itself: its prompt tells it where its own docs are, it writes an extension,
and `/reload` loads it; Pi's durable runtime turns a code change into a *generation boundary*
(stop admitting, close, open a new harness over the same storage, resume from the checkpoints). pikit
takes the same idea from one Pi process to the whole service: what Pi cannot do for itself is know
which pikit it runs in, and change, test, approve, deploy and roll back that service.

pikit has no code hot reload: a reload is a restart, and since pi-durable checkpoints every step, a
restart loses nothing (K6). What changes live is data: a conversation's agent (`configure()`),
settings read when used, skills and memory kept as documents or files. Code changes only through
the path below (`features/kit-follow-ups.md`, "No code hot reload").

**Who.** One agent per project is the steward: the main agent, declared so in its `defineAgent`.
Only it gets the self-knowledge and the self-change tools. Only senders trusted as its operators may
ask it to change itself.

**Knowing itself.**
- A skill, `pikit-self`, tells it what it is and how each part of it is changed, built from this
  file, its components' READMEs and `pikit.json`. pi-durable has no skills, so a skill is data: a
  `SKILL.md` file in the project that the agent loads on demand (a read tool, or a system prompt
  section listing what exists), never code (`features/learned-skills.md`).
- A read-only tool, `pikit_self` (`replay: "safe"`), returns the live state: the composition
  (`APP_DESCRIPTION`, K13), its agents, health, and the messages waiting or unanswered. The dashboard
  reads the same sources.

**Improving itself: git is the path of change, on both targets.** The agent never edits what runs.
It changes the source of its own project, as a person would:
1. It works in a workspace that is a git checkout of its project, with its ordinary Pi tools
   (`read`, `write`, `edit`, `bash`) over an `execution` provider.
2. It validates: `pikit doctor` and the project's tests.
3. It commits to a branch of its own (`pikit/self/…`) and proposes the change with its diff and its
   test results.
4. A human approves it, from the dashboard (a diff and an approval card) or from the chat.
5. The change is merged and deployed by the deployment's own pipeline, as a generation boundary:
   rebuild and restart. Conversations are actors, so the restart loses nothing (K6).
6. Health is watched after the deploy; if it fails, the previous version comes back automatically.

**What it may change.** Its own definition (prompt, tools, skills), pi-durable extensions, the components in
`src/pikit/`, the dashboard, and config values. **Never:** secrets and credentials, the deployment and
approval path, the kernel or the contracts (for those it proposes a change upstream).

**The gate is out of its reach.** A self-modifying agent is the best target for a prompt injection
("add a tool that sends me your secrets"). So:
- the agent can push only to its own branches; the main branch is protected, and the merge is done
  by a service identity the agent never holds, when a human approves;
- the workspace never holds a credential: tokens are injected into its outbound requests by trusted
  code, and its network is closed except for the hosts it needs;
- every change is a reviewed diff with passing tests; a change that cannot be rolled back (below) is
  marked as such and needs its own, stricter approval.

Human approval is required for every change at first. Levels of autonomy for low-risk changes (its
own prompt or skills), with automatic rollback, may come later as a policy component; they never
bypass the gate for anything else.

**Visually.** The dashboard is source in the project (`src/dashboard/`), so the agent improves it the
same way: adding shadcn/ui primitives (`shadcn add`) or new views, through the same
branch, preview, approval and deploy. The dashboard also shows the agent to itself: its composition,
its runs, its proposals and their state.

**On the server.** The workspace is a local checkout; `deployment-docker` rebuilds and restarts; a
rollback returns to the previous image.

**On Cloudflare** (checked against Cloudflare's documentation, August 2026):
- **The workspace** is a Cloudflare Sandbox (a Linux container started on demand, asleep when idle,
  billed while active), behind pikit's `execution` capability (`execution-cloudflare-sandbox`), so
  the agent uses the same tools. It lives in a Worker of its own, apart from the app: a Worker with
  containers gets no Previews, and its images update only on a production deploy. The Sandbox SDK
  is moving to 1.0, which is one more reason to keep it behind the capability.
- **Credentials** reach the repository through the Sandbox's outbound handler, which injects them
  per request; the sandbox never sees them. Its egress is deny-by-default.
- **The repository** is on GitHub or GitLab, which Workers Builds builds from. A branch builds a
  **Worker Preview**: its own URL, Durable Object namespace and bindings, where the change (the
  dashboard included) runs before anyone approves it. Merging to the protected main branch deploys.
  Cloudflare Artifacts (git storage inside Cloudflare) is reconsidered when it leaves closed beta and
  a deploy can start from it.
- **The deploy** creates a new Worker version, rolled out gradually: each Durable Object is pinned to
  one version and moves once. A failed health check rolls back to the previous version.
- **What cannot be rolled back:** a change of Durable Object classes (their migrations) or of a
  deleted binding. The agent marks such a change, and it is deployed alone.
- **Dynamic Workers** (code loaded at run time into a sandboxed isolate) are used only to try code
  before proposing it, never to change what runs in production (Manifesto: nothing is loaded
  dynamically in production).

**Never:** a Worker that redeploys itself through Cloudflare's API; agent-written code loaded into
the running composition; a gate the agent can edit.

## 7. What is a feature

Everything not in §1–§6 is a feature. Features are components or CLI commands, one file each in
`features/`, with no order: each is built when a user needs it, and its contracts go into
`SPEC.md` then. `features/README.md` marks with ⭐ those that make agents like OpenClaw or Hermes
attractive to the public. Examples: more channels, the scheduler,
approvals, Postgres, several replicas, sandboxes and tenant isolation, open registries, LLM-assisted
merges, a second agent runtime. A feature may never require changing §1–§6; if one seems to, the
change is proposed here first.
