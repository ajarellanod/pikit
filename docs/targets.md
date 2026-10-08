# Targets

A target is a runtime model (SPEC §4, K1): how code lives, not whose machine it is. A project is made
for one (`pikit new --target`, recorded in `pikit.json`'s `targets`), and every component it installs
must list it in its `targets`. Most components list both and are the same code on each; the few that
touch how code lives come one per target. A provider of a target is a `deployment-*` component.

| | `server` | `durable` |
|---|---|---|
| Model | one long-lived process | one actor (Durable Object) per conversation, evicted between events |
| Provider today | `deployment-docker` | `deployment-cloudflare` |
| Apps in `pikit.config.ts` | one (default export) | two: the object's (default) and the Worker's (`worker`) |
| Requests arrive at | `server-bun` (Hono on `Bun.serve`, port 3000) | the Worker (deployment-cloudflare's host), then RPC to an object |
| `storage.sql` | `storage-sqlite`: one file, `.pikit/` | `storage-do`: each object's own SQLite |
| `actor.mailbox` / `actor.inbox` | `mailbox-local`: the App is every key's actor | `platform-cloudflare`: RPC to `idFromName(key)` |
| `wakeups` | `wakeups-timers`: in-process timers, lost on restart | `platform-cloudflare`: rows over the object's one alarm, in slices |
| `secrets` | `secrets-env`: the process environment (`.env`) | `secrets-cloudflare`: the Worker's `env` |
| `execution` | `execution-local`: the machine's files and shell | `execution-do`: files in the object's SQL, a simulated shell |
| Telegram | `channel-telegram` (long polling) | `channel-telegram-webhook` (two halves) |
| HTTP API channel | `channel-http` | none yet |
| Model logins | `credentials-file` (OAuth or keys) | API keys only (no `model.credentials` provider) |

Components on both targets: runtime-pi, conversations-kv, storage-kv-sql, router-basic, router-rules,
outbound-durable, admin-api, admin-auth-token, health-registry, log-events, the tools, the providers,
extension-house-rules. Server only: channel-http, channel-telegram, conversations-file,
credentials-file, execution-local, mailbox-local, secrets-env, server-bun, storage-sqlite,
wakeups-timers, workspace-local, deployment-docker. Durable only: channel-telegram-webhook,
execution-do, platform-cloudflare, secrets-cloudflare, storage-do, deployment-cloudflare.

`registry validate` refuses `node:*` or `bun:*` imports in the shipped files of a component that
lists `durable`, and `cloudflare:*` in one that lists `server` (tests, and files that run on the
deploying machine, are exempt: `checkImports` in [checks.ts](../packages/cli/src/registry/checks.ts)).
[scripts/boundaries.test.ts](../scripts/boundaries.test.ts) holds the kit packages to their
boundaries (only the adapter imports Pi; the kernel and contracts stay neutral).

## server

- **Process.** deployment-docker's container runs `bun src/pikit/deployment-docker/main.ts`
  (`entrypoint.ts`): it recomposes `pikit.config.ts` with target `server` and a JSON-lines logger,
  starts the App with a 30 s deadline (exit 1 on failure, Docker restarts it), stops it on SIGTERM or
  SIGINT with a 10 s deadline. `compose.yaml`'s `stop_grace_period` is 20 s.
- **Disk.** `.pikit/` is the volume `pikit-state`: the SQLite database (conversations, the answers log,
  the outbox, the key-value store), credentials, the agent's workspace. `server` assumes a persistent
  disk.
- **HTTP.** server-bun serves every `http.route`, plus its own `GET /health` (200, or 503 when
  `health` says `down`) and `GET /ready` (200 between `runtime.ready` and `runtime.stopping`). The
  port is published on `127.0.0.1:3000` only.
- **Timers.** With `wakeups-timers`, a component's requests are in-process timers on the App's clock;
  a restarted process has none, so each component asks again in `start` from its durable state.
- **Limits.** One process per storage: conversations-kv's guarantees across two processes are weaker
  (one replica is the supported setup). Tools run as the server's user: `tool-bash` is a real shell.
- **Dev.** `pikit dev` runs `main.ts` with `bun --watch` and `.env` loaded.

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
  `deliver(type, key, message)`, `call(type, key, message)` and `alarm()`.
- **Halves.** A component that must be in both Apps has a Worker half (`apps.worker` in
  `component.json`). channel-telegram-webhook (route in the Worker, handler in the object) and admin-api
  (routes in the Worker, answers in the objects) have two; platform-cloudflare, secrets-cloudflare and
  admin-auth-token go in both as they are. See [concepts.md](concepts.md#the-two-apps-on-cloudflare).
- **actor.mailbox / actor.inbox.** In the Worker, `send` and `call` are RPCs to the object
  `idFromName(key)`; in an object, its own key is a local call. A handler resolves once the message is
  durable; the RPC resolves with it.
- **Wakeups and alarms (C3, C4).** An object keeps running only during an event (a request, an RPC,
  an alarm); a promise left after it dies within minutes, and an outbound `fetch` does not keep it
  alive. So all background work is a `wakeups` handler. platform-cloudflare keeps requests as rows in
  `platform_cloudflare_wakeups` and sets the object's single alarm to the earliest. An alarm runs one
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

## Deployment components

A `deployment-*` component runs the App instead of running in it: no default export, never listed in
`pikit.config.ts`. The CLI delegates `pikit up | down | restart | logs | status` to the functions its
`src/pikit/<name>/index.ts` exports (`DeploymentModule`,
[deployment-module.ts](../packages/cli/src/project/deployment-module.ts)); `dev` and `exec` are
optional exports. A project has exactly one.

| Function | deployment-docker | deployment-cloudflare |
|---|---|---|
| `up` | `beforeDeploy` hooks, `docker compose up --detach --build --wait` | login check, `beforeDeploy` hooks, `wrangler deploy --secrets-file` (`.env`), wait until `/health` answers from the new version (3 min), roll back if it says its App does not start, then `afterDeploy` hooks |
| `down` | `docker compose down` (the volume stays) | `wrangler delete` (deletes every object's data; only at a terminal) |
| `restart` | `docker compose restart` | not exported |
| `logs` | `docker compose logs [--follow] [--tail N]` | `wrangler tail` (always follows) |
| `status` | containers, `/health`, `/ready` | `wrangler deployments list`, `/health` |
| `dev` | not exported (the CLI runs `main.ts --watch`) | `wrangler dev` |
| `exec` | a one-off container of the app (used by `pikit configure --login` and `up`'s credential check) | not exported |

The dashboard is built by every deploy of a project with `src/dashboard/`: in a stage of the Docker
image, or by `wrangler.jsonc`'s `build.command` ([dashboard.md](dashboard.md)).

## What each target cannot do

- **server**: no per-conversation isolation (one process holds every conversation); no horizontal
  scale (one process per storage); timers do not survive a restart by themselves.
- **durable**: no processes or native binaries (`execution-do`'s shell is just-bash with `git`
  (isomorphic-git), `curl` (fetch) and `node` (QuickJS) as host commands; a real Linux is another
  `execution` provider, not built); no long polling; no `channel-http`; no OAuth model login (no
  `model.credentials` provider, API keys in `.env` only); no `restart` and no `exec`; `down` deletes
  data; admin-api's Delivery view has nothing to list (each object's outbox is its own) and live events
  are a snapshot polled every 2 s.

Moving a project to the other target is swapping those components, never changing an agent, a route
or a contract. [features/deployment-targets.md](../features/deployment-targets.md) has other hosts and a
possible third target (design notes).
