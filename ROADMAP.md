# pikit — Roadmap

This roadmap is not a task list. It says what must become true, in what order, and which
standards hold the whole way. A milestone is done when its proof runs, not when its tasks
are ticked.

- The **why** is in `MANIFESTO.md`.
- The **contracts** are in `SPEC.md`.
- The **how we work** is in `AGENTS.md`.

---

## Part 1 — The standards

These hold at every milestone, for every change. A milestone that breaks one is not done,
however much it ships. Each standard names the check that enforces it, because a rule
nobody can check is only a wish.

> **The first standard: Pi first.**
>
> Pi is the agent. pikit is the kit: everything Pi needs to run as a robust, multi-agent
> service in the cloud, and nothing Pi already does.
>
> Before building any agent-facing feature, check whether Pi does it:
> 1. Read `pi-agent-core` (harness, session, runtime) and `pi-ai`, and **always check the
>    upstream repo `earendil-works/pi`** (`agent`, `durable`, `chord`, `server`). The
>    installed version shows what Pi does today; the repo shows what it is about to do.
> 2. If Pi does it, use it through the adapter. pikit builds nothing.
> 3. If Pi does it partially, wrap it in the adapter and take the gap upstream.
> 4. Build it in pikit only when one Pi process cannot provide it for itself.
>
> When Pi ships something pikit built, pikit deletes its version. If another standard seems
> to conflict with this one, this one wins.

### The idea

| # | Standard | Check |
|---|---|---|
| S1 | **Pi first.** No agent behavior is built in pikit if Pi provides it: loop, models, compaction, retries, steering and follow-up queues, session serialization, resume, tool execution, skills. Only `@pikit/pi-adapter` imports `@earendil-works/pi-*`; `coding-agent` is never a dependency. | Every agent-facing SPEC section names the Pi API it uses, or why one Pi process cannot provide it; SPEC §6.2 lists what Pi does and what pikit adds. Import scan: `pi-*` imports only under `packages/pi-adapter`. |
| S2 | **The core stays small.** `@pikit/core` holds events, pipelines, capabilities, lifecycle, config, diagnostics and contract interfaces. Nothing domain-specific. Its only runtime dependency is `typebox`. | Every new export from `packages/core/src/index.ts` is approved by the maintainer and recorded in `SPEC.md`. |
| S3 | **Absence, not flags.** A component that is not installed leaves no table, timer, config key, dependency or import. No `enabled: false`. | Removal test: add → run scenario → remove → `pikit doctor` green, `git diff` shows only that component. |
| S4 | **Contracts are the only coupling.** A component never imports another component's files; it depends on a capability with `use("capability")`. | Import scan: nothing under a component imports a sibling component path. |
| S5 | **Runtime neutrality.** No `node:*`, `bun:*` or `cloudflare:*` imports in core or in any component that declares more than one target. | Import scan per declared target; Miniflare run for `cloudflare`. |
| S6 | **No magic.** No directives, hooks with implicit context, decorators, compiler transforms, side-effect registration or production dynamic imports. | Review, backed by `pikit doctor` printing the full graph from `pikit.config.ts` alone. |
| S7 | **Values in config, behavior in code.** A config key that selects a strategy is a design error; the strategy is a component and the key is a capability selector. | Review of every new config schema. |

### The service

| # | Standard | Check |
|---|---|---|
| S8 | **Fail loudly.** If a component fails to start, the harness does not start: the components already started are stopped in reverse, and `start()` rejects. Resources are acquired in `start`, never in `setup` or in an event listener. `/ready` is true only when every component started. | Core lifecycle tests; per-component start-failure test. |
| S9 | **No silent substitutes.** Outside tests, nothing falls back to an in-memory stand-in for something that must persist. If persistence is missing, it is missing visibly. | Review; `doctor` warnings. |
| S10 | **Stated delivery semantics.** Every path to or from the outside world states its guarantee (at-least-once by default). Effects carry idempotency keys derived from `${sessionId}:${runId}:${toolCallId}`. Every tool declares `replay: "safe" \| "never"`. | Conformance suites for `inbound.dedup` and `outbound.queue`; tool manifest validation. |
| S11 | **Actors and workers.** A conversation's state is records, never worker memory. At most one worker has a conversation's session open, on every target. Messages that reach a busy conversation go to Pi's inbox (`steer` by default), never to a pikit queue. Losing a worker loses no conversation, and eviction is never a reset. An idle conversation holds no open session, timer or sandbox. Session is not workspace. | Kill-the-worker-mid-run scenario on each target; a message sent during a run changes its course; a two-replica scenario once several replicas are supported. |

### Ownership

| # | Standard | Check |
|---|---|---|
| S12 | **Contracts first.** Every capability has an interface and a conformance suite before its first implementation. It is stable only when two implementations (or one implementation plus the memory double) pass the same suite. Session stores also pass Pi's `createSessionRepoConformance` and `createStorageConformance`. | The suite exists and runs in CI for every implementation. |
| S13 | **Readable source.** Copied components are small files with comments on the *why*. They ship their tests inside `files/`, so the tests keep running in the user's project, and they have no install scripts, ever. | Registry validation; review. |
| S14 | **One truth per fact.** A component's dependencies are what its `setup` does (`provide`/`use`), never a separate declaration. `component.json`'s `provides`/`requires` are generated from `setup` and never edited by hand. | `describe()` in `pikit registry validate` and `pikit doctor` fails on drift. |
| S15 | **Always green.** `bun test` and `tsc --noEmit` pass on `main`. Every change leaves exactly one runnable check. A milestone ends with its scenarios running, not described. | CI. |

### Stability

| # | Standard | Check |
|---|---|---|
| S16 | **Boring on purpose.** Before 1.0 anything may change, but always through `SPEC.md` first: code that contradicts the spec is a bug in one of the two. From 1.0, SPEC §12a applies: additive within a major, deprecate before removing, and majors are rare and come with migrations. | Release notes list "what you must change" first. |

### Budgets

Numbers are part of the design, not deployment details. They are re-measured whenever a
milestone touches them.

| Budget | Value | From |
|---|---|---|
| Empty server → responding agent | ≤ 5 minutes, one command sequence | M1 |
| Core runtime dependencies | `typebox` only | M0 |
| Cloudflare bundle | ≤ 10 MB compressed | M4 |
| Cloudflare cold start | ≤ 1 s | M4 |
| Cloudflare memory | ≤ 128 MB per isolate | M4 |
| Subagent fan-out on Cloudflare | ≤ 6 concurrent outbound connections | M4 |

---

## Part 2 — The milestones

Each milestone proves one claim of the idea. The claims build on each other, so the order
is a rule: a milestone starts when the previous one's evidence is green. The scenarios are
defined in SPEC §15.

### M0 — The language is enough ✅

**Proves:** a small core of events, pipelines, capabilities and lifecycle can express a
harness without knowing anything about channels, storage or Pi.

**Done:** `@pikit/core` is implemented and tested:
- typed events;
- pipelines with priority, anchors and `halt`;
- single-provider capabilities with selection;
- composition validated before any code runs;
- ordered `start` / reverse `stop` with rollback;
- config merge and validation;
- `describe()` for `doctor`.

`Clock` and `Logger` are the only contracts, because every other contract is written when
its first component needs it.

### M1 — Five minutes, then it's yours

**Proves:** a source-owned harness can be onboarded as fast as a finished product.

**Done when:**
- On a clean VPS, `curl … | sh && pikit new my-agent --preset http && cd my-agent &&
  pikit configure && pikit up` gives a responding agent with `/health`, an honest `/ready`,
  logs and status.
- `src/pikit/` contains every behavior as readable source.
- A message sent while the agent is working changes its course: it is steered through Pi's
  inbox, and pikit has no queue of its own.
- An existing tier-A Pi extension runs unmodified.

**First step, before any M1 component: the adapter spike.** A throwaway spike of
`@pikit/pi-adapter` on Pi 0.87.x that proves the translation to the shapes of Pi's durable
runtime (SPEC §6.4) before any contract depends on it:
- one conversation is one `AgentHarness` over one Pi session;
- a prompt runs to an answer;
- a message sent mid-run is steered and its answer is attributable to it (the future
  submission);
- a repeated `requestId` is recognised as a duplicate;
- `agent.state` reads and writes session values and starts fresh after a reset;
- a killed run is continued by `resume()` in a new process.

The spike's findings update SPEC §6.1 and §6.4, and it is then deleted or turned into the
adapter. If Pi cannot do one of these things, the gap goes upstream before pikit works
around it.

**Scope:**
- `@pikit/pi-adapter` in automatic drive mode, shaped by the spike.
- `defineAgent` with `prepare(state)` and `agent.state`.
- Tools written against `ExecutionEnv`.
- The http preset, running one server replica: one process is the only worker.
- The installer and the core CLI: `new`, `add`, `remove`, `doctor`, `dev`, `configure`, and
  `up`/`down`/`logs`/`status`.

**Evidence:** scenarios 1 and 7.

### M2 — It survives the real world

**Proves:** the harness is reliable as a service in front of real platforms. It survives
redeliveries, channel outages, restarts and scheduled work.

**Done when:**
- A Telegram bot keeps state across restarts.
- A redelivered update is answered once, and a crashed attempt is retried rather than
  dropped.
- A channel outage is retried by the outbox without touching the channel component.
- Scheduled prompts run.

**Scope:** `channel-telegram`, `inbound-dedup`, `durable-outbox`, `scheduler-cron`, the
telegram preset, `expose`, `config check`.

**Evidence:** scenarios 2 and 3, plus a redelivery scenario for `inbound-dedup`.

### M3 — Ownership survives upstream change

**Proves:** copied source does not rot. A user can edit components and still take upstream
improvements.

**Done when:**
- A locally modified component upgrades with a three-way diff, and conflicts can be resolved
  with Pi.
- SQLite is swapped for Postgres without touching the router, channel or agent.
- A project extension changes routing and blocks a tool without forking a component.

**Scope:** `pikit.json` hashes, `outdated`/`diff`/`upgrade`, `create`,
`registry init|validate`, `sessions-postgres`.

**Evidence:** scenarios 4 and 5.

### M4 — The contracts are real

**Proves:** the same project runs at the edge, which means none of the contracts was hiding
a server.

**Done when:**
- The same agents deploy to Durable Objects and answer.
- A run survives DO eviction mid-run: `resume()` completes it.
- The DO session backend passes Pi's conformance suite.
- Every Cloudflare budget is measured and met.

**Scope:** `sessions-cloudflare-do`, manual drive mode with resume, `deployment-cloudflare`,
`workspace-virtual`, `execution-fetch`, `scheduler-cloudflare`.

**Evidence:** scenario 6.

### M5 — Operational patterns at the edge

**Proves:** the patterns that made the original production platform worth having can be
built as removable components:
- approvals that wait for days and bind to the surface where a human can answer;
- real shells;
- workspace snapshots;
- Google Chat.

**Scope:** `execution-cloudflare-container`, `workspace-container`,
`workspace-r2-snapshot`, `approvals` on Workflows, `channel-google-chat`.

### 1.0 — The promise

pikit reaches 1.0 when:
1. All seven scenarios are green on every target they declare.
2. Every contract is stable under S12.
3. Every standard above has an automated check.
4. SPEC §12a is in force.

From then on the programming model does not get rewritten.

### Later, only if demanded

- Several server replicas, with `conversations.ownership` (a lease per conversation and
  fenced writes).
- A remote executor protocol.
- A second agent runtime behind `AgentRuntime`.
- A static registry gallery.

Nothing here starts because it would be nice; each item needs a user who needs it.

---

Open design questions are tracked in SPEC §16. A milestone that forces a decision records
it there as `[decision]` with a one-line rationale.
