# deployment-local

Runs a pikit project as a service of this machine, without Docker: a systemd user unit on Linux, a
launchd user agent on macOS. The process entrypoint, its log, the unit and plist templates, and the
commands `pikit up | down | restart | logs | status | dev` delegate to.

- **Provides:** nothing. It is not an app component and is not listed in `pikit.config.ts`: it runs
  the app rather than running inside it.
- **Requires:** nothing. It runs whatever `pikit.config.ts` composes; for `/health` and `/ready` that
  is `server-bun`.
- **Target:** `server` (it uses the process's signals and `node:child_process`).
- **Platforms:** Linux with systemd (a user manager: log in over SSH or a desktop, not `su`), and
  macOS. Elsewhere (Alpine, a container, WSL without systemd, Windows) `pikit dev` runs and `pikit up`
  refuses: use deployment-docker.
- **Installs to:** `src/pikit/deployment-local/`. `pikit up` writes the unit to
  `~/.config/systemd/user/pikit-<project>-<hash>.service`, or the plist to
  `~/Library/LaunchAgents/dev.pikit.<project>.<hash>.plist` (`<hash>`: of the project's path).
- **npm dependencies:** none. Bun 1.4 or later, which pikit runs on already.
- **Environment:** none of its own. The app's variables are read from `.env` when the process starts.

## Isolation: what you give up without Docker

In Docker the app runs as an unprivileged user that sees its own files and its volume. Here it runs
**as you**: it reads what you can read (`~/.ssh`, your other projects, your cloud credentials), and
with `execution-local` the agent's shell (`tool-bash`) is your own. `pikit up` says so when `tool-bash`
is installed. To fence the agent's commands, use `execution-gondolin` (a micro-VM per conversation);
to fence the whole app, use deployment-docker.

## What it does

### It runs the project in place

The service runs the project's directory as it is: `<bun> --env-file=.env
src/pikit/deployment-local/main.ts`, in the project. There is no image, so:
- **`.pikit/` is the project's own**, the one `pikit dev` uses: the conversations, and one copy of
  each model login (`pikit configure` needs no `--local`).
- **A restart runs the files as they are on disk**, a crash restart too. `pikit up` is the deploy; an
  edit is live after `pikit up` or `pikit restart`.
- **`pikit dev` and the service never run together**: they would share `.pikit/`'s database and the
  port. `pikit dev` refuses while the service runs (`pikit down` first), and `pikit up` refuses while
  something else answers on the app's port.

### The process (`main.ts`, `local.ts`, `entrypoint.ts`)

The entrypoint is deployment-docker's (SPEC K2 and P5): a 30 s start deadline (a failed start exits 1),
a 10 s stop deadline on SIGTERM or SIGINT (exit 0 when every component stopped), a second signal
exits at once. The supervisor's own stop budget is 20 s, so the app stops itself before it is killed.

`local.ts` adds what a service of this machine needs:
- **Loopback.** server-bun listens on every interface by default (`0.0.0.0`). Here it listens on
  `127.0.0.1`, as deployment-docker publishes `127.0.0.1:3000` only. To serve other machines, put a
  TLS proxy in front, or pass `hostname: "0.0.0.0"` to `local` in `main.ts`, knowing that the bearer
  token is then the only lock.
- **Under the supervisor** (`PIKIT_SERVICE=1`, which the unit and the plist set; `pikit dev` does not):
  - the app's log goes to `.pikit/logs/app.log`, rotated at 10 MB, five files kept;
  - **the watchdog**: every 10 s it fetches `/health`; on a 503 (`health` says the app is down past
    its grace: health-registry) it stops the app cleanly and exits 1, and the supervisor starts it
    again. A refused connection or a timeout restarts nothing. That is what deployment-docker's
    healthcheck does.

### The supervisor (`pikit.service`, `pikit.plist`, `supervisor.ts`)

| | Linux | macOS |
|---|---|---|
| Supervisor | systemd, user manager (`systemctl --user`) | launchd, user agent (`gui/<uid>`) |
| Runs | while you are logged in, or from boot with linger (`sudo loginctl enable-linger $USER`) | while you are logged in |
| Restart | `Restart=always`, after 2 s, never giving up | `KeepAlive`, at most every 10 s |
| Stop | SIGTERM to Bun, SIGKILL after 20 s (`KillMode=mixed`) | SIGTERM, SIGKILL after 20 s (`ExitTimeOut`) |
| Before the logger | `.pikit/logs/stdio.log` (an import error, a crash) | the same |

Any exit restarts it, as Docker's `restart: unless-stopped`; `pikit down` stops it for good. The
templates are yours: edit them, then `pikit up`. `{{…}}` is filled in by `pikit up`: the project's
path, the Bun running the CLI (`~/.bun/bin/bun` from the installer; a new Bun needs `pikit up` again),
and the `PATH` and `HOME` of the shell that ran it (the agent's shell needs your tools). No secret is
in either file: `.env` is read when the process starts, so a change of `.env` needs `pikit restart`.

On Linux a project path with a space or one of `"'\$%;` is refused (a unit cannot hold it); on macOS
a project under `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive cannot be read by a
background process without Full Disk Access: `pikit doctor` says so for both.

### The commands (`commands.ts`)

The CLI delegates to these functions; you can call them from a script too. Each goes through a
`Runner`, without a shell.

| Function | Does |
|---|---|
| `up()` | Refuses a component that runs beside the app in Docker (`compose`: expose-cloudflare-tunnel, proposals-local). Then the components' `beforeDeploy` hooks; `bun install --frozen-lockfile`; each UI project's install and build (every folder of `src/` with a `package.json` but `src/pikit/`); the unit or plist written; the service (re)started (`daemon-reload`, `enable`, `restart`; or `bootout`, `bootstrap`); then it waits up to 45 s until the service is active and `/health` answers 200, and runs the components' `afterDeploy` hooks with `PIKIT_PUBLIC_URL` |
| `down()` | Stops the service, unloads it and removes its file. `.pikit/` stays |
| `restart()` | `systemctl --user restart`, or `launchctl kickstart -k`: the files as they are |
| `logs({ follow, tail })` | `.pikit/logs/app.log` and its rotated files, oldest first; `--follow` follows it across rotations |
| `status()` | The supervisor's view (state, pid, restarts, last exit), `GET /health` and `GET /ready`, and linger on Linux |
| `exec({ command })` | Runs a command here, in the project, with `.env`: `pikit configure` logs in to a model with it, and `pikit up` checks the logins with it, where the app reads them |
| `dev()` | Refuses while the service runs; else builds each UI project once and runs `main.ts` with `bun --watch` |
| `doctor()` | `pikit doctor`'s check: notes only, so `pikit dev` is never blocked; `up` refuses on its own |

A problem before the restart (a hook, the install, a build) leaves the running service alone. One
after it (no `/health` within 45 s) prints the last lines of both logs and leaves the service
installed and restarting, as a container that fails `docker compose up --wait`: fix it and `pikit up`
again, or `pikit down`.

**Before the restart: the components' `beforeDeploy` hooks. Once it answers: their `afterDeploy`
hooks.** The same as deployment-docker's, with the same `BeforeDeployIO` and `AfterDeployIO`. What
registers a webhook needs `PIKIT_PUBLIC_URL`, where the platform reaches this machine (a TLS proxy, a
tunnel you run yourself); without it, `up` runs none and says which it skipped.

Read the log with `pikit logs`, or `jq 'select(.level == "error")' .pikit/logs/app.log`.

## Not here

- **Services beside the app**: `compose` in a component.json means "run by deployment-docker". A
  tunnel (`expose-cloudflare-tunnel`) as a second unit is not built.
- **Self-improvement's deployer** is built only for deployment-docker. With proposals-local installed,
  `pikit up` here refuses its Compose file, even though the wizard currently offers the feature.
  The missing local deployer, isolation, rollback and verification are recorded in
  [features/deployment-local.md](https://github.com/ajarellanod/pikit/blob/main/features/deployment-local.md),
  "Self-improvement without Docker".
- **A unit of the system, with a user of its own** (started at boot without a login, fenced from your
  home): it needs `sudo`. Not built.
- **A hung process**: like Docker's healthcheck, the watchdog restarts on a 503, not on a process that
  stops answering (that needs systemd's `WatchdogSec` and `sd_notify`).
- **Windows**: WSL2 with systemd is Linux here; native Windows is not supported.

## Removing it

`pikit down` first: `pikit remove deployment-local` deletes `src/pikit/deployment-local/` and runs
nothing, so a unit still installed would keep running files that are gone (`pikit doctor` cannot see
it once the component is gone). `.pikit/` is never touched.

## Tests

The tests are copied with the component and run in your project:
- `entrypoint.test.ts` runs the entrypoint in a child process with a fixture app
  (`entrypoint-fixture.ts`): deployment-docker's cases (failed and late starts, the K2 rollback bound,
  SIGTERM and SIGINT, a failed stop, a second signal, a signal during the start, `main.ts` running the
  project's `pikit.config.ts`), the watchdog (a 503 stops the app and exits 1; a 200 or a refused
  connection restart nothing), and `main.ts` under the supervisor writing `.pikit/logs/app.log`.
- `logger.test.ts`: deployment-docker's (lines, levels, errors, redaction, odd fields), and the file:
  private, rotated by size with five files kept, continued after a restart, never throwing.
- `supervisor.test.ts`: the names; the unit and the plist as written (the program, `.env` only,
  restart always, the stop budget above the stop deadline); escaping; a path a unit cannot hold;
  `systemctl show` and `launchctl print` parsed. On macOS `plutil -lint` checks the plist; on Linux
  `systemd-analyze verify` checks the unit.
- `commands.test.ts`: with a fake `Runner` playing systemd and launchd, and a fake `fetch`: the exact
  argv of `up` on each, the UI builds, an install or hook problem touching nothing, a Compose component
  refused, a port already taken, `/health` never answering (the logs' last lines), without server-bun,
  linger and the shell's notes; `down` keeping `.pikit/`; `restart`, `status`, `logs` (rotated files,
  `--tail`, `--follow` across a rotation), `exec`, `dev` refusing while the service runs, and
  `doctor`'s notes. No supervisor needed.

`component.json`'s capability fields are generated. With no `setup`, it provides and requires no
runtime capabilities. Its `files` maps `files/src` to `src`.
