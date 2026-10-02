# Kit follow-ups

Work on the kit itself that is not a feature: nothing a user installs, but something pikit owes
itself. Features have their own files ([README](README.md)); no file tracks status, so an item
leaves this list when its change lands (and the CHANGELOG says so). Each item says why, when and
how big.

## Move the adapter to Pi's durable runtime (spike)
- **Why:** P1. `pi-durable` carries sessions, submissions and resume; once the adapter runs on it,
  `sessions-sql`, `@pikit/pi-adapter/sql` and part of `submissions-sql` go
  ([pi-durable migration](pi-durable-migration.md)).
- **When:** deferred by the owner until Pi ships handoff packages 16–18 (tool turns, the
  busy-conversation inbox, owned runs). Re-check `pico-v5-handoff.md` and `pi-durable` on each Pi
  bump; 0.99.0 has 1–15.
- **Size:** the spike is bounded (a message in, tool calls and an answer out, a busy conversation,
  owned runs); the migration after it is large and removes code.

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
    that Pi derives loses its signal; `toPi()` in `packages/pi-adapter/src/context.ts` re-attaches it.
    Proposed fix: `ContextValue.abortSignal` returns its own value when it holds the abort key, and
    `parent.abortSignal` otherwise. With it, pikit deletes `toPi()`.
  - *When:* once the owner decides to send it.
  - *Size:* a few lines upstream, and a test; then a small deletion in the adapter.

## Chord: through the adapter and components, never in `@pikit/core`
- **Decided:** Chord does not enter the kernel. The kernel's only runtime dependency is `typebox`
  (SPEC §3); `Context` is pikit's own and frozen (K5), matching Chord's shape and bridged by the
  adapter; Chord is 0.x and moves with Pi (0.99.1 here); and it depends on `esbuild`.
- **Candidates**, each through the adapter or a component, when its feature is built:
  - the dashboard's live state (SPEC §5): Chord's `replicatedState` and `delta`;
  - [health](health.md): Chord's availability semantics (stable handles, `unavailable` /
    `replaced`, `ready()`).
- **Size:** none now; each candidate is weighed with its feature.

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
