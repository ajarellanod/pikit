# Kit follow-ups

Work on the kit itself that is not a feature: nothing a user installs, but something pikit owes
itself. Features have their own files ([README](README.md)); no file tracks status, so an item
leaves this list when its change lands (and the CHANGELOG says so). Each item says why, when and
how big.

## Move the adapter to Pi's durable runtime (switch-over)
- **Why:** P1. Pi 1.0 removed the 0.99 `AgentHarness` pikit ran on; `pi-durable` carries
  conversations, submissions, resume, the inbox, compaction, tasks and subagents. Once the kit runs on
  it, `sessions.store`, `sessions-sql`, `sessions-jsonl` and `@pikit/pi-adapter/sql` go
  ([pi-durable migration](pi-durable-migration.md)).
- **When:** now. The spike held and the adapter's pieces are built beside the 0.99 code; the
  switch-over of the components is in progress.
- **Size:** large, and it removes code. The decisions it follows are in the migration file.

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
  the pi-durable kit, and its code improved, once everything is on npm, not from commits. Its
  conversations start fresh then (decided: no migration).
- **When:** after the pi-durable switch-over is merged.
- **Size:** medium: package publishing, `pikit new`/`upgrade` resolving versions instead of commits.

## Dashboard and deployment stay open
- **Decided:** the operator dashboard is a component (`admin-dashboard`, SPEC §5), designed for
  every host: its own `http.route` handlers, server-sent events, no host API; deployment is never
  closed to server and Cloudflare (Vercel, E2B, exe.dev, Modal are expected), see
  [deployment targets](deployment-targets.md).
- **When:** the dashboard is the next piece after the switch-over, in its minimal form:
  conversations, a live view of one, steer/abort, cost per conversation.

## Upstream contributions (pending the owner's decision)
- **pi-mcp's `StreamableHttpTransport` on Workers.**
  - *Why:* it stores `options.fetch ?? globalThis.fetch` and calls `this.fetch(...)`, which Workers
    reject ("Illegal invocation"); and its SSE parser measures events with `Buffer.byteLength`, a Node
    global that needs `nodejs_compat` ([mcp](completed/mcp.md), "On Cloudflare"). pikit wraps `fetch` in
    `mcpHttpTransport` (`packages/pi-adapter/src/mcp/index.ts`), and the workerd lane pins the gap.
  - *When:* once the owner decides to send it.
  - *Size:* a small upstream patch for each; then `mcpHttpTransport`'s wrapper goes.
- **Chord's context loses a foreign parent's `abortSignal`.**
  - *Why:* Chord's `withContextValue` reads cancellation through a private key, so a pikit context
    that Pi derives loses its signal; `toPi()` in `packages/pi-adapter/src/context.ts` re-attaches it
    (`toChord` in `durable/context.ts` for Chord 1.0, which still has the gap).
    Proposed fix: `ContextValue.abortSignal` returns its own value when it holds the abort key, and
    `parent.abortSignal` otherwise. With it, pikit deletes the bridge.
  - *When:* once the owner decides to send it.
  - *Size:* a few lines upstream, and a test; then a small deletion in the adapter.

## Chord: through the adapter and components, never in `@pikit/core`
- **Decided (re-checked against Chord 1.0):** `@pikit/core` stays, and Chord does not enter the
  kernel. The kernel's only runtime dependency is `typebox` (SPEC §3); `Context` is pikit's own and
  frozen (K5), matching Chord's shape and bridged by the adapter (`toChord`, `toPi()`).
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
