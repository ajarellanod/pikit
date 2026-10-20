# deployment-celld

Runs a pikit project of the `durable` target on your own machines with
[celld](https://celld.dev) (`denoland/celld`, self-hosted Durable Objects, beta): the Worker and its
`Conversation` objects running the project's two Apps, `wrangler.jsonc`, the commands
`pikit up | down | logs | status | dev` delegate to, a deploy script for CI, and templates for the
nodes (SPEC §4.1: C1, C4, C5, C8). It is the second provider of the `durable` target, beside
`deployment-cloudflare`: the same Apps and components run unchanged (`storage-do`, `actors-do`,
`secrets-workers`, `execution-do`, `channel-telegram-webhook`; [features/deployment-celld.md](https://github.com/ajarellanod/pikit/blob/main/features/deployment-celld.md), "The
spike").

- **Provides:** nothing. It is not an app component and is not listed in `pikit.config.ts`: it runs
  the Apps rather than running inside them.
- **Requires:** nothing. It runs whatever `pikit.config.ts` composes: its default export in each
  Durable Object, and `export const worker` in the Worker.
- **Target:** `durable`. Only `entrypoint.ts` imports `cloudflare:workers` (celld provides it); only
  what runs where the deploy runs imports `node:*`: `commands.ts` on your machine, and the plain Node
  scripts `celld-config.mjs`, `bucket.mjs`, `rollout.mjs` and `deploy.mjs`, there and in CI.
- **Installs to:** `src/pikit/deployment-celld/`, plus `wrangler.jsonc` at the project's root.
- **npm dependencies:** `@pikit/contracts`; `esbuild` 0.28.1 as a dev dependency, which celld bundles
  the Worker with (`CELLD_ESBUILD` is set to the project's).
- **Needs on the machine that deploys:** `celld` 0.6.1 or later (`curl -fsSL https://celld.dev/install.sh | sh`:
  Linux x86-64 and ARM64, macOS ARM64; or `PIKIT_CELLD_BIN`), and Node 22 for a CI deploy.
- **Environment** (`pikit configure` offers each; none is required by `pikit dev`):

  | Variable | What | Where it goes |
  |---|---|---|
  | `CELLD_BUCKET` | the fleet's bucket: `s3://name[/prefix]`, `gs://…`, `az://…` | celld's process, never the Worker |
  | `PIKIT_CELLD_URL` | the fleet's public URL (`https://bot.example.com`) | `up` waits for `/health` there; the `afterDeploy` hooks get it |
  | `S3_ENDPOINT`, `AWS_REGION` | a non-AWS bucket's endpoint and region (R2: `auto`) | celld's process |
  | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the bucket's key (R2: an S3 API token) | celld's process, and the rollback |
  | `PIKIT_CELLD_SSH` | the nodes' SSH destinations, for `logs` and `down` | this machine |

  Everything else in `.env` is the app's: the Worker gets it (below, "Secrets").

## Your assistant on your machines

```sh
pikit new my-agent --target durable --preset celld
cd my-agent
pikit configure   # the admin token, model key, fleet bucket and public URL
pikit dev         # one local node; dashboard at http://127.0.0.1:9876/admin/
pikit up          # deploy to the fleet and wait for /health
```

The dashboard is included and no external channel is selected by default. The first agent is
Steward (`src/agents/steward/agent.ts`). Add `--with agents-folders` for several code agents.
`pikit up` needs a fleet: nodes running celld against the bucket, behind HTTPS ("Running a fleet").
`pikit dev` needs none: one node with a local store in `.celld/dev`, `.env` as the Worker's variables.

For Telegram, select `--with channel-telegram-webhook` at creation, or install the channel later.
It asks for the bot's token, allowed users and webhook secret. Telegram cannot reach `celld dev`
directly; use the deployed public URL, or post test updates to `http://127.0.0.1:9876/telegram`
with `X-Telegram-Bot-Api-Secret-Token`. Other channels are opt-in in the same way.

## What it does

### Two Apps (`worker.ts`, `entrypoint.ts`, `host.ts`)

The same host as `deployment-cloudflare`'s, kept apart (a component never imports another's files):
read that README, "Two Apps", for the object's start inside `blockConcurrencyWhile` (20 s deadline,
5 s rollback), the guard alarm, the Worker's routes and `/health`. A fix to one belongs in the other.
What differs on celld:

- **`/health`'s version** is the Worker's variable `PIKIT_DEPLOYMENT`, which every deploy sets to a new
  id (`20261019T120000Z-a1b2c3`): celld has no `version_metadata` binding. `{ "ok": true, "version":
  "<id>" }`; `"dev"` under `pikit dev`.
- **The client's address** a route sees (`x-pikit-client-address`) is the last address of
  `x-forwarded-for`, the one the proxy in front of celld appended (Caddy, a load balancer). celld sets
  none, so the public listener must be reachable from that proxy only (`nodes/firewall.nft`), or a
  client could claim any address. Without a proxy, routes see none.
- **The origin** (`WORKERS_HOST.origin`, where the Telegram webhook registers itself) is the public
  `https://` URL when the nodes run with `CELLD_TRUST_FORWARDED_HEADERS=1` behind a proxy that sets
  `X-Forwarded-Proto` and `X-Forwarded-Host` (Caddy does): `nodes/celld.env` sets it.
- **Objects move.** An object is evicted when idle (`CELLD_IDLE_EVICT_S`) and handed to another node
  when its node stops; it starts its App again on its next event, as after an eviction on Cloudflare
  (K6). celld cancels a running alarm when it hands the object off, and the next owner runs it again.

### `wrangler.jsonc`, and the config celld reads

`wrangler.jsonc` is the project's one Worker config, the same shape as on Cloudflare: one Durable
Object class, `Conversation`, bound as `CONVERSATION`, SQLite-backed by migration `v1`,
`nodejs_compat`, `.md` files imported as text, and a `build.command` that builds the UI projects.
celld refuses keys it does not know, needs a `name`, and takes rules differently, so each `pikit up`,
`pikit dev` and `deploy.mjs` derives the config celld reads, `wrangler.celld.jsonc`
(`celld-config.mjs`), and deletes it after. Never edit or commit it: `pikit new` ignores it in
`.gitignore`, and `up` refuses in a git repository that does not.

| `wrangler.jsonc` | `wrangler.celld.jsonc` |
|---|---|
| `build`, `observability`, `version_metadata` | dropped (pikit runs `build.command` itself; logs are the nodes'; `/health` reports `PIKIT_DEPLOYMENT`) |
| no `name` | `name`: `wrangler.jsonc`'s if it has one, else `package.json`'s in the letters celld accepts (`my_bot.v2` → `my-bot-v2`) |
| `rules` with `fallthrough`, a module glob (`@jitl/quickjs-wasmfile-release-sync/wasm`) | `type` and `globs` only, globs of the form `**/*.ext` only; a rule left with none is dropped. celld bundles every `**/*.wasm` import as a compiled module by itself (execution-do's QuickJS) |
| `vars` | `vars`, plus the secrets and `PIKIT_DEPLOYMENT` |
| everything else | as it is: celld refuses what it does not support, naming it |

A secret may not take the name of a variable of `wrangler.jsonc`, of another binding
(`CONVERSATION`), or `PIKIT_DEPLOYMENT`: the deploy stops, saying which (so does `pikit doctor`).

**The UI build.** `build.command` (every folder of `src/` with a `package.json` but `src/pikit/`:
`bun install --frozen-lockfile && bun run build`, which writes `src/pikit/<component>/<folder>-files.ts`)
runs before celld bundles: in `up`, in `deploy.mjs` (so CI needs Bun), and once at the start of
`dev` (then the CLI builds a UI project again when its files change, and `celld dev` reloads the
module it writes). A build that fails stops the deploy: no Worker ships an old or empty page.

### The commands (`commands.ts`)

| Function | Runs |
|---|---|
| `up({ url })` | the components' `beforeDeploy` hooks, the UI build, `celld deploy --config wrangler.celld.jsonc --json`, then `GET <PIKIT_CELLD_URL>/health` every 2 s until it answers ok from the new `PIKIT_DEPLOYMENT` (3 min at most), then the components' `afterDeploy` hooks; or the rollback below. Resolves with `{ version, celldVersion, worker, location, url }` |
| `dev()` | `celld dev wrangler.celld.jsonc` (one node, a local store in `.celld/dev`, `http://127.0.0.1:9876`, rebuilding on change) |
| `status({ url })` | what `up` deployed from this machine (`.pikit/deployment-celld.json`), `celld diagnose --read-only --json` (the bucket, each node's lease and probe), `GET /health` |
| `logs({ follow, tail })` | `ssh <node> journalctl --unit=celld.service --output=cat` on every node of `PIKIT_CELLD_SSH` at once, each line led by its node (`--lines`: `tail`, 100, or 10 with `--follow`) |
| `down()` | `ssh <node> sudo systemctl stop celld.service`, one node at a time. **It deletes nothing** |
| `doctor(io)` | `pikit doctor`'s check (below) |

celld runs from the PATH (`PIKIT_CELLD_BIN` names another), without a shell, in the project's
directory, with the environment and `.env`'s deploy settings (an exported variable wins).

**`up` waits for the deployment (C8).** `celld deploy` writes the deployment to the bucket and moves
its pointer, `deploy/current.json`; each node polls it (`CELLD_DEPLOY_POLL_S`, 30 s by default) and
adopts the new deployment in place, without a restart (a busy object moves once its request ends, at
most `CELLD_DEPLOY_MAX_AGE_S` later). `up` resolves only once `/health` answers ok from the id it
deployed, so whatever registers against the fleet next (the Telegram webhook) reaches it. Behind a
load balancer, the first node to adopt answers first; the others follow within the poll.

**`logs` and `down`** reach the nodes over SSH because celld has no command for either (`BatchMode`:
use a key; `down` needs `sudo` for `systemctl stop celld` without a password, or root).
`PIKIT_CELLD_UNIT` names another unit. Without `PIKIT_CELLD_SSH` they say where to look instead: each
node's journal (`journalctl -u celld -f`), or `CELLD_OTEL` (celld's logs and traces as Parquet in the
bucket, or to an OpenTelemetry collector). On ECS, the logs are in CloudWatch
(`nodes/ecs/task-definition.json`), and stopping is the service's desired count. **`down` stops,
never deletes**: the deployment and every conversation stay in the bucket, and starting the nodes
serves them again. celld has no command to delete a deployment (denoland/celld#181): to delete
everything, empty the bucket, or its prefix.

No `restart` (a node restarts with `systemctl restart celld`, one at a time; a new deployment needs
none) and no `exec`: nothing runs a command where the app runs, so model keys go in `.env`.

### Secrets

celld has no secrets (denoland/celld#190, open; 0.5 removed the per-node `CELLD_VAR_*` overlay), and
nothing reaches a Worker but its config's `vars`. So the secrets go there, as on Cloudflare they go
with each version:

- `pikit up` reads `.env`, and gives every set variable but the deploy settings (`CELLD_*`, `AWS_*`,
  `S3_ENDPOINT`, `AZURE_*`, `GOOGLE_*` credentials, `PIKIT_CELLD_*`, `CLOUDFLARE_*`) to the Worker.
  Those stay on your machine: celld's process gets them, the Worker never does.
- They are written into `wrangler.celld.jsonc` only while `celld deploy` runs: created anew with mode
  0600, deleted after (also when the deploy fails), ignored by git. Never into a committed file.
- `celld deploy` stores them in the deployment's manifest in the bucket, in plain text, as celld
  stores every `vars`. **The bucket is the fleet's trust boundary**: its credentials already give full
  control of the fleet (celld's docs: "Treat access to the bucket and its credentials as fleet
  administrator access"), and every conversation is in it. Use a bucket for the fleet alone, keys
  scoped to it, encryption at rest (S3's default SSE, R2's), and no public access.
- celld keeps every deployment, old values included (no prune yet). A secret that leaked is revoked
  where it was issued (BotFather, OpenRouter), then `pikit up` with the new one: redeploying alone
  does not erase the old.
- `pikit dev` writes `.dev.vars` (0600, ignored by git) from `.env` without the deploy settings,
  because `celld dev` reads `.dev.vars` instead of `.env`, and deletes it when it exits. It writes it
  again when `.env` or `wrangler.jsonc` change.
- A CI deploy takes them from the job's environment (below).

Encrypting the values with a key the nodes hold does not help while celld can hand a Worker nothing
but `vars`: the key would sit in the same bucket. When celld has secrets, this is where they change.

### Rolling back (`rollout.mjs`, `bucket.mjs`)

celld has no rollback command (denoland/celld#181), but it keeps every deployment's objects
(`deploy/<worker>/<celld version>/`, never changed) and selects the fleet's with one pointer,
`deploy/current.json` (and `deploy/<worker>/current.json`), which the nodes converge to ("Changing
this is a deploy", celld's `protocol.rs`). So every deploy, `up`'s and `deploy.mjs`'s, by the same
file:

1. reads the pointer before deploying;
2. if the new deployment answers `/health` that its App does not start, or does not answer within
   3 minutes, writes the previous pointer back, the Worker's then the fleet's, **each only if it is
   still the one this deploy wrote** (`If-Match` on its ETag): a deploy that landed since is never
   undone. The nodes adopt it at their next poll. The log says so in one line: `pikit: <id> (celld
   version <v>) failed /health: rolled back to celld version <previous>`. The deploy fails all the
   same.
3. **Not across a change of Durable Object classes:** when the previous deployment's manifest lists
   other classes (`do_classes`, `sqlite_classes`), nothing is rolled back and the deploy fails saying
   so, as on Cloudflare: a migration goes forward. Fix it forward.
4. A first deploy has nothing to go back to. A deployment that answers, but whose `afterDeploy` hooks
   fail, is never rolled back: what failed is outside it.

pikit reads and writes the bucket itself (AWS Signature V4, `bucket.mjs`, checked against AWS's
published examples), so the rollback needs **an S3-compatible bucket** (`s3://`: AWS S3, R2,
Tigris; MinIO, rustfs) **and its keys in the environment** (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; no instance role, no `~/.aws` profile). Otherwise (a
`gs://` or `az://` bucket, an instance role) the deploy runs, `pikit doctor` notes that a failure
cannot be rolled back, and one that fails stays, saying so. `rollback: false` keeps a failing one.

### Deploy from CI (`deploy.mjs`, `ci/deploy.yml`)

Self-improvement on `durable` deploys every merge (an approved proposal is merged, then deployed): on
Cloudflare, Workers Builds runs `deployment-cloudflare`'s `deploy.mjs`; here a CI job runs this
component's, with only Node and celld:

```sh
node src/pikit/deployment-celld/deploy.mjs [<after-deploy script>…]
```

It builds the UI projects, reads the pointer, deploys with a new `PIKIT_DEPLOYMENT`, waits for
`/health` at `PIKIT_CELLD_URL`, rolls back by the rules above (exit 1, so the job fails), then runs
each after-deploy script given: `node <script> <url> <id>` (`channel-telegram-webhook`'s
`setup-webhook.mjs` registers the webhook). The Worker's variables are the ones `.env.example` names
(every installed component's, and yours if you add them there or to `PIKIT_CELLD_VARS`, names
separated by commas) that the job's environment sets, but the deploy settings; it says which are not
set. It runs no `beforeDeploy` hook: commit what they write (`tool-mcp`'s `seed.ts`) before merging.
`PIKIT_HEALTH_WAIT_MS` and `PIKIT_HEALTH_INTERVAL_MS` change the wait.

`ci/deploy.yml` is a GitHub Actions workflow for it: copy it to `.github/workflows/deploy.yml`, set
the repository's variables (`CELLD_BUCKET`, `PIKIT_CELLD_URL`, `AWS_REGION`, `S3_ENDPOINT`) and
secrets (the bucket's keys, and one per secret of `.env.example`, each listed in its `env`). It runs
one deploy at a time (`concurrency`, never cancelled halfway), installs the celld release the fleet
runs, and pins it: change `CELLD_VERSION` when you upgrade the nodes.

### `doctor`

`pikit doctor` (and so `pikit dev` and `pikit up` first) runs `doctor` in `commands.ts`:

- problems: celld missing or older than 0.6.1; no esbuild (`bun install`); a `wrangler.jsonc` that
  cannot be derived (a secret named like a binding, a name celld refuses);
- notes: `CELLD_BUCKET` or `PIKIT_CELLD_URL` not set (`up` needs them, `dev` does not); with a
  bucket, `celld diagnose --read-only --json` (it reads the leases and probes each node, writing
  nothing; 20 s at most): the bucket's error, `no node serves it yet`, or the number of nodes; and
  whether a failed deploy can be rolled back from this machine.

## Running a fleet

A fleet is the nodes that share a bucket: one `celld` process per machine, finding the others through
leases in the bucket (no join, no membership list). `pikit up` deploys to the bucket; the nodes adopt
it. The numbers below are the spike's ([features/deployment-celld.md](https://github.com/ajarellanod/pikit/blob/main/features/deployment-celld.md), "Stability").

**The bucket.** It must provide conditional writes, exact ranged reads and read-after-write
consistency: **AWS S3, Cloudflare R2, Google Cloud Storage, Tigris** qualify (S3 tested by the
spike; rustfs worked locally); **Hetzner Object Storage, DigitalOcean Spaces and Backblaze B2 do
not**. MinIO passes the test but is not qualified for production. Check one with
`celld diagnose --bucket s3://<name>` (it writes and deletes one small object). Put it in the nodes'
region: every activation reads it. One bucket (or prefix: `s3://bucket/prod`) per fleet.

**Two nodes at least.** A write is acknowledged once a follower node has it on disk (about 20 ms); a
single node waits for the bucket on every write (about 90 ms region-local, several per turn). Three
keep three copies.

**Each node keeps its identity and its disk.** A fixed `CELLD_NODE` and `CELLD_WATCH` on a disk that
outlives the process, under a supervisor that restarts it: a bucket outage makes every node fence
itself and exit (code 3) within about 10 s, and with the same identity and disk everything recovers
(the spike: 3,798 messages, none lost). A node back with a new identity or an empty disk cannot
vouch for the writes it acknowledged, and the conversations active during the outage stay blocked,
with no documented way out. So: VMs, or ECS on EC2 with a volume per instance; never Fargate (its
tasks come back with an empty disk).

**Networks.** The internal listener (peers, and an operator API without authentication) on a private
network only: a VPC, WireGuard or Tailscale; peer traffic is plain text. The public listener behind
TLS (Caddy, or a load balancer checking `/.well-known/celld/health`, which answers 503 while a node
drains or joins), and reachable from that proxy only.

### On VMs: systemd, Caddy, nftables (`nodes/`)

- `nodes/celld.service`: the systemd unit (`Restart=always`, `TimeoutStopSec=90`, above celld's
  40 s handoff; `CELLD_WATCH` under `/var/lib/celld`), and `nodes/celld.env`, each node's settings
  (`/etc/celld/celld.env`, 0600): the bucket and its keys (or an instance role), a fixed `CELLD_NODE`,
  `CELLD_ADDR` (public, for Caddy), `CELLD_INTERNAL_ADDR` and `CELLD_ADVERTISE` (private),
  `CELLD_TRUST_FORWARDED_HEADERS=1`, `CELLD_IDLE_EVICT_S`. The steps are at the top of the unit.
- `nodes/Caddyfile`: HTTPS for the public name (`PIKIT_CELLD_URL`), round robin over every node's
  public listener, out of the pool while `/.well-known/celld/health` is not 200, a refused connection
  tried on another node.
- `nodes/firewall.nft`: nftables, a table of its own (celld's Containers keep theirs): 8081 from the
  private network only, 8080 from Caddy only, SSH; 80 and 443 on Caddy's machine.

All nodes run the same celld version: celld's upgrade notes say which upgrades can roll (stop and
start one node at a time) and which must stop the whole fleet.

### On ECS on EC2 (`nodes/ecs/`)

`nodes/ecs/Dockerfile` adds `entrypoint.sh` (and curl and jq) to celld's release image;
`task-definition.json` runs it: `awsvpc` (each task its own IP), the instance's `/var/lib/celld`
mounted, `stopTimeout` 90, a health check on `/.well-known/celld/health` (5 minutes to settle: a new
node is not healthy until the fleet is), logs to CloudWatch. The entrypoint advertises the task's IP
(from the task metadata endpoint) and keeps the node's identity in `/var/lib/celld/node-id`, so a
task restarted on that instance is the same node with the same disk. Create the service with one
task per instance (`--placement-constraints type=distinctInstance`), behind an Application Load
Balancer whose health check is `/.well-known/celld/health`, security groups letting 8080 in from the
load balancer only and 8081 from the fleet's own group only; roll it one task at a time
(`minimumHealthyPercent` that keeps all but one, `maximumPercent` 100). The bucket's keys come from
SSM parameters there; a task role is untested (denoland/celld#225).

### Scaling

- **Scale on memory, not CPU**: a turn waits on the model. About 2 MB per resident conversation (474
  in 930 MB), so 3,000 to 4,000 per 8 GB node. Add a node when a node's lease reports `pressured`, or
  `/state` (internal listener) a positive `capacity_waiting`.
- **Set `CELLD_IDLE_EVICT_S`** (the templates: 300): without it, idle conversations stay in memory
  until pressure. A hibernated one wakes in about 0.1 to 0.4 s.
- A new node takes new activations and idle cells (balancing moves hibernated cells only): a busy
  conversation stays where it is until it sleeps.
- **Scale in one node at a time**, and only while the others report memory headroom. On SIGTERM a node
  hands its conversations off (about 25 s); killed before, they wait for its lease (20 to 35 s). A
  graceful stop is not seamless: Telegram's retries of the `500`/`503` answers during a drain arrive
  (up to about a minute late), none lost; a channel that does not retry sees them.
- `CELLD_LTX_RETENTION_SECS` keeps the bucket from growing at every activation (epoch GC).

## Limits

- celld is beta. Takeover and balancing, which nodes that come and go exercise, are its least proven
  paths: load-test adding and removing nodes before production.
- The rollback is pikit's own pointer write, on S3-compatible buckets with keys in the environment;
  `gs://` and `az://` deploy without it.
- Secrets are in the bucket in plain text (above) until celld has secrets.
- No `version_metadata`: `/health` reports `PIKIT_DEPLOYMENT`, set by pikit's deploys only. A
  `celld deploy` by hand of a config without it answers `version: null`, which `up` never waits for.
- celld's Containers (a real sandbox per conversation) run on Linux only and are not wired here
  ([features/deployment-celld.md](https://github.com/ajarellanod/pikit/blob/main/features/deployment-celld.md), "Sandbox").

## Removing it

`pikit remove deployment-celld` deletes `src/pikit/deployment-celld/` and `wrangler.jsonc`. It never
touches the fleet or the bucket: `pikit down` stops the nodes, and the bucket is yours to empty.

## Tests

The tests are copied with the component and run in your project; none needs celld, a node, a bucket
or the network:
- `celld-config.test.ts`: golden tests of the derived config from the spike's changes, on
  `deployment-cloudflare`'s `wrangler.jsonc` and on this one's; what may be a variable and what stays
  on the machine; names; the derived file's mode.
- `bucket.test.ts`: SigV4 against AWS's published GET and PUT examples, the addressing celld uses,
  conditional writes on a fake S3.
- `commands.test.ts`: `up`, `dev`, `status`, `logs`, `down` and `doctor` through the real runner,
  against a fake `celld` and `ssh` on the PATH, a fake bucket and a fake `/health`
  (`fake-fleet.test-support.ts`): what celld is given and what stays here, the wait, the rollback (a
  failing deployment, one never adopted, one that migrated, a first deploy, a bucket pikit cannot
  write), the UI build, the git check, the hooks.
- `deploy.test.ts`: `deploy.mjs` run by Node, the same way: secrets from the job's environment by
  `.env.example`, the wait, the rollback, the after-deploy scripts.
- `rollout.test.ts`: a rollback that a later deploy overtook, another Worker's previous deployment, a
  missing manifest.
- `host.test.ts`: `deployment-cloudflare`'s host tests, with celld's version and client address.
- `files.test.ts`: `wrangler.jsonc`, the imports, and what the node templates must hold.

Not covered by tests: the templates themselves (systemd, Caddy, nftables, ECS, the workflow) and a
fleet of real nodes; the pikit repository's spike ran the Apps on celld 0.6.1 with two and three
nodes, on rustfs and on S3.

`component.json` is generated, not written by hand. With no `setup`, it provides and requires
nothing. Its `files` maps `files/src` to `src` and names `wrangler.jsonc`; its `devDependencies`,
written by hand, name `esbuild`.
