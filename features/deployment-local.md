# Local deployment: the server target as a service of this machine

**Public appeal:** -

**Specified:** built (`registry/components/deployment-local`; its README has the details). It replaces
the former note deployment-systemd: systemd is one of its two supervisors. It moves to `completed/`
once a project has run on it in production on each platform.

**Needed by:** nothing required. It makes Docker optional for `pikit up` on the `server` target:
without it, the installer offers the systemd or launchd service.

## What it gives
Run a pikit project of the `server` target as a background service of the machine it is on, without
Docker: a systemd user unit on Linux, a launchd user agent on macOS. `pikit up | down | restart | logs |
status` work as with `deployment-docker`; the process is the same entrypoint, the same deadlines, the
same `/health` and `/ready`, and it is restarted when it exits or `/health` answers 503.

For a laptop or a Mac mini that runs your agent while it is on, and a VPS without Docker. Not for
anyone who needs the container's isolation, self-improvement's deployer, or services beside the app
(`compose`).

## How it fits pikit
- `deployment-local` is a `deployment-*` component of the `server` target, a second provider beside
  `deployment-docker` (SPEC §4: a new provider of an existing runtime model changes no core). The
  CLI's protocol (`DeploymentModule`) was enough: it exports `up`, `down`, `restart`, `logs`, `status`,
  `dev` and `exec`; no CLI code knows systemd or launchd. Nothing in `@pikit/contracts`, `@pikit/core`
  or the capability catalogue: a deployment provides and requires no capability.
- The name follows the registry's `-local` (`execution-local`, `workspace-local`): this machine.
- **The `base` preset asks** "How should it run on this machine?" (`choose: kind: deployment`):
  every server deployment answers, `deployment-docker` the default; `--with deployment-local` answers
  it in a script, and `telegram` (its alias) asks it too. A component that answers a question needs a
  `title`, so the three deployments got one.
- The installer still offers Docker; when it is missing it says to answer "This machine's service".

## Decisions
- **In place.** The service runs the project's directory: no image, no release snapshot. `.pikit/` is
  the one `pikit dev` uses (one copy of each login), a crash restart runs the files as they are on disk,
  and `up` is the deploy (hooks, `bun install`, UI builds, restart, `/health`). `pikit dev` refuses
  while the service runs, and `up` refuses while something else answers on the app's port. No rollback,
  as deployment-docker's `up` (its deployer rolls back).
- **Same entrypoint**, copied from deployment-docker (components are owned source), plus a watchdog: it
  fetches `/health` every 10 s and on a 503 stops the app cleanly and exits 1. One 503, as Docker's
  healthcheck: health-registry already says `down` only past its grace. A refused connection or a timeout
  restarts nothing.
- **Restart always** (`Restart=always`, `StartLimitIntervalSec=0`; `KeepAlive`), as `unless-stopped`.
  Stop budget 20 s (`TimeoutStopSec`, `ExitTimeOut`) above the 10 s stop deadline; `KillMode=mixed`.
- **Its own log file**, `.pikit/logs/app.log`, rotated (10 MB, five files) by the process, on both
  platforms: launchd never rotates, and a user unit's journal is not readable everywhere (Debian keeps it
  volatile by default). The supervisor's stdout and stderr go to `.pikit/logs/stdio.log`: what is written
  before the logger exists.
- **Loopback.** `main.ts` moves server-bun from every interface (its default) to `127.0.0.1`, as Docker
  publishes `127.0.0.1:3000` only.
- **The environment** is `.env` only (`bun --env-file=.env`), plus `PATH` and `HOME` captured at `up`
  and the absolute path of the Bun that ran `up`. No secret in the unit or the plist.
- **Its own doctor hook gives notes only** (supervisor reachable, linger, a path a unit cannot hold,
  macOS's protected folders, Compose components, `.env`'s mode): `pikit dev` must never be blocked by
  what only `up` needs. Before the hook runs, the CLI checks the composition: a component needing
  `services.compose` or `proposals.deployer` is a problem with deployment-local, on `dev` and `up`
  alike. `up` keeps its guard against Compose files.
- **Isolation is given up**, and said: the app runs as you, and with `execution-local` the agent's shell
  is yours. `pikit up` says so when `tool-bash` is installed; `execution-gondolin` fences the commands.

## Pi first
Nothing in Pi: deployment is pikit's (SPEC P1).

## Tests
The component's own (copied into each project): the entrypoint in a child process (deployment-docker's
K2 cases, the watchdog's 503 and non-503, the log file under the supervisor), the logger and its
rotation, the unit and the plist (golden lines, escaping, `plutil -lint` on macOS, `systemd-analyze
verify` on Linux), and every command's exact argv against a fake systemd and launchd. The CLI's wizard
end to end (`PIKIT_E2E=1`) answers the new question both ways.

### Verification still needed
The manual trial on macOS used a generated project with `provider-faux`: a real launchd agent,
HTTP messages answered, loopback binding, recovery after `kill -9`, restart, redeploy, log following,
`dev` refused while the service ran, and `down` and removal keeping `.pikit/`. This does not prove:
- **A real Linux service:** install and run under a systemd user manager, with and without linger;
  exercise start, stop, crash recovery and logout. Fake-runner tests and unit syntax checks do not
  establish this.
- **Reboot recovery on either platform:** Linux with linger should return at boot; the macOS user
  agent should return after login, not before it. Neither was tested through a machine reboot.
- **Production operation:** a real bot over time on each platform, before moving this note to
  `completed/`.

## Self-improvement without Docker: decided, not built

**Decision.** pikit does not build a deployer for `deployment-local`. Safe self-improvement (the agent
proposes, a person approves, a deployer checks, deploys and rolls back) needs Docker on a server
(`deployment-docker`), or GitHub and Workers Builds on Cloudflare. On `deployment-local` the project's
code is changed by editing it in place, without proposals, and that is the user's choice and
responsibility.

**Why.** Docker gives the gated path what it needs for free; a service of this machine gives none of it,
and building each piece would be a large project of its own for one deployment:
- **Isolation.** The proposal's `bun install`, typecheck and tests are code the agent wrote. Docker runs
  them in a throwaway container without secrets or the socket. Here they would run as the user, with
  their home, credentials and other projects; fencing them needs a real sandbox (a VM), not a
  supervisor template.
- **An immutable artifact and its rollback.** Docker builds a new image and keeps the previous one, so
  a failed deploy returns to it. Here the project runs in place: the candidate code and its
  `node_modules` would have to be prepared apart, the previous ones kept, and every transition recorded
  so a crash or a power cut mid-deploy could resume or roll back without a half-applied tree.
- **Native dependencies.** Checks in a Linux VM do not prove the code runs on the user's Mac.
- **State beside the code.** `.pikit/` (conversations, logins) lives in the project's directory: a code
  rollback must never restore it, and cannot undo a schema change.
- **A separate, privileged process.** In Docker the deployer is one more Compose service, and only it
  holds the socket. Here it would be another systemd or launchd unit with its own rights, which the
  app and the agent must not be able to reach.

A thin version (a `git pull` and a restart) would have run the agent's code unfenced and had no
reliable rollback: the gated path it claims to be, without its guarantees. pikit offers none instead.

**What the CLI does.** `proposals-local` needs `proposals.deployer` (and, for its Compose file,
`services.compose`); `deployment-local` supports neither, and will not
([component-composition](component-composition.md)). So the wizard shows self-improvement disabled,
saying why; `pikit new --with admin-proposals` and `pikit add proposals-local` refuse before writing;
`pikit doctor` (so `dev` and `up`) refuses a project that has both before any component's hook or Docker
runs. To approve the agent's changes, use `deployment-docker` (`pikit remove deployment-local`, then
`pikit add deployment-docker`).

**How code changes on `deployment-local`.** By editing the project, in place, as any source:
1. Edit `src/` (your agents, components, the dashboard): by hand, or with a coding agent you run in the
   project (Pi, Claude Code), or by asking the steward, which then tells you what to change, file by
   file (its `pikit-self` guide, when the project has no proposals).
2. `pikit doctor` and `bun test`, as for any change.
3. `pikit restart` (or `pikit up`): the service runs the files as they are on disk; `pikit dev` reloads on
   each save. Commit what you keep: the project is a git repository.

**Unsafe on purpose, and the user's to decide.** Nothing here is gated: no approval, no checks before
the change runs, no automatic rollback (`git` is the way back). The steward never edits the project by
itself: its guide says so, and its tools work in `.pikit/workspace/`. But on this deployment the app
runs as the user, so a steward given `bash` (`steward.tools` in the preset, or `tools` in its
`agent.ts`) could edit any file the user can, the project's included; that is outside SPEC P9's gate,
which pikit offers only where a deployment supports `proposals.deployer`. Give it a shell only on a
machine and a project where you accept that. To fence it, run its shell in a VM (`execution-gondolin`);
for the gated path, use Docker.

**If it is revisited.** A deployer for this deployment would declare `proposals.deployer` in
`deployment-local`'s `deployment.supports` and implement the `@pikit/contracts/deployer` file protocol;
the wizard, `add` and `doctor` would accept it with no CLI change. It must bring every guarantee above
(sandboxed checks, recoverable deploys with rollback of code and dependencies, state never rolled
back), proven by the deployer protocol's conformance cases on real Linux and macOS. None is planned.

## Open questions
- **Windows.** Bun runs there, the installer does not (POSIX sh). WSL2 with systemd is the Linux path;
  native Windows would need a service wrapper or Task Scheduler.
- **System mode:** a system unit or LaunchDaemon with a user of its own, started at boot without a
  login. Real isolation from your home, but `sudo` and the project's files owned for that user.
- **Services beside the app:** `cloudflared` (expose-cloudflare-tunnel) as a second unit. Today `compose`
  needs a deployment supporting `services.compose` (deployment-docker does); a provider-neutral way
  to declare a native service waits for a second component that needs one (contract rule 1).
- **Hangs:** systemd's `WatchdogSec` with `sd_notify` (Bun has no unix datagram sockets).
- **Shared code:** the entrypoint, the logger and the deploy-hook runners now exist in two or three
  copies (deployment-docker, deployment-cloudflare's hooks, this). A kit package for the server process
  waits until a copy drifts.

## Moved from the former SPEC
The former SPEC §9.1 (from the deleted deployment-systemd note):

  - `deployment-systemd` `[planned]` generates a unit file.
