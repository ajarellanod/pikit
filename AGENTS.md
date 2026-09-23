# pikit — Agent Guide

How to work on this repository. Read it before touching code.

## What this project is

pikit is a harness for running your own AI agents as a cloud service, built from parts you
own. It is the moldable alternative to OpenClaw and Hermes. It does not compete with Pi,
Claude Code or Codex: Pi is its engine.

The project has four parts:
- **A small core:** events, pipelines, capabilities and lifecycle.
- **A Pi adapter.**
- **A registry of components** that users copy into their project as source.
- **Two runtime targets:** a long-running server and Cloudflare Durable Objects.

This repository is the idea made real. The documents are not background; they are the
spec the code is held to.

| Document | Answers | Authority |
|---|---|---|
| `MANIFESTO.md` | Why pikit exists and what it believes | Every decision is judged against it |
| `ROADMAP.md` | Which standards always hold, and what each milestone proves | A milestone that breaks a standard is not done |
| `SPEC.md` | The contracts: layering, lifecycle, capabilities, targets | Code that contradicts it is a bug in one of the two |
| `IDEA.md` | Positioning, context, and how pikit differs from Flue and others | Background for judgment calls |

Tags in the SPEC:
- `[open]`: undecided.
- `[decision]`: settled.
- `[planned]`: agreed but not built.
- `[upstream]`: depends on experimental Pi APIs.

**Status:** `ROADMAP.md` is the single place that says what is done. Do not start a
milestone's work until the user asks for it.

## Stack

- TypeScript, ESM only. Bun for development and tests. Node ≥ 22 must also work for the
  server target. The Cloudflare target is built with Wrangler.
- `typebox` for schemas (the same library Pi uses). No zod.
- A YAML 1.2 parser. Do not use `Bun.YAML`: it implements YAML 1.1, where `off` and `on`
  become booleans.
- Pi: `@earendil-works/pi-agent-core` (0.85.1) and `@earendil-works/pi-ai` (0.80.10), later
  `pi-protocol` and `pi-client`. `pi-coding-agent` is never a dependency. It is only invoked
  as the external `pi` binary by the CLI.
- Checks: `bun test` and `bun run typecheck` (`tsc --noEmit`, TypeScript 7, strict,
  `exactOptionalPropertyTypes`). Conformance suites live in `@pikit/core/testing`.

## The rules

These are not style preferences. A change that breaks one is wrong even if it works. Each
rule maps to a standard in `ROADMAP.md` (S1–S16), which says how the rule is checked.

1. **Pi only through the adapter** (S1). `@pikit/pi-adapter` is the only package that
   imports `@earendil-works/pi-*`. It exposes pikit-shaped types, and components import Pi
   contract types (`ExecutionEnv`, `SessionRepo`) from the adapter's re-exports. Import
   `pi-ai` providers by subpath, never through the barrel, because of the Cloudflare bundle
   limit. Existing non-TUI Pi extensions must run unmodified (SPEC §6.2b). That compatibility
   lives in the adapter; never bend core names to Pi's `snake_case`.
2. **The core stays small** (S2). A scheduler, storage driver, channel, router strategy,
   tool, admin route or deduplication store is a component, not core. Ask before adding any
   public export to `@pikit/core`.
3. **Absence, not flags** (S3, S9). Never add `enabled: false` switches. Never add a core
   behavior that changes depending on which components are installed. Never add an in-memory
   fallback for something that must persist.
4. **Contracts are the only coupling** (S4). A component imports `@pikit/core` and contract
   types, and calls `pikit.require("capability")`. It never imports another component's
   files. Events are notifications, pipelines transform, and capabilities are services with
   one provider. Do not fake a service call with an event and a shared variable.
5. **Runtime neutral by default** (S5). No `node:*`, `bun:*` or `cloudflare:*` imports
   unless the component declares a single target. Other needs go through capabilities:
   - filesystem and shell through `execution`;
   - storage through `storage.sql` and `storage.blob`;
   - time through `clock`;
   - secrets through `secrets`.

   Anything that must survive a restart or an eviction is persisted through a capability,
   never kept in module state.
6. **`setup` registers; `start`/`stop` own resources** (S8). `setup` calls
   `on`/`pipeline`/`provide` and returns `{ start, stop }` if the component owns sockets,
   files, connections or timers. Never acquire a resource in `setup` or in an event listener:
   a failure there becomes a log line and a process that looks healthy.
7. **State delivery semantics** (S10, S11). Anything that talks to the outside world says
   whether it is at-least-once and how duplicates are handled:
   - Effectful tools are `replay: "never"` and derive idempotency keys from
     `${sessionId}:${runId}:${toolCallId}`.
   - Read-only tools are `replay: "safe"`.
   - A channel acknowledges a webhook only after the message is durably accepted.
8. **No magic** (S6). No directives, hooks with implicit context, decorators, compiler
   transforms or registration as a side effect of an import. A component is
   `defineComponent({ setup(pikit) { … } })`. Do not propose hooks as an ergonomic
   improvement; that is Flue's model, and IDEA.md explains why pikit rejects it.
9. **Dynamic agents through `prepare(state)`**. Agents change tools, model, prompt and skills
   per turn by returning a `TurnConfig` from `defineAgent({ prepare(state, ctx) })`, with
   state kept in `agent.state`. A multi-step process is `state.phase` plus conditional tools,
   never a workflow DSL. `prepare` has no registration side effects.
10. **Values in config, behavior in code** (S7). A config key that selects between
    strategies means those strategies are components, and the key is a capability selector
    (`capabilities: { sessions.store: postgres }`).
11. **Contracts first** (S12). Write the interface and its conformance suite before the
    first implementation.
12. **Source ownership is real** (S13, S14). Copied code must be readable by someone who did
    not write it:
    - small files, explicit names, comments on the *why*;
    - tests inside `files/`;
    - no install scripts.

    Protocols and crypto are npm dependencies; behavior is copied source. `defineComponent`
    is the runtime truth, and `component.json` must agree with it.
13. **Prove it by removing** (S3). When a component is finished, install it, run its
    scenario, remove it, run `pikit doctor`, and confirm that nothing else changed.
14. **Stable on purpose** (S16). If two designs are equivalent, pick the one that will need
    fewer changes later. Never propose rewriting the agent model as a minor change.

## Where does this code go?

| I am writing… | It goes in… |
|---|---|
| An event name, pipeline name, capability contract, lifecycle rule | `@pikit/core` (ask first) |
| A conformance suite for a contract | `@pikit/core/testing` |
| Anything importing `@earendil-works/pi-*` | `@pikit/pi-adapter` |
| A channel, router, store, queue, dedup, scheduler, tool, executor, workspace, deployment target | a component in `registry/components/<name>/` |
| Project-specific behavior in a sample or user project | `src/extensions/<name>.ts` |
| A list of components to install together | `registry/presets/<name>.yaml` |
| Deployment glue (Dockerfile, compose, systemd, wrangler) | a `deployment-*` component; the CLI only delegates |
| The one-line installer | `installer/` (must work on a clean Debian/Ubuntu VPS and on macOS) |
| A CLI command | `packages/cli/` |

## Naming

| Thing | Convention | Examples |
|---|---|---|
| Components | kebab-case, prefixed by kind | `channel-*`, `router-*`, `sessions-*`, `storage-*`, `workspace-*`, `execution-*`, `scheduler-*`, `deployment-*`, `tool-*`, `policy-*`, `admin-*`, `inbound-*` |
| Reserved component names | never used | `capabilities` (it is a core config key) |
| Capabilities | `dotted.lowercase` | `sessions.store`, `execution.shell`, `channel.transport:telegram` |
| Events (notifications) | `namespace.verb`, past tense | `outbound.delivered` |
| Pipelines | present tense | `inbound.normalize` |

## Working method

- **Understand before changing.** Read the relevant SPEC section and contract. If the SPEC
  is silent, propose the contract change in the conversation before writing code.
- **Confirm before important modifications:** core public API, contract signatures, manifest
  or `pikit.json` format, anything marked `[decision]`.
- **Keep diffs small:** one component or one contract per change. No "while I'm here" edits.
- **Search structurally first:** `ast-grep` for code, `rg` for docs and config. Avoid plain
  grep.
- **Edit, then verify in a separate step.** Never run a check in the same parallel block as
  the edit it verifies.
- **Verify by running.** Every non-trivial change leaves one runnable check. Report what you
  ran and what it returned.
- **Keep the documents true.**
  - When implementation forces a contract change, edit `SPEC.md` in the same change.
  - When a milestone's state changes, edit `ROADMAP.md`.
  - When work forces a decision on an `[open]` question, record it in SPEC §16 as
    `[decision]` with a one-line rationale.

## Testing expectations

- **Core:** event ordering, pipeline priority, anchors and `halt`, capability resolution and
  selection, composition errors before setup, lifecycle order and rollback, config
  merge/validation.
- **Every contract implementation** passes its pikit conformance suite: `storage.sql`,
  `storage.blob`, `workspace`, `execution`, `channel.transport`, `inbound.dedup`,
  `outbound.queue`, `scheduler`.
- **Session stores** also pass Pi's `createSessionRepoConformance()` and
  `createStorageConformance()` (from `pi-agent-core/harness/session/testing`).
- **Every component that owns resources** has a start-failure test.
- **Components targeting `cloudflare`** are tested under Miniflare or `wrangler dev`.
- **Timezones:** never mutate `process.env.TZ` in a test; spawn a subprocess instead. Do not
  rely on `bun test` forcing UTC; run TZ-sensitive parsing under `bun run` too.

## Things that are easy to get wrong

- **Session ≠ workspace.** The transcript says a file was edited; it is not the file.
- **Eviction ≠ reset.** Dropping a harness from memory never deletes the conversation →
  session pointer. Only an explicit reset repoints it.
- **Events cannot fail the harness.** A listener's error is logged and swallowed. If
  something must succeed, it belongs in `start`.
- **Selection shapes dependency order.** A consumer depends only on the provider `require`
  will return: the selected one when there are several.
- **Transports are per message.** `channel.transport:<name>` is resolved from
  `message.channel` and never listed in `requires`.
- **Deduplication belongs to the channel.** The delivery id and the ack rule are
  platform-specific; `inbound-dedup` holds claims, and the core holds nothing.
- **Cloudflare limits are design inputs:** no `child_process`, no `eval`, no dynamic
  imports, a 10 MB bundle, 128 MB of memory, about 6 concurrent outbound connections,
  15-minute alarms, and in-memory state that is lost on hibernation.
- **Presets are shortcuts, not modes.** Never branch behavior on which preset was used.

## Git and docs

- Commit messages follow `<area>: <imperative summary>`. Areas: `core`, `adapter`, `cli`,
  `component/<name>`, `spec`, `docs`.
- A change that adds a component, changes a contract or fixes user-visible behavior gets a
  line in `CHANGELOG.md` (created at M1).
- Do not commit generated user-project files (`pikit.json`, `src/pikit/**`) from samples
  unless the sample is intentionally a fixture.

## Reference material

Local Pi installation for API lookups (versions drift; check `package.json`):

- `~/.bun/install/global/node_modules/@earendil-works/pi-agent-core/dist/harness/`:
  `AgentHarness`, `ExecutionEnv`, `SessionStorage`, `SessionRepo`, records, conformance.
- `~/.bun/install/global/node_modules/@earendil-works/coding-agent/docs/extensions.md`: the
  extension model pikit mirrors at harness level. Read-only reference; never import it.
- `~/.bun/install/global/node_modules/@earendil-works/pi-protocol/README.md` and
  `pi-client/README.md`: transport-neutral remote sessions.
- Cloudflare: Durable Objects (SQL storage, alarms, hibernation), Workers Node
  compatibility, Workflows, Containers. Re-verify limits against current docs before
  relying on a number.

### Flue: a guide, not a source

Flue (`withastro/flue`, Apache-2.0) is the closest project.

- **Read, don't copy, its runtime.** `@flue/runtime` carries its own session model; pikit
  delegates sessions to Pi.
- **Worth reading** (`gh api repos/withastro/flue/contents/<path>?ref=v1.0.0-beta.9 --jq
  .content | base64 -d`):
  - `packages/runtime/src/agent-definition.ts`
  - `packages/runtime/src/adapter.ts` and `adapter-helpers.ts`
  - `packages/runtime/src/cloudflare/agent-coordinator.ts` (the best reference for M4)
  - `packages/runtime/src/test-utils/`
- **Copying is allowed only for small, contract-level code**, with its Apache-2.0 header and
  a line in `NOTICE`.
- **Channel blueprints** (`blueprints/channel--*.md` on `main`) are the reference for
  `channel-*` components. Depending on `@flue/<provider>` for protocol/crypto is allowed by
  rule 12.
- **Do not converge on its model** (rule 8). Borrow ideas, credit them in the changelog, and
  express them the pikit way.

### OpenClaw: the product pikit is an alternative to

`openclaw/openclaw` is the reference for what a production harness must survive. Read it
with `gh api repos/openclaw/openclaw/contents/<path>`.

- `docs/plugins/sdk-channel-plugins/durable-ingress.md`: ack-after-append, claim/commit
  dedup, tombstone retention by transport class.
- `src/plugin-sdk/persistent-dedupe.ts`

Take its operational lessons; do not take its plugin model.

### Downloaded packages and docs

Add an entry here when you fetch something for context.

- _(none yet)_

## Lessons

Record here anything that went wrong twice, or that the user explicitly said not to do.

- `coding-agent` is never a dependency: it is 19 MB, has 105 files importing `node:*`, uses
  `jiti` for dynamic extension loading, and has its own `SessionManager`. Its tool factories
  take `cwd` + `operations`, not `ExecutionEnv`, so tools are pikit source over
  `ExecutionEnv`.
- Pi's session conformance is `createSessionRepoConformance` + `createStorageConformance`
  under `harness/session/testing`. `createSessionBackendConformance` does not exist.
- The docs use `§`, `→` and `—`. When editing them with the edit tool, write these characters
  literally in both `oldText` and `newText`: `\uXXXX` escapes are written into the file as
  literal text or fail to match. An edit batch is atomic, so one bad entry discards all the
  others.
