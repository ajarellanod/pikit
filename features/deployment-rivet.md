# Rivet deployment: the durable target on Rivet Actors

**Public appeal:** —

**Specified:** idea, researched 2026-10-19 against Rivet 2.3.27 (rivetkit 2.3.x, `rivet-dev/rivet`
at `aa8800b`). Not built, no spike yet. An alternative to
[deployment-celld](deployment-celld.md) for scaling out on your own machines.

**Needed by:** nothing required.

## What it gives
The `durable` runtime model (one actor per conversation, its own SQLite, evicted when idle, SPEC §4)
on [Rivet Actors](https://www.rivet.dev/actors/docs) (`rivet-dev/rivet`, Apache-2.0), self-hosted or
on Rivet Cloud. An actor is addressed by key, has a SQLite database (tiered to S3), schedules, and
sleeps after 30 s without activity. When a worker dies, its actors are rescheduled on another worker
with their state.

What it adds over celld:
- **Actors run in a Bun or Node process you run**, not in workerd. The Workers limits (30 s of CPU,
  50 subrequests per invocation, 128 MB per isolate) do not apply.
- **Subscription logins work.** pi-ai's OAuth flow loads in Bun (on Workers its dynamic import is
  not bundled), so a Claude or ChatGPT login only needs an owner actor, not an upstream fix.
- **Sandboxes as actors.** Rivet ships agentOS (WASM shell, git, node, python) as an actor type.
- **A more mature base.** 2.3 and in use since 2023; celld is a 0.6 beta.
- **A second, independent provider of `durable`.** celld implements Cloudflare's API, so it does not
  count as independent for contract stability (contract rule 8); Rivet would.

What it costs: Rivet does **not** implement the Durable Objects API. The code that runs unchanged on
Cloudflare and celld (`-do`, `-workers`) needs a host layer of its own (below).

## How it fits pikit
- A second provider of the existing `durable` model: a `deployment-rivet` component and the pieces
  named after the API they use, `-rivet` (as `-do` and `-workers` are), SPEC §4.
- **SPEC change, proposed first.** SPEC §4 defines `durable` as "one actor (a Durable Object) per
  conversation, with its own SQLite and one alarm", and C1, C4 talk about Durable Objects. A feature
  may not require changing SPEC §1–§6, so the wording is generalised before anything is built: an
  actor per conversation, its own SQLite, its timed work through `wakeups`; Durable Objects become
  one implementation. The required set (a Cloudflare provider for every capability) is unchanged:
  Rivet is optional.
- **A platform handle** `RIVET_HOST` in its own subpath `@pikit/contracts/rivet` (contract rule 2),
  as `WORKERS_HOST` is: on the actor's start context the actor's context (key, `db`, `schedule`,
  `keepAwake`), on the front App's the Rivet client and origin.

### The two Apps on Rivet
| Cloudflare | Rivet |
|---|---|
| Worker (stateless, routes) | **Front App**: a Bun HTTP process (one or more, stateless) serving `http.route`s and `/health`, calling actors through the Rivet client |
| `Conversation` Durable Object, `idFromName(key)` | A `conversation` actor, `getOrCreate([key])` |
| Composes the App in `blockConcurrencyWhile` (20 s) | Composes it in `onWake`; Rivet's gateway holds requests until `onWake` finished |
| RPC methods `deliver`, `call`, `stream`, `alarm` | Actions (`actionTimeout`, 60 s default) for `deliver`/`call`; `onRequest` streaming for `stream` (headers within 5 min); schedules for the alarm |
| One alarm, multiplexed by actors-do | `c.schedule.at` / `after`, several per actor |
| Evicted between events, no warning | Sleeps after `sleepTimeout` (30 s) idle; `onSleep` with a 15 s grace; moved on upgrades and worker loss |
| Object SQL (synchronous) | `c.db`, asynchronous, `c.db.transaction(cb)` |
| A `fetch` does not keep the object alive | A `fetch` is not activity either: a run is wrapped in `c.keepAwake(promise)` |

### Components to build
| Component | Provides | Replaces on Cloudflare | What it does |
|---|---|---|---|
| `deployment-rivet` | the deployment module, entrypoints | `deployment-cloudflare` | The worker entry (registry with the `conversation` actor composing the default export on wake, a guard schedule when the App cannot start), the front App's entry, `up`/`down`/`status`/`logs`/`dev`, `/health` with the version, rollout with rollback, compose templates (below) |
| `actors-rivet` | `actor.mailbox`, `actor.inbox` (`scope` `"one"` in an actor), `wakeups` | `actors-do` | `send`/`call` as actions on `getOrCreate([key])`, a local call for the actor's own key; `wakeups` as rows over `c.schedule`, each run under `keepAwake`, sliced with `driveSlice` (C4) so a move or upgrade mid-run loses nothing |
| `storage-rivet` | `storage.sql` | `storage-do` | Over `c.db`: `transaction(work)` maps to `c.db.transaction(cb)`; must pass the `storage.sql` suite and pi-durable's storage conformance |
| `credentials-rivet` | `model.credentials` | none today (API keys only on Cloudflare) | One actor `pikit:credentials` owns the tokens and is the only one refreshing them (a refresh rotates the token); conversations ask it for a fresh access token. Login with `copy_code` from `pikit configure --login`, sent through an admin route |
| An `execution` provider | `execution`, `execution.shell` | `execution-do` (does not port: it runs on the object's synchronous SQL) | Either `execution-agentos` (Rivet's sandbox actor, WASM shell) or `execution-remote` against a Gondolin service on KVM nodes (real Linux), [sandboxed execution](sandboxed-execution.md). Must pass `createDurableExecutionConformance` |
| Secrets | `secrets` | `secrets-workers` | The worker is a Bun process with an environment: let `secrets-env` list `durable` (it reads `process.env`, no `node:` import), or a `secrets-rivet` if Rivet's env handling differs |

Changes to existing components:
- **runtime-pi** decides "one chat per storage" (`conversations: "root"`) from `WORKERS_HOST`
  (`runtime-pi/.../index.ts`, `perObject`). Read `actor.inbox`'s `scope` instead, as admin-api does.
- **channel-telegram-webhook**'s Worker half reads `WORKERS_HOST` (env, version): make it
  host-neutral or give it a Rivet half.
- **admin-api** uses `actor.mailbox` and `scope` only (its index actor `admin-api:index`): expected to
  work unchanged; verify.
- **outbound-durable, conversations-kv, storage-kv-sql** run on `storage.sql`: expected unchanged.
- **proposals-github / repo-github-app**: no Cloudflare import, but the deploy after an approval is
  Workers Builds today; with Rivet, CI runs `deployment-rivet`'s deploy script with the same rollout.
- **CLI**: a preset (`telegram-rivet`), the capability catalogue, `pikit new --target durable` choosing
  the deployment, `pikit dev` starting a local engine and the worker.
- **`registry validate`**: the import rules (`checkImports`) gain the `rivet` boundary: only `-rivet`
  components and `deployment-rivet` import `rivetkit`.

## Pi first
- pi-durable runs on `SqliteStorage` over `storage.sql` (`packages/pi-adapter/src/sql.ts`), the same
  path a server uses: no Pi change expected, if `c.db` passes pi-durable's storage conformance.
- One conversation per storage (its root), as on Cloudflare: pi-durable's global scheduler is no
  limit ([scheduling scope](../docs/upstream/pi-durable-scheduling-scope.md)).
- `contextRetentionMs` / `documentRetentionMs` are set to 0 only on Workers (`WORKERS_SETTINGS`,
  `runtime.ts`). In Bun the timers are unreferenced; check that a kept context neither blocks Rivet's
  sleep nor leaks across sleeps.
- pi-ai refreshes OAuth tokens in Bun: only the owner actor is pikit's.

## Limits to check against pikit
From Rivet's `docs/actors/content/docs/limits.mdx`:
- **1,310,720 bytes of dirty pages per commit** (320 pages of 4 KiB). pi-durable commits a message
  with its images in one transaction; on Cloudflare images are capped at 1 MB for the 2 MB row.
  Measure the largest commit; the cap may have to be lower on Rivet.
- Transaction deadline 60 s by default; at most 128 operations queued behind a transaction.
- Action timeout 60 s (configurable); `onRequest` must start its response within 5 min.
- Sleep grace 15 s; a worker drains its actors for up to 30 min on shutdown (their compose sets
  `stop_grace_period: 35m`): tune it, or a deploy takes half an hour.
- 10 GiB of storage per actor; 128 KiB per KV value (if the KV is used at all).

## Self-hosting
- **One machine**: the engine (`rivetdev/engine`, one Rust binary) with file-system storage on a
  volume, the worker, Caddy for TLS. The engine is then a single point of failure.
  (`self-host/control-plane/vm`, `self-host/workers/docker-compose`.)
- **Several machines**: two or more engines, Postgres (a managed one recommended) or FoundationDB,
  NATS between the engines, N workers. Workers hold no state (the engine's storage does, tiered to S3
  optionally), so they are added and removed freely. Kubernetes manifests in
  `self-host/control-plane/kubernetes`; guides for VMs with systemd, ECS, Railway.
- **Backups**: Postgres (and the bucket if tiering is on).
- Observability (ClickHouse, Grafana, OTel) is optional.
- A Gondolin `execution` needs nodes with KVM (`/dev/kvm`) besides.
- Rivet Cloud (or BYOC) is the same control plane: one endpoint setting in `deployment-rivet`.

## Compared with celld
| | celld | Rivet |
|---|---|---|
| API | Durable Objects: pikit's Cloudflare code unchanged (spike) | Its own: a host layer to write |
| Maturity | 0.6 beta | 2.3 |
| Runtime | workerd, Workers limits | Bun or Node |
| Timed work | One alarm per object | Several schedules per actor |
| State | Bucket with an epoch fence | Postgres or FoundationDB, S3 tiering |
| Isolation | An isolate per object | Many actors per worker process: an OOM drops all of that worker's (rescheduled elsewhere) |
| Subscription login | Needs an upstream fix in pi-ai | Works in Bun |
| Work to ship | `deployment-celld` | The components above |

## The proof
Following the contract rules (AGENTS.md):
- `storage-rivet` passes the `storage.sql` suite and pi-durable's storage conformance on a real engine.
- `actors-rivet` passes the mailbox, inbox and wakeups suites, with negative cases.
- A run cut mid-drive completes: a worker killed with `kill -9`, an actor put to sleep mid-run, an
  upgrade moving it.
- Telegram end to end, then a chaos run like celld's: every accepted message answered once, in
  order (outbound-durable's marked resends allowed).
- Measured: cold start, a warm turn, memory per resident conversation.
- `docs/targets.md`, `docs/contracts.md`, SPEC §4, the capability catalogue and every README updated;
  `bun run registry generate` and `validate`.

## Spike order
1. **Go/no-go**: pi-durable's storage conformance over `c.db`, and the largest commit pikit makes.
2. One `conversation` actor with runtime-pi and `provider-faux`, reached from a front App through
   the mailbox, a fake Telegram end to end.
3. A worker killed and an actor slept mid-run.
4. Only then the components, the SPEC change and the deployment.

## Open questions
- The SPEC §4 wording (above): its exact text, proposed before building.
- Slices or not: `keepAwake` lets a run go on past 60 s, but a move or upgrade still cuts it; keep
  `driveSlice` as on Cloudflare, or a longer slice?
- `stream`: `onRequest` streaming or Rivet's connection events.
- One process or two: the front App in the worker process (rivetkit serves its handler there), or
  apart so it scales on its own.
- Execution: agentOS (light, no KVM, emulated shell) or Gondolin behind `execution-remote` (real
  Linux, KVM nodes), or both.
- Whether `rivetkit` respects the neutral-layer rule for `durable` components (no `node:*`), or the
  Rivet pieces are reached only through `RIVET_HOST`, the way Cloudflare's are.
