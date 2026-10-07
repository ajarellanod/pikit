# celld deployment: the durable target on your own machines

**Public appeal:** —

**Specified:** idea, with a spike and stability tests (2026-10-07, celld 0.6.1). It should come: the self-hosted way to
scale out (owner's decision, 2026-10-07).

**Needed by:** nothing required.

## What it gives
The `durable` target (a Worker and one Durable Object per conversation, SPEC §4.1) on machines you
run, with [celld](https://celld.dev) (`denoland/celld`: self-hosted, distributed Durable Objects,
beta). It scales out the way Cloudflare does, one single-writer actor per conversation and the idle
ones hibernated in a bucket, without Cloudflare: VMs or an autoscaled ECS service, and an
S3-compatible bucket you own.

The `server` target scales up only (one process per storage, [replicas](replicas.md)). This is the
self-hosted way to scale out, and it needs no ownership component: celld fences each cell with an
epoch written conditionally in the bucket, as `idFromName` gives one owner on Cloudflare.

## How it fits pikit
- `deployment-celld` is a `deployment-*` component of the `durable` target, a second provider beside
  `deployment-cloudflare` (a new provider of an existing runtime model changes no core, SPEC §4).
  Both Apps stay as they are: `storage-do`, `execution-do`, `platform-cloudflare`,
  `secrets-cloudflare` and `channel-telegram-webhook` ran unchanged in the spike.
- It writes the wrangler config celld accepts (the differences are below), runs `celld deploy` for
  `pikit up` (the nodes adopt a deployment from the bucket within 30 s, no SSH) and waits for
  `/health`.
- It ships templates for the nodes: a systemd unit (a long `TimeoutStopSec`), a Caddyfile and
  firewall rules; and an ECS one (task definition, an entrypoint that advertises the task's IP).
- Absent: `deployment-cloudflare`, as today.

## Pi first
Nothing in Pi: pi-durable runs in the Durable Object as on Cloudflare (`storage/sqlite/cloudflare`),
one conversation per storage, so its global scheduler is no limit here. Its sleeping tasks still
need a host timer ([next wake](../docs/upstream/pi-durable-next-wake.md)): pikit's alarm workaround
runs on celld unchanged.

## The spike
`pikit new --target durable --preset telegram-cloudflare` with `provider-faux` (`faux/scripted`), a
fake Telegram (`apiBase`) and webhook updates posted locally; first on `wrangler dev` as the control.

- **Changes, all in `wrangler.jsonc`:** drop `build`, `observability` and `version_metadata` (celld
  refuses unknown keys; `/health` then reports `version: null`); add `name` (celld requires it, pikit
  passes `--name`); `rules` without `fallthrough` and with `**/*.ext` globs only (dropping the
  `CompiledWasm` rule works: celld's own `**/*.wasm` rule picks up QuickJS). `esbuild` on `PATH` or
  in `CELLD_ESBUILD` (wrangler's works).
- **Unchanged:** the Worker and the object per conversation, `storage.sql`, `transactionSync`,
  `blockConcurrencyWhile`, alarms, pi-durable, `outbound-durable`, `execution-do` (bash, `node -p`,
  files in the object's SQL).
- **An alarm after `kill -9`:** an outbound send failing, celld killed, then restarted with no
  request: the alarm woke the conversation and it delivered once.
- **Failover, two nodes on a bucket** (rustfs; `celld diagnose` passes the conditional writes): the
  owner killed with `kill -9`; the other node answered `500 not taken` until the lease expired
  (20 to 35 s); Telegram's retry of the same update then ran once, with the history and the files.
- **Numbers** (a laptop, the faux model, the bucket on localhost): one conversation 50 to 250 ms;
  100 new ones at once p50 2.5 to 2.9 s; 300 at once p50 6.5 s, all answered. About 2 MB per
  resident conversation (474 in 930 MB), so 3,000 to 4,000 per 8 GB node.

### Stability
A load of 40 conversations (each sends, waits for its answer, sends again; webhooks retried with
backoff the way Telegram does), checked at the end: every accepted message answered exactly once, in
order.

- **Chaos run** (3 nodes; a `SIGTERM`, a fourth node joining, a redeploy under load, three `kill -9`
  of random nodes): 5,806 messages, none lost, none out of order, no unmarked duplicate. Four
  answers were sent again, marked as possible duplicates, after a send was cut mid-flight (three
  had arrived the first time): `outbound-durable`'s at-least-once, as designed.
- **A cut send is retried without a new message:** celld cancels an object's running alarm when it
  hands the object off and its successor runs the alarm again; with the send in flight during a
  `SIGTERM`, the marked answer arrived about 70 s later, with nothing else sent.
- **A graceful stop is not seamless:** a `SIGTERM` drains for about 25 s, during which 110 to 150
  webhook deliveries got `500` or `503` and were retried; a few answers waited up to about a minute.
- **Bucket latency** (toxiproxy, about 50 ms round trip): one node pays it on every turn (about
  260 ms, so several bucket proofs per turn); three nodes do not (23 ms, as with no latency), the
  bucket being off the write path. Activating a conversation still reads it (about 225 ms).
- **A bucket outage of 30 s:** every node fences itself and exits (code 3) within about 10 s, so a
  supervisor must restart it. With a fixed `CELLD_NODE` and `CELLD_WATCH` on a disk that survives
  the restart, everything recovered: 3,798 messages, none lost; the slowest waited the outage.
  **With a new identity or disk at each restart** (what replaced containers get), the conversations
  active during the outage stayed blocked: their recovery needs the old followers' disks to vouch
  for acknowledged writes ("no complete true witness ... refusing seal"), and celld's docs give no
  override.
- **Hibernation** is off by default (`CELLD_IDLE_EVICT_S` unset: only memory pressure or the
  residency cap evict). At 30 s, 300 resident conversations went to 0 and the node's memory from
  911 to about 490 MB (macOS keeps freed pages); waking one took 122 ms, 20 at once p50 475 ms.
- **On real S3** (a bucket in eu-west-1 created for the test and deleted after it, reached from a
  laptop about 42 ms away; `celld diagnose` passes its conditional writes): the chaos run above
  gave 9,919 messages, none lost, none out of order, one marked resend; a warm turn took 256 ms on
  one node and 19 ms on three; a new conversation about 216 ms; waking a hibernated one 355 ms, 20
  at once p50 610 ms. celld does not read `~/.aws`'s credential files: give it environment
  variables or an instance or task role.
- pikit's inbound deduplication held: updates repeated minutes later (the same chat and message id,
  `telegram:<chat>:<message id>`) got no second answer.

### Sandbox (celld's Containers)
A spike tool `sandbox` ran commands in a container per conversation through `@cloudflare/sandbox`
0.12.9 (`getSandbox(env.Sandbox, <object id>)`), beside `execution-do`.

- **Linux only in practice:** on macOS with Docker Desktop the container started and was healthy, but
  celld's nftables fence broke the published-port path and every call hung. Run on Linux (the spike
  used celld inside a `--network host` container in Docker Desktop's VM).
- **Works there:** commands, files kept between turns, background processes, one sandbox per
  conversation with nothing shared. Warm commands 0.1 to 0.4 s; a new sandbox 8 to 10 s. The
  `cloudflare/sandbox` image is x86-64 only: on ARM it runs emulated (3 s per command, 18 s cold in
  the pikit run), so the nodes that run sandboxes should be x86-64.
- **The disk is the container's:** a sandbox that sleeps (`sleepAfter`) lost its files, and a move of
  its object to another node stops its container (celld's docs). `createBackup` and `restoreBackup`
  of `/workspace` through an R2 binding (`localBucket`) worked: about 20 s and 10 s, emulated.
- **`max_instances` caps the fleet's containers;** past it the start fails and the SDK keeps
  retrying, so a call hangs instead of failing: the tool needs its own timeout.
- A node killed outright leaves its containers running; they need cleaning up.
- `@cloudflare/sandbox` imports `cloudflare:workers`, so `pikit doctor` cannot compose a config that
  imports it under Bun: the sandbox belongs apart (as SPEC §6 puts `execution-cloudflare-sandbox` in
  a Worker of its own).

## Nodes and autoscaling
- Nodes find each other through leases in the bucket: no join, no membership list. The internal
  listener goes on a private network only (a VPC, Tailscale or WireGuard): peer traffic is plain
  text and the internal listener has an operator API without authentication. The public listener
  sits behind TLS (Caddy, or a load balancer checking `/.well-known/celld/health`).
- Two nodes at least: a write is acknowledged on a follower's fsync, while one node alone waits for
  the bucket on every write (about 90 ms, celld says). Three keep three copies.
- A new node takes new activations and idle cells (balancing moves hibernated cells only); a busy
  conversation stays where it is until it sleeps.
- Scale on memory or resident cells (celld's `/state`), not CPU: a turn waits on the model.
- Scale in one node at a time. On `SIGTERM` a node hands its cells off (about 25 s in the spike);
  killed before that, they are unavailable until the lease expires. Fargate caps `stopTimeout` at
  120 s, ECS on EC2 allows more; celld's Containers cannot run on Fargate.
- **A node keeps its identity and its disk:** a fixed `CELLD_NODE` and `CELLD_WATCH` on storage that
  outlives the process, under a supervisor that restarts it (a bucket outage makes every node exit).
  That rules out tasks that come back with a new disk (Fargate): ECS on EC2 with a volume per node,
  or VMs.
- Set `CELLD_IDLE_EVICT_S`, or idle conversations stay in memory until pressure.
- The bucket: R2, S3, GCS or Tigris. Hetzner Object Storage, DigitalOcean Spaces and Backblaze B2 lack
  the conditional writes (celld's docs); MinIO passes but is not qualified, and no longer ships
  binaries or a Docker Hub image.

## Open questions
- Secrets: celld has none yet (`denoland/celld#190`), and `vars` land in the bucket in plain text.
  Wait for it, or encrypt the values and give the nodes the key.
- `/health`'s version without `version_metadata` (C8: `pikit up` waits for the version it deployed):
  the deployment celld's `/state` reports, or a variable the component writes.
- R2, GCS and Tigris are untested (S3 is tested); and a fleet in the bucket's region, not a laptop.
- Channels that do not retry see the `500`s of a failover or a drain (`channel-http` has no
  `durable` twin yet).
- What an operator does when a node's disk is lost for good: blocked conversations and no documented
  way to accept the loss.
- ECS credentials through the task role (the standard AWS chain; untested; `denoland/celld#225`).
- A sandbox `execution` component on celld's Containers: pi-durable's `ExecutionEnv` over the
  sandbox, its workspace backed up to the bucket when it sleeps and restored when it wakes
  ([sandboxed execution](sandboxed-execution.md)).
- celld is beta, and nodes that come and go (autoscaling) exercise takeover and balancing, its least
  proven paths: a load test that adds and removes nodes comes before production.
