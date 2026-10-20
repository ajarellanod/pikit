# Self-improvement

**Public appeal:** ⭐ The assistant knows what it is made of, and builds its own tools, dashboard
views and prompt changes, which you approve from the dashboard.

**Specified:** SPEC §6 (required). This note is how it is built, on both targets: what exists, what
is missing, in which order.

**Needed by:** the launch, on both targets (the Deploy to Cloudflare button and a server).

## What it gives

- **It knows itself.** Asked "what can you do?" or "how would you add a Slack channel?", the steward
  answers from its real composition and from pikit's docs, not from what a model guesses.
- **It changes itself through a proposal.** Asked "add a tool that reads my calendar" or "show the
  delivery failures in the dashboard", it writes the component in its own project, tests it, and
  proposes it. The operator sees the diff, the checks and (on Cloudflare) a preview, and approves or
  rejects it in the dashboard. Approved, it deploys; unhealthy, it rolls back.

## How it fits pikit

Three pieces, each a component or a file of the kit, each removable (P3):

1. **`pikit-self`, built** (`extension-pikit-self`): data, never code, and nothing else to know
   itself: no tool. An agent extension whose system prompt section starts with a short guide
   bundled with the component (`pikit-self.md`, imported as text): what pikit is, how the agent is
   put together, how each part is changed, and where to read more, linked online at the project's
   `kit.commit` (the kit's `docs/`, and the skills a project already ships,
   `.agents/skills/pikit` and its references, read on demand with its file
   tools), so the docs, the coding agents' skills and the steward's self-knowledge stay one text and
   the section stays a map. Every preset that runs an agent installs it, and the starter agent names
   it.
   - **Its own composition is read in-process**, from the running App when it starts: the App's
     description (`APP_DESCRIPTION`, which K13 lets this component read: components and what each
     provides, pipelines, config with values that look like secrets redacted) and its agents
     (`agent.definition`: models, tools, extensions). It needs no project files (on Cloudflare the
     steward has none until it clones its repository) and no build step: on Cloudflare it is the
     objects' App, where agents run. Built once, so the section is the same on every request.
   - **Live state is the operator's**, in the dashboard (health, deliveries, proposals): the
     steward needs what it is made of and how to change it, not how it is doing.
2. **The workspace, a git checkout of the project**, through `execution` (no new tools: `read`,
   `write`, `edit`, `bash`). The steward proposes the same way on every target, from
   `proposals.remote()` (below): `git clone <remote>`, `git checkout -b pikit/self/<topic>`, the
   change, `git commit`, `git push origin pikit/self/<topic>`. The pushed branch is the proposal;
   pikit-self tells it these steps with its remote. No `git pr` anywhere. One suite holds both
   executions to it (`createWorkspaceGitConformance`, `@pikit/pi-adapter/execution/testing`): the
   steps through the shell against a remote, with real git's meaning; on Cloudflare also that the
   token appears nowhere the agent can read (SPEC C7).
   - **Cloudflare:** `execution-do`'s `git` is real git's subset (`clone` over HTTPS, `checkout -b`,
     `status`, `diff`, `add`, `commit`, `log`, `push origin <branch>`), pushes only to
     `proposals.remote()` (the repository `repo.github` connects, below) on branches under its prefix
     (`pikit/self/`), with its `authorization()`, and keeps the credential out of the shell. It cannot
     run `bun test` (no processes): checks run in CI (below).
   - **Server: real git, no fences.** `execution-local` with `bash`, in a checkout under the app's
     volume (`.pikit/workspace`). The image has git (deployment-docker's Dockerfile, committing as
     "pikit agent") and Bun: the steward clones the proposals repository on the server, runs
     `bun install` and `bun test`, and pushes its branch there. No token, and no fenced built-in:
     the shell runs as the app's user and can write that repository anyway, so a fence would protect
     nothing; the deployer's checks, `/health` and rollback are what hold (3, below).
3. **The gate: `proposals`, a contract** (`@pikit/contracts`' proposals.ts, with a conformance
   suite): `status`, `list`, `get`, `approve`, `reject`, and `remote()` (where the workspace clones
   from and pushes to). A proposal's id is its branch's topic. Its providers are interchangeable, and
   the agent, the dashboard and pikit-self's instructions do not change with one. **Built:**
   - **`admin-proposals`**, target-agnostic: its routes, its Proposals view (state, checks, deploy,
     diff per file, Approve / Reject behind a confirmation; Approve sends the head the operator read)
     and its Settings → Self-improvement (each part the provider checks, the last deploy and
     rollback), over `proposals` only. No GitHub or git code in it.
   - **`proposals-github`** (Cloudflare): a pushed `pikit/self/*` branch gets its pull request,
     opened by the provider the first time it lists or reads it (the head commit's first line the
     title, the rest the description); Approve squash-merges through GitHub's API, Reject comments and
     closes. GitHub through the `repo.github` contract (below), in one module (`github-access.ts`): the
     repository and a token asked for every call. Its checks are CI's: a GitHub Actions workflow it
     installs (`.github/workflows/pikit-checks.yml`: install by the lockfile, `typecheck`, `bun test`,
     `wrangler deploy --dry-run`); Approve is refused while they fail, run or never ran, unless the
     operator overrides it. Workers Builds deploys the merge; a failing `/health` rolls it back
     (deployment-cloudflare's `deploy.mjs`).
   - **`proposals-local`** (server): proposals are branches of a bare repository in the app's state
     volume (`.pikit/self/project.git`); Approve records the head and the operator in
     `.pikit/self/decisions.json`; Reject keeps the head under `refs/pikit/rejected/<topic>` and
     deletes the branch. Nothing to set up: no GitHub, no token, no CI, no systemd.
   - **The server's deployer** (deployment-docker's `deployer.ts`): a second compose service,
     `deployer`, activated by proposals-local's manifest-contributed Compose override and built and
     started by the same `pikit up`, restarted by Docker with the app. There is no component-id
     check in the deployment commands. Only it has the Docker socket; it
     mounts the project's directory and the state volume. Every 10 s it keeps the proposals
     repository's `main` at the project's, and deploys the oldest approval: the project must be a
     clean git repository on `main` (else the approval waits, saying why); in its own clone, the
     approved head merged into `main` (fast-forward, else a merge commit; a conflict fails it); a
     change of the deployment's own files refused; `bun install --frozen-lockfile`,
     `bun run typecheck`, `bun test` and the `beforeDeploy` hooks, each in a container of its image
     without the socket; the running image tagged `pikit-previous`, the merge built, `app`
     recreated, `/health` awaited; on any failure the previous image back and `main` unmoved. It
     writes each outcome, with its checks, to `.pikit/self/deployer.json`, which proposals-local reads.
     Both sides use the explicit `@pikit/contracts/deployer` file protocol; the privileged process
     imports types only and never project packages at runtime. Contributed Compose paths and changes
     to their declarations are part of the deployment fence too.
     After a deploy the project's `main` (as its owner) and the proposals repository's follow.
   - **On a server, a lock with the agent's shell in a VM.** With `execution-local` the agent's shell
     runs in the app's container: it can write the proposals repository and `decisions.json`, so it
     could forge an approval; the approval is the operator's decision, not a lock (proposals-local's
     doctor notes it). With `execution-gondolin` (**built**) the shell is in a VM that holds neither:
     the steward's `git clone file://<path>` is rewritten in the guest to a host only the guest has,
     whose requests the app answers in-process with `proposals.remote().serve` (git's smart HTTP over
     the repository, `createProposalsServeConformance`): clone, fetch, and pushes that only create or
     update `pikit/self/*` branches; main, other refs and deletions are refused before git sees them.
     `git` is added to the VM's image when `proposals` is installed (once, a checkpoint). Nothing is
     exposed on a network: no route, no port, no token. Either way the deployer trusts the app for
     nothing but "this head was approved", and always checks, waits for `/health` and rolls back.

**GitHub on Cloudflare: a GitHub App, one credential. Built:** `repo-github-app` and the `repo.github`
contract (the connected repository, a short-lived token for it). Workers Builds exposes no GitHub
token (its GitHub App is Cloudflare's), so the bot needs its own access, and pasting tokens into
Cloudflare is the step operators get wrong. The dashboard's Settings → GitHub → Connect creates a
GitHub App in the operator's own account from a manifest (private, no webhook; contents and pull
requests write, checks and statuses read) and installs it on the bot's repository: two clicks. The
app stores its private key sealed (a key derived from `PIKIT_ADMIN_TOKEN`) in one object, and mints
installation tokens for that repository alone. **One credential, not two**: on Cloudflare the agent
never sees a token (only trusted code asks `repo.github`; its shell has no processes; its pushes are fenced
to `pikit/self/*`; merging is only the operator-authenticated admin route's), so one
repository-scoped credential is enough, and a ruleset on the default branch is an extra layer, not a
requirement. Providers are interchangeable: `repo-github-token` gives the same `repo.github` from a
`GITHUB_TOKEN` secret and a repository setting, for CLI users and servers; no consumer branches on
which is installed. The one user of `repo.github` is proposals-github, which also gives its `remote()`
the credential. execution-do's `git` (real git's subset: `clone`, `checkout -b`, `add`, `commit`,
`push origin pikit/self/<topic>`; no `git pr`: the pushed branch is the proposal) and
extension-pikit-self read `proposals.remote()`, never `repo.github`: the workspace pushes where proposals
go, under their prefix, whichever provider that is.
`proposals-github` reads GitHub only through it (built).

**Who. Built:** the steward is the agent marked so in its `defineAgent` (`steward: true`), one per
project: runtime-pi refuses to start with two, and extension-pikit-self refuses an agent that names
`pikit-self` and is not the steward. The starter agent is the steward, and the dashboard marks it
(`/admin/api/agents`' `steward`, the Composition view's Agents). The git workspace's tools are the
steward's by its definition naming them, not by a check. Only operators may ask it to change
itself, with no permission of pikit's own: whoever reaches it through a door that admits only the
project's owners (the dashboard's `admin.auth`, a channel's allowed users or bearer token); a
channel that serves others routes them to another agent. Its guide (`pikit-self.md`) tells it to
propose a change only when an operator asks.

**What it may change.** SPEC §6: its definition (prompt, tools, skills), extensions, components in
`src/pikit/`, the dashboard, config values. Never secrets, the deployment and approval path, the
kernel or the contracts. The ruleset and CODEOWNERS on those paths make "never" checkable, not a
prompt's promise.

## Pi first

Pi improves itself in one process (its prompt points to its docs, it writes an extension,
`/reload`). pi-durable turns a code change into a generation boundary (stop, reopen, resume from
checkpoints), which is what a pikit restart is (K6): nothing to build there. What pikit adds is the
service around it: which pikit it runs in, and change, check, approve, deploy and roll back.

## In the dashboard

- **Proposals** (`admin-proposals`' view, built): open, approved, merged, failed, rejected; each
  with its diff (files, lines), the agent's description, checks, its deploy, the preview URL, and
  Approve / Reject. Settings → Self-improvement: each part, the last deploy and rollback.
- **The agent shown to itself**: the composition view already exists, from the same description
  `pikit-self` reads.

## Order

1. `pikit-self`, with the docs (`docs/`): cheap, and everything else uses them. Built.
2. Proposals on Cloudflare (**built**): `admin-proposals` with `proposals-github` and `repo-github-app`
   (the `telegram-cloudflare` preset's feature group, `--with admin-proposals`), dormant: the
   button's form asks no GitHub token, and GitHub is connected from Settings → GitHub. Left: the
   ruleset, advised, which the operator creates on GitHub (the status says whether one applies).
3. Rollback on Cloudflare (**built**): every deploy, Workers Builds' (the template's deploy command,
   `deployment-cloudflare`'s `deploy.mjs`) and `pikit up`'s, waits for `/health` from the new
   version and rolls one that fails it or never answers back to the previous version, failing the
   build (`pikit: <version> failed /health: rolled back to <previous>`). Never one whose deploy
   changed the Durable Object classes: each version is tagged with its last migration tag, and a
   different one fails the deploy without a rollback (deployment-cloudflare's README, "Rolling back").
4. The server (**built**): `pikit new` makes the project a git repository (`main`, everything
   committed; without git it says so and goes on). In `pikit new`, the http preset's feature
   "Self-improvement" (`--with admin-proposals`: the group `[admin-proposals, proposals-local]`)
   brings the dashboard (`NEEDS_DASHBOARD`) and makes the starter agent name `bash` (`NAMED_FOR`):
   the steward needs a shell for git and the tests. `pikit up` then starts the deployer.

## Open questions
- The template's repository: decided, connected after the deploy (Settings → GitHub), not a variable
  the button asks: the button's form stays short, and the repository it creates is not known before.
- The ruleset cannot be made by the button: advised, and the status says whether one applies.
- A merge that adds a Durable Object migration is never rolled back (Cloudflare cannot): its build
  fails and it stays until a fix is merged. Marking such a proposal as not reversible, for an
  approval of its own, is not built. A bad merge that passes `/health` is not rolled back either:
  reverting it on GitHub (Workers Builds deploys the revert), or `wrangler rollback` by hand.
- The server's deployer: decided, a compose service with the socket (no host process, no systemd).
  Not tried against a real Docker daemon here: compose's project name and the volume are found by
  inspecting its own container, `docker build` builds the merge from its clone (compose.yaml's build
  options beyond `build: .` are not read), and a rootless Docker needs the socket's path changed in
  compose.yaml. `pikit doctor` is not among its checks (the CLI is not in the project).
- A lock on a server: decided and built, the agent's shell in execution-gondolin's VM, the
  repository reached only through `serve` (above). Checked end to end over real VMs
  (`registry/components/execution-gondolin/proposals.test.ts`): the steward's git flow, a push to
  main or a deletion refused, the repository and the decisions out of the guest's reach. Not the
  default: it needs QEMU (and KVM to be fast) on the server, which deployment-docker's image leaves
  to the operator (execution-gondolin's README, "Docker"). Tools that run in the app's process
  (`tool-fetch`, MCP) never reach the repository or the decisions either: neither is served on a
  network.
- Preview on the server: none for now (the diff and the deployer's checks only).
- Levels of autonomy (a prompt change merged without approval): later, as a policy component (SPEC
  §6); never for code.
