# execution-boat

Each agent's tools work, in each chat, in a [boat.dev](https://boat.dev) VM of its own: a persistent
Ubuntu machine in boat's cloud (EU), stopped when idle (its disk kept, billing stopped), resumed on
the next use, deleted after `retentionDays`. It is a sandbox host's provider: `execution-serve`
serves it to `execution-remote` clients (a Cloudflare Durable Object, another server), so an agent
that needs a bigger machine than a Gondolin host has (Chrome, Docker, 16 vCPUs) gets one, and pays
only while it works. No secret reaches a VM.

- **Provides:** `workspace` (a VM per chat and agent, each on its agent's machine), and `execution`
  and `execution.shell` (one more VM, `default`, for a tool called outside a conversation). All are
  pi-durable's `ExecutionEnv`.
- **Requires:** `secrets` (boat's API key, the gateway's own).
- **Uses if present:** `storage.blob` (required once `snapshots` is on: start refuses without it).
- **Target:** `server` (the gateway's timers and its view of the VMs it runs).
- **Installs to:** `src/pikit/execution-boat/`.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter` (pinned with Pi), `typebox`. Not
  boat's SDK (below).
- **Secret:** `BOAT_API_KEY` (`apiKeySecret`), a key from boat's dashboard (API keys tab).
- **Instead of:** execution-gondolin (or workspace-local) in a sandbox host: one `workspace` provider
  per host App. A host per backend; execution-remote chooses the host per agent.

## A sandbox host on boat

A project of its own (`pikit new --target server`), as any sandbox host (execution-serve's README):

```ts
import { defineApp } from "@pikit/core";
import executionBoat from "./src/pikit/execution-boat/index.ts"; // provides `workspace`: a boat VM per sandbox
import executionServe from "./src/pikit/execution-serve/index.ts";
import logEvents from "./src/pikit/log-events/index.ts";
import secretsEnv from "./src/pikit/secrets-env/index.ts";
import serverBun from "./src/pikit/server-bun/index.ts";
import storageBlobS3 from "./src/pikit/storage-blob-s3/index.ts"; // the workspaces' snapshots

export const config = {
  "server-bun": { port: 3000 },
  "execution-serve": {},                       // PIKIT_SANDBOX_TOKEN in .env
  "storage-blob-s3": { endpoint: "https://<account>.r2.cloudflarestorage.com", region: "auto", bucket: "pikit-workspaces" },
  "execution-boat": {
    size: "small",                             // the base: 2 vCPU, 4 GB
    agents: {
      designer: { size: "default", template: "designer" }, // a saved snapshot with ffmpeg and fonts
    },
    snapshots: true,                           // export to the bucket, restore from it (any backend's)
  },
};

export default defineApp({
  components: [logEvents, secretsEnv, storageBlobS3, executionBoat, executionServe, serverBun],
  config,
});
```

`.env`: `BOAT_API_KEY`, `PIKIT_SANDBOX_TOKEN`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Deploy it
behind TLS like any host. A client sends some agents here and others to a Gondolin host with
execution-remote's `hosts` (its README has the exact shape; another change adds it):

```ts
"execution-remote": {
  hosts: {
    gondolin: { endpoint: "https://sandbox.example.com" },   // the default host
    boat: { endpoint: "https://boat-gateway.example.com" },  // this one: its own PIKIT_SANDBOX_TOKEN
  },
  agents: { designer: "boat" },
}
```

The template is made once on boat: a VM where you installed what the agent needs, saved as a saved
snapshot (`POST /saved-snapshots` with `{ sandboxId, name: "designer" }`, or `boat snapshot <id>
designer`). Every new VM of that agent starts from it (`from`), copy-on-write.

## How a VM is keyed

As execution-gondolin's sandboxes ([features/agent-sandboxes.md](https://github.com/ajarellanod/pikit/blob/main/features/agent-sandboxes.md)): **by
chat and agent**. The chat is `originOf(ref).key`; behind execution-serve, the sandbox
(`execution-serve:<id>`), and execution-remote already chooses one sandbox per chat and agent. So a
reset and a delegated child of the same agent find the same VM; another chat or agent gets its own.
The workspace is the hex SHA-256 of `"<chat key>\n<agent>"`, the same value the shared snapshot
format keys by; it is the VM's label (`pikit-workspace`), with `pikit-gateway: <gateway>` and
`pikit-agent: <agent>`. The VMs are found by these labels (`GET /sandboxes?label=...`), not kept in
a file: a restarted gateway finds them again, and adopts the ones it left up (stopped once idle).
An agent name that is not lowercase letters, digits, `_` and `-` (at most 128), and an empty chat
key, are refused at `resolve`, before any call.

The machine is the agent's profile in `agents` (its key is exactly the agent), each field replacing
the base's: `size` and `template`. An agent `agents` does not name gets the base. `workspace:
"agent"` (one VM for every chat) is not offered here.

## What a VM is

- **Files** are the VM's, in `/home/user/workspace` (the cwd; boat's user is `user`, with
  passwordless sudo). Each `FileSystem` method is one boat exec of a small Node script (`helper.ts`:
  the same `fs` calls as pi-durable's `NodeExecutionEnv`, so `not_found`, `is_directory`, symbolic
  links and `noFollow` behave as there), sent with the call: the VM keeps nothing of this component's.
  Contents up to 48 KiB travel in the call; larger ones through a file in `/tmp/pikit` and boat's
  signed upload and download URLs (no size limit there; a file read whole is at most 64 MiB). A binary
  reader reads its file when it is opened; a directory reader takes the names when opened.
- **Commands** run detached, read after offsets (`GET .../commands/{processId}`), streamed to
  `onOutput` per stream as they come (polled, backing off from 25 ms to 1 s). A string runs in `bash
  -c`, an argv as its program with its arguments unparsed; a missing working directory or program is a
  `spawn_error`. A timeout (counted from the start, not the VM's resume), the call's cancellation, a
  throwing `onOutput` and `cleanup` stop the command and every process it started (boat's stop:
  SIGTERM, then SIGKILL after 5 s). Past `spill`'s thresholds the whole output (at most 64 MiB) goes
  to a file in `/tmp/pikit`. `window` is not used: every chunk is delivered.
- **Marked.** Every command starts with `PIKIT_BOAT_COMMAND=1` in its environment (also with
  `inheritEnv: false`): what the idle check looks for.
- `watch` is `not_supported`.

## Lifecycle

- **Created** on first use (a file operation or a command), `noEnv`, with boat's own auto-stop
  (`autoStopSeconds`, an hour) as the safety net if the gateway dies; it is pushed forward while the VM
  is in use. With `snapshots` and a snapshot of the workspace, it is restored first.
- **Idle**: after `idleSeconds` (600) with no use, the idle check (every 30 s on the app's clock)
  asks the VM whether a command left a process running (`/proc/<pid>/environ` carrying the marker:
  `sleep 600 &`, a dev server). If none, the VM is exported (with `snapshots`) and stopped: boat
  snapshots the disk, removes the machine, billing stops. **Never during a use**: a VM with a file
  operation or a command in flight, or used while the check ran, is not stopped (`Vms.stop` is the one
  place that decides, synchronously with marking the stop). A use that arrives during a stop waits
  for it, then resumes the VM.
- **Resumed** by the next use: same id, new machine, same disk. boat says a few seconds (the fake's
  `resumeMs` sets it in the tests); each resume is logged with its time (`execution-boat: VM resumed`,
  `ms`). A create or resume not ready within `startSeconds` fails the use, and the next one tries
  again.
- **Bounded**: at most `maxVms` up at once, every agent's together. A new one stops the VM idle the
  longest; when all are in use, the use waits `queueSeconds`, then fails: `spawn_error` for a
  command, `unknown` for a file, saying all `maxVms` were busy.
- **Deleted** once stopped for `retentionDays` (13 by default; boat keeps a stopped VM's disk at least
  14 days, so at most 14), counted from boat's `stoppedAt`, so it outlives a restart. The sweep runs at
  start and hourly. Never one in use (a use waits for a deletion in progress, then gets a new VM). With
  `snapshots`, only once its latest state is in the bucket: when the latest snapshot is older than
  the VM's last start, it is resumed and exported first, and kept (stopped again) if that fails.

## Portability: the shared snapshot format

With `snapshots: true` (needs `storage.blob`), `snapshot.ts` writes and reads the format every backend
shares (kept apart from boat's code, so a shared helper can replace it):

- In namespace `workspace-snapshots`, under `<hex SHA-256 of "<chat key>\n<agent>">/`: the archive
  `snapshot-<createdAt ms>-<first 16 hex of its SHA-256>.tar.gz`, then `manifest.json`, written last:
  `{ "version": 1, "object", "sha256", "size", "createdAt", "agent" }`.
- **Export** (before each idle stop, and before a deletion when needed): `tar` in the VM, of the
  workspace's contents (relative paths; regular files, directories and links that stay inside: links
  out, FIFOs and sockets are skipped, and the log says how many), downloaded to the gateway, checked,
  put, read back and compared, then the manifest; superseded archives are deleted after it. The VM's
  copy is the truth until then: an archive larger than `storage.blob`'s `maxBytes` (25 MiB by
  default; a streaming upload is another change) is not saved, the stop goes ahead (boat keeps the
  disk), and retention never deletes that VM unsaved.
- **Restore** (a workspace with no VM): the manifest, the archive, its size and SHA-256, and every
  entry (`checkArchive`: no absolute path, no `..`, no hard link, device or FIFO, no link that leaves
  the root, followed through the archive's own links) are checked before anything reaches the VM; it
  is extracted into an empty directory beside the workspace, then swapped in. A snapshot that fails
  any check is refused: the new VM is deleted and the use fails saying why (an empty workspace never
  replaces the snapshot). Remove or fix the snapshot to use that chat again.

## Secrets and network

- **No secrets in a VM** (the owner's decision "a": cloud sandboxes receive none). Every create and
  resume is `noEnv` (boat passes none of the account's variables, secret files or credentials, and
  confines the VM so it cannot act on the account), no `env` is ever sent, and a profile or the base
  with `secrets` is refused at setup. An agent that needs a token works on a Gondolin host.
- **The API key** is read once at start through `secrets` (start refuses without it), sent only as
  the `Authorization` header of boat's API (never to a signed file URL), and replaced by `[redacted]`
  in every message that leaves the client, whatever boat echoed. No variable, file or command of a VM
  receives it.
- **Egress is open.** boat has no API setting for a VM's network: outbound traffic is open to the
  internet, and only a firewall inside the VM (which root, and so the agent, can remove) restricts it
  ([security](https://docs.boat.dev/security.md)). So `allowedHosts` cannot be enforced here, and is
  refused rather than promised. Inbound is closed except boat's own SSH.

## Errors

As execution-gondolin's failed boots: a command that cannot get its VM (boat down, a timeout, a
refusal, a VM that never became ready) answers `shell_unavailable`, a file operation `unknown`,
each saying why (no key in it); all `maxVms` busy is `spawn_error`. Nothing is retried within a call;
the next call tries again. Every boat call has a deadline (`callSeconds`; a command's own exec gets
boat's deadline plus 5 s), and a malformed answer (not the documented shape) is an error, never a
guess.

## The boat API it uses

Plain `fetch`, not `@boatdev/sdk`: the SDK (1.13.0, MIT, generated from boat's OpenAPI) is 5.3 MB
for 120 operations, and defaults to a `node:http2` transport; this component needs 13 calls, each
checked here. The shapes were read from the SDK's published types (`npm pack @boatdev/sdk@1.13.0`:
`src/apis/BoatApi.ts`, `src/models/*.ts`) and [the API reference](https://docs.boat.dev/api/v1);
base `https://boat.dev/api/v1`, `Authorization: Bearer <key>`, errors `{ ok: false, code, message,
status, error: {...} }`.

| Call | For |
|---|---|
| `POST /sandboxes` (`type`, `ttlSeconds`, `labels`, `name`, `noEnv: true`, `from`; `Idempotency-Key`) | a new VM, from a saved snapshot with `template` |
| `GET /sandboxes/{id}` | its state (`provisioning` … `ready`, `archiving`, `archived`), `stoppedAt`, `createdAt`, `hydratedAt` |
| `GET /sandboxes?label=k=v&limit&cursor` | a workspace's VM; the gateway's VMs (retention, adoption) |
| `POST /sandboxes/{id}/resume` (`type`, `ttlSeconds`, `noEnv: true`) | the next use after a stop |
| `POST /sandboxes/{id}/stop` | the idle stop (boat snapshots the disk; billing stops) |
| `DELETE /sandboxes/{id}` (`X-Ascii-Confirm-Delete: <id>`) | retention |
| `PATCH /sandboxes/{id}` (`ttlSeconds`) | pushing boat's auto-stop forward |
| `POST /sandboxes/{id}/commands` (`command`, `timeoutSeconds`) | a file operation, the idle probe, export and restore (synchronous, at most 600 s) |
| `POST /sandboxes/{id}/commands` (`detached: true`) | a command |
| `GET /sandboxes/{id}/commands/{processId}?stdoutOffset&stderrOffset` | its output and state |
| `DELETE /sandboxes/{id}/commands/{processId}` | stopping it and what it started |
| `POST /sandboxes/{id}/files/upload-url`, `/download-url` (`path`, `ttlSeconds`) | contents over 48 KiB, archives (the signed URL is GET or PUT, no key) |

**Not verified yet** (no key when this was written; `live.test.ts` checks them once one is set):
that a detached command runs its line through a POSIX shell in the user's home; that
`/proc/<pid>/environ` of the user's processes is readable to a command; that `node` and GNU `tar` are
on the VM's `PATH`; the label filter's syntax (`label=key=value`, several ANDed: answers are filtered
here too); the resume latency; whether `stoppedAt` is set by an auto-stop too; that `/tmp` survives
a stop (it holds only transfers and spill files); regions (no API field chooses one: machines are in
Germany, Finland and France, snapshot copies may be stored outside the EU, per [security](https://docs.boat.dev/security.md)).

## Config

```ts
"execution-boat": {
  apiUrl: "https://boat.dev/api/v1",   // default
  apiKeySecret: "BOAT_API_KEY",        // default: the secret's name, never the key
  gateway: "pikit",                    // default: this gateway's label; two gateways on one account keep apart
  size: "small",                       // default: small (2 vCPU, 4 GB), default (4, 8), large (8, 16), xlarge (16, 32)
  // template: "base-tools",           // a saved snapshot every new VM starts from
  agents: {},                          // default: { designer: { size: "default", template: "designer" } }
  idleSeconds: 600,                    // default: a VM unused this long (nothing left running) is stopped
  retentionDays: 13,                   // default: a VM stopped this long is deleted (at most 14)
  maxVms: 4,                           // default: VMs up at once
  queueSeconds: 60,                    // default: how long a use waits when maxVms are all in use
  startSeconds: 120,                   // default: a create or resume until ready
  callSeconds: 60,                     // default: one boat API call
  autoStopSeconds: 3600,               // default: boat's own auto-stop, pushed forward while in use
  snapshots: false,                    // default: true exports to storage.blob and restores from it
  node: "node",                        // default: the program that runs the file helper in the VM
}
```

`secrets` and `allowedHosts` are refused, on the base and in a profile (above).

## Decisions

- **No secrets in a cloud VM** (the owner's, "a"), enforced at two points: `noEnv` on every create and
  resume, and a refused config.
- **The bucket is the long-term store** (the owner's: S3 is the standard): with `snapshots`, a
  workspace leaves boat after `retentionDays` and comes back from the bucket at its next use, on boat
  or on any other backend that reads the format. The bucket's own lifecycle rules expire snapshots.
- **Labels, not a local registry**: boat's labels say which VM is whose, so the gateway keeps no
  state of its own, and a restart loses nothing but the idle clocks (adopted VMs start theirs anew).
- **One helper call per file operation**, Node's `fs` in the VM: the exact semantics of pi-durable's
  local environment for every edge case (links, `noFollow`, error codes), instead of mapping boat's
  file endpoints (which serve `/home/user` and `/tmp` only, with error codes not documented).
- **Refuse what cannot be enforced** (`allowedHosts`) rather than accept it silently.
- **Plain `fetch`** over the SDK (size, `node:http2`, 13 calls of 120).

## Limits and risks

- **Latency**: every file operation is a boat exec (a round trip to boat and a Node start in the
  VM); a tool call makes one to three. A stopped VM's first use waits for its resume.
- **The idle check sees only marked processes**: one that cleared its environment, a Docker container
  (started by `dockerd`) or a service is not seen, and goes with the stop (boat keeps no running
  programs). Processes started by `sudo` (root's `environ`) neither.
- **A gateway that dies** leaves its VMs up until boat's auto-stop (`autoStopSeconds`), or until the
  next gateway adopts and idles them.
- **Snapshots are whole values**: larger than `storage.blob`'s `maxBytes`, a workspace stays on boat
  (and is never deleted unsaved); after boat's 14 days of a stopped VM, boat may delete it.
- **`retentionDays` counts from the stop**, which comes `idleSeconds` after the last use.
- **Freshness of a snapshot** compares the gateway's clock (`createdAt`) with boat's (`createdAt`,
  `hydratedAt` of the VM): skew of more than the time between a VM's start and its first export would
  make a deletion resume and export once more, never skip it.
- **The agent is root in its VM** (passwordless sudo): it can change the helper's Node, `tar`, its
  own firewall. Nothing it does reaches the gateway beyond its own workspace: archives are checked at
  the gateway, and its files are its own.
- **Parallel commands of one VM** (a reset and the conversation before it, a parent and its same-agent
  children) run at once in the same workspace, unserialized, as on every backend.

## Tests

`execution-boat.test.ts` runs over a fake boat API (`fake-boat.test-support.ts`: boat's REST calls
over local directories, commands in a real local `bash`, so the real helper and wrapper run):

- pi-durable's `ExecutionEnv` suite with a real shell (argv, streams, timeouts, symbolic links), the
  `workspace` suite and the lifecycle suite; what setup declares;
- keying: a reset and a same-agent delegated child in the same VM, another chat or agent in its own;
  unsafe agent names and empty keys refused before any call; the profile chosen by agent, field by
  field (`size`, `template` as `from`), the base for an agent it does not name (`constructor` too);
- secrets and `allowedHosts` refused (base and profile), start without the key or with `snapshots`
  but no `storage.blob` refused; `noEnv` on every create and resume, no `env`; the key never in a
  signed URL's request, a command's environment, a log or an error (boat echoing it is redacted);
- on a manual clock: the idle stop after `idleSeconds`, the resume with its files and its logged
  latency; never during a command, nor during one that started while the idle check probed, nor
  while a marked process runs (a fake `/proc`); retention deleting only past `retentionDays`, and a
  use during a deletion getting a new VM; a restarted gateway adopting its running VMs;
- `maxVms` (the idlest stopped; all busy: the bounded wait and its message, `spawn_error`), a hanging
  API failing after `callSeconds`, an outage (`shell_unavailable`, `unknown`, then recovery), malformed
  answers (a list, a command's status, a command's result);
- snapshots: the export at an idle stop in the shared format (keys, manifest, sha256, size, relative
  entries, links out and FIFOs left out), deletion without a resume when the snapshot is fresh, restore
  into a new VM, the superseded archive deleted; an export too large for the store keeping the VM
  through retention; another backend's archive restored; an archive escaping the root or tampered
  refused, no VM kept.

`snapshot.test.ts`: the format alone: keys, manifests, archives as GNU tar, bsdtar and the tests' own
writer make them, every refused kind (absolute names, `..`, pax paths, links out directly and
through other links, hard links, devices, FIFOs, GNU long names, global pax paths, bad checksums, not
gzip), and a save's order (archive, read back, manifest, superseded deleted).

**Mutation checks** (each guarantee broken in its one place, its test seen failing, restored): `noEnv`
dropped from the create; `Vms.stop`'s in-use check; the probe's verdict; the retention period; the
"never deleted unsaved" check; the key's redaction; the secrets refusal; `maxVms`; links out through
links; `..` in names; the manifest written before the archive; a refused restore keeping its VM; the
malformed-status check; a call's deadline.

`live.test.ts` runs against boat itself when `BOAT_API_KEY` is set (skipped, saying so, otherwise):
the whole `ExecutionEnv` suite on one small VM, Ubuntu with `node` and no key in its environment, the
idle stop with its export, the resume (its latency printed), a deletion and the restore into a new VM.
It deletes every VM it made. Not covered without a key: anything in "Not verified yet" above.

`component.json` is generated from `setup` by `pikit registry generate`; the test "what setup
declares" pins it.
