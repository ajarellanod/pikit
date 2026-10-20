# Agent sandboxes: a machine profile per agent

**Public appeal:** — (a team of agents where the developer has `gh` and a GitHub token in its VM, the
analyst has Python and Google's APIs, and no other agent has either, not even through a delegation)

**Specified:** yes (2026-10-21), this note is the frozen interface the implementation follows.
**Built:** no.

**Needed by:** nothing required. Builds on [sandboxed execution](sandboxed-execution.md)
(`execution-gondolin`, `execution-remote`, `execution-serve`) and runs on every target they run on,
`durable` on celld or Cloudflare included ([deployment-celld](deployment-celld.md)).

## What it gives
Each agent may get its own machine: the Alpine packages in its VM image, the hosts its VM reaches,
the secrets its VM can use (as Gondolin placeholders, never the values), its memory and CPUs. An agent
the configuration does not name gets the base machine. Two agents never share a VM or a workspace,
also when one delegates to the other.

```ts
"execution-gondolin": {
  // the base: what any agent not named below gets
  allowedHosts: [],
  packages: [],
  agents: {
    developer: {
      packages: ["github-cli"],
      secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }],
      allowedHosts: ["objects.githubusercontent.com"],
    },
    analyst: { packages: ["py3-pandas"], allowedHosts: ["*.googleapis.com"], memory: "2G" },
  },
}
```

On a server, that is the project's `pikit.config.ts`. On `durable` (celld, Cloudflare), it is the
sandbox host's (`execution-serve`'s App): the conversation's App only runs `execution-remote`, which
now tells the host which agent each request is for. The secrets' values stay in the host's `secrets`
(`.env`): never in the Worker, the bucket, or a VM.

## Decisions (owner's, 2026-10-21)
1. **A workspace per agent.** A sandbox is a conversation's and an agent's: a delegated child of
   another agent works in a sandbox of its own, not its parent's. Results pass through the
   delegation's answer or through git. (A child of the same agent still shares its parent's.)
2. **A profile replaces the base field by field.** A field the profile sets replaces the base's (its
   `allowedHosts` are not added to the base's); a field it leaves out is the base's. What the
   configuration shows is what the agent gets.
3. **workspace-local behind execution-serve becomes a directory per agent**, as it is on a server
   (that trial setup was never a sandbox): the consequence of the host knowing the real agent.
4. **Sandbox ids are hashes of the conversation and the agent.** Existing `o-<object id>` and
   `k-<hash>` sandboxes are orphaned; no migration (pikit 0.0.x promises no compatibility).
5. **An agent misspelled in `agents` gets the base**: no secret, no network. Fails closed. A server
   App that has `agent.definition`s warns at start for a profile no agent defines; a sandbox host
   knows no agents and cannot.

## The interfaces (frozen)

### execution-gondolin (config and keying)
- Config gains `agents: Record<string, Profile>` (default `{}`). Each key matches the agent-name
  grammar (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, `@pikit/contracts`'s `AGENT_NAME`, at most 100
  characters); anything else is refused at define/start. `Profile` is
  `{ packages?, allowedHosts?, secrets?, memory?, cpus? }`, each with the base field's own schema.
  `root`, `idleSeconds`, `maxVms` and `queueSeconds` stay global only.
- **The effective machine** of an agent: for each field, the profile's when set, else the base's.
  Its reachable hosts: its `allowedHosts` plus its own secrets' hosts. Its packages: its `packages`,
  plus `git` when `proposals` is installed (as today).
- **The sandbox of a conversation is keyed by `(conversationId, agent)`**, from the
  `ConversationRef` `resolve` gets. Its files: `<root>/conversations/<conversationId>/<agent>/`
  (`/workspace` in the guest), its temporary files under `<root>/.execution-gondolin-tmp/` the same
  way. `agent` must be a safe directory name, `^[A-Za-z0-9_-]{1,128}$`, as `conversationId` is;
  otherwise `resolve` throws and nothing is made. The VM label is `pikit <agent> <conversationId>`.
  The profile is chosen by `ConversationRef.agent` alone: a key in `agents` equal to it, else the base.
- `execution`'s own sandbox (`default`, no conversation) always gets the base.
- **Secrets:** the pool reads every secret name of the base and of every profile (`secrets()`); each
  VM's spec keeps only its effective machine's secrets, and the unset-secret warning names only
  those. `refreshSecrets` already touches only the secrets a VM booted with: a VM never gains a
  secret it did not boot with. Start refuses when any secret (base or profile) is configured without
  a `secrets` provider.
- **Images:** one checkpoint per (Gondolin build id, sorted packages), as today, but making one
  removes only the checkpoints of **another build id** (today `gondolin.ts` removes every other file,
  so two profiles with different packages would delete each other's image forever). The file name
  must carry the build id part so stale ones can be told apart.
- `maxVms` counts every profile's VMs together.

### The protocol (execution-remote and execution-serve, both copies of `protocol.ts` identical)
- Every request may carry the header **`Pikit-Agent: <agent>`**, the agent the sandbox is for:
  `AGENT_NAME` grammar, at most 100 characters. A malformed one is `400 invalid_request`.
  (A header, not a body field: every operation's body schema is strict.)
- execution-remote sends it on every request of a conversation's sandbox (`workspace`), and never on
  `execution`'s own sandbox (no conversation, no agent).
- `PROTOCOL_VERSION` stays 1 (nothing is deployed that must tell versions apart).

### execution-remote (sandbox ids)
- In a Durable Object: a conversation's sandbox is `o-<hex SHA-256 of "<object id>\n<agent>">`
  (64 hex), one per agent of the object, each with its own `RemoteExecutionEnv` kept for the App's
  life. `execution`'s own sandbox stays `o-<object id>`.
- On a server: `k-<hex SHA-256 of "<conversation key>\n<agent>">`. `execution`'s own stays the
  configured `sandbox` (`shared`).
- The agent comes from `resolve(conversation)`'s `ConversationRef.agent`.

### execution-serve (the ConversationRef it resolves)
- With `Pikit-Agent`: `{ key: "execution-serve:<sandbox>", agent: <that agent>, conversationId: "remote-<sandbox>" }`.
- Without it: `agent` is `_<sandbox>` (an underscore, outside the agent grammar): it can never match
  a profile key, so an agentless sandbox always gets the base, and workspace-local still gives each
  agentless sandbox a directory of its own.
- A sandbox's readers and commands stay scoped to the sandbox id, as today.

## Pi first
Nothing in Pi: `ExecutionEnv` is unchanged, and the agent each tool call runs for is already in the
`ConversationRef` pikit's runtime passes to `workspace.resolve`.

## Contracts
No change to `@pikit/contracts`, `@pikit/pi-adapter` or the capability catalogue: `workspace`,
`execution` and `execution.shell` keep their shapes and suites. The protocol is execution-remote's
and execution-serve's own.

## Guarantees and tests
- execution-gondolin (fake guest): the profile chosen by agent; an unknown agent and `default` get the
  base (no secret, no host); two agents of one conversation get two VMs and two directories; a secret
  reaches only its profile's VMs, also after a rotation; two images with different packages coexist;
  bad agent keys and bad agent names refused; secrets in a profile without a `secrets` provider
  refused at start.
- execution-serve and execution-remote: the header sent for conversations and not for `execution`;
  a malformed header refused; the ref built with the real agent, `_<sandbox>` without one; two agents
  of one object (a delegated child) get two sandboxes; the protocol copies identical.
- Across both (`execution-remote/gondolin.test.ts`): remote, serve and gondolin over the fake guest,
  two agents and two profiles: only one gets the secret, an agent with no profile gets the base.
- The workerd lane (`tests/workerd/test/execution-remote.workerd.ts`): two agents in one real Durable
  Object reach two sandboxes.
- The `execution` and `workspace` conformance suites still pass on every provider.

## Limits
- The boundary is logical, not a process's: every agent runs in the same Worker, which holds the
  sandbox host's token and names the agent of each request. It holds as long as the reviewed code does
  (the steward's changes are approved by a person); it is not a wall against that code.
- An agent with a profile can do whatever its token allows: give it a fine-grained token, the fewest
  repositories and permissions.
- The sandbox host's disk holds every workspace, unreplicated
  ([workspace snapshots](workspace-snapshots.md) is not built).

## Open questions
- Several sandbox hosts (a GPU machine for one agent): `execution-remote` taking `hosts` and a host per
  agent, when a real case asks for it.
- Editing profiles from the dashboard.
- Files shared between agents (a read-only reference mount).
