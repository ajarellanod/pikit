# execution-local

The agent's tools work on this server: its filesystem and its shell.

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
command such as `env` would print the server's secrets (`PIKIT_HTTP_TOKEN`, `ANTHROPIC_API_KEY`).
Pi's own default passes every variable. Add a variable to `variables` only when a command needs it
(a `GITHUB_TOKEN` for `gh`), and remember that the agent can then read it.

Stopping the app kills the commands still running. It refuses to start when `root` cannot be
created or written.

## It is not a sandbox

Commands run as the server's OS user. They can read and change whatever that user can, **outside
`root` too**: other projects, `~/.ssh`, and this app's own `.pikit/credentials.json`. Paths are not
confined to `root`, because a shell would step outside anyway, and confining only the file tools
would be false security.

What protects you:
- **Give `bash` only to the agents that need it.** An agent gets a tool only when it names it
  (`tools: ["read"]`).
- **Policy extensions** such as Pi's `permission-gate` block known-dangerous commands (`rm -rf`,
  `sudo`). That is policy, not isolation: a command they do not recognise still runs.
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
- the allowlist (the server's variables unseen, allowed ones seen);
- commands killed at stop, and the start failure.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
