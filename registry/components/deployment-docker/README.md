# deployment-docker

Runs a pikit project in Docker on a server: the image, the container, the process entrypoint, its
logs, the commands `pikit up | down | restart | logs | status` delegate to, and self-improvement's
deployer, a second service started by the same `pikit up`, which deploys what an operator approves
and rolls back when unhealthy.

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

- `oven/bun:1.4-slim` with git (the agent's shell runs plain git, committing as "pikit agent"),
  dependencies installed from `bun.lock` with `--production`, running as the unprivileged user `bun`.
  The app is the Dockerfile's last stage; the `deployer` stage is the deployer's image.
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
`docker compose …` in the project's directory (`cwd`), without a shell, with `--profile
self-improvement` when `proposals-local` is installed (so `up` starts the deployer too):

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

### The deployer (`deployer.ts`): self-improvement on a server

Self-improvement's last step (SPEC §6, `proposals-local`): a proposal an operator approves in the
dashboard is deployed by a second compose service, `deployer`, next to the app. Nothing to set up and
no extra command: `pikit up` builds and starts it when `proposals-local` is installed (every command
then passes `--profile self-improvement`), and Docker restarts it with the app. It has the Docker
socket, the project's directory at `/project`, the app's state volume at `/state`, and a volume of
its own, `pikit-checks`, at `/checks`. The app never gets the socket.

What it shares with the app is `.pikit/self/` in the state volume: the proposals repository
(`project.git`, which it makes from the project's `main` and keeps at it), the approvals
proposals-local writes (`decisions.json`: all it takes from the app is "this head of this branch was
approved"), and what it writes back (`deployer.json`: a heartbeat, each approved head's outcome with
its checks, the last deploy, rollback and failure, which the dashboard shows).

Every 10 s it writes its heartbeat, keeps the proposals repository's `main` at the project's, and
deploys the oldest approved head without an outcome:
1. **The project** must be a git repository on `main` with nothing uncommitted (a deploy builds
   `main` plus the proposal: an edit not committed would be lost). Otherwise the approval waits, and
   the dashboard says why.
2. **The merge**, in its own clone (`/checks/repo`): the branch must still be at the approved head; a
   change of the deployment's own files (`compose.yaml`, `Dockerfile`, `.dockerignore`,
   `src/pikit/deployment-docker/`) is refused; then a fast-forward when it can, else a merge commit; a
   conflict fails it.
3. **The checks**, each in a throwaway container of its image with no socket and no secret, as the
   volume's owner: `bun install --frozen-lockfile`, `bun run typecheck` when package.json has it,
   `bun test`; then the components' `beforeDeploy` hooks (`before-deploy.ts`, with `.env`). The
   agent's code runs only there. `pikit doctor` is not run: the CLI is not in the project.
4. **The deploy:** it tags the running app's image `<image>:pikit-previous`, builds the merge
   (`docker build`), recreates `app` (`docker compose up --no-build --force-recreate --no-deps --wait
   app`), and `GET http://app:3000/health` must answer 200.
5. **Deployed:** the project's `main` is fast-forwarded to it (as the directory's owner, through
   `setpriv`, so its files keep their owner), and so is the proposals repository's. A failure before
   step 4 changes nothing; one after it puts the previous image back (`rolled back`). `main` never
   moves for a failed deploy.

Read its log with `pikit logs` (or `docker compose logs deployer`).

**What it trusts.** On a server the agent's shell runs in the app's container, as the app's user: it
can write the proposals repository and `decisions.json`, so it could forge an approval. The approval
is the operator's decision, not a lock. The deployer takes nothing else from the app, refuses changes
of the deployment, runs the agent's code only in containers without the socket, and always checks,
waits for `/health` and rolls back. A real lock needs the agent's commands to run elsewhere
(`features/sandboxed-execution.md`).

**Rootless Docker**, or a socket elsewhere: change the socket's path in compose.yaml's `deployer`.

## Removing it

`pikit remove deployment-docker` deletes `src/pikit/deployment-docker/` and the three root files.
It never touches the `pikit-state` volume: `docker compose down --volumes` deletes the conversations,
and is yours to run.

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
- `deployer.test.ts`: the deployer with real git (a project, the proposals repository, the agent's
  clone) and a fake Docker: the proposals repository made and kept at `main`; an approved branch
  merged, checked in sandboxes, built, recreated, healthy, deployed, `main` following; failing tests
  building nothing; an unhealthy one rolled back; a merge commit when `main` moved, a conflict failed;
  a change of the deployment refused, a branch moved after its approval refused; uncommitted changes
  holding the approval until committed; the loop surviving a failed pass.
- `files.test.ts`: the root files keep their promises. Bun ≥ 1.4, a non-root user, no secret in the
  image, `.env` and `.pikit` ignored, a healthcheck on `/health`, a `stop_grace_period` longer
  than the stop deadline, git in the stage the app and the deployer share, the app the last stage, and
  the Docker socket only in the deployer, behind its profile.

`component.json` is generated, not written by hand. With no `setup`, it provides and requires
nothing. Its `files` maps `files/src` to `src` and names each root file.
