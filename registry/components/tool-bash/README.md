# tool-bash

Pi's own `bash` tool, for the agents that name it: it runs a shell command in the working directory and returns its output (the last lines when it is long), with an optional timeout.

- **Provides:** `agent.tool`, under the key `bash`.
- **Requires:** `execution.shell` (for example `execution-local`).
- **Optional:** `workspace` (for example `workspace-local`): each agent's own directory.
- **Targets:** any target with an `execution.shell` provider (`server` with `execution-local`).
- **Installs to:** `src/pikit/tool-bash/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi).

## What it does

An agent gets this tool only when it names it:

```ts
defineAgent({ name: "ops", model: "anthropic/claude-sonnet-4-6", tools: ["bash"] })
```

pikit does not reimplement the tool; it is Pi's. The component adds only two things:
- the environment it works on, read when the tool runs: in a run, the agent's own `workspace` when
  one is installed (`workspace-local` gives each agent a directory); otherwise `execution.shell`.
  A `workspace` without a shell makes every `bash` call fail (`workspace-local` has one);
- It needs a real shell, so it requires `execution.shell`. An environment without one
  (`execution` only) cannot install it, and `pikit doctor` says so.
- its replay: `"never"`: a command can do anything, so after a crash Pi reports the call as interrupted and the model decides whether to run it again.

## Before you give it to an agent

A shell can do anything the environment's OS user can, outside the working directory too. With
`execution-local`, that is the server's user: other projects, `~/.ssh`, this app's credentials.
- Give `bash` only to the agents that need it. An agent gets a tool only when it names it.
- Pi extensions such as `permission-gate` block known-dangerous commands (`rm -rf`, `sudo`). That is
  policy, not isolation.
- Isolation comes from where commands run: a dedicated OS user, a container, a VM, or another
  `execution-*` component.

## Tests

`tool-bash.test.ts` is copied with the component and runs in your project, in a temporary directory.
It covers the tool under its name, its replay, what it does, and that a call in a run works in its
agent's workspace when one is installed.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
