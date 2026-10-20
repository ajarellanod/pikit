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
- **The `http` preset asks** "How should it run on this machine?" (`choose: kind: deployment`):
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
- **Doctor gives notes only** (supervisor reachable, linger, a path a unit cannot hold, macOS's protected
  folders, Compose components, `.env`'s mode): `pikit dev` must never be blocked by what only `up` needs,
  and `up` refuses on its own.
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

## Open questions
- **Windows.** Bun runs there, the installer does not (POSIX sh). WSL2 with systemd is the Linux path;
  native Windows would need a service wrapper or Task Scheduler.
- **System mode:** a system unit or LaunchDaemon with a user of its own, started at boot without a
  login. Real isolation from your home, but `sudo` and the project's files owned for that user.
- **Services beside the app:** `cloudflared` (expose-cloudflare-tunnel) as a second unit. Today `compose`
  means "run by deployment-docker"; a provider-neutral way to declare them waits for a second component
  that needs one (contract rule 1).
- **Self-improvement:** a local deployer (snapshots, merge, checks, restart, rollback). Without
  containers its checks would run the agent's code as you, so it needs system mode or a sandbox first.
  The wizard still offers `[admin-proposals, proposals-local]` with deployment-local, and `up` refuses
  it: a preset cannot yet tie a feature to a deployment.
- **Hangs:** systemd's `WatchdogSec` with `sd_notify` (Bun has no unix datagram sockets).
- **Shared code:** the entrypoint, the logger and the deploy-hook runners now exist in two or three
  copies (deployment-docker, deployment-cloudflare's hooks, this). A kit package for the server process
  waits until a copy drifts.

## Moved from the former SPEC
The former SPEC §9.1 (from the deleted deployment-systemd note):

  - `deployment-systemd` `[planned]` generates a unit file.
