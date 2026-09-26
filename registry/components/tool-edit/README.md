# tool-edit

Pi's own `edit` tool, for the agents that name it: it replaces exact pieces of text in a file, each one unique in it.

- **Provides:** `agent.tool`, under the key `edit`.
- **Requires:** `execution` (for example `execution-local`).
- **Optional:** `workspace` (for example `workspace-local`): each agent's own directory.
- **Targets:** `server` and `cloudflare`: any target with an `execution` provider.
- **Installs to:** `src/pikit/tool-edit/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi).

## What it does

An agent gets this tool only when it names it:

```ts
defineAgent({ name: "ops", model: "anthropic/claude-sonnet-4-6", tools: ["edit"] })
```

pikit does not reimplement the tool; it is Pi's. The component adds only two things:
- the environment it works on, read when the tool runs: in a run, the agent's own `workspace` when
  one is installed (`workspace-local` gives each agent a directory); otherwise `execution`;
- its replay: `"never"`: it changes files, and applying an edit twice is not the same as once.

## Tests

`tool-edit.test.ts` is copied with the component and runs in your project, in a temporary directory.
It covers the tool under its name, its replay, what it does, and that a call in a run works in its
agent's workspace when one is installed.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
