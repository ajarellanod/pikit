# tool-read

Pi's own `read` tool, for the agents that name it: it reads a text file (from a line, up to a number of lines) or an image, and truncates long files for the model.

- **Provides:** `agent.tool`, under the key `read`.
- **Requires:** `execution` (for example `execution-local`).
- **Targets:** `server` and `cloudflare`: any target with an `execution` provider.
- **Installs to:** `src/pikit/tool-read/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi).

## What it does

An agent gets this tool only when it names it:

```ts
defineAgent({ name: "ops", model: "anthropic/claude-sonnet-4-6", tools: ["read"] })
```

pikit does not reimplement the tool; it is Pi's. The component adds only two things:
- the environment it works on: `execution`, read when the tool runs;
- its replay: `"safe"`: it only reads, so a run resumed after a crash reads again.

## Tests

`tool-read.test.ts` is copied with the component and runs in your project, in a temporary directory.
It covers the tool under its name, its replay, and what it does.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
