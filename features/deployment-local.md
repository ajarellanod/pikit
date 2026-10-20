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

## Self-improvement without Docker
Not built. Today `proposals-local` activates deployment-docker's deployer through its Compose file,
and its doctor checks Compose. deployment-local runs neither Compose services nor the deployer.
`proposals-local` declares `requires.deployment: ["proposals.deployer"]`; its `compose` file implies
`services.compose`. deployment-local supports neither. The wizard shows the self-improvement feature
disabled with the reason when deployment-local is selected; `--with admin-proposals` and `pikit add`
refuse it before writing, as `doctor` does before any component hook or Docker runs. With Docker,
`pikit dev` does not run a deployer: proposals-local's hook says proposals are not applied there and
runs no Docker. The local deployer itself remains missing.

The missing work is not just another supervisor template:
1. **An independent deployer service**, under systemd or launchd, that survives an app restart and
   reports its heartbeat and outcomes through the existing `@pikit/contracts/deployer` file protocol
   (`decisions.json`, `deployer.json`). Keep the dashboard on `proposals`; no new dashboard protocol
   is needed merely to replace Docker.
2. **Isolated validation and builds.** Candidate installation scripts, tests, typecheck and UI builds
   must not run as the host user with access to the home, live state or service control. Gondolin/QEMU
   is the proposed replacement for check containers, not an implemented deployer runner. A dedicated
   OS user alone does not supply the filesystem and network isolation of a sandbox. Deploy hooks that
   need secrets require an explicit, narrow boundary too; the controller must not import candidate
   project code. Separately, `execution-gondolin` fences the agent's tools and protects the approval
   files; it does not implement the deployer's check runner.
3. **Recoverable deployment in the project's directory.** Prepare the candidate apart, keep the last
   working code and dependencies, stop the app before replacing its files, then start and verify the
   candidate. Serialize this with manual `up`, `restart` and other deployer attempts, and recheck that
   the checkout and approved head have not moved. Persist the previous and candidate versions and
   each transition so a killed deployer or power loss can resume or roll back without running a
   half-applied tree. A failed activation must restore both code and dependencies and verify the
   previous app, not just issue a restart.
4. **Native dependency handling.** Linux VM checks do not prove macOS runtime compatibility; do not
   copy Linux `node_modules` into a Mac deployment. Define how host-compatible dependencies and
   artifacts are prepared and retained for rollback without bypassing the isolation above.
5. **Approval and deployment fences.** Deploy the exact approved head, reject changes to the deployer,
   supervisor templates and approval path, and refuse a changed or dirty checkout rather than
   overwriting manual edits. A failure before activation leaves the current app alone.
6. **State is not a release artifact.** Never automatically restore `.pikit/` with the old code: it
   holds conversations, credentials and new writes. Code rollback cannot undo SQLite/schema changes;
   specify which state-changing proposals are reversible and how an irreversible or failed rollback
   is reported before enabling automatic deployment.
7. **Integration without Compose.** Let `proposals-local` work with the local supervisor as well as
   Docker, including its activation and doctor checks; do not just ignore its Compose file. The CLI
   now refuses unsupported combinations (the wizard explains why); this does not build the missing
   service. Any shared service registration must be justified by these real producers and consumers,
   not a speculative framework.

Before shipping: run the existing deployer protocol conformance cases with the local deployer, then
exercise approval, moved heads, protected paths, conflicts, dirty checkouts, failed checks/builds,
failed health checks and failed rollback. Kill the deployer during activation and recovery, test
concurrent/manual operations, and assert that conversations and credentials are retained. Test both
supervisors and host-native dependencies on real Linux and macOS. This is missing implementation and
verification, not a guarantee of today's `pikit up`.

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
