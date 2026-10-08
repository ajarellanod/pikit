# execution-local

The agent's tools work on this server: its filesystem and its shell, whose commands start without the
server's secrets.

- **Provides:** `execution` (files) and `execution.shell` (commands), both Pi's `ExecutionEnv`.
- **Requires:** nothing.
- **Target:** `server`.
- **Installs to:** `src/pikit/execution-local/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

It is Pi's own `NodeExecutionEnv`, in a working directory (`root`). Relative paths and commands
start there. `tool-read`, `tool-write`, `tool-edit` and `tool-bash` work through it.

Commands do not inherit the server's environment. They start from an allowlist of variables
(`HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `TZ`, `USER`). Without that, a
command such as `env` would print the server's secrets (`PIKIT_HTTP_TOKEN`, `ANTHROPIC_API_KEY`),
and every program a command runs would inherit them. Pi's own default passes every variable. A
variable added to `variables` is in every command's environment.

The allowlist is not a secret store: it hides nothing from a command that looks. On Linux,
`cat /proc/$PPID/environ` prints the server's whole environment, which the same OS user may read,
and the project's `.env` is a file like any other ("It is not a sandbox", below).

`workspace-local` builds on this environment: each agent's directory is inside `root`
(`<root>/agents/<agent>/` by default), and its commands start with these `variables`.

Stopping the app kills the commands still running. It refuses to start when `root` cannot be
created or written.

## git, and self-improvement (SPEC §6)

`git` in a command is the machine's own: deployment-docker's image installs it, and commits as
"pikit agent". For self-improvement (`proposals-local`) the steward clones the project from the
proposals repository on this server (`.pikit/self/project.git`, in the `pikit-state` volume), works
in a checkout under `root` (`.pikit/workspace`, which survives restarts and new images), runs
`bun install` and `bun test` there with the image's Bun, and pushes its branch
`pikit/self/<topic>` back: that is the proposal (extension-pikit-self tells it how, from
`proposals.remote()`).

There is no fence and no token in this git, on purpose: the shell runs as the app's user and can write
that repository's files anyway, so a fenced git would protect nothing. On a server an approval is the
operator's decision, not a lock, and the deployer (deployment-docker) checks, waits for `/health` and
rolls back whatever it deploys (proposals-local's README). A real lock needs the commands to run as
another user or in another container (features/sandboxed-execution.md). On Cloudflare, execution-do's
own git keeps its fences and the GitHub token away from the agent.

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
}
```

## Tests

`execution-local.test.ts` is copied with the component and runs in your project, in temporary
directories. It covers:
- the `execution` conformance suite from `@pikit/pi-adapter/testing`, with a shell;
- the lifecycle conformance suite;
- the workspace git suite (`createWorkspaceGitConformance`, the one execution-do passes): the
  steward's steps with the machine's `git` against a bare repository, as proposals-local's (skipped,
  saying so, where `git` is not installed);
- the allowlist (the server's variables unseen, allowed ones seen);
- commands killed at stop, and the start failure.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
