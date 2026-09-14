# pikit — Agent Guide

How to work on this repository. Read this before touching code.

## What this project is

pikit is a source-owned toolkit for building agent harnesses on top of Pi. A tiny stable core
(events, pipelines, capabilities, lifecycle), a registry of components users copy into their
project, a Pi adapter, and two runtime targets (server and Cloudflare Durable Objects).

Read, in this order, before any non-trivial task:

1. `MANIFESTO.md` — the principles. Every design decision is judged against them.
2. `IDEA.md` — what pikit is, is not, and why.
3. `SPEC.md` — contracts, layering, lifecycle, targets, roadmap. Sections marked `[open]`
   are undecided; `[upstream]` depends on experimental Pi APIs; `[decision]` is settled.

Current status: **M0 (contracts)**. There is no shipped code yet. Do not scaffold packages
until the user asks for a milestone to begin.

M1's definition of done is the five-minute path: installer → `pikit new --preset` →
`pikit configure` → `pikit up` on a clean VPS. Every M1 decision is judged against that
path first and against ownership second; both must hold.

## Stack

- TypeScript, ESM only. Bun for development and tests; Node ≥ 22 must also work for the
  server target. Cloudflare target is built with Wrangler.
- Schemas: `typebox` (same as Pi). No zod.
- YAML: a YAML 1.2 parser (not `Bun.YAML`, which is 1.1 and turns `off`/`on` into booleans).
- Agent runtime: `@earendil-works/pi-agent-core` (0.85.1), `@earendil-works/pi-ai` (0.80.10),
  and (later) `pi-protocol` / `pi-client`. Never `pi-coding-agent` as a dependency on any
  target; it is only invoked as the external `pi` binary by the CLI (SPEC §6.3).
- Tests: `bun test` for packages; conformance suites live in `@pikit/core/testing`.

## The rules that come from the manifesto

These are not style preferences. A change that violates one is wrong even if it works.
The closest existing project is Flue (built on Pi, owns the harness, hooks-based); when in
doubt about a design choice, check that it does not quietly converge on Flue's model.

### 1. The core stays small
`@pikit/core` contains: typed events, pipelines, capabilities, component lifecycle, config
merge/validation, diagnostics, contract interfaces, conformance test helpers. Nothing else.
If you are adding a scheduler, a storage driver, a channel, a router strategy, a tool, or an
admin route to core — stop. It is a component.

Ask before any change to core that adds a public export.

### 2. Absence, not flags
A feature that is not installed must leave no trace: no table, no timer, no config key, no
dependency, no import. Do not add `enabled: false` switches to core or to components for
behavior that belongs in another component. Removal must be clean: `pikit remove X` leaves a
working project.

### 3. Components talk only through contracts
- A component imports `@pikit/core` and contract types. It does **not** import another
  component's files. It calls `pikit.require("capability")`.
- Cross-component needs are expressed in `component.json` (`requires.capabilities`,
  `requires.components`), never as a relative import.
- Events are notifications; pipelines transform; capabilities are services with one provider.
  Do not fake a service call with an event and a shared mutable variable.

### 4. Runtime neutrality by default
- No `node:*`, `bun:*`, or `cloudflare:*` imports in core or in any component that does not
  declare a single target in its manifest.
- Filesystem and shell go through the `execution` capability (Pi's `ExecutionEnv`). Storage
  goes through `storage.sql` / `storage.blob`. Time goes through `clock`. Secrets through
  `secrets`.
- Anything that must survive a restart or a Durable Object eviction is persisted through a
  capability, never kept only in module state.

### 5. Pi is consumed only through the adapter
`@pikit/pi-adapter` is the single package allowed to import `@earendil-works/pi-*`. It exposes
pikit-shaped types. When Pi's experimental APIs change, the adapter changes; components do not.
Import `pi-ai` providers by subpath (`@earendil-works/pi-ai/providers/anthropic`), never the
barrel, because of the Cloudflare bundle limit.

### 6. Source ownership is real
Components are copied into the user's `src/pikit/`. Therefore:
- Component code must be readable by someone who did not write it: small files, explicit
  names, comments on the *why*, no clever indirection.
- Each component ships its own tests inside `files/` so they keep running in the user's
  project.
- No install scripts in components. Ever. (`[decision]` in SPEC §10.2.)
- Protocol and crypto logic is an npm dependency; behavior is copied source.

### 7. No magic
No directives (`'use agent'`), no hooks with implicit context (`useModel()`,
`usePersistentState()`), no compiler transforms, no mandatory build plugin, no decorators
that register things as a side effect of import. A component is a module that exports
`defineComponent({ setup(pikit) { ... } })` and registers plain functions. If a reader cannot
trace what runs by opening `pikit.config.ts` and following imports, the design is wrong.
This is a deliberate departure from Flue's "React for agents" model — see `IDEA.md`,
"Positioning against Flue". Do not propose hooks as an ergonomic improvement.

### 8. Contracts first
For every new capability or component: write the contract interface and its conformance
suite before the first implementation. Two implementations (or one implementation plus the
memory/test double) must pass the same suite before the contract is considered stable.

### 9. Stability is a feature
Public core API, contract interfaces, event/pipeline/capability names, and the
`component.json` / `pikit.json` schemas follow the stability policy in SPEC §12a: additive
within a major, deprecate before removing, majors are rare. Before 1.0 anything may change,
but still prefer the boring option: if two designs are equivalent, pick the one that will
need fewer changes later. Never propose "let's rewrite the agent model" as a minor.

### 10. Dynamic behavior goes through `prepare(state)`
Agents change tools, model, prompt and skills per turn by returning a `TurnConfig` from
`defineAgent({ prepare(state, ctx) })` (SPEC §6.2a). State lives in `agent.state`.
Multi-step processes are `state.phase` + conditional tools, never a workflow DSL. Do not
add registration side effects to `prepare`.

### 11. Prove it by removing
When you finish a component, verify the acceptance shape: install it, run the scenario,
remove it, run `pikit doctor`, confirm nothing else changed. If removal breaks a neighbor,
the boundary is wrong.

## Where does this code go?

| I am writing… | It goes in… |
|---|---|
| An event name, pipeline name, capability contract, lifecycle rule | `@pikit/core` (ask first) |
| A conformance suite for a contract | `@pikit/core/testing` |
| Anything importing `@earendil-works/pi-*` | `@pikit/pi-adapter` |
| A channel, router, store, queue, scheduler, tool, executor, workspace, deployment target | a component in `registry/components/<name>/` |
| Project-specific behavior in a sample/user project | `src/extensions/<name>.ts` |
| A list of components to install together | `registry/presets/<name>.yaml` |
| Deployment glue (Dockerfile, compose, systemd, wrangler) | a `deployment-*` component; the CLI only delegates |
| The one-line installer | `installer/` (shell script; must work on a clean Debian/Ubuntu VPS and macOS) |
| CLI command | `packages/cli/` |

Naming: components are `kebab-case` prefixed by kind: `channel-*`, `router-*`, `sessions-*`,
`storage-*`, `workspace-*`, `execution-*`, `scheduler-*`, `deployment-*`, `tool-*`,
`policy-*`, `admin-*`. Capability names are `dotted.lowercase` (`sessions.store`,
`channel.transport:telegram`). Event names are `namespace.verb` in past tense for
notifications (`outbound.delivered`), present for pipelines (`inbound.normalize`).

## Working method

- **Understand before changing.** Read the relevant SPEC section and the contract. If the
  SPEC is silent, propose the contract change in the conversation before writing code.
- **Confirm before important modifications**: core public API, contract signatures, manifest
  format, `pikit.json` format, anything under `[decision]`.
- **Keep diffs small.** One component or one contract per change. Do not "while I'm here".
- **Search structurally first**: `ast-grep` for code, `rg` for docs/config. Avoid plain grep.
- **Edit, then verify in a separate step.** Never run the check in the same parallel block
  as the edit it verifies.
- **Verify by running.** Every non-trivial change leaves exactly one runnable check (a test
  or a `pikit doctor` scenario). Report what you ran and its result, not what you intended.
- **Update SPEC.md when reality diverges.** If implementation forces a contract change, edit
  the SPEC in the same change and mark the section accordingly. The SPEC is the source of
  truth; code that contradicts it is a bug in one of the two.
- **Resolve `[open]` questions explicitly.** When work forces a decision on an open question,
  state the decision, record it in SPEC §16 as `[decision]`, and note the rationale in one
  line.

## Testing expectations

- Core: unit tests for event ordering, pipeline priority and `halt`, capability
  single-provider errors, config schema merge, lifecycle order.
- Every `sessions.store` implementation must pass Pi's
  `createSessionRepoConformance()` + `createStorageConformance()` (from
  `pi-agent-core/harness/session/testing`) **and** pikit's own suite.
- Every implementation of `storage.sql`, `storage.blob`, `workspace`, `execution`,
  `channel.transport`, `outbound.queue`, `scheduler` must pass its pikit conformance suite.
- Components declaring `targets: ["cloudflare"]` are tested under Miniflare / `wrangler dev`.
- Do not mutate `process.env.TZ` in tests; spawn a subprocess if timezone matters.
- Do not rely on `bun test` forcing UTC; run TZ-sensitive parsing under `bun run` too.

## Things that are easy to get wrong

- **Session ≠ workspace.** The transcript says a file was edited; it is not the file.
  Anything touching sessions must not assume the filesystem is restored, and vice versa.
- **Eviction ≠ reset.** Dropping a harness object from memory must never delete the
  conversation → session pointer. Only an explicit reset repoints it.
- **Replay safety.** Tools with external effects are `replay: "never"` and derive
  idempotency keys from `${sessionId}:${runId}:${toolCallId}`. Reads are `replay: "safe"`.
- **Cloudflare limits are design inputs**, not deployment details: no `child_process`, no
  `eval`, no dynamic imports, 10 MB bundle, 128 MB memory, ~6 concurrent outbound
  connections, 15-minute alarms, in-memory state lost on hibernation.
- **Presets are shortcuts, not modes.** A preset is a list of `pikit add`. Never branch
  behavior on "which preset".
- **Configuration holds values, not behavior.** If you find yourself adding a config key
  that selects between strategies, the strategies are components and the key is the
  capability selector (`capabilities: { sessions.store: postgres }`).

## Git and docs

- Commit messages: `<area>: <imperative summary>` where area is `core`, `adapter`, `cli`,
  `component/<name>`, `spec`, `docs`.
- A change that adds a component, changes a contract, or fixes user-visible behavior gets a
  line in `CHANGELOG.md` (create it at M1).
- Do not commit generated user-project files (`pikit.json`, `src/pikit/**`) from samples
  unless the sample is intentionally a fixture.

## Reference material

Local Pi installation used for API lookups (versions drift; check `package.json`):

- `~/.bun/install/global/node_modules/@earendil-works/pi-agent-core/dist/harness/` —
  `AgentHarness`, `ExecutionEnv`, `SessionStorage`, `SessionRepo`, records, conformance.
- `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` —
  (read-only reference; never import the package) —
  the event/extension model pikit mirrors at harness level.
- `~/.bun/install/global/node_modules/@earendil-works/pi-protocol/README.md` and
  `pi-client/README.md` — transport-neutral remote sessions.
- Cloudflare: Durable Objects (SQL storage, alarms, hibernation), Workers Node compatibility,
  Workflows, Containers — always re-verify limits against current docs before relying on a
  number.

### Flue as a guide (not a source)

Flue (`withastro/flue`, Apache-2.0) is the closest project and a good map of the problem.
Use it deliberately:

- **Read, don't copy, the runtime.** `@flue/runtime` v1 (`v1.0.0-beta.9`, ~1 MB) carries its
  own session/compaction/recovery model built before Pi 0.84 had `AgentHarness` and
  `SessionStorage`. pikit delegates all of that to Pi. Copying the runtime would import a
  second session model and Hono/valibot as core deps.
- **Worth reading as reference** (`gh api repos/withastro/flue/contents/<path>?ref=v1.0.0-beta.9
  --jq .content | base64 -d`):
  `packages/runtime/src/agent-definition.ts` (defineAgent shape),
  `packages/runtime/src/adapter.ts` + `adapter-helpers.ts` (persistence adapter contract),
  `packages/runtime/src/cloudflare/agent-coordinator.ts` (driving a run inside a Durable
  Object with alarms/hibernation — the best reference for M4),
  `packages/runtime/src/test-utils/` (store contract tests).
- **Worth copying with attribution** (small, contract-level code): pieces of
  `agent-definition.ts` validation and the store-contract-test structure. Keep the Apache-2.0
  header and add a line to `NOTICE`.
- **Channel blueprints** (`blueprints/channel--*.md` on `main`) contain complete, verified
  wiring for 18 providers. Use them as the reference when writing `channel-*` components.
  Using `@flue/<provider>` ingress packages as a *dependency* of a pikit channel component
  is allowed by rule 6 (protocol/crypto = dependency); decide per component.
- **Do not converge on their model.** Hooks, `'use agent'`, Vite plugin, runtime-owned
  harness: see rule 7 and `IDEA.md` "Positioning against Flue". When Flue ships something
  good, borrow the *idea*, credit it in the changelog, and express it the pikit way.
- **Track them.** Skim Flue's releases and blog when starting a milestone; note relevant
  changes in `IDEA.md` "Positioning against Flue" if they affect the comparison.

Downloaded packages / docs index (add entries here when you fetch something for context):

- _(none yet)_

## Lessons

Record here anything that went wrong twice, or that the user explicitly told us not to do.

- `pi-coding-agent` is never a dependency: 19 MB, 105 files importing `node:*`, `jiti` for
  dynamic extension loading, its own `SessionManager`. Its tool factories take `cwd` +
  `operations`, not `ExecutionEnv`. Tools are pikit source over `ExecutionEnv`.
- Pi's session conformance is `createSessionRepoConformance` + `createStorageConformance`
  under `harness/session/testing`; `createSessionBackendConformance` does not exist.
