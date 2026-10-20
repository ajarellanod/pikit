# Targets

A target is a runtime model (SPEC §4, K1): how code lives, not whose machine it is. A project is made
for one (`pikit new --target`, recorded in `pikit.json`'s `targets`), and every component it installs
must list it in its `targets`. Most components list both and are the same code on each; the few that
touch how code lives come one per target. A provider of a target is a `deployment-*` component.

| | `server` | `durable` |
|---|---|---|
| Model | one long-lived process | one actor (Durable Object) per conversation, evicted between events |
| Provider today | `deployment-docker`; `deployment-local` (a systemd or launchd service of this machine) | `deployment-cloudflare`; `deployment-celld` (your machines, celld) |
| Apps in `pikit.config.ts` | one (default export) | two: the object's (default) and the Worker's (`worker`) |
| Requests arrive at | `server-bun` (Hono on `Bun.serve`, port 3000) | the Worker (deployment-cloudflare's host), then RPC to an object |
| `storage.sql`, `storage.sqlite` | `storage-sqlite`: one file, `.pikit/` | `storage-do`: each object's own SQLite |
| `actor.mailbox` / `actor.inbox` | `mailbox-local`: the App is every key's actor (`scope` `"all"`) | `actors-do`: RPC to `idFromName(key)` (`scope` `"one"`) |
| `wakeups` | `wakeups-timers`: in-process timers, lost on restart | `actors-do`: rows over the object's one alarm, in slices |
| `secrets` | `secrets-env`: the process environment (`.env`) | `secrets-workers`: the Worker's `env` |
| `execution` | `execution-local`: the machine's files and shell; or `execution-gondolin`: a Linux micro-VM per conversation and agent (QEMU), its files on the host | `execution-do`: files in the object's SQL, a simulated shell; or `execution-remote`: a real shell in a sandbox of a host running `execution-serve` (a server, e.g. with execution-gondolin) |
| Telegram | `channel-telegram` (long polling) | `channel-telegram-webhook` (two halves) |
| HTTP API channel | `channel-http` | `channel-http` (two halves: routes in the Worker, the wait in the object) |
| Model logins | `credentials-file` (OAuth or keys) | `credentials-do` (OAuth or keys, in one object; a login made on your machine, uploaded by `pikit configure --login`), or API keys as Worker secrets |

This page does not list every component's targets: a component says them itself. Its
`component.json`'s `targets` is where it runs (`pikit add` refuses another), and its README's
**Targets** line why not elsewhere, and whether that is for good (channel-telegram's long polling
needs a process) or not built yet. A component on both targets
says how it differs, if it does, in its README ("On each target").

`registry validate` refuses `node:*` or `bun:*` imports in the shipped files of a component that
lists `durable`, and `cloudflare:*` in one that lists `server` (tests, and files that run on the
deploying machine, are exempt: `checkImports` in [checks.ts](../packages/cli/src/registry/checks.ts)).
[scripts/boundaries.test.ts](../scripts/boundaries.test.ts) holds the kit packages to their
boundaries (only the adapter imports Pi; the kernel and contracts stay neutral).

## server

- **Process.** deployment-docker's container runs `bun src/pikit/deployment-docker/main.ts`
  (`entrypoint.ts`): it recomposes `pikit.config.ts` with target `server` and a JSON-lines logger,
  starts the App with a 30 s deadline (exit 1 on failure, Docker restarts it), stops it on SIGTERM or
  SIGINT with a 10 s deadline. `compose.yaml`'s `stop_grace_period` is 20 s. deployment-local runs
  the same entrypoint as a service of this machine, in the project's directory: a systemd user unit
  (Linux) or a launchd user agent (macOS) restarts it, with the same 20 s stop budget; its app listens
  on `127.0.0.1` only, logs to `.pikit/logs/app.log`, and restarts on a 503 from `/health`, as Docker's
  healthcheck does. It has no container: the app runs as you (deployment-local's README, "Isolation").
- **Disk.** `.pikit/` is the volume `pikit-state` (deployment-local: the project's own `.pikit/`): the
  SQLite database (conversations, the answers log, the outbox, the key-value store), credentials, the
  agent's workspace. `server` assumes a persistent disk.
- **HTTP.** server-bun serves every `http.route`, plus its own `GET /health` (200, or 503 when
  `health` says `down`) and `GET /ready` (200 between `runtime.ready` and `runtime.stopping`). The
  port is published on `127.0.0.1:3000` only.
- **Timers.** With `wakeups-timers`, a component's requests are in-process timers on the App's clock;
  a restarted process has none, so each component asks again in `start` from its durable state.
- **Limits.** One process per storage: conversations-kv's guarantees across two processes are weaker
  (one replica is the supported setup). Tools run as the server's user: `tool-bash` is a real shell.
- **Dev.** `pikit dev` runs `main.ts` with `bun --watch` and `.env` loaded. With deployment-local,
  `.pikit/` is the service's own, so `pikit dev` refuses while the service runs.
- **Self-improvement** (`proposals-local`): the project is a git repository (`pikit new` makes it
  one); proposals are branches `pikit/self/<topic>` of a bare repository in the volume
  (`.pikit/self/project.git`), which the steward clones (`file://<path>`) into its workspace and
  pushes to with git. An approval in the dashboard is recorded there; the deployer, a second
  compose service `pikit up` starts with the app (profile `self-improvement`, the only one with the
  Docker socket), merges it into `main`, runs the checks in containers without the socket, rebuilds
  and restarts `app`, waits for `/health`, and rolls back on any failure (deployment-docker's
  README). With `execution-local` the approval is the operator's decision, not a lock: the agent's
  shell could forge one. With `execution-gondolin` it is a lock: the shell is in a VM that reaches
  the repository only through `serve` (pushes of `pikit/self/*` branches) and never the decisions.

## durable (Cloudflare)

- **Worker.** `wrangler.jsonc` deploys `src/pikit/deployment-cloudflare/worker.ts`, which imports
  both Apps. The Worker composes `export const worker` once per isolate, on its first request, with
  `WORKERS_HOST` `{ env, origin }`. It serves the Worker App's `http.route`s like server-bun does, and
  its own public `GET /health`, which starts the Worker's App and one object of its own
  (`idFromName("pikit:health")`) and answers `{ ok, version }`.
- **Objects.** One `Conversation` Durable Object (SQLite-backed, bound as `CONVERSATION`) per
  conversation key. It composes the default export on its first event, inside `blockConcurrencyWhile`
  (20 s start deadline, 5 s rollback). A failed start is rethrown so Cloudflare resets the object.
  The object is never stopped: it is evicted without warning (K6). Its RPC methods are `health()`,
  `deliver(type, key, message)`, `call(type, key, message)`, `stream(type, key, message)` and `alarm()`.
- **Halves.** A component that must be in both Apps has a Worker half (`apps.worker` in
  `component.json`). channel-telegram-webhook (route in the Worker, handler in the object), channel-http
  (routes in the Worker, admission and the wait for the answer in the object, inside the call's RPC)
  and admin-api (routes in the Worker, answers in the objects) have two; actors-do, secrets-workers and
  admin-auth-token go in both as they are. See [concepts.md](concepts.md#the-two-apps-on-cloudflare).
- **actor.mailbox / actor.inbox.** In the Worker, `send` and `call` are RPCs to the object
  `idFromName(key)`; in an object, its own key is a local call. A handler resolves once the message is
  durable; the RPC resolves with it.
- **Wakeups and alarms (C3, C4).** An object keeps running only during an event (a request, an RPC,
  an alarm); a promise left after it dies within minutes, and an outbound `fetch` does not keep it
  alive. So all background work is a `wakeups` handler. actors-do keeps requests as rows in
  `actors_do_wakeups` and sets the object's single alarm to the earliest. An alarm runs one
  slice (`sliceMs`, 60 s): due handlers start together, one run per name; at the deadline their
  contexts are cancelled, each asks again, and the next alarm continues. A row is deleted only when
  its handler resolved. A handler that rejects backs off (1 s, 5 s, 30 s, then 60 s). Nothing else may
  set the alarm. When the App cannot start, deployment-cloudflare sets a guard alarm (30 s, doubling,
  up to an hour) so the object is not dropped after Cloudflare's 6 retries.
- **Limits** (measured on the Workers Free plan, SPEC C4): per invocation 30 s of CPU, 50 subrequests
  (1,000 on Paid), about 200 MB of memory, 15 minutes of wall clock for an alarm; a deploy cuts alarms
  in progress (retried). SPEC §4 budgets: bundle ≤ 64 MiB, cold start ≤ 1 s, ≤ 128 MB per isolate, ≤ 6
  concurrent outbound connections. A Durable Object row holds at most 2 MB (a message's images are
  capped at 1 MB on Cloudflare). The Free plan allows 100,000 Worker requests and 100,000 Durable
  Object requests a day. One slice's subrequests are shared by every handler in it: runtime-pi's model
  and tool calls, "typing" renewals (up to 15 a minute), answer pieces (at most 20 per run).
- **Dev.** `pikit dev` is `wrangler dev`: the Worker and its objects in local workerd, state in
  `.wrangler/`.
- **Self-improvement** (`proposals-github`): the steward clones the repository `repo.github` connects
  (Settings → GitHub) and pushes `pikit/self/<topic>` with execution-do's `git`, the same steps as on
  a server (both executions pass `createWorkspaceGitConformance`); CI checks it, the operator's
  Approve merges it, Workers Builds deploys it. **The agent never holds the GitHub credential**, a
  rule every durable `execution` provider keeps (SPEC C7): `git` asks `proposals.remote()` for its
  `authorization()` from trusted code and sends it only to that remote; no variable, command output or
  workspace file (`.git/config` included) contains it.

## Deployment components

A `deployment-*` component runs the App instead of running in it: no default export, never listed in
`pikit.config.ts`. The CLI delegates `pikit up | down | restart | logs | status` to the functions its
`src/pikit/<name>/index.ts` exports (`DeploymentModule`,
[deployment-module.ts](../packages/cli/src/project/deployment-module.ts)); `dev` and `exec` are
optional exports. A project has exactly one.

| Function | deployment-docker | deployment-local | deployment-cloudflare | deployment-celld |
|---|---|---|---|---|
| `up` | `beforeDeploy` hooks, `docker compose up --detach --build --wait` | `beforeDeploy` hooks, `bun install`, the UI builds, the unit or plist written, `systemctl --user restart` or `launchctl bootstrap`, wait until it is active and `/health` answers (45 s), then `afterDeploy` hooks | login check, `beforeDeploy` hooks, `wrangler deploy --tag migrations:<last tag> --secrets-file` (`.env`), wait until `/health` answers from the new version (3 min), roll back if it says its App does not start or never answers (not across a Durable Object migration), then `afterDeploy` hooks | `beforeDeploy` hooks, `build.command`, `celld deploy` of the config derived from `wrangler.jsonc` (`.env`'s secrets as `vars`), wait until `/health` answers the new `PIKIT_DEPLOYMENT` (3 min), roll back by restoring the bucket's previous pointer (S3-compatible buckets; not across a class change), then `afterDeploy` hooks |
| `down` | `docker compose down` (the volume stays) | stop, unload and remove the unit or plist (`.pikit/` stays) | `wrangler delete` (deletes every object's data; only at a terminal) | `systemctl stop celld` on each node over SSH, one at a time (deletes nothing) |
| `restart` | `docker compose restart` | `systemctl --user restart`, `launchctl kickstart -k` | not exported | not exported |
| `logs` | `docker compose logs [--follow] [--tail N]` | `.pikit/logs/app.log` and its rotated files | `wrangler tail` (always follows) | `journalctl -u celld` on every node over SSH (`PIKIT_CELLD_SSH`) |
| `status` | containers, `/health`, `/ready` | the supervisor's state, `/health`, `/ready`, linger | `wrangler deployments list`, `/health` | the last deploy from this machine, `celld diagnose --read-only`, `/health` |
| `dev` | not exported (the CLI runs `main.ts --watch`) | refuses while the service runs; else the UI builds and `main.ts --watch` | `wrangler dev` | `celld dev` (one node, a local store) |
| `exec` | a one-off container of the app (used by `pikit configure --login` and `up`'s credential check) | the command here, in the project, with `.env` | not exported | not exported |

Every UI project (a folder of `src/` with a `package.json`: the dashboard's `src/dashboard/`, a
component's own such as channel-web's `src/chat/`) is built by every deploy: in a stage of the Docker
image, in place by deployment-local's `up`, or by `wrangler.jsonc`'s `build.command`
([dashboard.md](dashboard.md#other-ui-projects)).

On Cloudflare, a deploy without pikit's CLI (a Deploy to Cloudflare template's Workers Builds, which
deploys every merge) runs `node src/pikit/deployment-cloudflare/deploy.mjs` instead of `pikit up`: the
same wait for `/health` and the same rollback, from the same file (`rollout.mjs`), with only Node;
then the after-deploy scripts it is given (the Telegram webhook's). A rollback is one line in the log,
`pikit: <version> failed /health: rolled back to <previous>`. A deploy that changed the Durable Object
classes (a new `migrations` tag) is never rolled back: Cloudflare cannot, and the deploy fails saying
so. deployment-cloudflare's README has the rules ("Rolling back").

On celld (deployment-celld), the same Apps run on your machines: nodes that share a bucket
(R2, S3, GCS, Tigris; two at least), each with a fixed identity and disk, behind TLS. A CI job runs
`node src/pikit/deployment-celld/deploy.mjs` (`ci/deploy.yml`) with the same wait and rollback; celld
has no secrets yet, so they reach the Worker as `vars`, stored in the bucket. Its README has the
rules and the node templates ("Running a fleet").

## What each target cannot do

- **server**: no per-conversation isolation (one process holds every conversation); no horizontal
  scale (one process per storage); timers do not survive a restart by themselves.
- **durable**: no processes or native binaries in the object (a real Linux is a sandbox on a server,
  through `execution-remote`); no connection held between events (no long polling); no `restart`
  and no `exec`, and `down` deletes data (deployment-cloudflare's README).

What a component cannot do on a target is in that component's README: credentials-file (a file: credentials-do on Cloudflare), execution-do
(its simulated shell), admin-api (on Cloudflare, no Delivery view).

Moving a project to the other target is swapping those components, never changing an agent, a route
or a contract. [features/deployment-targets.md](../features/deployment-targets.md) has other hosts and a
possible third target (design notes).
