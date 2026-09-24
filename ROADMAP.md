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
| S8 | **Fail loudly.** If a component fails to start, the app does not start: the components already started are stopped in reverse, and `start()` rejects. Resources are acquired in `start`, never in `setup` or in an event listener. `/ready` is true only when every component started. | Core lifecycle tests; per-component start-failure test. |
| S9 | **No silent substitutes.** Outside tests, nothing falls back to an in-memory stand-in for something that must persist. If persistence is missing, it is missing visibly. | Review; `doctor` warnings. |
| S10 | **Stated delivery semantics.** Every path to or from the outside world states its guarantee (at-least-once by default). Effects carry idempotency keys derived from `${sessionId}:${runId}:${toolCallId}`. Every tool declares `replay: "safe" \| "never"`. | Conformance suites for `inbound.dedup` and `outbound.queue`; tool manifest validation. |
| S11 | **Actors and workers.** A conversation's state is records, never worker memory. At most one worker has a conversation's session open, on every target. Messages that reach a busy conversation go to Pi's inbox (`steer` by default), never to a pikit queue. Losing a worker loses no conversation, and eviction is never a reset. An idle conversation holds no open session, timer or sandbox. Session is not workspace. | Kill-the-worker-mid-run scenario on each target; a message sent during a run changes its course; a two-replica scenario once several replicas are supported. |

### Ownership

| # | Standard | Check |
|---|---|---|
| S12 | **Contracts first.** Every capability has an interface and a conformance suite before its first implementation. It is stable only when two implementations (or one implementation plus the memory double) pass the same suite. Session stores also pass Pi's `createSessionRepoConformance` and `createStorageConformance`. | The suite exists and runs in CI for every implementation. |
| S13 | **Readable source.** Copied components are small files with comments on the *why*. They ship their tests inside `files/`, so the tests keep running in the user's project, and they have no install scripts, ever. | Registry validation; review. |
| S14 | **One truth per fact.** A component's dependencies are what its `setup` does (`provide`/`use`), never a separate declaration. `component.json`'s `provides`/`requires`/`optional` are generated from `setup` and never edited by hand. | `describe()` in `pikit registry validate` and `pikit doctor` fails on drift. |
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

**Proves:** a small core of events, pipelines, capabilities and lifecycle can express an
app without knowing anything about channels, storage or Pi.

**Done:** `@pikit/core` is implemented and tested:
- typed events, notifications whose failures cannot fail the app;
- pipelines with priority and `halt`;
- **`setup` is the manifest**: synchronous, registration only, sealed when it returns. The
  dependency graph is derived from `provide`/`use`, with explicit handles resolved from
  `start` onward;
- capabilities: single (with selection), optional (`useOptional(name)`) and
  keyed (`provideKeyed`/`useKeyed`);
- composition validated after every setup and before any start: missing, ambiguous and
  badly selected providers, mixed modes, duplicate keys and cycles;
- ordered `start` / reverse `stop` with rollback, deadlines passed by the caller as a
  context, and a `stop()` that cancels an in-flight `start()`;
- an invocation `Context` (cancellation and values) with Chord's shape, bridged to Pi in one
  line;
- config merge and validation;
- `describe()` for `doctor`.

`Clock` and `Logger` are the only contracts. Every other contract (`sessions.store`,
`execution`, `channel.transport`…) with their conformance suites, the `defineAgent` shapes
and `registerEvent` arrive with the first component that needs them. `@pikit/core/testing`
starts with the lifecycle conformance, which every resource-owning component passes.

### M1 — Five minutes, then it's yours

**Proves:** a source-owned harness can be onboarded as fast as a finished product.

**Done when:**
- On a clean VPS, `curl … | sh && pikit new my-agent --preset http && cd my-agent &&
  pikit configure && pikit up` gives a responding agent with `/health`, an honest `/ready`,
  logs and status.
- `src/pikit/` contains every behavior as readable source.
- A message sent while the agent is working changes its course: it is steered through Pi's
  inbox, and pikit has no queue of its own. (✅ over HTTP in `samples/http`: both requests get the
  run's answer.)
- An existing tier-A Pi extension runs unmodified. (✅ Pi's own examples run byte for byte
  through `createRuntimePi({ extensions })`, and over HTTP in `samples/http`, scenario 7.)

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

✅ **Spike done** on Pi 0.87.1 (`packages/pi-adapter/src/spike`). All six run. Three gaps in
`pi-agent-core` are bridged in the adapter with Pi's own mechanisms until it moves to
`pi-durable` (SPEC §6.4).

✅ **Agent contracts in core:** `defineAgent`, `AgentRuntime`, `agent.definition` and the
`agent.*` events (SPEC §6.1), and the `agent.runtime` conformance suite in
`@pikit/core/testing`, passed by an in-memory double.

✅ **The adapter:** `@pikit/pi-adapter` passes that suite on Pi 0.87.1, killed-process cases
included. It bridges four gaps of `pi-agent-core` (SPEC §6.4), the spike is deleted, and
`pi-gaps.test.ts` / `pi-facts.test.ts` pin the Pi behaviour it relies on.

✅ **`runtime-pi`** (`registry/components/runtime-pi`): provides `agent.runtime` and passes both
suites from its own copied tests. Its `component.json` waits for the CLI's generator; a test pins
what `setup` declares until then.

✅ **Pi extensions** (SPEC §6.2b): a vendored `ExtensionAPI` subset with no TUI, loaded per
conversation and imported through `@pikit/pi-extension-shim`. Pi's `permission-gate`,
`protected-paths` and `hello` examples run unmodified. Tested how a conversation with extensions
is taken up again: reopened after idle, resumed after a crash, the provider's prompt cache across
a reopen, and extension state across a reopen (SPEC §6.2b). Open: reading an extension's entries
back (`ctx.sessionManager`).

✅ **Scenario 1, talk to an agent over HTTP** (`samples/http`, SPEC §15). It runs `runtime-pi` +
`server-bun` + `channel-http`, with `secrets-env`, `sessions-jsonl`, `conversations-file`,
`credentials-file`, `provider-anthropic` and `router-basic`. Each component passes its contract's
conformance suite and the lifecycle suite, and has a start-failure test.
- New core contracts, each with a suite and an in-memory double: `secrets`,
  `conversations.registry` (with `conversation.reset`), `http.route`, and the inbound pipelines
  of §5.
- In the adapter: Pi's JSONL store and session suites, `model.credentials` (pi-ai's
  `CredentialStore`) with its suite, and Anthropic by subpath.
- Two end-to-end tests over real HTTP, with Pi's faux model:
  - scenario 1: the answer in the response; a message steered into a busy run, both POSTs
    answered through `requestIds`; `401`; an honest `/ready`; reset; a conversation surviving a
    restart;
  - the HTTP half of scenario 7: Pi's `permission-gate` blocks `rm -rf` asked for over HTTP.
- A live test against Anthropic runs when a credential exists (a stored login or
  `ANTHROPIC_API_KEY`). Login is pi-ai's OAuth flow (`samples/http/scripts/login.ts`), stored by
  `credentials-file`.
- The answer is the HTTP response; `outbound.prepare`, `channel.transport` and the outbox wait for
  M2 (SPEC §5).

✅ **Tools** (SPEC §6.3, §8.3). An agent names the installed tools it uses
(`tools: ["read", "bash"]`), resolved through `agent.tool`; installing a tool gives no agent
anything.
- `tool-read`, `tool-write`, `tool-edit` and `tool-bash` are Pi's own tools, each bound to the
  capability it declares, with a `replay` (only `read` is `"safe"`).
- `execution-local` provides `execution` and `execution.shell` over Pi's `NodeExecutionEnv`. Its
  commands start from an allowlist of variables, so they do not see the server's secrets. It is
  documented as not a sandbox.
- Pi ships no suite for `ExecutionEnv`, so `createExecutionConformance` lives in
  `@pikit/pi-adapter/testing`.
- In `samples/http`, `assistant` has all four tools with Pi's `permission-gate` loaded:
  - scenario 7 now runs against the real `bash`;
  - the live test has Claude write a file in the workspace.

✅ **Dynamic agents** (SPEC §6.2a). `defineAgent({ state, prepare(state, ctx) })`:
- `prepare` runs once per run in Pi's `before_run` and changes the model, system prompt and tools
  for that run.
- The state is a Pi session value. It survives restarts and starts fresh after a reset.
- Tools update it through their run's context (`context.value(AGENT_STATE)`), never another
  conversation's.
- Each run records what it had as a `pikit.turn` entry, and a resumed run is prepared again.
- `createAgentStateConformance` checks the contract. The `agent.prepare` pipeline stays
  `[planned]` until a component needs it.

✅ **Logs and usage.**
- `AgentResult.usage` carries each run's tokens and cost, summed from Pi's own records; the runs of
  a session add up to Pi's session totals.
- `log-events` writes one structured line per event, and never a message's text.

✅ **`deployment-docker` and the `http` preset** (SPEC §9.1, §11).
- The entrypoint follows §9.1: start and stop deadlines, signals, exit codes.
- Logs are JSON lines, with fields named like secrets redacted.
- `Dockerfile` (non-root, no secrets in the image, `.pikit/` on a volume) and `compose.yaml`
  (healthcheck, stop grace period above the stop deadline, localhost port, rotated logs).
- `up`, `down`, `restart`, `logs` and `status` are functions for the CLI to delegate to.
- `registry/presets/http.yaml` is exactly `samples/http`'s components plus `deployment-docker`,
  and a test keeps them equal.
- Not yet run in a real container: the build and `up` wait for a running Docker daemon.

✅ **Manifests** (SPEC §10.2, §10.4).
- Every component has a `component.json`. Its `provides`, `requires`, `optional` and the tools'
  `replay` are generated from `setup` through `describe()`.
- `registry/registry.json` indexes the components.
- `bun run registry validate` enforces S1, S4, S5, S13 and S14, dependencies and file mappings:
  the checks `pikit registry validate` and `doctor` will run.

✅ **Docker, for real** (Docker Desktop 29.6, arm64).
- `samples/http` builds and goes healthy in about 10 s. It runs as a non-root user, keeps `.env`
  out of the image, and logs JSON lines.
- SIGTERM stops it in milliseconds with exit 0.
- A conversation survives `down` and `up` on the volume.
- A real Claude answers from inside the container, and its `bash` does not see
  `PIKIT_HTTP_TOKEN`.

✅ **The CLI and the installer** (`packages/cli`, `installer/install.sh`, SPEC §10.3, §10.5, §11).
- The CLI has `new`, `add`, `remove`, `doctor`, `configure` (with the Anthropic OAuth login),
  `dev`, and `up`/`down`/`restart`/`logs`/`status` delegating to `deployment-docker`, plus
  `registry validate`/`generate`.
- The `@pikit/*` packages are vendored in the project until they are published; the project
  resolves one copy of the core.
- The end-to-end test runs `new` → `doctor` → the project's own tests → `configure` → `dev`
  answers → S3 add/remove → `up`/`status`/`down` in Docker, in about 19 s on a warm cache.
- The installer ran on macOS (in a temporary HOME) and in a clean `debian:bookworm-slim`
  container: install in 4 s, `new` → answering in 1 s.

✅ **An OAuth login reaches the container** (SPEC §11). `pikit configure` logs in where the app runs,
through `deployment-docker`'s `exec` (`docker compose run`), so the tokens land in the volume; `pikit
up` refuses to start an agent with no credentials there. The Docker end-to-end test covers both, and
the login was run in a pseudo-terminal up to pi-ai's URL and paste prompt, inside the container.

✅ **The guided path** (SPEC §11). The installer goes straight into `pikit new`, which asks the name
and the channel (the registry's presets), runs the channel's own setup and the model's login, and
starts the agent. `e2e-wizard.test.ts` drives it in a real pseudo-terminal against the fake Bot API:
Ctrl-C with nothing written, configuring later, and `pikit new` continuing.

Left for M1:
- **Measure the five-minute budget on a real, clean VPS.**

Decided and deferred: token usage in `AgentResult.usage` arrives with logs and status; an idle
delay before closing a conversation (`idleMs`) is added only if reopening is measured to be slow.

**Scope:**
- `@pikit/pi-adapter` on `accept()` / `drive()` in one server process, shaped by the spike.
- `defineAgent` with `prepare(state)` and `agent.state`.
- Tools: Pi's `read` / `write` / `edit` / `bash` wrapped as `tool-*` components (SPEC §6.3).
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

**Started early: `channel-telegram`** (SPEC §5), to measure how easy a chat channel is to set up.
- It receives by long polling, so it needs no public URL.
- `pikit configure` runs the component's own step: it checks the bot token, then allows whoever
  sends the bot a message. Nobody looks up a user id.
- `pikit new --preset telegram` → `configure` → `dev` → an answer in the chat takes about 2 s
  (end-to-end test against a fake Bot API). `pikit add channel-telegram` to an HTTP project works
  alongside `channel-http`.
- Already covered:
  - a redelivered update is one request, answered once;
  - only allowlisted users reach the agent.
- Left for M2: replies through `channel.transport` and `durable-outbox`, and a run against the real
  Telegram.

**Scope:** `channel-telegram`, `inbound-dedup`, `durable-outbox`, `scheduler-cron`, the
telegram preset, `expose`, `config check`. Runtime availability (SPEC §16) is decided here,
with the first components that can fail while running.

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
- The tools' own tests (`tool-read`, `tool-write`, `tool-edit`, `tool-bash`) run under
  Miniflare, as their `cloudflare` target promises. Today they set their files up with
  `node:fs` in a temporary directory; they set them up through `execution` instead. `tool-bash`
  has a shell there only when something provides `execution.shell` (M5's container).

**Scope:** `sessions-cloudflare-do`, alarm-driven `drive()` with resume, `deployment-cloudflare`,
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
