# Health and degradation

**Public appeal:** —

**Specified:** yes: the contract, its suite and a first provider are built (below); what is still
open is listed at the end. The former SPEC §16's text is kept at the bottom.

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

## Decisions
- **The contract** is `health` in `@pikit/contracts` (`packages/contracts/src/health.ts`), a single
  capability: `reporter(name)` gives `up()`, `degraded(reason)`, `down(reason)`; `snapshot()` gives
  `{ status, components: [{ name, status, reason?, since, essential }] }`, JSON, sorted by name.
  A component's state is its last report; `since` (epoch ms on the App's clock) moves only when its
  status changes; a component that never reported is not listed (absence is not failure).
  Reporting never throws or waits. A reason is short operator text: never a secret, a token or
  message text.
- **The policy is in the contract, applied by the provider:** a component degraded, or a
  non-essential one down, makes the App `degraded`; an essential one down for at least the grace
  makes it `down`; down for less counts as `degraded`, so a blip restarts nothing (no flapping).
- **Where "essential" is declared:** in health-registry's config (`essential: string[]`, default
  `[]`), per deployment, as the moved text leaned. Names are matched exactly: a component's name, or
  `<name>:<part>` for a part that fails on its own (channel-telegram's second bot,
  `channel-telegram:ops`).
- **The grace** is health-registry's `graceMs`, 30 s by default: past one or two failed retries of
  a poller, short of a supervisor's patience.
- **The suite** is `createHealthConformance` (`@pikit/contracts/testing`), on a manual clock: the
  listing, last report wins, `since`, the policy, the grace to the millisecond and its restart, the
  snapshot as a JSON copy. Its own test shows it catches a provider without a grace.
- **The provider** is `health-registry` (kind `health`, targets `server` and `durable`), in memory:
  health is the process's, and after a restart every component reports again.
- **`/health`** (server-bun) answers `{ status }`: `200` `up` or `degraded`, `503` `down`; `200`
  `up` without a provider. Only the status: which component and why are the admin API's, behind
  `admin.auth`.
- **The first reporter** is channel-telegram: each bot is `up` once started and after each poll that
  answered, `degraded` after a failed one, `down` after 5 in a row (`DOWN_AFTER_FAILURES`), with
  Telegram's code as the reason.
- **No event** (`health.changed`): readers poll `snapshot()`, which is the truth (K3).

## Open questions
- **What "the supervisor restarts" means per deployment.** systemd and Kubernetes restart on a
  failed probe when told to; Docker Compose only marks the container `unhealthy`
  (deployment-docker's healthcheck), and restarts nothing without an autoheal companion or a
  restart from `pikit status`. Cloudflare has no process to restart: each object's App has its own
  health-registry, and nothing reads it yet.
- **More reporters.** Only channel-telegram reports. Candidates: outbound-durable (deliveries
  failing), a webhook channel's last set, tool-mcp's connections, runtime-pi's storage.
- **A `health.changed` event**, if the dashboard's live view needs one (a notice, never the truth).
- **What a component reports while it stops**, and whether a stopped component leaves the list.
- **Self-improvement** (SPEC §6) reads it after a deploy: how long it waits, and on what status it
  rolls back.

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
