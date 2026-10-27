# Agent sandboxes: a machine profile per agent

**Public appeal:** — (a team of agents where the developer has `gh` and a GitHub token in its VM, the
analyst has Python and Google's APIs, and no other agent has either, not even through a delegation)

**Specified:** yes (2026-10-20), this note is the frozen interface the implementation follows.
**Built** (2026-10-20): `execution-gondolin` (`agents`), `execution-remote` and `execution-serve`
(`Pikit-Agent`), `workspace-local` (one leading `_`); checked with real micro-VMs
(`execution-remote/gondolin.test.ts`) and in workerd.

**Needed by:** nothing required. Builds on [sandboxed execution](sandboxed-execution.md)
(`execution-gondolin`, `execution-remote`, `execution-serve`) and runs on every target they run on,
`durable` on celld or Cloudflare included ([deployment-celld](deployment-celld.md)).

## What it gives
Each agent may get its own machine: the Alpine packages in its VM image, the hosts its VM reaches,
the secrets its VM can use (as Gondolin placeholders, never the values), its memory and CPUs. An agent
the configuration does not name gets the base machine. Two agents never share a VM or a workspace,
also when one delegates to the other. An agent's workspace is its own in each chat, kept through
`/new`, or, when its profile says `workspace: "agent"`, one for every chat.

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

## Decisions (owner's, 2026-10-20)
1. **A workspace per chat and agent, on every target** (revised 2026-10-20). The chat is the key of
   the conversation a person or a channel opened (`originOf(ref).key`: a Google Chat space, a Telegram
   chat). It survives `/new` (a reset is a new `conversationId` under the same key): the agent sees
   what its past self wrote in that chat. A delegated child of the same agent works in its parent's
   workspace on every target (execution-gondolin in process, execution-remote on a server or in a
   Durable Object, workspace-local); a child of another agent works in that agent's workspace of the
   chat, not its parent's: results pass through the delegation's answer or through git. Two chats
   never share one. Before, a sandbox was a conversation's (`conversationId`) on a server: `/new`
   started empty, and a same-agent child got its own. **Shared across chats, by configuration only:**
   execution-gondolin's `workspace: "agent"` (on the base or an agent's profile; on `durable`, the
   sandbox host's) and workspace-local's `per: "agent"` give an agent one workspace for every chat
   (an agent with the context of everything). **Parallel tasks** of one agent in one chat share its
   workspace and VM, commands unserialized: by convention each works in a subfolder of its own or a
   git worktree.
2. **A profile replaces the base field by field.** A field the profile sets replaces the base's (its
   `allowedHosts` are not added to the base's); a field it leaves out is the base's. What the
   configuration shows is what the agent gets.
3. **workspace-local behind execution-serve becomes a directory per agent**, as it is on a server
   (that trial setup was never a sandbox): the consequence of the host knowing the real agent. It
   takes one leading `_` in a name, so an agentless sandbox (`_<sandbox>`) still gets its own. With
   decision 1, its default is a directory per chat and agent (`per: "chat"`; the chat behind the host
   is the sandbox), `per: "agent"` the directory per agent.
4. **Sandbox ids are hashes of the chat and the agent.** Existing `o-<object id>` and
   `k-<hash>` sandboxes are orphaned, as are execution-gondolin's `conversations/...` directories and
   workspace-local's `<root>/<agent>/` files under its new default; no migration (pikit 0.0.x promises
   no compatibility).
5. **An agent misspelled in `agents` gets the base**: no secret, no network. Fails closed. A server
   App that has `agent.definition`s warns at start for a profile no agent defines; a sandbox host
   knows no agents and cannot.

## The interfaces (frozen)

### execution-gondolin (config and keying)
- Config gains `agents: Record<string, Profile>` (default `{}`). Each key matches the agent-name
  grammar (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, as `defineAgent` checks it) and has at most 100
  characters, a limit of these components' own (`defineAgent` has none: an agent with a longer name
  is refused at `resolve`); anything else is refused at define/start. `Profile` is
  `{ packages?, allowedHosts?, secrets?, memory?, cpus?, workspace? }`, each with the base field's own
  schema (`workspace`: `"chat"`, the default, or `"agent"`).
  `root`, `idleSeconds`, `maxVms` and `queueSeconds` stay global only.
- **The effective machine** of an agent: for each field, the profile's when set, else the base's.
  Its reachable hosts: its `allowedHosts` plus its own secrets' hosts. Its packages: its `packages`,
  plus `git` when `proposals` is installed (as today).
- **The sandbox of a conversation is keyed by `(chat, agent)`**, the chat `originOf(ref).key` of the
  `ConversationRef` `resolve` gets. Its files: `<root>/chats/<hex SHA-256 of the chat>/<agent>/`
  (`/workspace` in the guest), or `<root>/agents/<agent>/` with `workspace: "agent"`, its temporary
  files under `<root>/.execution-gondolin-tmp/` the same way. `agent` must be a safe lowercase
  directory name, `^[a-z0-9_-]{1,128}$`, and the chat key non-empty; otherwise `resolve` throws and
  nothing is made. The VM label is `pikit <agent> <first 12 of the chat's hash>` (`pikit <agent>`
  shared).
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
  agent-name grammar, at most 100 characters. A malformed one is `400 invalid_request`.
  (A header, not a body field: every operation's body schema is strict.)
- execution-remote sends it on every request of a conversation's sandbox (`workspace`), and never on
  `execution`'s own sandbox (no conversation, no agent).
- `PROTOCOL_VERSION` stays 1 (nothing is deployed that must tell versions apart).

### execution-remote (sandbox ids)
- In a Durable Object: a conversation's sandbox is `o-<hex SHA-256 of "<object id>\n<agent>">`
  (64 hex), one per agent of the object, each with its own `RemoteExecutionEnv` kept for the App's
  life. `execution`'s own sandbox stays `o-<object id>`.
- On a server: `k-<hex SHA-256 of "<chat key>\n<agent>">`, the chat key `originOf(ref).key` (a
  delegated child's own key chooses nothing). `execution`'s own stays the configured `sandbox`
  (`shared`). The Durable Object's id already is the chat's: the object is `idFromName` of the chat's
  key, which a reset keeps, and its delegated children live in it.
- The agent comes from `resolve(conversation)`'s `ConversationRef.agent`.

### execution-serve (the ConversationRef it resolves)
- With `Pikit-Agent`: `{ key: "execution-serve:<sandbox>", agent: <that agent>, conversationId: "remote-<sandbox>" }`,
  no `origin`: the chat is `execution-serve:<sandbox>`, a chat per sandbox (the client's sandbox ids are
  per chat and agent already); `workspace: "agent"` on the host shares an agent's across sandboxes.
- Without it: `agent` is `_<sandbox>` (an underscore, outside the agent grammar): it can never match
  a profile key, so an agentless sandbox always gets the base, and workspace-local still gives each
  agentless sandbox a directory of its own.
- A sandbox's readers and commands stay scoped to the sandbox id, as today.

## The GitHub CLI (spike, 2026-10-20)
Checked in a real Gondolin VM (Alpine 3.23, gh 2.83.0) with `$GH_TOKEN` a placeholder: `gh api`,
`gh repo view`, `gh pr list`, `git ls-remote`, `git clone` of a private repository and an
authenticated `git push --dry-run` work; `gh` accepts the placeholder, and git's Basic auth
(`x-access-token:<placeholder>`) is substituted too. The placeholder sent to any other host is
refused (`403`).

```ts
developer: {
  packages: ["github-cli", "git"],
  secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }],
  allowedHosts: ["codeload.github.com", "release-assets.githubusercontent.com"], // tarballs, release assets
}
```

- `gh auth setup-git` writes `/root/.gitconfig`, gone at the VM's next boot: run it (or
  `git -c credential.helper='!gh auth git-credential' ...`) in the session that pushes.
- `gh` is about 55 MB: the image's root disk keeps about 25 MB free, so clone into `/workspace`.
- Not checked: real writes (PRs, pushes), release uploads (`uploads.github.com` would need the
  secret), Git LFS.
- On celld (spike, celld 0.6.2): execution-remote ran unchanged against a sandbox host; the host
  needs a publicly trusted TLS certificate (celld checks against Mozilla's roots).

## Pi first
Nothing in Pi: `ExecutionEnv` is unchanged, and the agent each tool call runs for is already in the
`ConversationRef` pikit's runtime passes to `workspace.resolve`.

## Contracts
No change to `@pikit/contracts`, `@pikit/pi-adapter` or the capability catalogue: `workspace`,
`execution` and `execution.shell` keep their shapes and suites. The protocol is execution-remote's
and execution-serve's own.

## Guarantees and tests
- execution-gondolin (fake guest): the profile chosen by agent; an unknown agent and `default` get the
  base (no secret, no host); two agents of one chat get two VMs and two directories; a reset and a
  same-agent delegated child find the chat's files, another chat does not; `workspace: "agent"` one
  sandbox for every chat; a secret
  reaches only its profile's VMs, also after a rotation; two images with different packages coexist;
  bad agent keys and bad agent names refused; secrets in a profile without a `secrets` provider
  refused at start.
- execution-serve and execution-remote: the header sent for conversations and not for `execution`;
  a malformed header refused; the ref built with the real agent, `_<sandbox>` without one; two agents
  of one object (a delegated child) get two sandboxes; the protocol copies identical.
- Across both (`execution-remote/gondolin.test.ts`): remote, serve and gondolin over the fake guest,
  two agents and two profiles: only one gets the secret, an agent with no profile gets the base.
- The workerd lane (`tests/workerd/test/execution-remote.workerd.ts`): two agents in one real Durable
  Object reach two sandboxes, each found again by a same-agent child and by a reset in a new App.
- The `execution` and `workspace` conformance suites still pass on every provider.

## Limits
- The boundary is logical, not a process's: every agent runs in the same Worker, which holds the
  sandbox host's token and names the agent of each request. It holds as long as the reviewed code does
  (the steward's changes are approved by a person); it is not a wall against that code.
- An agent with a profile can do whatever its token allows: give it a fine-grained token, the fewest
  repositories and permissions.
- The sandbox host's disk holds every workspace, unreplicated
  ([workspace snapshots](workspace-snapshots.md) is not built).
- **Workspaces are ephemeral** ([spaces](spaces.md)): what must last is saved on purpose
  (`tool-space-files`, memory). With `retentionDays: N` (execution-gondolin, workspace-local,
  execution-do; absent, the default, keeps everything), a chat's workspace not used for N days (a
  command run or a file read or written; marked at most once an hour, on the App's clock) is deleted.
  A workspace in use is never deleted, and a command that starts during a sweep waits and gets a fresh
  empty one. Shared workspaces (`workspace: "agent"`, `per: "agent"`) are never swept. Behind
  execution-serve each sandbox id is a chat, so the host's provider's `retentionDays` applies to
  remote sandboxes. On a server the sweep runs at start and hourly; execution-do deletes an object's
  files through a `wakeups` request in the object (actors-do), so an object that never wakes again
  keeps its files (Cloudflare cannot list a namespace's objects).
- **Delegation reaching a profile is closed by `from`.** tool-delegate's `agents` (who a task may be
  handed to) is one list for every delegating agent, but an agent in it with `from` takes tasks only
  from the agents it names, and only when every agent of the delegation chain is one of them
  (`support` cannot reach `developer` through an `orchestrator` it may delegate to). Give every agent
  with a profile a `from`: without it, any agent with `delegate` can have a developer child make
  authenticated GitHub calls and read the answer (in the chat's developer sandbox, on every target). The chain is in keys only tool-delegate makes, checked against the runtime's origin; this
  is the same logical boundary as above, the reviewed code's, not a process's.
- **One secret name, one value.** Profiles read secrets by name from the host's one `secrets`: two
  profiles naming `GH_TOKEN` get the same token. Give each agent's token its own name.
- **The host trusts the token holder.** Anyone with the sandbox host's token can name any agent in
  `Pikit-Agent` and get its machine: the token is the fleet's, as the bucket is celld's. Readers and
  commands are scoped by sandbox and agent, so two agents never share one.

## Open questions
- Several sandbox hosts (a GPU machine for one agent): `execution-remote` taking `hosts` and a host per
  agent, when a real case asks for it.
- Editing profiles from the dashboard.
- Files shared between agents (a read-only reference mount).
