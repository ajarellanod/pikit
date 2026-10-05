# Kit follow-ups

Work on the kit itself that is not a feature: nothing a user installs, but something pikit owes
itself. Features have their own files ([README](README.md)); no file tracks status, so an item
leaves this list when its change lands (and the CHANGELOG says so). Each item says why, when and
how big.

## Upstream proposals for pi-durable (pending the owner's decision to send)
Every gap pikit works around in Pi's packages (pi-durable, Chord, pi-mcp, pi-ai), with problem,
evidence, workaround, ask, priority and status, is listed in
[`docs/upstream/README.md`](../docs/upstream/README.md) so that none is lost; the longer ones have
their own file there. Each one Pi ships removes a workaround in the adapter or a limit of the kit.
- **Size:** small to write; each is sent when the owner decides.

## Publish the kit to npm; then upgrade the deployed bot
- **Why:** generated projects get the kit as tarballs vendored from a commit (`vendor/*.tgz`,
  `pikit.json`'s `kit.commit`), so a project's dependencies are pinned to source text from this
  repository's commits. Published `@pikit/*` packages make them ordinary versioned dependencies.
- **The deployed bot** (`pikit-telegram-cloudflare`, the first preset's template) is upgraded to
  the pi-durable kit, and its code improved, once everything is on npm, not from commits.
- **When:** now that the kit runs on pi-durable (the switch-over is done:
  [pi-durable migration](pi-durable-migration.md)).
- **Size:** medium: package publishing, `pikit new`/`upgrade` resolving versions instead of commits.

## Dashboard and deployment stay open
- **Decided:** the operator dashboard is a project's choice (`pikit new --ui`, `pikit ui on|off`), a
  shadcn/ui project of its own in `src/dashboard/` over a component, `admin-api` (SPEC §5), designed
  for every host: `admin-api`'s `http.route` handlers, server-sent events, no host API; deployment is never
  closed to server and Cloudflare (Vercel, E2B, exe.dev, Modal are expected), see
  [deployment targets](deployment-targets.md).
- **A base UI with shadcn/ui, extensible by components.** Not the largest interface: enough to
  start, and every other view comes from a component that brings it (SPEC §5). No platform
  under pikit (Pi Durable, Cloudflare, Rivet) offers an interface that is the user's to extend.
- **Pi first, watched:** Pi's `pi-server` (experimental: clients attached to durable sessions, a Unix
  socket and CBOR, authentication left to the application) is the closest thing Pi has to the admin
  API's live part. When it reaches a browser (an HTTP or WebSocket transport) with authentication,
  admin-api's events and actions move onto it and pikit's own transport goes. The coding agent's RPC
  mode is for one process over stdio; its event vocabulary is the one `agent.observe` forwards.
- **When:** in phases, each one usable. The first two have landed (CHANGELOG): `admin-api`,
  `src/dashboard/` (`registry/dashboard/`) and `pikit new --ui` / `pikit ui on|off` on a server, with
  the conversations, one live, steer, abort and reset, cost and the composition. Next:
  2. Landed too: pikit's UI pieces and views as shadcn items (`@pikit`), components with a view
     through `pikit add`, the `pikit-view` skill, and the Health (`health-registry`) and Delivery views.
  3. Cloudflare: a conversation's object read and watched from the Worker, and
     [the index](cloudflare-conversation-index.md) to list them all.
  4. The agent changing its own UI, through SPEC §6's gate.

## Building on the bases must be the easy path
- **Why:** pikit gives the bases and the user builds their assistant on them (SPEC P1, MANIFESTO
  principle 13). That only holds if a person or their AI agent can build a component that comes
  out right: [building components](building-components.md).
- **What:** skills for AI agents in every project (write a channel, a tool, a store, a dashboard
  view, a feature from its design note); a conformance suite for every contract (the execution
  environment and the tool shape still lack one in `@pikit/contracts`); each ⭐ feature note as a
  build guide (contract, Pi pieces, guarantees, tests); Git registries to share what users build.
- **Where it stands:** two skills, `pikit-component` and `pikit-extension` (`.agents/skills/`), are
  written and `pikit new` copies them into every project; `extension-house-rules` is the reference
  agent extension; [memory](memory.md) is the first ⭐ note written as a build guide; the contracts
  still without a suite are listed in [building components](building-components.md).
- **When:** the other skills with what they teach (adding a view with the dashboard).

## Upstream contributions (pending the owner's decision)
- **Chord's context loses a foreign parent's `abortSignal`.**
  - *Why:* Chord's `withContextValue` reads cancellation through a private key, so a pikit context
    that Pi derives loses its signal; `toChord` in `packages/pi-adapter/src/context.ts` re-attaches it
    (Chord 1.0 still has the gap).
    Proposed fix: `ContextValue.abortSignal` returns its own value when it holds the abort key, and
    `parent.abortSignal` otherwise. With it, pikit deletes the bridge.
  - *When:* once the owner decides to send it.
  - *Size:* a few lines upstream, and a test; then a small deletion in the adapter.

## Chord: through the adapter and components, never in `@pikit/core`
- **Decided (re-checked against Chord 1.0):** `@pikit/core` stays, and Chord does not enter the
  kernel. The kernel's only runtime dependency is `typebox` (SPEC §3); `Context` is pikit's own and
  frozen (K5), matching Chord's shape and bridged by the adapter (`toChord`).
- **Why, with Chord 1.0:** portability is no longer the objection (it runs in Bun and in bare
  workerd). What remains:
  - its 1.0 is 1.0 in name, not stable: it comes from Pi's lockstep versioning, and Chord's
    `PLANNING.md` says it is not a stable public contract, while the kernel promises 1.x (K8, P7);
  - `esbuild` is still a hard dependency, though only its `./bundler` subpath uses it;
  - `withContextValue` still drops a foreign parent's `abortSignal` (below, "Upstream
    contributions"), which pikit bridges;
  - its facades pay off only with hot reload or remote services, which pikit does not do (below);
  - it lacks what pikit's kernel provides: typed events, pipelines with priority and halt, optional
    dependencies, provider selection, keyed lookup, cancellable start/stop with deadlines and
    rollback, `describe()`, and per-component config validation.
- **Keep:** aligning `Context` with Chord's shape.
- **Candidates**, each through the adapter or a component, when its feature is built:
  - the operator UI's live state (SPEC §5): pi-durable's `watch()`/`taskGraph()`, and Chord's
    `replicatedState` and `delta` for the rest (health);
  - [health](health.md): Chord's availability semantics (stable handles, `unavailable` /
    `replaced`, `ready()`).
- **Open:** the `abortSignal` fix upstream; `esbuild` as an optional peer of Chord; Chord's semver.
- **Size:** none now; each candidate is weighed with its feature.

## No code hot reload
- **Decided:** a reload is a restart. pi-durable checkpoints every step, so a restart loses nothing
  (K6). Code hot reload could never be cross-target (Workers forbid `eval` and `new Function`), and
  it contradicts "nothing is loaded dynamically in production" (MANIFESTO) and "the agent never edits
  what runs" (SPEC §6).
- **Yes to:**
  - a fast restart in development: `pikit dev` with watch, and a test that a restart mid-turn loses
    no message;
  - behaviour changes as data, applied live: per-conversation `configure()`, settings read through
    live getters, skills and memory as documents or files (editable later from the operator UI);
  - deploys that lose nothing.
- **Revisit** only for a marketplace of third-party plugins installed live, which is not pikit's
  model.
- **Size:** the restart test is small; the rest comes with the features that use it.

## Leftovers of the § reference pass
- **The properties lost their checks.** SPEC §2's table named, for each property, the standard in
  the former ROADMAP that enforced it (S1–S16, M3, M4, track S). ROADMAP is gone, so the column
  went. Whether each property should name its check again (`scripts/boundaries.test.ts`,
  `registry validate`, the removal test…) is open. *Size:* small, but it is a SPEC decision.
- **References outside the docs pass.** About 380 references to sections of the former SPEC (and to
  `SPEC-CORE.md`, `ROADMAP.md`, `AGENTS.md`) remain in code comments and READMEs: `registry/`
  (component READMEs, schemas, presets), `packages/cli`, `packages/pi-adapter` (besides `state.ts`),
  `packages/core`, `samples/http`, `scripts/`, `IDEA.md` and `installer/README.md`. They need the same
  mapping (current decision, contract file, or no number). *Size:* medium, mechanical, one package
  at a time.
- **CHANGELOG's older entries** cite the former SPEC's sections as they were when written; they are
  history and stay.
