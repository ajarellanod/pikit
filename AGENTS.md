# pikit — Agent Guide

How to work on this repository. Read it before touching code.

## What this project is

**Pi is the agent. pikit is the kit.** As its name says, pikit is a kit for Pi: everything Pi
needs to run as a robust, multi-agent service in the cloud, and nothing Pi already does. It
is the moldable alternative to OpenClaw and Hermes. It is not a second agent and does not
compete with Pi, Claude Code or Codex.

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

## Rule zero: Pi first

This rule comes before every other rule in this file. **Before building any agent-facing
feature, verify whether Pi already does it.** Agent-facing means anything about how the agent
thinks, queues, remembers, retries, calls tools, compacts, resumes or is configured per turn.

1. **Look in Pi first, including the upstream repo.** Read the installed `pi-agent-core`
   (`dist/harness/`: `agent-harness.d.ts`, `session/types.d.ts`, `runtime/`, `types.d.ts`)
   and `pi-ai`, **and always check `earendil-works/pi` on GitHub**. pikit depends on Pi so
   heavily that the idea itself rests on it. The installed package shows what Pi does today;
   the repo shows what Pi is about to do. See "Always check the Pi repo" below.
2. **If Pi does it, use it through the adapter.** pikit builds nothing.
3. **If Pi does it partially, wrap it in the adapter** and take the gap upstream. Do not fork
   the behavior.
4. **Build it in pikit only when one Pi process cannot provide it for itself:** channels,
   ingress, routing between agents, conversation ownership across processes, durable
   delivery, deduplication, scheduling, approvals surfaces, deployment.
5. **Write the check down.** The SPEC section of the feature names the Pi API it uses, or
   says why Pi cannot provide it. SPEC §6.2 keeps the table of what Pi does and what pikit
   adds.
6. **When Pi ships something pikit built,** delete pikit's version.

An example of the rule working: Pi already has steering, follow-up and next-run queues,
persisted as the session inbox. pikit therefore has no message queue of its own. A message
that reaches a busy conversation is handed to Pi as `steer`.

Pi first also covers **what Pi is building**. Pi's durable runtime (SPEC §6.4) will provide
submissions with `requestId` deduplication, durable tasks and documents. pikit builds none of
these: it shapes its contracts to match them and bridges the gap inside the adapter.

If you are about to write a loop, a queue of agent messages, a retry policy for model calls,
a compaction strategy, a tool scheduler or a session format: stop and read Pi.

### Always check the Pi repo

`earendil-works/pi` is pikit's upstream in every sense: the agent, its session model, its
durable runtime and its composition runtime all live there, and they move weekly. Check it
before designing any contract, before starting a milestone, and before writing adapter
code:

```bash
gh api 'repos/earendil-works/pi/commits?per_page=20' --jq '.[] | .commit.author.date[:10] + " " + (.commit.message|split("\n")[0])'
gh pr list -R earendil-works/pi --limit 20
gh api repos/earendil-works/pi/contents/<path> --jq .content | base64 -d
```

What to look at:

| Package | Why it matters to pikit |
|---|---|
| `packages/agent` | `AgentHarness`, sessions, queues, resume: what the adapter wraps today |
| `packages/durable` | Pi's durable runtime ("Pico5"): submissions, tasks, documents. The adapter's target (SPEC §6.4) |
| `packages/chord` | Composition runtime, `Context`, keyed services. The design closest to `@pikit/core` |
| `packages/server`, `protocol`, `client` | Routing sessions to workers and remote sessions: overlaps with actors and workers |
| `packages/ai` | Providers and models. Always imported by subpath |

When the repo changes something pikit relies on or plans:
- update SPEC §6.2 (what Pi does versus what pikit adds) and §6.4 (alignment);
- delete any pikit piece Pi now provides;
- record the Pi commit or version you checked against.

Never design from memory of Pi's API; its API changes faster than this document.

## Stack

- TypeScript, ESM only. Bun >= 1.4.0 for development and tests (enforced by
  `scripts/require-bun.ts` through `bunfig.toml`, because Bun ignores `engines`). Node ≥ 22 must also work for the
  server target. The Cloudflare target is built with Wrangler.
- `typebox` for schemas (the same library Pi uses). No zod.
- A YAML 1.2 parser. Do not use `Bun.YAML`: it implements YAML 1.1, where `off` and `on`
  become booleans.
- Pi: `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, pinned to exactly **0.87.1**
  (0.87.x is the supported line; a bump is deliberate, SPEC §6.4). `typebox` follows Pi's exact
  version. Later come `pi-protocol` and `pi-client`. From 0.87, `pi-agent-core` depends on
  `@earendil-works/chord` (the harness `Context` is Chord's); only the adapter sees it. Pi's
  durable runtime (`@earendil-works/pi-durable`) is the target the adapter moves to
  (SPEC §6.4). `pi-coding-agent` is never a dependency. It is only invoked
  as the external `pi` binary by the CLI. A `package.json` entry named
  `@earendil-works/pi-coding-agent` is an alias of `@pikit/pi-extension-shim` (SPEC §6.2b),
  never the real coding agent.
- Checks: `bun test` and `bun run typecheck` (`tsc --noEmit`, TypeScript 7, strict,
  `exactOptionalPropertyTypes`). Conformance suites live in `@pikit/core/testing`.

## The rules

These are not style preferences. A change that breaks one is wrong even if it works. Each
rule maps to a standard in `ROADMAP.md` (S1–S16), which says how the rule is checked.

1. **Pi first, and Pi only through the adapter** (S1). Rule zero applies.
   `@pikit/pi-adapter` is the only package that imports `@earendil-works/pi-*`. It exposes pikit-shaped types, and components import Pi
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
   types, and depends on a capability with `pikit.use("capability")`. It never imports
   another component's files. Events are notifications, pipelines transform, and
   capabilities are services with one provider. Do not fake a service call with an event and a shared variable.
5. **Runtime neutral by default** (S5). No `node:*`, `bun:*` or `cloudflare:*` imports
   unless the component declares a single target. Other needs go through capabilities:
   - filesystem and shell through `execution`;
   - storage through `storage.sql` and `storage.blob`;
   - time through `clock`;
   - secrets through `secrets`.

   Anything that must survive a restart or an eviction is persisted through a capability,
   never kept in module state.
6. **`setup` registers; `start`/`stop` own resources** (S8). `setup` is synchronous. It calls
   `on`/`pipeline`/`provide`/`use` and returns `{ start, stop }` if the component owns sockets,
   files, connections or timers. A handle from `use()` is resolved with `get()` in `start` or
   later, never in `setup`. Registration is sealed when `setup` returns: never keep `pikit`
   around to register something later. Never acquire a resource in `setup` or in an event listener:
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
9. **Conversations are actors; processes are workers** (S11).
   - A conversation's state lives in records: registry, Pi session, workspace ref. A
     worker's memory is only a cache.
   - At most one worker has a conversation's session open. On a single-process server that
     is automatic; several replicas need `conversations.ownership`.
   - Messages that reach a busy conversation go to Pi's inbox as `steer` by default. An
     agent may choose `followUp` or `nextRun`. pikit never builds its own queue.
10. **Dynamic agents through `prepare(state)`**. Agents change tools, model, prompt and skills
   per turn by returning a `TurnConfig` from `defineAgent({ prepare(state, ctx) })`, with
   state kept in `agent.state`. A multi-step process is `state.phase` plus conditional tools,
   never a workflow DSL. `prepare` has no registration side effects.
11. **Values in config, behavior in code** (S7). A config key that selects between
    strategies means those strategies are components, and the key is a capability selector
    (`capabilities: { sessions.store: postgres }`).
12. **Contracts first** (S12). Write the interface and its conformance suite before the
    first implementation.
13. **Source ownership is real** (S13, S14). Copied code must be readable by someone who did
    not write it:
    - small files, explicit names, comments on the *why*;
    - tests inside `files/`;
    - no install scripts.

    Protocols and crypto are npm dependencies; behavior is copied source. `setup` is the
    manifest: `provides`/`requires` are derived from its `provide`/`use` calls, and
    `component.json` is generated from them, never edited by hand.
14. **Prove it by removing** (S3). When a component is finished, install it, run its
    scenario, remove it, run `pikit doctor`, and confirm that nothing else changed.
15. **Stable on purpose** (S16). If two designs are equivalent, pick the one that will need
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
| Components | kebab-case, prefixed by kind | `channel-*`, `router-*`, `sessions-*`, `storage-*`, `workspace-*`, `execution-*`, `scheduler-*`, `deployment-*`, `tool-*`, `policy-*`, `admin-*`, `inbound-*`, `log-*`, `conversations-*`, `credentials-*`, `provider-*`, `runtime-*`, `secrets-*`, `server-*`. `bun run registry validate` enforces the list (`KINDS` in `packages/cli/src/registry/checks.ts`) |
| Reserved component names | never used | `capabilities` (it is a core config key) |
| Capabilities | `dotted.lowercase`; keyed ones take a key per implementation | `sessions.store`, `execution.shell`, `channel.transport` (key `telegram`) |
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

- **Core:** event ordering, pipeline priority and `halt`, capability resolution and
  selection, composition errors before setup, lifecycle order and rollback, config
  merge/validation.
- **Every contract implementation** passes its pikit conformance suite: `storage.sql`,
  `storage.blob`, `workspace`, `execution`, `channel.transport`, `inbound.dedup`,
  `outbound.queue`, `scheduler`.
- **Session stores** also pass Pi's `createSessionRepoConformance()` and
  `createStorageConformance()` (from `pi-agent-core/harness/session/testing`).
- **Every component that owns resources** has a start-failure test and passes
  `createLifecycleConformance` (it honours `ctx.abortSignal` and leaves nothing open).
- **Components targeting `cloudflare`** are tested under Miniflare or `wrangler dev`.
- **Timezones:** never mutate `process.env.TZ` in a test; spawn a subprocess instead. Do not
  rely on `bun test` forcing UTC; run TZ-sensitive parsing under `bun run` too.

## Things that are easy to get wrong

- **Pi is single-process by contract.** Pi serializes writes and opens a session exclusively
  inside one process, and calls a second process "unsupported". Conversation ownership
  exists to keep that true across processes.
- **`steer` waits for the tools.** A steered message enters after every tool call of the
  current turn finishes, before the next model call. Stopping at once is `abort()`.
- **One pikit conversation is one Pi session.** A Pi session is the single-writer unit. The
  "conversations" inside a Pi session are Pi's transcript scopes: the root one, forks and
  subagents. Do not map a pikit conversation to a Pi conversation.
- **A context crossing into Pi needs the bridge.** pikit's `Context` has Chord's shape, but
  Chord's `withContextValue` drops a foreign context's cancellation. The adapter wraps it once
  with Chord's `withAbortSignal` (SPEC §6.2). A context coming from Pi needs nothing.
- **Two kinds of deduplication.** Transport deduplication (platform delivery id and ack) is
  `inbound-dedup`. Logical deduplication ("was this message answered?") is Pi's submission
  `requestId`.
- **"Ownership" has two meanings.** Source ownership (the user owns the code) and
  conversation ownership (one worker has a session open). Always write "conversation
  ownership" for the second.
- **Session ≠ workspace.** The transcript says a file was edited; it is not the file.
- **Eviction ≠ reset.** Dropping an `AgentHarness` from memory never deletes the conversation →
  session pointer. Only an explicit reset repoints it.
- **Events cannot fail the app.** A listener's error is logged and swallowed. If
  something must succeed, it belongs in `start`.
- **Selection shapes dependency order.** A consumer depends only on the provider `get()`
  will return: the selected one when there are several.
- **Transports are keyed.** `channel.transport` is a keyed capability: each channel provides it
  under its own key (`provideKeyed`), and delivery looks it up per message with
  `useKeyed(...).get(message.channel)`.
- **Optional capabilities are declared.** A component that can work without a capability
  declares it with `useOptional(name)`, so that its provider starts first when present, and
  asks `get() !== undefined`. There is no `ctx.has()`: an undeclared question is an undeclared
  dependency. It is a verb, not a `{ optional }` option: a boolean could be wired to config,
  which is a flag.
- **Deduplication belongs to the channel.** The delivery id and the ack rule are
  platform-specific; `inbound-dedup` holds claims, and the core holds nothing.
- **Cloudflare limits are design inputs:** no `child_process`, no `eval`, no dynamic
  imports, a 10 MB bundle, 128 MB of memory, about 6 concurrent outbound connections,
  15-minute alarms, and in-memory state that is lost on hibernation.
- **Presets are shortcuts, not modes.** Never branch behavior on which preset was used.

## Git and docs

- Commit messages follow `<area>: <imperative summary>`. Areas: `core`, `adapter`, `cli`,
  `component/<name>`, `registry` (manifests, `registry.json`, presets, `scripts/registry*`, `packages/cli/src/registry/`),
  `samples`, `spec`, `docs`.
- A change that adds a component, changes a contract or fixes user-visible behavior gets a
  line in `CHANGELOG.md` (created at M1).
- Do not commit generated user-project files (`pikit.json`, `src/pikit/**`) from samples
  unless the sample is intentionally a fixture.

## Reference material

Local Pi installation for API lookups (versions drift; check `package.json`):

- `~/.bun/install/global/node_modules/@earendil-works/pi-agent-core/dist/harness/`:
  `AgentHarness`, `ExecutionEnv`, `SessionStorage`, `SessionRepo`, records, conformance.
  The pin is exactly 0.87.1. Prefer the project's own copy under
  `packages/pi-adapter/node_modules/@earendil-works/`: the global install can differ (its
  top-level `pi-ai` is 0.80.10).
  - Queues: `agent-harness.d.ts` (`steer`, `followUp`, `nextRun`, `steeringMode`,
    `followUpMode`), `session/types.d.ts` (`LaneState.inbox`), and `runtime/lane.js` (drain
    rules).
  - Queue semantics: `../types.d.ts` (`getSteeringMessages`, `getFollowUpMessages`).
  - Single-process precondition: `pico3/types.d.ts`, `session/mutation-line.d.ts`.
- `mini`, Pi's experimental session-worker host
  (`packages/coding-agent/src/experimental/mini`): the reference for `@pikit/pi-adapter`.
  - `worker/run.ts`: opens a session (`JsonlSessionRepo`, `NodeExecutionEnv` from
    `pi-agent-core/node`), builds the `AgentHarness`, and resumes every open operation with
    `lane.resume(context)` after the previous worker died.
  - `README.md`: the topology. A server routes calls to one worker per session, kills the
    worker when nobody is attached, and a new worker resumes.

  Read it for how Pi drives its own harness from a host. Do not copy its RPC or its TUI.
- Pi's durable runtime ("Pico5"), in the Pi monorepo (`gh api
  repos/earendil-works/pi/contents/<path> --jq .content | base64 -d`):
  - `packages/durable/docs/pico-v5.md`, the normative spec. Read §4 (transactions), §5
    (tasks), §6 (submissions and inbox), §12 (footguns).
  - `packages/durable/docs/pico-v5-handoff.md` for implementation status.
- Chord (`packages/chord/README.md`, `PLANNING.md`): Pi's composition runtime. Its plugin host
  (sync setup, singleton and keyed services, ordered activation, reverse disposal) is the
  closest design to `@pikit/core`. Align with its semantics; do not depend on it from core
  without a decision.
- `~/.bun/install/global/node_modules/@earendil-works/coding-agent/docs/extensions.md`: the
  extension model pikit mirrors at app level. Read-only reference; never import it.
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
  rule 13.
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

- `packages/pi-adapter/src/extensions/pi-examples/`: Pi 0.87.1's `permission-gate.ts`,
  `protected-paths.ts` and `hello.ts` example extensions, byte for byte (scenario 7). Refresh
  them from the tag when Pi is bumped; attribution in `NOTICE`.

## Lessons

Record here anything that went wrong twice, or that the user explicitly said not to do.

- `coding-agent` is never a dependency: it is 19 MB, has 105 files importing `node:*`, uses
  `jiti` for dynamic extension loading, and has its own `SessionManager`. Its tool factories
  take `cwd` + `operations`, not `ExecutionEnv`. Tools come from `pi-agent-core` instead: from
  0.87.1 it ships `read` / `write` / `edit` / `bash` over `ExecutionEnv` (SPEC §6.3). Check
  Pi's current exports before writing a tool.
- Pi's session conformance is `createSessionRepoConformance` + `createStorageConformance`
  under `harness/session/testing`. `createSessionBackendConformance` does not exist.
- The docs use `§`, `→`, `—` and box-drawing characters. The edit tool keeps writing
  `\uXXXX` escapes as literal text, or fails to match with them, and this has happened
  repeatedly. For doc edits that contain these characters, use a Python heredoc with
  `str.replace` and an `assert count == 1`, then scan for `\\u[0-9a-f]{4}`. An edit batch is
  atomic, so one bad entry discards all the others.
- Bun < 1.4.0 cancels an `AbortSignal.timeout()` for good when its abort-listener count drops
  from one to zero (`removeEventListener`, `onabort = null`): it never fires and `aborted`
  stays `false`. Node and Bun >= 1.4.0 are correct (fixed by oven-sh/bun#37666), so pikit
  requires Bun >= 1.4.0 and `bounded()` in `lifecycle.ts` removes its listener normally. If a
  deadline test hangs, check `bun --revision` first. Before reporting a runtime bug upstream,
  reproduce it on the latest release (download it to `/tmp`, do not upgrade the global
  install) and search merged PRs, not only issues.
- Bun's `expect(actual).toBe(expected)` is typed from `actual`, so it fails `tsc` when a test
  asserts on a value typed by a narrowed annotation (a type-level test with `@ts-expect-error`).
  Assert on the original value instead, and keep the annotated variable only for the type check
  (`void variable`). This broke `typecheck` twice in `agent.test.ts`.
- TypeScript 7 loses the core tests' relative module augmentations (`declare module "./capabilities.ts"`
  in `app.test.ts`: 37 errors) when another workspace package resolves `@pikit/pi-adapter` through its
  own `node_modules`. It passed in a `/tmp` worktree and failed in the main checkout, so a typecheck in
  a worktree alone is not proof. Tooling that talks to a project's adapter (the CLI) describes the few
  calls it makes with local types and loads the adapter at run time; it does not import it.
- macOS has no `timeout` command. Bound a command that may hang with
  `perl -e 'alarm 60; exec @ARGV' <cmd>`, and give hanging tests `--timeout <ms>`.
