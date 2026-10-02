# Deployment targets beyond server and Cloudflare

**Public appeal:** —

**Specified:** partly (SPEC §4: two first-class targets; `Target` is `"server" | "cloudflare"` in
`packages/core/src/app.ts`, the component schema's `targets` enum and the CLI's `TARGETS`)

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
| Long-lived process | `server` | a process that stays up, a local disk, timers | Docker on a VPS (`deployment-docker`), systemd, exe.dev (persistent VMs over SSH), E2B (sandboxes, persistence to check), Modal (containers; its SDK is Python-first, so likely a container image plus a thin deploy script), Fly, Railway |
| Actor at the edge | `cloudflare` | one Durable Object per conversation, its SQLite, one alarm, eviction | Cloudflare |
| Stateless functions | (new, e.g. `functions`) | a request-scoped invocation, no local disk, concurrent instances, a time limit | Vercel (Functions), others alike |

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
So a functions target is mostly the Cloudflare model with external storage and leases; it waits for
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

## Pi first
Pi Durable runs on any JS runtime (Node, Bun, Workers) and its storage and execution environment are
pluggable; hosting is not Pi's concern. Its limits that bind new targets are the upstream proposals
above.

## Open questions
- Opening `Target`: adding a value is a core change (`Target` in `@pikit/core`, the schema enum, the
  CLI). Whether to keep a closed union (each model reviewed into the core) or let a platform
  component declare its target. Recommended: keep it closed but by runtime model, so providers never
  need a core change.
- Which provider comes first after Cloudflare and server, when there is demand.
