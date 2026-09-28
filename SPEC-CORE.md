# pikit — Core Specification

What must hold, whatever else pikit becomes. Everything in this file is required; everything
else is a feature (a component, a preset, a CLI command) specified in `SPEC.md` and scheduled in
`ROADMAP.md`.

**Authority.** This file comes first. `SPEC.md`, the code and the other documents must fit it;
when one of them contradicts it, that one is wrong. Changing this file is a decision of the
project's owner, recorded here with its reason. It holds requirements and decisions, never
status: what is done lives in `ROADMAP.md` only.

---

## 1. What pikit must be

**Your Pi agents running as a reliable service on your own infrastructure in five minutes, with
all the code around the agent in your repository, so you can reshape it.**

Three outcomes are required. Without any one of them, pikit is not what it set out to be:

1. **A reliable, source-owned service.** One command from an empty server to an agent that
   answers; every harness piece is source the user owns; nothing is lost or pretended (§2).
2. **The same project runs on a server and on Cloudflare** (§4).
3. **The service is visible and operable from a dashboard** built with Beautiful UI (§5).

## 2. The properties that must hold

Each one is enforced by a standard in `ROADMAP.md` (Part 1); a milestone that breaks one is not
done.

| # | Property | Standard |
|---|---|---|
| P1 | **Pi is the agent; pikit is the kit.** pikit builds only what one Pi process cannot give itself (channels, routing between agents, conversation ownership across processes, durable delivery, scheduling, approvals, deployment, the dashboard). When Pi ships something pikit built, pikit deletes its own. | S1 |
| P2 | **Five minutes, then it's yours.** One command sequence from an empty server to a reachable agent, leaving a project the user owns. | Budget "Empty server → responding agent" |
| P3 | **Components are source you own.** Copied into the project, readable, editable, removable; removing one leaves a clean, working project. | S3, S13, S14 |
| P4 | **A small, stable kernel; contracts are the only coupling; no magic; absence, not flags.** | S2, S4, S6, S7 |
| P5 | **Fail loudly, recover honestly.** A part that cannot start stops the app. Delivery is at-least-once and says so. A restart, crash or eviction never loses a conversation and never pretends a message was answered. | S8–S11 |
| P6 | **Copied code does not rot.** A user who edited a component still takes upstream fixes, with a three-way merge from the base kept at install. | M3 |
| P7 | **Boring on purpose.** The model learned for 1.0 holds for all of 1.x (`SPEC.md` §12a). | S16 |
| P8 | **Runs where you want:** server and Cloudflare (§4). | S5, M4 |

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
- **K8. The kernel is declared stable only after it is proven.** `@pikit/core` 1.0 requires K1–K12
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

### 3.2 What never enters the kernel

Scheduling, approvals, health and degradation policy, deduplication, routing, storage, channels,
delivery, the dashboard. Each is a capability in `@pikit/contracts` and a component. A new kernel
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

**Decisions still open** `[open]`:
- **How the dashboard reads the composition.** `App.describe()` exists but is not reachable from a
  component. Either the kernel offers a read-only description in the context (a kernel export, so a
  decision under K-rules), or the dashboard reads a description generated with the app. Settled
  before the dashboard is built.
- **How primitives reach the registry.** Copied into `registry/components/admin-dashboard/` and
  pinned to a Beautiful UI commit (the pikit way: source owned, reproducible), or fetched with the
  shadcn CLI from Beautiful UI's registry at install time. The first is the default unless there
  is a reason against it.

## 6. What is a feature

Everything not in §1–§5 is a feature. Features are components or CLI commands, specified in
`SPEC.md` and scheduled in `ROADMAP.md` when a user needs them: more channels, the scheduler,
approvals, Postgres, several replicas, sandboxes and tenant isolation, open registries, LLM-assisted
merges, a second agent runtime. A feature may never require changing §1–§5; if one seems to, the
change is proposed here first.
