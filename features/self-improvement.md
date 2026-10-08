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

1. **`pikit-self`, the skill** (data, never code), and nothing else to know itself: no tool. What
   pikit is, how each part is changed, and where to read more. Built from the same sources as the
   docs (`docs/`, the components' READMEs) and the skills a project already ships
   (`.agents/skills/pikit-component`, `pikit-view`, `pikit-extension`), so the docs, the coding
   agents' skills and the steward's self-knowledge are one text. Given to the steward as a system
   prompt section (an `agent.extension`) listing what exists, and read on demand with its file
   tools.
   - **Its own composition is in the skill**, written when the project is built (from `pikit.json`
     and the App's description: components, what each provides, its agents, config with secrets
     redacted), because on Cloudflare the steward has no project files until it clones its
     repository. Bundled with the App, as the dashboard's files are; never read from the running
     App.
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
   one Workers Builds already deploys from.
   - **Approve in the dashboard:** a "Proposals" view lists them (diff, checks, preview URL),
     with Approve and Reject. Approve merges through GitHub's API with a merge token
     (`PIKIT_MERGE_TOKEN`) that only admin-api's operator route reads; the agent's token
     (`GITHUB_TOKEN`) can push branches and open PRs, never merge. A ruleset on the main branch
     (no direct push, PR required) holds even if the agent's token leaks.
   - **Checks:** a GitHub Actions workflow the project ships (`pikit doctor`, `bun test`, the bundle
     on Cloudflare), whose status the view shows; Approve is refused while they fail, unless the
     operator overrides it.
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

- **Proposals** (a view of the self-change component): open, merged, rejected; each with its diff
  (files, lines), the agent's description, checks, the preview URL, and Approve / Reject.
- **The agent shown to itself**: the composition view already exists, from the same description the
  skill is written from.

## Order

1. `pikit-self`, with the docs (`docs/`): cheap, and everything else uses them.
2. Proposals on Cloudflare: `GITHUB_TOKEN` and `PIKIT_MERGE_TOKEN` asked by the button, the
   project's CI workflow and ruleset, the Proposals view and its Approve route.
3. Rollback on Cloudflare (`wrangler rollback` after a failed health check).
4. The server: git and Bun in the image, the checkout in the volume, the host deployer.

## Open questions

- SPEC §6 still names a `pikit_self` tool: it is replaced by the composition written into the skill
  (this note), and §6 changes with the first piece built.
- The host deployer: a `pikit deploy-watch` systemd unit (polls GitHub, or a webhook through the
  same tunnel), or a GitHub Action that reaches the host over SSH. The first needs no inbound
  access.
- A project made by `pikit new` has no GitHub repository: `pikit configure` could create one
  (`gh repo create`), or self-improvement stays off until the operator connects one.
- Preview on the server: none for now (the diff and the checks only).
- Levels of autonomy (a prompt change merged without approval): later, as a policy component (SPEC
  §6); never for code.
