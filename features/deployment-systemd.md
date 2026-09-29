# systemd deployment

**Public appeal:** —

**Specified:** idea (moved from the former SPEC §9.1)

**Needed by:** nothing required.

## What it gives
Run a pikit project as a systemd service on a VPS, without Docker.

## How it fits pikit
- `deployment-systemd` is a `deployment-*` component like `deployment-docker`: it owns
  the entrypoint, the logger (journald) and the unit file, and exports `up`, `down`, `restart`,
  `logs`, `status` (and `exec` for logins) for the CLI to delegate to.
- It follows `deployment-docker`'s start and stop rules: deadlines, signals, exit codes; the stop
  deadline shorter than `TimeoutStopSec`, checked by a test; the rollback bounded (SPEC K2).
- `Restart=on-failure` is the supervisor that restarts a process whose `/health` fails
  ([health](health.md)).
- Secrets from `.env` through `EnvironmentFile`, mode 0600; a user of its own.
- Absent: `deployment-docker`, as today.

## Pi first
Nothing in Pi: deployment is pikit's (SPEC P1).

## Open questions
- User unit or system unit (a system unit needs `sudo`, which the installer asks for).
- Bun, or Node once the packages are built to JavaScript (K8).

## Moved from the former SPEC
The former SPEC §9.1:

  - `deployment-systemd` `[planned]` generates a unit file.
