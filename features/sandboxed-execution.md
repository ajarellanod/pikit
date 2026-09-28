# Sandboxed execution

**Public appeal:** ⭐ Let the agent run code without risking the host. Hermes runs its terminal on
seven backends (local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox); OpenClaw offers
sandboxing.

**Specified:** partly (SPEC §8.2 and §8.3 name the components)

**Needed by:** track S requires `execution-cloudflare-sandbox` (SPEC-CORE §6; ROADMAP, track S): that
one is required work, specified there, not here. On the server, track S's rule that the workspace's
network is closed except for the hosts it needs may require `execution-docker` (open below).

## What it gives
Commands and file tools that run somewhere other than the pikit process: a container, a VM, a
remote host, with their own user, filesystem and network.

## How it fits pikit
- Providers of `execution` and `execution.shell` (Pi's `ExecutionEnv`) that pass
  `createExecutionConformance` (SPEC §8.3). No new contract.
  - `execution-docker` (server): a container per agent, or per conversation.
  - `execution-remote` (both targets): a host speaking an executor protocol over HTTP or WebSocket.
  - Hosted sandboxes (Modal, Daytona, E2B…) as `execution-*` components of their own.
- A `workspace` provider over a sandbox gives each agent its own ([workspace snapshots](workspace-snapshots.md)).
- An idle conversation holds no sandbox (S11): started on demand, stopped when idle.
- Credentials are injected into the sandbox's outbound requests by trusted code, never stored in
  it (the SPEC-CORE §6 pattern).
- Absent: `execution-local`, which is not a sandbox and says so (SPEC §8.3, §13).

## Pi first
`ExecutionEnv` is Pi's contract, and Pi's coding agent documents containers and ships a sandbox
example for one terminal (`docs/containerization.md`, `examples/extensions/sandbox`). pikit adds
only where each agent's commands run across a service.

## Open questions
- Does track S on the server need `execution-docker`, or is a local checkout with a closed network
  achievable otherwise?
- The remote executor protocol: check `pi-protocol` and `pi-client` before defining one.
- Per agent or per conversation, and what it costs.

## Moved from SPEC
SPEC §8.2 (the schedule it named is gone; features have no order):

> Isolation needs each agent's tools in a separate sandbox (`execution-docker`, planned after M2).

ROADMAP, "Later, only if demanded":

> - A remote executor protocol.

ROADMAP M1.5, "Not in scope":

> running each agent's tools in a container of its own (`execution-docker`) comes after M2.
