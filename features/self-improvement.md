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
   `.agents/skills/pikit-component`, `pikit-view`, `pikit-extension`, read on demand with its file
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
   `write`, `edit`, `bash`):
   - **Cloudflare:** `execution-do` already has `git clone` (GitHub over HTTPS), `commit`, `push`
     and `pr`, pushes only to `git.pushRepositories` on branches under `pikit/self/`, and keeps the
     token out of the shell. It cannot run `bun test` (no processes): checks run in CI (below).
   - **Server:** `execution-local` with `bash`, in a checkout of the project's repository under the
     app's volume, with `git` and Bun in the image. Checks run there (`pikit doctor`, `bun test`)
     before it proposes, and again in CI.
3. **The gate, out of the agent's reach:** proposals are pull requests from `pikit/self/*` to the
   main branch of the project's repository on GitHub, on both targets. One path for both, and the
   one Workers Builds already deploys from. **Built:** `admin-proposals` (server and durable; on
   Cloudflare in both Apps, the Worker's serving its routes).
   - **Approve in the dashboard:** its "Proposals" view lists them (state, checks, preview URL) and
     shows each (the agent's description, the diff per file, the checks), with Approve and Reject
     behind a confirmation. Approve squash-merges through GitHub's API with a merge token
     (`PIKIT_MERGE_TOKEN`) that only its operator routes read; reads use `GITHUB_TOKEN`, which may
     be the agent's (push branches, open PRs, never merge); the same token in both is refused. Only
     a branch under the prefix of the repository itself is a proposal (never a fork's), into the
     default branch, at the head the operator read. A ruleset on the main branch (no direct push, PR
     required, the `checks` status required) holds even if the agent's token leaks.
   - **Checks:** a GitHub Actions workflow the component installs
     (`.github/workflows/pikit-checks.yml`: install by the project's lockfile, `typecheck`,
     `bun test`, `wrangler deploy --dry-run` on Cloudflare), whose status the view shows; Approve is
     refused while they fail, run or never ran, unless the operator overrides it. `pikit doctor` is
     not in it: the CLI is not a project dependency nor on npm yet.
   - **Deploy:** Cloudflare: Workers Builds deploys the merge (a branch's push already builds a
     Preview). Server: a deployer on the host, outside the container (the app cannot run `docker`
     without root), pulls the main branch and runs `pikit up`; it keeps the previous image.
   - **Rollback:** after a deploy, `/health` from the new version; if it fails, Cloudflare goes back
     with `wrangler rollback` (in the deploy script, as `setup-webhook.mjs` waits for health today),
     the server with the previous image. A change of Durable Object classes is marked as not
     reversible and needs its own approval.

**Who.** The steward is the agent marked so in its `defineAgent` (`steward: true`, one per project).
Only it is given `pikit-self` and the git workspace. Only operators (the dashboard's,
or a chat's owner the channel trusts as one) may ask it to change itself.

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

- **Proposals** (`admin-proposals`' view, built): open, merged, rejected; each with its diff
  (files, lines), the agent's description, checks, the preview URL, and Approve / Reject.
- **The agent shown to itself**: the composition view already exists, from the same description
  `pikit-self` reads.

## Order

1. `pikit-self`, with the docs (`docs/`): cheap, and everything else uses them. Built.
2. Proposals on Cloudflare: the project's CI workflow, the Proposals view and its Approve and
   Reject routes (**built**: `admin-proposals`, which works on a server too). Left: the template
   (the component in the preset, `GITHUB_TOKEN` and `PIKIT_MERGE_TOKEN` asked by the button,
   execution-do's `git.pushRepositories` set to the repository) and the ruleset, which the
   operator sets on GitHub.
3. Rollback on Cloudflare (`wrangler rollback` after a failed health check).
4. The server: git and Bun in the image, the checkout in the volume, the host deployer.

## Open questions

- The template's repository: the button forks the template into the operator's account under a
  name of their choosing, so `admin-proposals.repository` and execution-do's
  `git.pushRepositories` are not known when the template is built. A variable the button asks
  (`PIKIT_REPOSITORY`) read at start, or a setup step after the deploy, decides it.
- The ruleset cannot be made by the button: a setup page (or `pikit configure`) says how, or
  makes it with the merge token if that token is given the Administration permission (it should
  not need it otherwise).
- Rollback after an approved deploy (Order 3) is not built: until it is, a bad merge is undone by
  reverting it on GitHub (Workers Builds deploys the revert) or `wrangler rollback` by hand.
- The host deployer: a `pikit deploy-watch` systemd unit (polls GitHub, or a webhook through the
  same tunnel), or a GitHub Action that reaches the host over SSH. The first needs no inbound
  access.
- A project made by `pikit new` has no GitHub repository: `pikit configure` could create one
  (`gh repo create`), or self-improvement stays off until the operator connects one.
- Preview on the server: none for now (the diff and the checks only).
- Levels of autonomy (a prompt change merged without approval): later, as a policy component (SPEC
  §6); never for code.
