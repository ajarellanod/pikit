# proposals-local

Self-improvement on a server (SPEC §6, `features/self-improvement.md`), with nothing to set up: no
GitHub, no token, no CI. The agent's changes to itself are branches `pikit/self/<topic>` of a git
repository on this server; an operator approves or rejects them in the dashboard (`admin-proposals`);
the deployer next to the app (`deployment-docker`) merges, checks and deploys what is approved, and
rolls back when the new version is unhealthy.

- **Provides:** `proposals`.
- **Requires:** nothing. **Works with:** `admin-proposals` (the dashboard's Proposals and Settings →
  Self-improvement), `deployment-docker` (the deployer: `pikit up` starts it when this component is
  installed), `extension-pikit-self` (it tells the steward how to propose, from `remote()`).
- **Target:** `server`.
- **Installs to:** `src/pikit/proposals-local/`.
- **npm dependencies:** `isomorphic-git` 1.42.3, `diff` 8.0.4, `typebox`.

```sh
pikit add admin-proposals proposals-local    # or: pikit new --preset http --with admin-proposals
```

## How a change goes

1. **The project is a git repository.** `pikit new` on a server makes it one (`main`, everything
   committed). Commit what you change by hand: the deployer deploys `main` plus the proposal, so it
   waits while the project has uncommitted changes, and says so.
2. **The proposals repository** is a bare repository in the app's state volume,
   `.pikit/self/project.git`. The deployer makes it from the project's `main` when it starts, and keeps
   its `main` there. `remote()` answers its path.
3. **The steward proposes** with plain git in its shell (the image has git), as on every target:
   `git clone <remote> project`, `git checkout -b pikit/self/<topic>`, the change, `bun install` and
   `bun test`, `git commit -m "<title>" -m "<description>"`, `git push origin pikit/self/<topic>`.
   The pushed branch is the proposal: its head commit's first line is the title, the rest the
   description.
4. **The operator reads it** in the dashboard: the description, the diff against `main` per file (from
   where the branch left `main`), and once approved the deployer's checks.
5. **Approve** records the head the operator read, with the operator, in `.pikit/self/decisions.json`.
   The deployer picks it up within seconds: it merges it into the project's `main` (fast-forward when
   it can, else a merge commit; a conflict fails it), runs `bun install --frozen-lockfile`,
   `bun run typecheck` and `bun test` in containers without the Docker socket, builds the image,
   restarts the app and waits for `/health`; on any failure it keeps or restores the previous image and
   `main` does not move. It writes what happened to `.pikit/self/deployer.json`, which this component
   reads: the proposal's state (`approved`, `merged`, `failed`), its deploy and checks, and the
   status's last deploy, rollback and failure.
6. **Reject** records the rejection and its comment, keeps the head under `refs/pikit/rejected/<topic>`
   and deletes the branch. A new push on the same topic is a new proposal.

A proposal's id is its topic. Approving a head that moved since the operator read it is `moved`;
acting on one decided already is `not_open`.

## Security: an approval is a decision, not a lock

On a server the agent's shell runs in the app's container, as the same user as the app. It can write
the proposals repository and `decisions.json` directly, so it could push any branch or forge an
approval; there is no fence in git and no token to keep. What holds:
- the deployer trusts nothing of the app's but "this head of this branch was approved": it fetches the
  head itself, refuses a change of the deployment's own files (compose.yaml, the Dockerfile,
  `.dockerignore`, `src/pikit/deployment-docker/`), runs the agent's code only in containers without
  the socket or secrets, and always checks, waits for `/health` and rolls back;
- give `bash` only to the steward, and ask it for changes only through doors only you reach.

A real lock needs the agent's commands to run elsewhere, as another user or in another container
(`features/sandboxed-execution.md`).

## Status

`status()` checks the proposals repository (made, `main` at which commit), the deployer (its
heartbeat younger than 60 s), and the project's checkout as the deployer last saw it (a repository on
`main`, nothing uncommitted). It is connected when all three are. Before `pikit up` (or under
`pikit dev`, which runs no deployer) it says what is missing, and `list` is `not_connected`.

## Configure

```ts
"proposals-local": {
  directory: ".pikit/self",     // default: in the state volume, shared with the deployer
  branchPrefix: "pikit/self/",  // default
  mainBranch: "main",           // default
}
```

## Tests

`proposals-local.test.ts` runs the `proposals` conformance suite over a repository made with
isomorphic-git (`repository.test-support.ts`, no git binary needed), then: the title and description
from the head commit, the files against `main` (added, modified, removed, binary) with their patches;
an approval written for the deployer, and the deployer's outcome read back as the state, the deploy and
the checks; the deployer's heartbeat in the status; a rejection kept under `refs/pikit/rejected/` and a
new push on the topic open again.

## Remove it

`pikit remove proposals-local` (with `admin-proposals`): the next `pikit up` no longer enables the
deployer's profile; stop a running one with `docker compose --profile self-improvement down`. The
state volume keeps `.pikit/self/`.
