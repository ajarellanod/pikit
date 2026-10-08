# execution-local

The agent's tools work on this server: its filesystem and its shell, with a `git` whose pushes are
fenced and whose token the shell never sees.

- **Provides:** `execution` (files) and `execution.shell` (commands), both Pi's `ExecutionEnv`.
- **Requires:** nothing. **Optional:** `secrets`, for the GitHub token.
- **Target:** `server`.
- **Installs to:** `src/pikit/execution-local/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`, `isomorphic-git` 1.42.3,
  `diff` 8.0.4.

## What it does

It is Pi's own `NodeExecutionEnv`, in a working directory (`root`). Relative paths and commands
start there. `tool-read`, `tool-write`, `tool-edit` and `tool-bash` work through it.

Commands do not inherit the server's environment. They start from an allowlist of variables
(`HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `TZ`, `USER`). Without that, a
command such as `env` would print the server's secrets (`PIKIT_HTTP_TOKEN`, `ANTHROPIC_API_KEY`),
and every program a command runs would inherit them. Pi's own default passes every variable. A
variable added to `variables` (a `GITHUB_TOKEN` for `gh`) is in every command's environment.

The allowlist is not a secret store: it hides nothing from a command that looks. On Linux,
`cat /proc/$PPID/environ` prints the server's whole environment, which the same OS user may read,
and the project's `.env` is a file like any other ("It is not a sandbox", below).

`workspace-local` builds on this environment: each agent's directory is inside `root`
(`<root>/agents/<agent>/` by default), and its commands start with these `variables`.

Stopping the app kills the commands still running. It refuses to start when `root` cannot be
created or written.

## git

`git` in a command is not the machine's: it is this component's own (`git.ts`), isomorphic-git run
by the server, the same command as `execution-do`'s on Cloudflare. `clone` (GitHub over HTTPS,
latest commit only), `status`, `diff`, `add`, `commit -m` (takes every change, like
`git add -A && git commit`), `log`, `push`, and `pr` (opens a pull request through GitHub's API:
`git pr pikit/self/<topic> <title> [-b <body>]`). No `fetch`, `pull`, `merge` or `checkout`: to start
from the latest main, clone again.

The shell reaches it through a small `git` program first on the commands' `PATH` (`shim.ts`): it sends
its arguments and its directory to the server (127.0.0.1, a random port, a random key made at each
start) and prints the answer. The program holds the port and the key, never the token. It lives in a
directory of its own under the system's temporary directory, removed at stop. `git` runs only inside
`root`. A real `git` binary, if the machine has one, is still reachable by its full path: it has no
token and no fence, so the image does not install one.

The fences, as on Cloudflare:
- **Pushes go only to `git.pushRepositories`, on branches under `git.branchPrefix`** (`pikit/self/`
  by default): never to `main`. Those branches are the agent's own, so a push replaces what is there.
  The origin is read and checked at each push, and the push goes to the URL built from it.
- **The token is read through `secrets`** (the secret named `git.tokenSecret`, `GITHUB_TOKEN`) when
  `git` needs it, and sent only to github.com and api.github.com. It is never a command's variable:
  the component refuses to start when `variables` lists it. No credential is written into the
  checkout (`.git/config` holds the plain URL).
- **A failed clone leaves nothing behind**, and a 429 or 5xx from GitHub is retried twice.
- Unlike on Cloudflare, `.git` itself is not fenced: commands may change any file there. A changed
  remote is refused at the push.

### For self-improvement (SPEC §6)

The steward's checkout lives in `root`, `.pikit/workspace` by default, which deployment-docker keeps
in the `pikit-state` volume: it survives restarts and new images. There it can run `bun install` and
`bun test` with the image's Bun before it proposes. Limits: `bun install` downloads from npm (the
container needs the network, and the dependencies take room in the volume) and installs the
devDependencies too; no Docker in the container, so no `pikit up`; `pikit doctor` is not there (the
CLI is not a project dependency). Checks run again in CI (`admin-proposals`' workflow).

**What is not protected on a server.** The token stays out of the shell's variables, its output and
the checkout. It does not stay out of a command that looks for it: commands run as the server's OS
user, and on Linux `cat /proc/$PPID/environ` (or `/proc/1/environ` in the container) prints the
process's whole environment, `GITHUB_TOKEN` and, with `admin-proposals`, `PIKIT_MERGE_TOKEN` included.
Removing a variable from `process.env` after reading it does not help: `/proc/<pid>/environ` keeps
the environment the process started with. A file the server reads, the shell reads too (same user).
So with `bash` on a server, a determined agent can read both tokens:
- give `bash` only to the steward, and only where you accept that;
- use fine-grained tokens scoped to the one repository (the agent's: contents and pull requests; the
  merge token: contents only), and keep the ruleset on the main branch (pull request and the `checks`
  status required);
- for a real wall, the commands must run as another user or elsewhere (another `execution-*`
  component, features/sandboxed-execution.md). On Cloudflare the shell has no processes and no
  environment to read.

## It is not a sandbox

Commands run as the server's OS user. They can read and change whatever that user can, **outside
`root` too**: other projects, `~/.ssh`, and this app's own `.pikit/credentials.json`. Paths are not
confined to `root`, because a shell would step outside anyway, and confining only the file tools
would be false security.

What protects you:
- **Give `bash` only to the agents that need it.** An agent gets a tool only when it names it
  (`tools: ["read"]`).
- **Isolation** comes from where commands run. Run the server as a user that owns nothing else, in
  a container or a VM, or install another `execution-*` component that runs commands elsewhere.
  The tools do not change.

## Config

```ts
"execution-local": {
  root: ".pikit/workspace", // default; relative to the working directory
  variables: ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "TZ", "USER"], // default
  git: {
    tokenSecret: "GITHUB_TOKEN",        // default
    pushRepositories: ["you/your-bot"], // default: none
    branchPrefix: "pikit/self/",        // default
  },
}
```

## Tests

`execution-local.test.ts` is copied with the component and runs in your project, in temporary
directories. It covers:
- the `execution` conformance suite from `@pikit/pi-adapter/testing`, with a shell;
- the lifecycle conformance suite;
- the allowlist (the server's variables unseen, allowed ones seen);
- commands killed at stop, and the start failure;
- `git` from the shell, from clone to pull request, against a fake GitHub reached through `fetch`
  (`git-server.test-support.ts`, no network): the token only on GitHub's requests and never in the
  shell, every fence, a failed clone, `git` outside `root`, and the program removed at stop.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
