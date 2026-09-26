# workspace-local

Each agent's tools work in a directory of their own on this server: order, not isolation.

- **Provides:** `workspace`.
- **Requires:** nothing. The tool components (`tool-read`, `tool-write`, `tool-edit`, `tool-bash`)
  use it when it is installed.
- **Target:** `server`.
- **Installs to:** `src/pikit/workspace-local/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

Without it, every agent's tools work in `execution`'s one directory. With it, each agent gets
`<root>/<agent>/` (`.pikit/workspaces/support/`, `.pikit/workspaces/ops/`):
- A tool call in a run asks for the workspace of the run's conversation, and gets its agent's
  directory. Every conversation of one agent shares it; two agents never do.
- A directory is created on the agent's first call. Removing the component leaves them on disk;
  the tools go back to `execution`.
- An agent name that is not kebab-case (`..`, `a/b`, empty) is refused: the tool call fails, and
  nothing is created outside `root`.
- Each directory is Pi's own `NodeExecutionEnv`, with a shell, so `bash` works in it too. Commands
  start from an allowlist of the server's variables, as with `execution-local`, so `env` does not
  print the server's secrets.
- It refuses to start when `root` cannot be created or written. Stopping the app kills the commands
  still running.

A tool called outside a run (a test calling it directly) has no conversation, and works in
`execution` as before. Install `execution-local` too: the tools still require it.

## Order, not isolation

A directory per agent keeps the agents' files apart when they behave. It is not a wall:
- Paths are not confined. A file tool given `../ops/notes.md` or an absolute path reads it.
- `bash` runs as the server's OS user. It can `cd ..`, read another agent's files, and read this
  app's `.pikit/credentials.json`.

Real isolation needs each agent's tools in a sandbox of their own: an `execution-*` component that
runs them in a container (`execution-docker`, planned after M2). Until then, give `bash` only to the
agents that need it, and see `execution-local`'s README.

## Config

```ts
"workspace-local": {
  root: ".pikit/workspaces", // default; relative to the working directory
  variables: ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "TZ", "USER"], // default
}
```

## Tests

`workspace-local.test.ts` is copied with the component and runs in your project, in temporary
directories. It covers:
- the `workspace` conformance suite, and the `execution` one on an agent's directory (with a shell);
- two agents in two directories, one agent in one environment;
- in real runs (scripted model), a file agent A writes is in A's directory and not in B's;
- unsafe agent names refused;
- the allowlist of variables;
- the lifecycle conformance suite and the start failure.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
