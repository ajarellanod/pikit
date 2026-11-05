# execution-cloudflare-sandbox

A sandbox host on Cloudflare Containers: a Linux container per sandbox id and agent, served over
HTTP with execution-serve's protocol, so `execution-remote` (in any pikit App, on a server or in a
Durable Object) reaches it as one more host. Each agent can have its own image and instance size.
When a sandbox goes idle, its workspace is saved to `storage.blob`, and it comes back on the next
operation. **It never gets secrets.** It runs in a Worker of its own (SPEC §6: a Worker with containers
gets no Previews), with no runtime, no agents and no channels.

- **Provides:** `http.route`, under `POST /execution/v1/sandboxes/:sandbox/:operation`, in the
  Worker's App (`worker`).
- **Requires:** `secrets` in the Worker's App (the token) and `storage.blob` in the default App (the
  snapshots; `storage-blob-s3`).
- **Target:** `durable`, on Cloudflare only. Containers are Cloudflare's (Workers Paid), and celld's
  Containers are not supported ([features/deployment-celld.md](https://github.com/ajarellanod/pikit/blob/main/features/deployment-celld.md)).
- **Installs to:** `src/pikit/execution-cloudflare-sandbox/`: the two halves, the `Sandbox` Durable
  Object class, the images (`images/`) and the host's `wrangler.host.jsonc`.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter` (pinned with Pi), `typebox`. No
  `@cloudflare/sandbox`: 1.x has no `getSandbox` (0.x, which the spike used, did). A 1.x sandbox is a
  Durable Object that runs its own container through the native `ctx.container` API, and this is that
  object.
- **Secret:** `PIKIT_SANDBOX_TOKEN`, at least 32 characters, the same value as every client's (`pikit
  configure --generate PIKIT_SANDBOX_TOKEN`).

## A sandbox host on Cloudflare

This is a project of its own:

```sh
pikit new my-sandboxes --target durable --preset base-cloudflare
cd my-sandboxes
pikit add storage-blob-s3 execution-cloudflare-sandbox
```

Its `pikit.config.ts` has the two halves and nothing else. The default App runs in each `Sandbox`
object; deployment-cloudflare's `/health` object runs it too, and there it does nothing:

```ts
import { defineApp } from "@pikit/core";
import executionCloudflareSandbox, { worker as executionCloudflareSandboxWorker } from "./src/pikit/execution-cloudflare-sandbox/index.ts";
import logEvents from "./src/pikit/log-events/index.ts";
import secretsWorkers from "./src/pikit/secrets-workers/index.ts";
import storageBlobS3 from "./src/pikit/storage-blob-s3/index.ts";

export const config = {
  "storage-blob-s3": { endpoint: "https://<account>.r2.cloudflarestorage.com", region: "auto", bucket: "sandboxes" },
  "execution-cloudflare-sandbox": {
    image: "base",                // the base machine: a name of wrangler.jsonc's containers[].images
    internet: false,              // enableInternet (default false)
    agents: {
      designer: { image: "designer", instance: "standard-2", internet: true },
    },
    idleMinutes: 10,              // save and release a sandbox idle this long
  },
};

export default defineApp({ components: [logEvents, secretsWorkers, storageBlobS3, executionCloudflareSandbox], config });
export const worker = defineApp({
  components: [logEvents, secretsWorkers, executionCloudflareSandboxWorker],
  config: { "execution-cloudflare-sandbox-worker": { binding: "SANDBOX" } },
});
```

Two more steps, made by hand once:
1. **`wrangler.jsonc`**: copy `src/pikit/execution-cloudflare-sandbox/wrangler.host.jsonc` over it.
   It is deployment-cloudflare's, plus the `Sandbox` class (binding `SANDBOX`, migration `v2`) and its
   container: `scheduling_policy: "durable_object"` and the named `images`. Wrangler 4.143 refuses
   `max_instances` and `instance_type` on such a container ("Unsupported fields for Durable
   Object-managed Containers"). The size is the profile's `instance`, given at each start. What caps
   how many containers run is the account's limit, and every call's deadline bounds a start past it.
2. **`src/pikit/deployment-cloudflare/worker.ts`** (the project's own file) exports the class:

   ```ts
   export { Sandbox } from "../execution-cloudflare-sandbox/entrypoint.ts";
   ```

Then `pikit configure` (the token, storage-blob-s3's keys) and `pikit up`. deployment-cloudflare's
deploy applies here too (its wait for `/health`, its rollback, `pikit logs`). The first deploy builds and pushes the images,
so it needs Docker where wrangler runs.

**The conversation App** names the host with execution-remote, on a server or on Cloudflare, as it
names an execution-serve host:

```ts
"execution-remote": { endpoint: "https://my-sandboxes.<subdomain>.workers.dev" } // the same PIKIT_SANDBOX_TOKEN
```

With several hosts in execution-remote (its `hosts`, when that lands), this one is one entry, `hosts:
{ cloud: { endpoint: "https://my-sandboxes.<subdomain>.workers.dev" } }`, and the agents routed there
work in Cloudflare containers. Routing happens on the client; this host takes any agent.

## What it does

- **The Worker's route** (`worker.ts`) makes execution-serve's checks, in its order. The token comes
  first (`401` before the URL or the body are read; compared as SHA-256 digests in constant time).
  Then the sandbox id as sent, the operation, `Pikit-Agent` (an agent's name, at most 100 characters)
  and the body, against the operation's strict schema and `maxRequestBytes`. The request then goes to
  the sandbox's object over RPC: `getByName("<sandbox>\n<agent>")`, or `_<sandbox>` as the agent
  without a header, so each sandbox id and agent has one object and one container. The object gets
  `callSeconds` past the request's own `wait`. One that never answers is `503` (its container never
  started: the account's limit).
- **The object** (`entrypoint.ts` → `durable-object.ts` → `object.ts`) composes the default App of
  `pikit.config.ts` on its first event, with its container and storage in the start context. It keeps
  the sandbox id and agent of its first request in its storage, and refuses any other.
- **A container per object**, started on the first operation with the agent's machine (`profileOf`).
  A profile's fields replace the base's one by one: `image` (a name of `containers[].images`),
  `instance` (`lite`, `standard-1` to `standard-4`) and `internet`. An agent with no profile gets the
  base, and so does an agentless sandbox. Every container call has its own deadline: the start waits
  `startSeconds` for the helper to answer, and then the sandbox is `unavailable`, its container
  destroyed (past the account's container limit a start never happens). Each helper call waits `callSeconds`.
- **Every operation of the protocol**, through one helper in the image (`images/pikit-sandbox`, Node,
  no packages). Each file operation is one short process that answers with pi-durable's `FileError`
  codes, mapped from Node's errno as pi-durable's local environment maps them. Writes create parent
  directories. A file of up to `prefetch` bytes is sent whole. A larger one is read through a hard
  link made when it was opened, so a rename afterwards changes nothing. Directory readers page a
  listing.
- **Commands** run through the helper's `exec`, which gives the command a process group of its own
  and kills the whole group on stop. As execution-serve does: `execStart` starts under the client's
  id, `execRead` reads from a cursor, and `execKill` stops. Output goes through execution-serve's
  `OutputLog`, a copy of its `output.ts`, and the window folds what the client would drop. `timeout`
  is this host's timer. With `spill`, the output goes to a file in the container, which is kept only
  when a threshold was passed. A command nobody reads for `leaseSeconds` is stopped. This is checked at
  each request and at the alarm, because a timer would keep an object in memory.
- **Idle checkpoint.** Each operation pushes the object's alarm to `idleMinutes` ahead, at most every
  30 s. When the alarm fires, no operation has come since and no command runs:
  1. the helper lists what a snapshot keeps (`snapshot-list`): directories, regular files, and
     symlinks that stay inside by the format's rule (relative, `..` only leading, no higher than the
     link's directory). Anything else is left out, and the log names it;
  2. the helper archives that list (`snapshot-make`: GNU tar, `--format=pax --no-recursion --null -T
     -`, gzip'd by Node into `<root>.snapshot.tar.gz`, one gzip member whatever tar pads), hashing it
     as it writes. It stops past `storage.blob`'s `maxStreamBytes`;
  3. the object streams that file from `cat`'s output into `putStream` at the key its SHA-256 names,
     checked on the way as a restore would check it (`putSnapshotArchive`); the provider checks the
     SHA-256 (S3 multipart for storage-blob-s3). Then the manifest, read back (`commitSnapshotManifest`),
     then the superseded archives deleted;
  4. only then is the container destroyed. The platform's own inactivity timeout, `idleMinutes +
     backstopMinutes`, is the backstop.
- **Restore.** The first operation of an object whose container is new reads the chat and agent's
  manifest, then streams its archive from `getStream` into `<root>.restore.tar.gz` in the container
  (`snapshot-receive`), checking the size, the SHA-256 and every entry on the way
  (`readSnapshotArchive`). Only once all of it held does `tar -x` extract it into `<root>.restore`, an
  empty directory, whose entries move into the root (entry by entry: overlayfs cannot rename the
  image's own `/workspace`, a finding of the Docker run below). A container still running (the object
  was evicted, its container was not) is used as it is: its disk is the truth.

## Snapshots (the shared format)

Other backends read and write the same format, so one restores what another saved. It has one
implementation, `@pikit/contracts`' `workspace-snapshot.ts`, which this component uses for everything
the format defines: the namespace, the id and keys, the manifest and its checks, the archive's entry
check, the order of the writes, the deletion of superseded archives. Only how the archive is made and
extracted in the container is this component's (the helper, `tar`).

- `storage.blob` namespace `workspace-snapshots`: shared by design, not this component's name.
  `registry validate` allows that one shared name (`SHARED_NAMESPACES` in `checks.ts`).
- Keys under `<id>/`, `snapshotId` of the chat key and agent. Here the chat key is execution-serve's
  `execution-serve:<sandbox>`, and the agent is the header's, or `_<sandbox>` without one, as
  execution-serve's `ConversationRef` has it: the same id execution-gondolin, workspace-local and
  execution-boat compute for that sandbox behind execution-serve, so a workspace moves between them
  (`tests/acceptance/workspace-snapshots.test.ts`).
- The archive, `snapshot-<createdAt ms>-<first 16 hex of its SHA-256>.tar.gz`: a gzip'd pax tar of
  the root's contents, with relative paths only.
- Then, written last, `manifest.json`: `{ "version": 1, "object": "<archive key>", "sha256": "<hex>",
  "size": <bytes>, "createdAt": <ms>, "agent": "<agent>" }`, once the archive is whole in the bucket
  (`putStream` resolved, its size and SHA-256 the check's), and read back.
- The superseded archives are deleted only after the new manifest is written.
- **Refused on restore**, and the sandbox stays `unavailable` until the snapshot is fixed or
  removed:
  - a manifest of another version, for another agent, or naming an object outside its id, or one
    whose name does not carry its time and SHA-256;
  - a size or SHA-256 that does not match;
  - by the shared entry check (`SnapshotTarCheck`, the server restore's rules): an absolute path, a
    `..`, an entry below a symlink of the archive, a symlink leaving the root, two entries at one
    path, a hard link, a device or FIFO, a sparse file, a bad header checksum, a truncated archive,
    bytes after its end, or more than `maxUnpackedBytes` unpacked.

  The archive is never half-extracted: nothing is extracted before every byte was checked.
- **Size.** The largest archive is `storage.blob`'s `maxStreamBytes` (storage-blob-s3: S3's
  multipart limit), not its `maxBytes`: the archive streams from the container's output to the bucket
  and back, never whole in the object's memory (a gunzip window, the paths seen and the provider's
  part, 16 MiB for storage-blob-s3). An archive over it is not saved: the log says so, the container is
  kept until the backstop, and its files are lost then. The container's disk holds the archive beside
  the workspace while it is made or received. What bounds a large one is time: `snapshotSeconds` (at
  most 840), and the object's CPU, since its SHA-256 is plain JavaScript (`createBlobHash`, about 160
  MB/s in Bun) on upload (the provider's) and on restore (the check's), with the gunzip of the check:
  a few seconds a GB, within a Worker's CPU limit (`limits.cpu_ms`, 30 s by default, up to 5 min).
  Cloudflare's own `createBackup` and `DirectoryBackup` (R2 only, a format of their own) are not used.

## Credentials (SPEC C7): none, by decision

This host never gets workspace secrets (the owner's decision). The config has no `secrets`: one given
on the base or on a profile is refused at setup, saying so. Nothing secret travels through the
protocol (a command's variables are the calling tool's). The token authenticates the client to the
Worker and goes no further: it is in the Worker's env, never in a container's. Containers have no
internet unless a profile says `internet: true`. An agent that needs a credential in its sandbox
(`gh` with a token) runs on a host that injects it outside the sandbox: execution-gondolin behind
execution-serve.

## Images

The `images/` Dockerfiles are linux/amd64 only. Cloudflare runs x86-64; on ARM the spike saw 3 s a
command.

- `base.Dockerfile`: `node:22-alpine` with GNU tar, gzip and git, the helper at
  `/usr/local/bin/pikit-sandbox`, and `/workspace`.
- `designer.Dockerfile`: Debian with Chromium, ffmpeg and fonts (DejaVu, Liberation, Noto, emoji,
  CJK), about 1.2 GB. Give it a larger instance.

An image of your own needs Node, GNU tar and gzip, `/bin/sh`, the helper, and the root directory.
Name it in `wrangler.jsonc`'s `images` and in a profile's `image`. Building and pushing happen at
deploy, with Docker.

## Config

```ts
"execution-cloudflare-sandbox": {            // the default App: each Sandbox object
  image: "base", instance: undefined, internet: false, // the base machine
  agents: {},                                // agent -> { image?, instance?, internet? }
  root: "/workspace",
  idleMinutes: 10, backstopMinutes: 15, leaseSeconds: 120,
  callSeconds: 30, startSeconds: 45, snapshotSeconds: 300,
  maxUnpackedBytes: 4294967296,
},
"execution-cloudflare-sandbox-worker": {     // the Worker's App
  tokenSecret: "PIKIT_SANDBOX_TOKEN", binding: "SANDBOX",
  maxRequestBytes: 33554432, callSeconds: 55,
}
```

## Limits

- **Measured in the spike** (`@cloudflare/sandbox` 0.12.9 on celld's Containers, not on Cloudflare):
  warm commands took 0.1 to 0.4 s, and a new sandbox 8 to 10 s, plus its restore. A container's disk
  is its own: it was lost when the container stopped. That is why snapshots exist.
- **Commands and readers live in the object's memory.** An evicted object forgets them (`unknown`
  for a command being read). Its container may still run, and its files stay.
- **A file is read whole** (`readTextFile`, `readBinaryFile`) in the object (128 MB of memory); a
  snapshot's archive is not (it streams, above).
- **No network policy beyond `internet`**: no per-host allow list (`interceptOutboundHttp` is not
  used).
- **Per object:** 16 running commands and 64 open readers (`429`).
- **`watch` and `listFiles`** are not in the protocol (execution-serve's limits).
- **No `max_instances` of its own.** Named images need Durable Object-managed containers, which take
  none: the account's limit caps them. Past it, starts show as `503`s after `startSeconds`, and the log
  says so. A cap of pikit's own (a count across objects) is not built.

## Tests

Copied with the component:

- `sandbox.test.ts` runs the object's logic over a fake container. The real helper and the machine's
  `tar` run as local processes in a temporary directory, and `destroy` wipes the workspace. Covered:
  - every file operation and pi-durable's error codes;
  - readers (whole, pinned through a rename, scanned, paged);
  - commands (streams, exit code, variables, an argv unparsed, a kill, a timeout, a spill file kept
    or not), a command id in use, an acknowledged cursor;
  - one object for one sandbox and agent;
  - the agent's image, instance and internet, the base for any other agent and for none;
  - an image that is not configured;
  - a container that never answers, at its start and at a file operation, within the deadlines;
  - the idle checkpoint in the exact format (fields in order, keys, SHA-256, size), the container
    released, and the restore into a new container (symlinks outside, or with `..` after a name,
    left out; a directory kept);
  - a superseded archive deleted; an evicted object's running container used as it is;
  - no checkpoint while a command runs or after a recent request;
  - an archive over `maxBytes` streamed out (`putStream`) and back (`getStream`; `get` refuses it);
    one over `maxStreamBytes` skipped with the container kept;
  - an upload that fails partway: the container kept, no value, no manifest, then retried; the
    archive whole before the manifest; an archive the check refuses on its way never named;
  - a snapshot another backend wrote restored;
  - archives leaving the root refused (`..`, absolute, a symlink outside, below a symlink, a hard
    link), with nothing extracted;
  - a size, agent or version mismatch, and a valid archive under another's SHA-256, refused.
- The format's own cases (each manifest refusal, each archive refusal, the order of the writes, a body
  that fails partway) are `@pikit/contracts`' `workspace-snapshot.test.ts`, the one implementation's.
- `execution-cloudflare-sandbox.test.ts` covers:
  - what setup declares;
  - the route: forwarding per sandbox and agent, failures mapped to their status, the token first,
    every malformed id, agent and body refused before an object is asked, `503` for an object that
    never answers;
  - the start refused without the token, with a short one, without the binding, or in an object's
    App;
  - profiles, and secrets refused;
  - the object's App composed over a fake container, without a container, and without the component;
  - the host's `wrangler.jsonc` and Dockerfiles;
  - only `durable-object.ts` and `entrypoint.ts` importing Workers or the project.

In the registry:
- `twins.test.ts` keeps `protocol.ts` identical to execution-remote's and execution-serve's, and
  `output.ts` to execution-serve's.
- The workerd lane, `tests/workerd/test/execution-cloudflare-sandbox.workerd.ts`, covers:
  - the route behind deployment-cloudflare's real Worker `fetch`, with secrets-workers and a fake
    `SANDBOX` namespace;
  - the object's App in a real Durable Object: its identity and alarm in real storage, and a
    container that never answers;
  - the shared snapshot format through workerd's Web APIs (an archive past `maxBytes` streamed and
    checked into the bucket, read back checked, one leaving the root refused and not stored).

  The lane cannot run containers, so its container is a double.
- `tests/acceptance/workspace-snapshots.test.ts` moves one workspace between the server helper, this
  host's restore and checkpoint (over the fake container) and execution-boat's, byte for byte, checks
  the three compute one id, and that another agent's manifest is refused by all.

**Mutation-checked**: each of these was broken in turn, a test failed, and the code was restored:
- the token check;
- the `..`, symlink-outside and below-a-symlink refusals;
- the SHA-256 check and the manifest's agent check;
- the archive uploaded before the manifest (a manifest first, an upload failing partway), the
  extraction only after the check ended, the helper's link rule, the chat key, the current archive
  kept;
- the container released only after the upload;
- the Worker's and the start's deadlines;
- the per-agent machine;
- secrets refused;
- one object per sandbox and agent;
- validate's shared namespace, allowed while another stays refused.

- `docker.test.ts` is opt-in (`PIKIT_DOCKER_IMAGE`, the base image built for linux/amd64). It runs
  the object's logic against the real image through `docker exec`: Alpine, Node, GNU tar, `uname -m`
  x86_64, no network. It covers a checkpoint (GNU tar's pax archive, through the shared check) and a
  restore into a new container. It found that overlayfs refuses renaming the image's own
  `/workspace`, hence the entry-by-entry move. Run again 2026-11-05 with the streamed archives.

**Checked by hand** (2026-11-05): `wrangler deploy --dry-run` (wrangler 4.143) of a Worker exporting
`createSandboxClass`, with this container config. It built both images for linux/amd64 (designer
included), bundled 577 KiB, and listed `Sandbox (durable_object)`. The same run is how wrangler
refused `max_instances` and `instance_type`.

**Not run:** real Cloudflare Containers (none here). That leaves untested:
- a real deploy: images pushed, the `v2` migration;
- `ctx.container` itself (`start`, `exec`'s streams and `kill`, `destroy`, `setInactivityTimeout`,
  `instance`);
- the account's container limit reached;
- the designer image's tools (it builds; Chromium and ffmpeg are not run);
- the real latencies;
- a checkpoint racing a platform eviction.
