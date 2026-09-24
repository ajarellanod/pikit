# deployment-docker

Runs a pikit project in Docker on a server: the image, the container, the process entrypoint, its
logs, and the commands `pikit up | down | restart | logs | status` delegate to.

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
following SPEC §9.1:
- It starts the app with a 30 s deadline. If the start fails, it exits 1, and Docker restarts the
  container. The app is never restarted inside the same process.
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
- `.pikit/` (sessions, conversations, model credentials, the agent's workspace) is the volume
  `pikit-state`. It survives `down`, `up` and new images.
- Secrets are never in the image. `.dockerignore` keeps `.env` out of the build, and compose passes
  `.env` to the container when it starts.
- `restart: unless-stopped`, a healthcheck on `GET /health`, and `init: true` (a small PID 1 that
  forwards signals and reaps the commands the agent's tools run).
- The port is published on `127.0.0.1:3000` only. To serve other machines, put a TLS proxy in front,
  or publish `"3000:3000"`, knowing that the bearer token is then the only lock.

These files are yours: edit them. A project that is not a single app (a monorepo, another port) adapts
them, and the tests below keep checking what matters.

### The commands (`commands.ts`)

The CLI delegates to these functions; you can call them from a script too. Each one runs
`docker compose …` in the project's directory (`cwd`), without a shell:

| Function | Runs |
|---|---|
| `up()` | `docker compose up --detach --build --wait`: fails if the app never becomes healthy |
| `down()` | `docker compose down`: the `.pikit/` volume stays |
| `restart()` | `docker compose restart`: a clean stop and a new process; rebuilding is `up()` |
| `logs({ follow, tail })` | `docker compose logs --no-log-prefix [--follow] [--tail N]` |
| `status({ url })` | `docker compose ps --all --format json`, plus `GET /health` and `GET /ready` |

`status()` returns the containers (name, state, health) and each probe's HTTP status, or
`"unreachable"`. The default URL is `http://127.0.0.1:3000`, the port `compose.yaml` publishes.

## Removing it

`pikit remove deployment-docker` deletes `src/pikit/deployment-docker/` and the three root files.
It never touches the `pikit-state` volume: `docker compose down --volumes` deletes the conversations,
and is yours to run.

## Tests

The tests are copied with the component and run in your project:
- `entrypoint.test.ts` runs the entrypoint in a child process with a fixture app
  (`entrypoint-fixture.ts`): a failed or late start exits 1, SIGTERM and SIGINT stop cleanly with 0,
  a failed stop exits 1, a second signal exits at once, a signal during the start cancels it. It
  also runs `main.ts` in a throwaway project to check that it runs the project's `pikit.config.ts`.
- `logger.test.ts`: the shape of a line, levels, errors, redaction, and odd fields that never throw.
- `commands.test.ts`: the exact `docker` argv of every command, `status`'s parsing and probes, with a
  fake runner and a fake `fetch`. No Docker needed.
- `files.test.ts`: the root files keep their promises. Bun ≥ 1.4, a non-root user, no secret in the
  image, `.env` and `.pikit` ignored, a healthcheck on `/health`, and a `stop_grace_period` longer
  than the stop deadline.

`component.json` is generated, not written by hand. With no `setup`, it provides and requires
nothing. Its `files` maps `files/src` to `src` and names each root file (SPEC §10.2).
