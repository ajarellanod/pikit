# Deployment targets beyond server and durable

**Public appeal:** —

**Specified:** partly (SPEC §4: two first-class targets, each a runtime model; `Target` is
`"server" | "durable"` in `packages/core/src/app.ts`, the component schema's `targets` enum and the
CLI's `TARGETS`)

**Needed by:** nothing now. Owner's decision: deployment must never be closed; the dashboard and
every component are designed so that Vercel, E2B, exe.dev, Modal (and the next ones) can come
without rewriting them.

## What it gives
The same project, its agents, channels and dashboard, on more hosts, chosen at install time like any
other component.

## How it fits pikit
**A target is a runtime model, not a provider.** What a component must know is how its code lives,
not whose machine it is. Providers are `deployment-*` components on a target:

| Runtime model | Target | What it guarantees | Providers (each a `deployment-*`) |
|---|---|---|---|
| Long-lived process | `server` | a process that stays up, a persistent local disk, in-process timers, one process per storage | Docker on a VPS (`deployment-docker`), systemd, exe.dev (persistent VMs over SSH), E2B (sandboxes, persistence to check), Modal (containers; its SDK is Python-first, so likely a container image plus a thin deploy script), Fly, Railway |
| Actor per conversation | `durable` | one actor (a Durable Object) per conversation, its own SQLite, one alarm, eviction between events, work in slices (`driveSlice`) | Cloudflare (`deployment-cloudflare`) |
| Stateless functions | (future) `functions` | a request-scoped invocation, no local disk, concurrent instances, a time limit | Vercel (Functions), others alike |

`server` guarantees a persistent disk: a provider without one supplies it (a volume), and its
`deployment-*` checks it in `pikit doctor`; otherwise it is not `server`. The pieces specific to the
only `durable` provider keep its name (`deployment-cloudflare`, `platform-cloudflare`,
`secrets-cloudflare`, `@pikit/contracts/cloudflare`, `WORKERS_HOST`, the presets `telegram-cloudflare`
and `cloudflare-minimal`); only the target is `durable` (it was `cloudflare` until the rename: a
`pikit.json` that says `cloudflare` is read as `durable`, and `pikit new --target cloudflare` is refused
with the new name).

Facts about each provider (persistence, limits, pricing) are checked when its component is built;
this table records the model, not promises.

**What a new runtime model needs** (the stateless-functions case, which is the hard one):
- **Storage**: no local disk, so pi-durable's storage over a network database: a `Storage` backend
  for Postgres or libSQL/Turso ([storage-postgres](storage-postgres.md); D1 lacks interactive
  transactions).
- **One writer per conversation**: concurrent instances break pi-durable's one-process-per-storage
  rule; needs per-conversation leases and scheduling scope upstream
  ([upstream](../docs/upstream/README.md), proposals 4 and 5), or one storage per conversation.
- **Wake-ups**: no process between requests; the `wakeups` contract on a scheduler/queue the host
  offers, driven by `driveSlice` exactly as a Durable Object's alarm is.
- **Time limits**: long runs continue across invocations in slices (`driveSlice`), as on Cloudflare.
So a functions target is mostly the `durable` model with external storage and leases; it waits for
those pieces, not for a rewrite.

**Rules that keep deployment open** (checked in review, and by `scripts/boundaries.ts` where it can):
- Only `platform-*`/`deployment-*` components (and server-only ones declared so) import host APIs;
  everything else talks through contracts: `http.route` (standard fetch handlers), `storage.sql` /
  pi-durable `Storage`, `wakeups`, `secrets`, `actor.mailbox`.
- HTTP is a fetch handler (`Request` → `Response`), never a host's server object; streams are plain
  streaming responses (server-sent events), WebSockets only as an optional optimization.
- No component assumes a local disk, a long-lived process or a timer unless its manifest says
  `targets: [server]`.
- The dashboard follows the same rules (SPEC §5): served by its own `http.route` handlers, live by
  server-sent events, location-transparent reads.

**Sandboxes are also execution, not only hosting.** E2B, Modal sandboxes and exe.dev VMs fit as
`execution` providers too: the harness runs anywhere, the agent's tools run in a remote sandbox
(pi-durable's `ExecutionEnv` is designed for remote environments). See
[sandboxed execution](sandboxed-execution.md).

## What to add when Vercel or Modal comes

**Modal (and exe.dev, E2B, Fly): target `server`, no core change.** A provider of a model pikit already
has is one component:
- **`deployment-modal`**, shaped like `deployment-docker` (`registry/components/deployment-docker`):
  a container image of the app, and the functions the deployment contract has
  (`packages/cli/src/project/deployment-module.ts`): `up`, `down`, `status`, `logs`, optionally
  `restart` and `dev`. Modal's SDK is Python-first, so the component carries a thin deploy script that
  its `up`/`down` run, nothing else in Python.
- **A persistent volume** mounted where the app keeps its state: the SQLite file (`storage-sqlite`) and
  `.pikit/`. Without it the app is not on `server`.
- **Secrets** through `secrets-env` (Modal injects them as environment variables) or a component that
  provides `secrets` from Modal's secrets.
- **A `pikit doctor` check** (the component's `doctor` hook) that the volume is mounted and writable.
- **`exec`**, so `pikit configure --login` runs where the app runs and the model credentials land on
  its volume.

E2B and exe.dev are the same component shape, with their persistence model checked by the same doctor
hook (an exe.dev VM's disk persists; an E2B sandbox's must be shown to). Separately, Modal or E2B
sandboxes can be an `execution` provider for any target ([sandboxed execution](sandboxed-execution.md)).

**Vercel: a new target `functions`, a core change.** Its runtime model is neither of the two:
- **The value `functions`** in `Target` (`@pikit/core`), the schema's `targets` enum and the CLI
  (`TARGETS`, `pikit new --target`, the starter), with its guarantees documented beside the others:
  request-scoped invocations, no disk, concurrent instances, a time limit.
- **A pi-durable `Storage` over a network database**: a Postgres or libSQL backend
  ([storage-postgres](storage-postgres.md)); D1 does not fit (no interactive transactions).
- **One writer per conversation**: a per-conversation lease (upstream proposals 4 and 5,
  [upstream](../docs/upstream/README.md)), or one storage per conversation.
- **`platform-vercel`**: provides `wakeups` on Vercel's cron/queue offering and `actor.mailbox`, and
  drives runs with `driveSlice`, as a Durable Object's alarm does.
- **`deployment-vercel`**: the project's configuration, environment and secrets, deploy, logs.
- **The dashboard unchanged**: it is `http.route` handlers and server-sent events.
- **Components decide by their `targets`** whether they run there: what needs a disk or a process
  (`storage-sqlite`, `execution-local`, `wakeups-timers`) does not declare `functions`.

## Pi first
Pi Durable runs on any JS runtime (Node, Bun, Workers) and its storage and execution environment are
pluggable; hosting is not Pi's concern. Its limits that bind new targets are the upstream proposals
above.

## Decided
- Opening `Target`: **closed, by runtime model.** A target names a runtime model, never a provider:
  `server` (a long-lived process with a persistent disk) and `durable` (renamed from `cloudflare`: an
  actor per conversation). A provider is a `deployment-*` component on one of them and never needs a
  core change. A third value (`functions`) is added, in `@pikit/core`, the schema's enum and the CLI,
  only when a stateless-functions host is built.

## Open questions
- Which provider comes first after Cloudflare and server, when there is demand.
