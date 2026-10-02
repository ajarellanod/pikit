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
2. **The same project runs on a server and on Cloudflare** (§4).
3. **The service is visible and operable from a dashboard** built with Beautiful UI (§5).
4. **The main agent knows what it is and can improve itself**, internally (its components) and
   visually (its dashboard), through a gated path that nothing it controls can bypass (§6).

## 2. The properties that must hold

A change that breaks one is not done.

| # | Property |
|---|---|
| P1 | **Pi is the agent; pikit is the kit.** pikit builds only what one Pi process cannot give itself (channels, routing between agents, conversation ownership across processes, durable delivery, scheduling, approvals, deployment, the dashboard, the path by which an agent
changes its own service). When Pi ships something pikit built, pikit deletes its own. |
| P2 | **Five minutes, then it's yours.** One command sequence from an empty server to a reachable agent, leaving a project the user owns. |
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

- **K1. The kernel knows no target.** `Target`, `pikit.target` and `ctx.target` leave the kernel.
  A component's targets are declared in its `component.json`; a component that needs something
  different per target gets it through a capability. *Why:* nothing reads it today, a closed list
  would change the kernel for every new runtime, and `setup` that branches per target makes the
  generated manifest depend on which target it was generated for. Adding it back later would be
  additive.
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
  matches Chord's shape today; when Chord changes, the adapter bridges it. *Why:* users are isolated
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
delivery, the dashboard, self-knowledge and self-change. Each is a capability in `@pikit/contracts` and a component. A new kernel
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

The same project, with the same agents, routing and channels, runs on Cloudflare Workers and
Durable Objects. This is not a feature: it is the proof that the contracts hide no server
(Manifesto, principle 11).

What it requires:
- **Neutral layers.** The kernel, the contracts, the adapter's shipped exports and every component
  in the required set import no `node:*`, `bun:*` or `cloudflare:*` (checked by
  `scripts/boundaries.test.ts` and `registry validate`). A component may be server-only, but the
  required set has a Cloudflare provider for every capability it needs.
- **The required set.** At least a channel, the runtime, sessions, conversations, delivery,
  workspace and execution providers for Cloudflare, the dashboard (§5), and `deployment-cloudflare`.
- **The actor model holds there.** One conversation is owned by one Durable Object (C1). An
  evicted object loses nothing: the next request or alarm resumes the run (`resume()`), per K6.
- **The budgets hold.** Bundle ≤ 10 MB compressed, cold start ≤ 1 s, ≤ 128 MB per isolate,
  ≤ 6 concurrent outbound connections, measured, not estimated.
- **The proof runs.** The required set deploys and answers; a run killed by eviction mid-drive
  completes after `resume()`; the Durable Object session backend passes Pi's session conformance.

### 4.1 Decisions

Each decision was proven by a spike on Cloudflare (September 2026, Workers Free plan) before it was
written here. Status (built or not) is not tracked here, as for the kernel.

- **C1. A thin Worker, and one Durable Object per conversation running the App.** A project on
  Cloudflare has two Apps (K7), both in `pikit.config.ts`: the default export is the Durable
  Object's App (the channel's other half, the router, the registry, the runtime, sessions, storage,
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
  `idFromName(key)` (`platform-cloudflare`). *Why:* one channel component serves both targets, and no
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
- **C5. State through neutral contracts; the platform through one context key.** Sessions
  (`sessions-sql`, Pi's `Storage` on `storage.sql`) and conversations (`conversations-kv`, on
  `storage.kv`) have neutral providers that run on both targets; the only Cloudflare-specific storage
  is `storage-do` (`storage.sql` on the object's SQLite, whose transactions pass the `storage.sql`
  suite unchanged). Platform objects reach components through one context key in
  `@pikit/contracts/cloudflare`, `WORKERS_HOST`, which `deployment-cloudflare`'s entrypoints put on each App's
  start context: the Worker's `env` (and, in the Worker's App, the origin its first request reached),
  and in an object its id, its storage, and the hooks its alarm and RPC call. Its types are structural: no `cloudflare:*` import leaves the entrypoints. *Why:* the
  components that must touch the platform are few and say so by reading one key; everything else is
  the same code on both targets.
  `sessions-sql` is transitional (P1): when the adapter moves to Pi's durable runtime (`pi-durable`),
  sessions are that runtime's own storage and `sessions-sql` goes (`features/pi-durable-migration.md`).
  `pi-durable`'s SQLite core takes a synchronous database facade, which a Durable Object's SQLite
  and Bun's can implement and an asynchronous API cannot: sessions will then sit on the object's SQL
  directly, through `WORKERS_HOST`, not on `storage.sql`, which stays asynchronous so that Postgres fits
  and keeps the records components own.
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

A visual dashboard to see and operate a running pikit service, built from
[Beautiful UI](https://github.com/slev12397/beautiful-ui) primitives (MIT): copy-paste React
components for AI products (thinking and streaming states, tool-call status, approval cards,
records and diff tables, prompt bars, an agent chat harness).

**What it shows and does.**
- The composition: components, capabilities and their providers, pipelines, the config without
  secrets.
- Conversations: their agent, their session, their runs; a run's messages, tool calls and result.
- Delivery: what is queued, sent, retried, abandoned or possibly duplicated.
- Health: what is up, degraded or failing.
- Actions, each through an existing contract, never around one: abort a run, reset a
  conversation, answer an approval (when `approvals` exists), talk to an agent.

**How it fits pikit.**
- **It is a component** (`admin-dashboard`), not kernel: installed with `pikit add`, removable,
  absent when not installed (P3, P4). Its source, including the Beautiful UI primitives it uses, is
  copied into the project like any other component and is the user's to change.
- **It reads contracts and feeds, never internals.** Its data comes from an authenticated admin
  HTTP API it registers through `http.route`, backed by the capabilities of the installed
  components. What must not be missed comes from feeds, not from events (K3). A view whose
  capability is not installed does not appear.
- **It runs on both targets** (§4). The UI is static assets built by the component (React and
  Tailwind v4, the stack of Beautiful UI's primitives; no Next.js server runtime), served by
  `server-bun` on a server and as Workers static assets on Cloudflare. Live updates use a stream
  both targets offer (server-sent events on the server; the Durable Object's hibernating WebSocket
  on Cloudflare).
- **Its build is its own.** Building the dashboard's assets does not become a build step every
  pikit app needs (no magic, principle 9).
- **It is safe by default.** Authenticated; never shows a secret or a credential. Operational logs stay without message text; the transcript views are an explicit,
  authenticated read of the session.
- **No paid dependencies.** Beautiful UI's `SidebarNav` uses a commercial icon set
  (`@central-icons-react`); the dashboard replaces it with a free set. Every copied primitive is
  attributed in `NOTICE`.

The dashboard reads the composition through `APP_DESCRIPTION` (K13).

**Decision still open** `[open]`:
- **How primitives reach the registry.** Copied into `registry/components/admin-dashboard/` and
  pinned to a Beautiful UI commit (the pikit way: source owned, reproducible), or fetched with the
  shadcn CLI from Beautiful UI's registry at install time. The first is the default unless there
  is a reason against it.

## 6. The agent knows and improves itself

Pi can already improve itself: its prompt tells it where its own docs are, it writes an extension,
and `/reload` loads it; Pi's durable runtime turns a code change into a *generation boundary*
(stop admitting, close, open a new harness over the same storage, resume from the checkpoints). pikit
takes the same idea from one Pi process to the whole service: what Pi cannot do for itself is know
which pikit it runs in, and change, test, approve, deploy and roll back that service.

**Who.** One agent per project is the steward: the main agent, declared so in its `defineAgent`.
Only it gets the self-knowledge and the self-change tools. Only senders trusted as its operators may
ask it to change itself.

**Knowing itself.**
- A Pi skill, `pikit-self`, tells it what it is and how each part of it is changed, built from this
  file, its components' READMEs and `pikit.json`. A skill is Pi's own way to load knowledge on demand
  (Pi first).
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

**What it may change.** Its own definition (prompt, tools, skills), Pi extensions, the components in
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

**Visually.** The dashboard is source in the project, so the agent improves it the same way: adding
Beautiful UI or shadcn primitives (`shadcn add <registry URL>`) or new views, through the same
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
