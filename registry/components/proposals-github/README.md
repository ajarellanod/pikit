# proposals-github

Self-improvement on Cloudflare (SPEC §6, `features/self-improvement.md`): the agent's changes to
itself as pull requests on the project's GitHub repository. The steward proposes as it does on every
target: it pushes a branch `pikit/self/<topic>` to `remote()` (execution-do's git, with the token kept
away from it). This component opens the branch's pull request itself, the first time it lists or
reads it (its head commit's first line the title, the rest the description); the operator reads it in
the dashboard (`admin-proposals`: the description, the diff, the checks, a preview) and approves it,
which squash-merges it, or rejects it, which closes it. Workers Builds deploys the merge. It is
**dormant until connected**: it starts without a repository or a token, and is connected after
deploying ("Connect it" below).

- **Provides:** `proposals`.
- **Requires:** `secrets` (the two tokens). **Uses, if installed:** `settings` (the repository, live;
  `settings-store`).
- **Settings:** `settings/`, the Settings dialog's Self-improvement on GitHub: the repository, the
  connection checked live, and the steps (installed to `src/dashboard/src/settings/proposals-github/`).
  admin-proposals' Self-improvement links to it.
- **Target:** `durable`. It goes in both Apps (`apps.worker: "default"`), with its config in both: the
  Worker's App answers the dashboard's routes, the objects' App the steward's guide (`remote`).
- **Installs to:** `src/pikit/proposals-github/`, and `.github/workflows/pikit-checks.yml`, the
  project's checks ("Checks" below).
- **npm dependencies:** `typebox`.

```sh
pikit add admin-proposals proposals-github   # or: pikit new --target durable --preset telegram-cloudflare --with admin-proposals
```

## GitHub access, in one module

`github-access.ts` is the only file that knows where the repository and the tokens come from: today
the repository setting and two secrets. The rest asks it, so moving GitHub access onto a contract (a
GitHub App, a token provider) changes that file only.

## Connect it

Three things, each checked live by `status()` (Settings → Self-improvement, and Self-improvement on
GitHub):

1. **The repository**, `owner/name`: a setting, set in Settings → Self-improvement on GitHub (saved
   with execution-do's own, where the agent may push), applied at the next call; its default is the
   config's `repository` (which `pikit configure` writes). The Deploy to Cloudflare button's repository
   is not known before deploying, so the template leaves it empty.
2. **The two tokens** ("Tokens" below), as secrets, never typed into the dashboard: in the Worker's
   Variables and Secrets (they apply at once and stay through deploys).
3. **A ruleset** on the default branch ("Protect the default branch" below): best effort, the status
   reads the rules GitHub applies to it with the read token.

Until the repository and the read token are there, everything but `status` is `not_connected` (503),
saying what is missing; Approve and Reject also need the merge token.

`pikit configure` (`configure.ts`) offers the same in a terminal: the repository (`git remote
get-url origin`'s by default) written to `pikit.config.ts` (both Apps' configs), the two tokens asked
without echo into `.env`, and how to create the ruleset. Without a terminal it asks nothing, and
nothing is missing.

## Configure

```ts
"proposals-github": {
  repository: "ana/my-bot",              // default "": the setting's default (empty: not connected)
  branchPrefix: "pikit/self/",           // default: execution-do's git.branchPrefix
  tokenSecret: "GITHUB_TOKEN",           // default: the token that reads and opens pull requests
  mergeTokenSecret: "PIKIT_MERGE_TOKEN", // default: the token that merges and closes
  apiBase: "https://api.github.com",     // default: GitHub's API (GitHub Enterprise Server, a test double)
}
```

The same entry goes in `config` and in `workerConfig`.

## Tokens

Two secrets, read through `secrets` at each call, never in config, a log line or an answer:

| Secret | Used for | Fine-grained token, this repository only |
|---|---|---|
| `GITHUB_TOKEN` (`tokenSecret`) | listing branches and pull requests, their files, comments and checks; opening a pushed branch's pull request; the status; `remote()`'s authorization | Contents and Pull requests: read and write; Checks and Commit statuses: read. The agent's own token (execution-do's) does. |
| `PIKIT_MERGE_TOKEN` (`mergeTokenSecret`) | Approve (squash merge), Reject (comment and close) | Contents and Pull requests: read and write. Nothing else holds it. |

The merge token is read only by `approve` and `reject`, which only admin-proposals' operator routes
call: no tool, no agent code reaches it. Both secrets holding the same token is refused
(`not_configured`), and so is a config naming one secret for both (the App does not start). On
Cloudflare every secret is a binding the objects' App could read too: what keeps the agent from it is
that no tool reads `secrets` for it.

**Protect the default branch** with a ruleset (Settings → Rules): a pull request required, no direct
push, no force push, status check `checks` (this workflow's job) required, and nobody bypasses it but
the merge token's account if you choose so. The gate then holds even if the agent's token leaks. A
CODEOWNERS on `.github/`, `src/pikit/proposals-github/` and the deployment's files makes "the agent
never changes its gate" checkable.

## What it does

- **A proposal** is a branch under `branchPrefix` of `repository` itself, its id the topic
  (`pikit/self/<topic>`), and its pull request (`number`). A fork's branch with the same name, or a
  person's pull request, is not one: not listed, `not_found` to read or act on.
- **Opening:** a pushed branch with no pull request, nor one closed at its head, gets one into the
  default branch, opened with the read token (at most 5 per call). A rejected or merged branch the agent
  pushes again (a new head) gets a new one.
- **Approve refuses**, before anything is written: a pull request already merged or closed
  (`not_open`); a base other than the default branch (`wrong_base`); a head other than the one the
  operator read (`moved`); checks that fail, still run, or never ran (`checks_failing`), unless
  `override`; GitHub refusing the merge (`not_mergeable`). Each approval and rejection is logged with
  the operator.
- **Checks** are the head commit's check runs and commit statuses: `failing` when one fails, else
  `pending` while one runs, else `passing` when one passed, else `none`.
- **Bounds:** the list reads the last 100 open and 30 closed pull requests and the prefix's branches,
  lists 20 closed proposals, and reads the checks of the first 20 open ones (a Worker's subrequests are
  counted). A proposal's page shows its first 100 files, each patch cut at 60,000 characters and none
  past 400,000 in all.
- **GitHub's errors:** its rate limit is `rate_limited` (429) with `retryAfter`; a refused token is
  `unauthorized` or `forbidden` (502), a repository the token cannot see `missing_repository` (502),
  GitHub down or slow (15 s) `unavailable` (502). Messages name the secret, never hold it.
- **Preview:** best effort, a `https://….workers.dev` URL in the head's check runs (Workers Builds')
  or the pull request's comments.

## Checks

`.github/workflows/pikit-checks.yml` runs on every pull request (`pull_request`, so the proposed code
gets no secret and a read-only token): install with the project's lockfile (`npm ci` with
`package-lock.json`, else `bun install --frozen-lockfile`), `bun run typecheck` when package.json has
the script, `bun test`, and `wrangler deploy --dry-run` with a `wrangler.jsonc`. Its job is `checks`:
the status check to require in the ruleset. `pikit doctor` is not in it: the pikit CLI is not a
dependency of the project nor on npm yet.

## Tests

`proposals-github.test.ts` runs the `proposals` conformance suite, then the component against a fake
GitHub on a local port (`fake-github.test-support.ts`, a read token that cannot merge and a merge token
that can): dormant without a repository; the repository read from the setting at each call; the status
of each part, the merge token never sent; `remote()` authorized by trusted code; a pushed branch's pull
request opened once, titled from its head commit, never reopened at a closed head; the list keeps only
the prefix's branches of the repository itself; a page's patches bounded; approve refused for failing,
pending or missing checks unless overridden, for a non-proposal, a fork, another base, a closed one, a
moved head, GitHub's own refusals; the merge done with the merge token alone, logged with the
operator; reject comments and closes with the merge token; a missing token, the same token twice, a
rate limit, a refused token, GitHub down, none holding a token. `configure.test.ts` runs the
`pikit configure` step with a scripted terminal.

## Remove it

`pikit remove proposals-github` takes the provider, its section and the workflow away; the pull
requests stay on GitHub, to merge there. Remove the ruleset's required check too, or nothing merges.
