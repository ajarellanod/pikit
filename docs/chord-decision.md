# When pikit moves to Chord

**Decision: not now.** Last validated 2026-10-20, against Pi 1.3.0 (`@earendil-works/chord` 1.3.0):
G1 and G2 only. All gates last ran 2026-10-13 against 1.2.0, with the spike on branch
`spike/chord-core` (commit `2036e40`). Next validation: the next Pi pin bump
([upstream/README.md](upstream/README.md), "At each Pi pin bump", step 4).

"Moving to Chord" means replacing `@pikit/core` with Chord's host runtime: components written against
Chord (`defineFacet`, `host.serve`, contracts, registries, resources), or a kernel built over it.
This page says what must be true first, how to check each condition, and what every check found.

Not in question, allowed today: Chord **through the adapter**. pi-durable's `Context` (bridged by
`toChord`), `replicatedState` and pi-durable's watches for the dashboard's live state, and keeping
pikit's `Context` in Chord's shape (SPEC K5).

## When to validate

- At every Pi pin bump (`packages/pi-adapter/package.json`): gates G1 and G2 only read Chord's
  changelog and source, a few minutes.
- When Chord publishes a stability statement ([upstream proposal 10](upstream/README.md)): all gates.
- When a feature needs what only Chord gives (G6): all gates, and the spike again.

Record every validation in [History](#history), even when nothing changed.

## The gates

Move only when **every** gate passes. Each has a check anyone can run, and its result last time.
The commands assume the Pi checkout next to this one (`../pi`, AGENTS.md) and `<v>` the Pi version
being checked (`git -C ../pi fetch --tags` first).

| Gate | Passes when | 1.2.0 | 1.3.0 |
|---|---|---|---|
| G1 Stable API | Chord says which entry points follow semver, the kernel's among them, and no minor broke them | fail | fail |
| G2 One Chord | a context of another Chord keeps its cancellation, or the kit enforces one Chord | fail | fail |
| G3 Kernel guarantees | core's own suite passes over Chord without rebuilding core | fail (44/49) | not re-run |
| G4 Green everywhere | the repository and the workerd lane pass over Chord | fail (10 failures) | not re-run |
| G5 SPEC decision | SPEC lets the kernel import Pi | not taken | not re-run |
| G6 A reason | a feature needs what only Chord gives | none | not re-run |
| G7 Worth it | the kernel loses most of its own code | 9 % | not re-run |

### G1. Stable API

*Why:* every component and every project would import Chord directly, while the kernel promises 1.x
(K8). Today only the adapter follows Pi's churn (SPEC 3.3).

*Passes when* Chord's README or docs state which entry points follow semver, the root host runtime
and `./context` are among them, and no release since the last validation broke them in a minor.

*Check:*

```bash
git -C ../pi show v<v>:packages/chord/README.md | rg -n -i 'semver|stable|experimental'
git -C ../pi show v<v>:packages/chord/docs/spec.md | rg -n -i 'semver|stable|experimental'
git -C ../pi show v<v>:packages/chord/CHANGELOG.md | rg -n '^## |Breaking'
```

*1.2.0: fail.* No stability statement. 1.2.0, a minor, replaced the whole runtime (`defineService`,
`createFacetHost` and the remote services removed). A kernel on 1.1's Chord would have been rewritten.

*1.3.0: fail.* No stability statement (the README has no match; `docs/spec.md`'s two are "stable
identity" and "stable readables"). 1.3.0, a minor, lists 17 breaking changes (`Handle` renamed `Ref`,
typed principals with `createHost({ self })` required, async `ctx.get` and `host.get`, state typed
`T`, link `PROTOCOL_VERSION` 4).

### G2. One Chord

*Why:* Chord keeps the abort signal under a private key of its own module. A context made by another
Chord (another version, or pikit's own) loses its cancellation when derived, **silently**: in the
spike, with the kernel on Chord 1.2 and pi-durable on 1.1, 18 runtime-pi cases hung until their
30 s timeout, with no error anywhere.

*Passes when* either Chord's derived contexts read the parent's `abortSignal` property (a foreign
context then keeps its signal), or the kit enforces that the kernel's Chord is exactly pi-durable's,
with a test that fails on any drift.

*Check:*

```bash
git -C ../pi show v<v>:packages/chord/src/context/index.ts | rg -n -A2 'get abortSignal'
```

Fails while it returns `this.value(ABORT_SIGNAL_CONTEXT_KEY)`. Over the spike, core's test "a foreign
context of the same shape keeps its cancellation when derived" must pass.

*1.2.0: fail.* Unchanged since 1.0 (pikit asked, declined: upstream #10189).

*1.3.0: fail.* Line 24 still returns `this.value(ABORT_SIGNAL_CONTEXT_KEY)`. 1.3.0 rejects a foreign
ctx on a remote call (`invalid/foreign_ctx`, #10959), which is not reading its signal.

### G3. Kernel guarantees without rebuilding them

*Why:* the point is to delete kernel code, not to rebuild it over Chord.

*Passes when* core's own suite passes over the Chord-backed kernel with core's `graph.ts`,
`lifecycle.ts` and `context.ts` deleted, and the native router-basic needs no hand-made load order.

*Check:* the spike, `bun test packages/core-chord` ([Re-running the spike](#re-running-the-spike)).

*1.2.0: fail, 44 of 49.* What Chord changes:

1. `describe()` cannot give the start order before starting: Chord decides it while activating.
2. A dependency cycle fails `start()`, not `create()` (Chord's `invalid/cycle`).
3. Independent components start and stop concurrently: list order is no longer the tiebreaker.
4. A foreign context loses its cancellation (G2).
5. In native Chord, "a keyed capability's providers start first" cannot be said: a registry is
   published only once its registering object is live, activations run concurrently, and a consumer
   cannot hold the providers of a registry. The native router-basic saw no agents at start.

Chord has no per-component config, optional dependencies, provider selection, typed events or
pipelines: those stay pikit's code whatever happens (core's `config.ts`, `capabilities.ts`,
`events.ts`, `pipeline.ts`).

### G4. Green everywhere

*Passes when* the whole repository and the workerd lane pass over the Chord-backed kernel, but for
failures a SPEC decision accepts (G5 and the changes of G3 that SPEC is changed to allow).

*Check:* the spike, `bun test` and `(cd tests/workerd && bunx vitest run)`.

*1.2.0: fail.* `bun test`: 2407 pass, 10 fail of 2446 (the original: all pass), 158.6 s against 160 s.
The 10: core's five (G3), server-bun's `/health` during a slow start (x2, list order), platform-
cloudflare's object Apps asserting the start order (x2, `describe()`), the boundary test (G5).
workerd: 324 of 324 pass. Typecheck: clean.

### G5. A SPEC decision

*Why:* SPEC 3.3 makes `@pikit/pi-adapter` the only package that imports Pi
(`scripts/boundaries.test.ts`); a Chord kernel imports Pi. K5 (`Context` is pikit's own) and K8 change
too.

*Passes when* SPEC is changed by a recorded decision, after G1 to G4 pass. Not a technical check.

*1.2.0: not taken.*

### G6. A reason

*Why:* Chord's strengths are objects across processes, hot reload, principals and replicated state to
browsers. pikit decided against code hot reload (features/kit-follow-ups.md, "No code hot reload").

*Passes when* a design note in `features/` needs one of them and pikit cannot get it more cheaply.
Not reasons: isolating conversations on `server` (an `actor.mailbox` / `actor.inbox` provider with
`scope: "one"` over child processes, no Chord needed); the dashboard's live state (Chord through the
adapter is allowed today); concurrent start (`lifecycle.ts` can do it).

*Check:* `rg -n -i 'chord|hot reload|replicated|worker process' features/*.md`, and read what it finds.

*1.2.0: none.*

### G7. Worth it

*Passes when* the kernel loses most of its own code, measured over the spike without tests:
`wc -l packages/core/src/{app,capabilities,clock,config,context,events,graph,index,lifecycle,logger,pipeline}.ts`
against `wc -l packages/core-chord/src/{app,capabilities,clock,config,context,events,index,logger,pipeline}.ts`.

*1.2.0: 1440 to 1315 lines (9 %).* The 889 lines Chord replaces (app, lifecycle, graph, context)
became 764 lines of glue.

## Re-running the spike

The branch `spike/chord-core` is local to the user's checkout (push it to keep it elsewhere). In it,
`packages/core-chord` is `@pikit/core` (the original is `@pikit/core-original`, and the CLI vendors
`core-chord`); `packages/core-chord/SPIKE.md` describes it, `spike/native/router-basic.ts` is the
native component.

```bash
git worktree add ../pikit-chord-spike spike/chord-core
cd ../pikit-chord-spike
git rebase main   # core changes since the spike: port them to packages/core-chord too
# packages/core-chord/package.json: "@earendil-works/chord" = pi-durable's exact version (G2),
# "chord-host" = "npm:@earendil-works/chord@<v>" (the host runtime being checked)
bun install
bun test packages/core-chord                     # G3
bun test                                         # G4
(cd tests/workerd && bunx vitest run)            # G4
bun run typecheck
```

`packages/core-chord` copies core's `capabilities.ts`, `config.ts`, `events.ts`, `pipeline.ts`,
`logger.ts`, `clock.ts`, its tests and `testing/`: a change to them in core since the spike is copied
before running. A new Chord API may let the spike drop glue: try it, it is what G3 and G7 measure.

## History

| Date | Pi / Chord | Decision | What changed |
|---|---|---|---|
| 2026-09 | 1.0.0 to 1.0.3 | not now | Chord stays out of the kernel: unstable API, `esbuild` a hard dependency, foreign `abortSignal` dropped (#10189 declined), no events, pipelines, optional dependencies, selection, `describe()` or config validation (features/kit-follow-ups.md, docs/architecture-audit.md). |
| 2026-10 | 1.1.0 | not now | Nothing changed but the version. Portability no longer an objection (Bun and bare workerd). |
| 2026-10-13 | 1.2.0 | not now | Runtime rewritten (typed host runtime). `esbuild` gone, only `typebox` 1.3.27 (the kernel's). Spike: Bun and workerd work; G1, G2, G3, G4, G5, G6 fail; G7 9 %. Found the silent two-Chords hang (G2) and the keyed-providers gap (G3.5). |
| 2026-10-20 | 1.3.0 | not now | G1 and G2 only, both fail: 17 breaking changes in a minor (typed principals, async `get`, protocol 4), no stability statement; `abortSignal` unchanged. Spike not re-run. |
