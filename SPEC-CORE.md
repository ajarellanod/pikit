# pikit — Core Specification

What must hold, whatever else pikit becomes. Everything in this file is required; everything
else is a feature (a component, a preset, a CLI command) described in `features/` (one file each,
with no order); its contracts are written in `SPEC.md` when it is built, and what is built is
tracked in `ROADMAP.md`.

**Authority.** This file comes first. `SPEC.md`, the code and the other documents must fit it;
when one of them contradicts it, that one is wrong. Changing this file is a decision of the
project's owner, recorded here with its reason. It holds requirements and decisions, never
status: what is done lives in `ROADMAP.md` only.

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

Each one is enforced by a standard in `ROADMAP.md` (Part 1); a milestone that breaks one is not
done.

| # | Property | Standard |
|---|---|---|
| P1 | **Pi is the agent; pikit is the kit.** pikit builds only what one Pi process cannot give itself (channels, routing between agents, conversation ownership across processes, durable delivery, scheduling, approvals, deployment, the dashboard, the path by which an agent
changes its own service). When Pi ships something pikit built, pikit deletes its own. | S1 |
| P2 | **Five minutes, then it's yours.** One command sequence from an empty server to a reachable agent, leaving a project the user owns. | Budget "Empty server → responding agent" |
| P3 | **Components are source you own.** Copied into the project, readable, editable, removable; removing one leaves a clean, working project. | S3, S13, S14 |
| P4 | **A small, stable kernel; contracts are the only coupling; no magic; absence, not flags.** | S2, S4, S6, S7 |
| P5 | **Fail loudly, recover honestly.** A part that cannot start stops the app. Delivery is at-least-once and says so. A restart, crash or eviction never loses a conversation and never pretends a message was answered. | S8–S11 |
| P6 | **Copied code does not rot.** A user who edited a component still takes upstream fixes, with a three-way merge from the base kept at install. | M3 |
| P7 | **Boring on purpose.** The model learned for 1.0 holds for all of 1.x (`SPEC.md` §12a). | S16 |
| P8 | **Runs where you want:** server and Cloudflare (§4). | S5, M4 |
| P9 | **Self-improvement is gated.** An agent changes the service only through the source of its own project, with tests, a human's approval and an automatic rollback; nothing it can edit can open that gate (§6). | Track S |

## 3. The kernel

The kernel is `@pikit/core`: what the app runs itself (composition, capabilities, events,
pipelines, lifecycle, config validation, context, clock, logger), with no word of the domain.
Its exports are held by `packages/core/src/exports.test.ts`; its only runtime dependency is
`typebox`. The shared vocabulary lives in `@pikit/contracts` and versions apart (`SPEC.md` §4.9).

### 3.1 Decisions

Each decision states what the kernel promises and why it keeps holding as pikit grows. Status
(built or not) is tracked in `ROADMAP.md`, track K.

- **K1. The kernel knows no target.** `Target`, `pikit.target` and `ctx.target` leave the kernel.
  A component's targets are declared in its `component.json`; a component that needs something
  different per target gets it through a capability. *Why:* nothing reads it today, a closed list
  would change the kernel for every new runtime, and `setup` that branches per target makes the
  generated manifest depend on which target it was generated for. Adding it back later would be
  additive.
- **K2. Whoever runs the app bounds the rollback.** The kernel keeps no timeouts (`SPEC.md` §4.6).
  A failed start's rollback is bounded by a `stop(ctx)` with a deadline, which the host calls while
  `start()` is pending or after it rejects. Every `deployment-*` component's entrypoint does so, and
  a conformance case for deployment components hangs a rollback on purpose and requires the process
  to exit. *Why:* no new kernel API, and the rule is checked, not only written.
- **K3. Events are never persisted.** An event is a notification and may be missed. A fact that
  must not be lost is a feed (`SPEC.md` §4.8). There is no runtime schema for events and no
  `registerEvent`. *Why:* one pattern for durability instead of two, and less kernel surface.
- **K4. The kernel takes a plain, validated object as config.** It merges the components' TypeBox
  schemas under their names, validates, and deep-freezes. Where the object comes from (TypeScript
  in `pikit.config.ts` today, YAML or a wizard later) is the project's or the CLI's business, never
  the kernel's. *Why:* formats change; the kernel's contract does not.
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
  (M4), never the kernel's. *Why:* the kernel already supports it, so no answer M4 reaches changes
  the kernel.
- **K8. The kernel is declared stable only after it is proven.** `@pikit/core` 1.0 requires K1–K13
  applied, the kernel running on Node from a JavaScript build, and the Cloudflare proof (a run that
  survives eviction, §4). The contracts stay 0.x and `experimental` on their own schedule. *Why:*
  declaring stable a kernel that Cloudflare could still force to change is the surest way to break
  the promise.
- **K9. Kernel stability is its own track.** `ROADMAP.md` tracks it as K, apart from the features
  (M2–M5). No 1.0 of pikit ships without K done.
- **K10. Deprecation exists before publishing.** A removal from the kernel is announced by a runtime
  warning and a `pikit doctor` hint for at least one minor (`SPEC.md` §12a). The mechanism is
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
  TypeScript 7 already lost relative augmentations once (`AGENTS.md`, lessons).
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

## 4. Cloudflare is required

The same project, with the same agents, routing and channels, runs on Cloudflare Workers and
Durable Objects. This is not a feature: it is the proof that the contracts hide no server
(Manifesto, principle 11).

What it requires:
- **Neutral layers.** The kernel, the contracts, the adapter's shipped exports and every component
  in the required set import no `node:*`, `bun:*` or `cloudflare:*` (S5, checked by
  `scripts/boundaries.test.ts` and `registry validate`). A component may be server-only, but the
  required set has a Cloudflare provider for every capability it needs.
- **The required set.** At least what scenario 6 names (`SPEC.md` §15): a channel, the runtime,
  sessions, conversations, delivery, workspace and execution providers for Cloudflare, the
  dashboard (§5), and `deployment-cloudflare`.
- **The actor model holds there.** One conversation is owned by one Durable Object (S11). An
  evicted object loses nothing: the next request or alarm resumes the run (`resume()`), per K6.
- **The budgets hold.** Bundle ≤ 10 MB compressed, cold start ≤ 1 s, ≤ 128 MB per isolate,
  ≤ 6 concurrent outbound connections (`ROADMAP.md`, Budgets), measured, not estimated.
- **The proof runs.** Scenario 6 deploys and answers; a run killed by eviction mid-drive completes
  after `resume()`; the Durable Object session backend passes Pi's session conformance.

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
- **It is safe by default.** Authenticated; never shows a secret or a credential; follows
  `SPEC.md` §13. Operational logs stay without message text; the transcript views are an explicit,
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
