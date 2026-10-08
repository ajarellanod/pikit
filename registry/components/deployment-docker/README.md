# deployment-docker

Runs a pikit project in Docker on a server: the image, the container, the process entrypoint, its
logs, the commands `pikit up | down | restart | logs | status` delegate to, and the deployer on the
host (`pikit deploy watch | install`) that deploys each merge into the main branch and rolls back
when unhealthy.

- **Provides:** nothing. It is not an app component and is not listed in `pikit.config.ts`: it runs
  the app rather than running inside it.
- **Requires:** nothing. It runs whatever `pikit.config.ts` composes; for `/health` and `/ready` that
  is a server such as `server-bun` on port 3000.
- **Target:** `server` (it uses the process's signals and `node:child_process`).
- **Installs to:** `src/pikit/deployment-docker/`, plus `Dockerfile`, `compose.yaml` and
  `.dockerignore` at the project's root.
- **npm dependencies:** none. Docker with the Compose plugin on the machine that runs the containers.
- **Environment:** none of its own. The app's variables (`PIKIT_HTTP_TOKEN`, `ANTHROPIC_API_KEY`…)
  are read from `.env` when the container starts.

## What it does

### The process (`main.ts`, `entrypoint.ts`)

The container runs `bun src/pikit/deployment-docker/main.ts`, which runs your `pikit.config.ts`
as SPEC K2 and P5 require:
- It starts the app with a 30 s deadline. If the start fails, it exits 1, and Docker restarts the
  container. The app is never restarted inside the same process.
- At the start deadline, or once the start failed, it stops the app with the 10 s stop deadline,
  which bounds the rollback of the components already started, and exits 1. A component whose stop
  hangs cannot keep a container alive that never serves: the process exits within both deadlines.
- On SIGTERM (`docker compose down`, `docker stop`) or SIGINT (Ctrl-C), it stops the app with a
  10 s deadline and exits 0 if every component stopped, 1 otherwise. `compose.yaml`'s
  `stop_grace_period` is 20 s, so the app stops itself before Docker kills it.
- A signal during the start cancels the start. A second signal during the stop exits at once.

The entrypoint recomposes `pikit.config.ts`'s components and config with its own logger and the
`server` target. A process's log format belongs to where it runs, like its deadlines. A `logger` or
`clock` passed to `defineApp` in `pikit.config.ts` is not visible from outside it, so it does not
reach the container. Pass them to `runEntrypoint` in `main.ts` instead, with the deadlines
(`startDeadlineMs`, `stopDeadlineMs`). Keep `stop_grace_period` above the stop deadline; a test
checks it.

### Logs (`logger.ts`)

One JSON object per line: `debug` and `info` on stdout, `warn` and `error` on stderr.

```json
{"time":"2026-01-02T03:04:05.678Z","level":"info","msg":"pikit: started","components":15}
```

- An error keeps its name, message, stack, cause and code. A stop that failed in several
  components lists every failure.
- A field whose name looks like a secret (`token`, `authorization`, `apiKey`, `password`,
  `cookie`, `credential`…) is written as `"[redacted]"`, at any depth. That is a net, not a
  guarantee: never put a secret's value in a message or under an innocent name.
- A log call never throws. A field that cannot be serialized (a cycle, a `BigInt`, a getter that
  throws) is replaced, and the line is still written.
- `debug` is dropped unless you pass `createJsonLogger({ level: "debug" })` in `main.ts`.

Docker rotates the log files (5 × 10 MB). Read them with `pikit logs`, or
`docker compose logs --no-log-prefix app | jq 'select(.level == "error")'`.

### The image and the container (`Dockerfile`, `compose.yaml`, `.dockerignore`)

- `oven/bun:1.4-slim`, dependencies installed from `bun.lock` with `--production`, running as the
  unprivileged user `bun`.
- A project with a UI (`src/dashboard/`, `pikit ui on`) gets its dashboard built in a stage of its own
  (`bun install --frozen-lockfile` and its `build`, from its own `bun.lock`), whose last step writes
  the built files into admin-api as a module (`src/pikit/admin-api/dashboard-files.ts`): only that
  file reaches the image, over the context's copy, and admin-api serves it at `/admin/`. Without a UI
  the stage builds nothing. No hook builds it before: `up` builds the dashboard once, in the image.
- `vendor/` is copied before the install. Until `@pikit/*` is published on npm, `pikit new`
  vendors those packages there as tarballs, and `package.json` depends on them with
  `file:vendor/…`, so the image builds from the project's directory alone.
- `.pikit/` (the database with the conversations, the registry, model credentials, the agent's workspace) is the volume
  `pikit-state`. It survives `down`, `up` and new images.
- Secrets are never in the image. `.dockerignore` keeps `.env` out of the build, and compose passes
  `.env` to the container when it starts.
- `restart: unless-stopped`, a healthcheck on `GET /health`, and `init: true` (a small PID 1 that
  forwards signals and reaps the commands the agent's tools run). Docker restarts nothing for an
  unhealthy container, so when `/health` answers 503 (`health` says the app is down: health-registry)
  the check sends SIGTERM to PID 1: the app stops cleanly and the restart policy starts it again.
- The port is published on `127.0.0.1:3000` only. To serve other machines, put a TLS proxy in front,
  or publish `"3000:3000"`, knowing that the bearer token is then the only lock.

These files are yours: edit them. A project that is not a single app (a monorepo, another port) adapts
them, and the tests below keep checking what matters.

### The commands (`commands.ts`)

The CLI delegates to these functions; you can call them from a script too. Each one runs
`docker compose …` in the project's directory (`cwd`), without a shell:

| Function | Runs |
|---|---|
| `up({ say })` | The components' `beforeDeploy` hooks, then `docker compose up --detach --build --wait`: fails if the app never becomes healthy |
| `down()` | `docker compose down`: the `.pikit/` volume stays |
| `restart()` | `docker compose restart`: a clean stop and a new process; rebuilding is `up()` |
| `logs({ follow, tail })` | `docker compose logs --no-log-prefix [--follow] [--tail N]` |
| `status({ url })` | `docker compose ps --all --format json`, plus `GET /health` and `GET /ready` |
| `exec({ command, share, interactive })` | `docker compose [--progress quiet] run --rm --build --no-deps [-T] [--volume dir:dir] app …`: a one-off container of the app, resolving with its exit code. Without a person, no terminal and a quiet build (Compose 5.5 fails a `run --build` whose stdout is not a terminal otherwise) |

**Before the build: the components' `beforeDeploy` hooks.** A component may write what the image must
carry before it is built (`tool-mcp` writes `seed.ts`, its MCP servers' tools). It names the file in
its `component.json` (`"hooks": { "beforeDeploy": "deploy.ts" }`), `pikit add` records it in
`pikit.json` by project path, and `up` calls its `beforeDeploy({ config, get, write, say })`: its
config in `pikit.config.ts`, a reader of the environment and `.env`, `write(file, text)` for a file of
its own `src/pikit/<name>/` (only when the text changes), and a line to print. It resolves with its
problems; any problem, or a hook that throws, fails `up` before the build (`BeforeDeployIO` in
`commands.ts`, the same shape as `deployment-cloudflare`'s). `pikit dev` runs none.

`status()` returns the containers (name, state, health) and each probe's HTTP status, or
`"unreachable"`, and the `lines` `pikit status` prints. The default URL is `http://127.0.0.1:3000`, the port `compose.yaml` publishes.

`exec()` runs a command where the app runs: the same image (rebuilt first if the source changed),
`.env` and the `pikit-state` volume, in a separate short-lived container that publishes no ports and
leaves a running app alone. `pikit configure` logs in to a model provider through it, so an OAuth
login lands in the volume the app reads, and `pikit up` checks there that the app has credentials.
There is one copy of each login: the one on your machine (`.pikit/`) is for `pikit dev` only.
Directories in `share` are mounted at the same path, read-only unless `writable`.

### The deployer (`deploy.ts`): `pikit deploy watch | install`

Self-improvement's last step on a server (SPEC §6): a proposal approved in the dashboard is a
merge into the main branch on GitHub, and this deploys it from the host, outside the container (the
app cannot run `docker`). It polls, so the host needs no inbound access.

```sh
git clone https://github.com/you/your-bot && cd your-bot   # the project's directory is a checkout
pikit deploy install          # a systemd user service running `pikit deploy watch --interval 60`
journalctl --user -u pikit-deploy-your-bot -f
```

Every `--interval` seconds (60), `watch` runs `git fetch` and, when the checkout's upstream
(`origin/main`) is at a commit not deployed yet:
1. tags the running app's image `<image>:pikit-previous` (`docker compose ps`, `docker inspect`,
   `docker tag`);
2. `git merge --ff-only` to that commit, then `bun install --frozen-lockfile` (the CLI loads the
   project here);
3. `pikit up`, in a fresh process (doctor, the credentials check, `beforeDeploy` hooks, the build,
   Compose's wait for the healthcheck), then `GET /health` must answer 200;
4. on any failure, it tags the previous image as the app's again, runs
   `docker compose up --detach --no-build --force-recreate --wait`, returns the checkout to the
   deployed commit (`git reset --keep`) and logs `pikit: <commit> failed /health: rolled back to
   <previous>`. That commit is not tried again; the next one is.

It never rolls back across a change `irreversible` names (`noneIrreversible` in `deploy.ts`: none is
known on a server today, since both images share the `.pikit/` volume; edit it for one, such as a
migration an older version cannot read): it says so and leaves the new version running. The first
deploy has no previous image to return to.

What it deployed and the commit that failed are kept in `.pikit/deployer.json` on the host, so a
restarted deployer neither redeploys nor retries; its first start takes the checkout's `HEAD` as
what runs.

`install` writes `~/.config/systemd/user/pikit-deploy-<directory>.service` (`ExecStart` is this CLI,
as it was run, with the current `PATH`), then `systemctl --user daemon-reload` and `enable --now`.
A user service stops when its user logs out unless lingering is on: `install` says to run
`sudo loginctl enable-linger <user>` when it is off. SIGTERM stops the deployer after the deploy in
progress (`KillMode=mixed`, 15 minutes). Without systemd, run `pikit deploy watch` under a
supervisor of your own. To remove it: `systemctl --user disable --now pikit-deploy-<directory>`,
then delete the file.

What the host needs: the checkout, with read access to the repository (a read-only deploy key, or
HTTPS with a credential helper: the deployer adds no credential), kept clean (a local change stops
the fast-forward and nothing is deployed until it is cleaned), Docker usable by its user (the
`docker` group, or rootless Docker), Bun and the pikit CLI. Do not run `pikit up` by hand while it
deploys.

## Removing it

`pikit remove deployment-docker` deletes `src/pikit/deployment-docker/` and the three root files.
It never touches the `pikit-state` volume: `docker compose down --volumes` deletes the conversations,
and is yours to run. A deployer service installed stays: disable it first.

## Tests

The tests are copied with the component and run in your project:
- `entrypoint.test.ts` runs the entrypoint in a child process with a fixture app
  (`entrypoint-fixture.ts`): a failed or late start exits 1, even when its rollback hangs (the K2
  conformance case: it exits within both deadlines), SIGTERM and SIGINT stop cleanly with 0,
  a failed stop exits 1, a second signal exits at once, a signal during the start cancels it. It
  also runs `main.ts` in a throwaway project to check that it runs the project's `pikit.config.ts`.
- `logger.test.ts`: the shape of a line, levels, errors, redaction, and odd fields that never throw.
- `commands.test.ts`: the exact `docker` argv of every command, `status`'s parsing and probes, the
  components' `beforeDeploy` hooks run before the build (their own files written once, a problem
  building nothing), with a fake runner and a fake `fetch`. No Docker needed.
- `deploy.test.ts`: the deployer against a fake host (git, Docker, `pikit up`, `/health`): no new
  commit does nothing; a new one is tagged, merged, installed, deployed; an unhealthy one, or a
  failing `pikit up` or `bun install`, rolls back to the previous image and is not retried; never
  across an irreversible change; the loop survives a failed poll; the systemd unit `install` writes.
- `files.test.ts`: the root files keep their promises. Bun ≥ 1.4, a non-root user, no secret in the
  image, `.env` and `.pikit` ignored, a healthcheck on `/health`, and a `stop_grace_period` longer
  than the stop deadline.

`component.json` is generated, not written by hand. With no `setup`, it provides and requires
nothing. Its `files` maps `files/src` to `src` and names each root file.
