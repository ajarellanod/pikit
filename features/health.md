# Health and degradation

**Public appeal:** —

**Specified:** partly (moved from the former SPEC §16)

**Needed by:** the dashboard (it shows what is up, degraded or failing, SPEC §5) and
self-improvement (a deploy rolls back when health fails, SPEC §6). Health stays out of the kernel
(SPEC §3.2), so it is this component.

## What it gives
A component that breaks after `start` (a stuck poller, a dead connection) becomes visible, and the
process is restarted when what broke is essential.

## How it fits pikit
- A `health` capability and a `health-registry` component (the kind `health` is new: a naming
  decision). Components report through `useOptional("health")`, so its absence changes nothing.
- The registry owns the policy: degrade what can be tolerated, fail `/health` for what is essential
  so that the supervisor restarts the process (`server-bun`'s `/health` and `/ready`).
- The dashboard reads it through the admin API (SPEC §5); self-improvement reads it after a deploy
  (SPEC §6).
- A conformance suite proves a component reports its failures.

## Pi first
Chord has the consumer half: stable handles, `unavailable` / `replaced`, calls that fail fast
without queueing, `ready()`. pikit follows its semantics so that the move to Pi's runtime
([pi-durable migration](pi-durable-migration.md)) does not leave two models. A model provider's
outage is not a component failure: Pi retries model calls itself (`RetryPolicy`).

## Open questions
Listed in the moved text: grace periods against flapping, where "essential" is declared, and the
suite.

## Moved from the former SPEC
The former SPEC §16, "Open questions":

- Runtime availability and degradation: how a component that breaks after `start` (a stuck
  poller, a dead connection) becomes visible, and who decides between degrading and
  restarting. Today `/ready` reflects only the start, so a broken process looks healthy
  and no supervisor restarts it (§9.1). Chord has the consumer half (stable handles,
  `unavailable`/`replaced`, calls fail fast without queueing, `ready()`) but no
  self-report, no notion of essential, and no policy. Current lean: a `health` capability
  and a `health-registry` component, not core. Components report through
  `useOptional("health")`, so absence changes nothing. The registry owns the policy: degrade
  what can be tolerated, fail `/health` for what is essential so that the supervisor
  restarts the process. It follows Chord's availability semantics so that §6.4 does not end
  up with two models. It is decided with M2's real components, not before. To settle: grace
  periods against flapping, where "essential" is declared (per deployment, so config), and a
  conformance suite that proves a component reports its failures.
