# workspace-local

Each agent's tools work in a directory of their own, inside execution: order, not isolation.

- **Provides:** `workspace`.
- **Requires:** `execution` (`execution-local`): the agents' directories are in it.
- **Target:** `server`.
- **Installs to:** `src/pikit/workspace-local/`.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

Without it, every agent's tools work in `execution`'s one directory. With it, each agent gets
`<root>/<agent>/` inside `execution`'s (`.pikit/workspace/agents/support/`,
`.pikit/workspace/agents/ops/` with `execution-local`'s defaults):
- A tool call in a run asks for the workspace of the run's conversation, and gets `execution`
  itself, working in its agent's directory. Every conversation of one agent shares it; two agents
  never do.
- A directory is made on the agent's calls. Removing the component leaves them on disk; the tools
  go back to `execution`'s directory.
- An agent name that is not kebab-case (`..`, `a/b`, empty) is refused: the tool call fails, and
  nothing is created outside `root`.
- Everything else is `execution`'s: its shell (so `bash` works when `execution` has one), its
  variables (`execution-local`'s `variables`: a `GITHUB_TOKEN` added there reaches every agent's
  commands), and its stop, which kills the commands still running.
- It refuses to start when `root` cannot be created.

A tool called outside a run (a test calling it directly) has no conversation, and works in
`execution`'s directory.

## Order, not isolation

A directory per agent keeps the agents' files apart when they behave. It is not a wall:
- Paths are not confined. A file tool given `../ops/notes.md` or an absolute path reads it.
- `bash` runs as `execution` runs it: with `execution-local`, as the server's OS user. It can
  `cd ..`, read another agent's files, and read this app's `.pikit/credentials.json`.

Real isolation needs each agent's tools in a sandbox of their own: an `execution-*` component that
runs them in a container (`execution-docker`, a planned feature: `features/sandboxed-execution.md`).
Until then, give `bash` only to the agents that need it, and see `execution-local`'s README.

## Config

```ts
"workspace-local": {
  root: "agents", // default; relative to execution's working directory, or absolute
}
```

## Tests

`workspace-local.test.ts` is copied with the component and runs in your project, in temporary
directories. It covers:
- the `workspace` conformance suite, and the `execution` one on an agent's directory (with a shell);
- one directory per agent under `root`, relative to `execution`'s directory or absolute;
- `execution`'s variables in an agent's commands, which run in its directory;
- in real runs (scripted model), a file agent A writes is in A's directory and not in B's;
- unsafe agent names refused;
- the lifecycle conformance suite and the start failure.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
