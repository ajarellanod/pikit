# tool-write

Pi's own `write` tool, for the agents that name it: it creates or overwrites a file, creating its parent directories.

- **Provides:** `agent.tool`, under the key `write`.
- **Requires:** `execution` (for example `execution-local`).
- **Targets:** `server` and `cloudflare`: any target with an `execution` provider.
- **Installs to:** `src/pikit/tool-write/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi).

## What it does

An agent gets this tool only when it names it:

```ts
defineAgent({ name: "ops", model: "anthropic/claude-sonnet-4-6", tools: ["write"] })
```

pikit does not reimplement the tool; it is Pi's. The component adds only two things:
- the environment it works on: `execution`, read when the tool runs;
- its replay: `"never"`: it changes files, so after a crash Pi reports the call as interrupted and the model decides whether to write again.

## Tests

`tool-write.test.ts` is copied with the component and runs in your project, in a temporary directory.
It covers the tool under its name, its replay, and what it does.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
