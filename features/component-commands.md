# Component commands: `pikit <name>` from an installed component

**Public appeal:** —

**Specified:** this note. Built with its first user, [agent folders](agent-folders.md) (`pikit agents`).

**Needed by:** agent folders. tool-mcp could refresh its seed with one (`pikit mcp-seed`) instead of
waiting for a deploy.

## What it gives
An installed component adds a command to the CLI: `pikit agents` runs agents-folders' generator in the
project. The CLI knows nothing of what it does, as it knows nothing of Docker (`pikit up` is the
deployment component's) or of MCP (tool-mcp's `doctor` hook): it finds the command in `pikit.json` and
runs the component's file. Removing the component removes the command.

## How it fits pikit
- **The generalisation of what the CLI already does.** `pikit up | down | restart | logs | status` are
  functions the installed `deployment-*` exports (`packages/cli/src/commands/deployment.ts`), and
  `doctor`, `beforeDeploy` and `afterDeploy` are hooks a component declares in `component.json` and
  `pikit add` records in `pikit.json` (`HOOKS`, `packages/cli/src/registry/manifest.ts`). A command is
  a hook the user runs by name.
- **Declared in `component.json`**, beside `hooks`:

  ```jsonc
  "commands": {
    "agents": { "file": "generate.ts", "description": "Write src/extensions/agents.ts from src/agents/ and src/skills/" }
  }
  ```

  The name is kebab-case and never one of the CLI's own (`BUILT_IN_COMMANDS`: `new`, `add`, `remove`,
  `upgrade`, `ui`, `doctor`, `configure`, `dev`, `registry`, `help`, the deployment's `up`, `down`,
  `restart`, `logs`, `status`, and the names kept for later, `init`, `create`, `outdated`, `diff`,
  `config`, `expose`): `registry validate` refuses it. The file is the component's own
  (`src/pikit/<name>/…`, the hooks' `OWN_FILE` rule); the description is one line.
- **Recorded by `pikit add`** in `pikit.json`, under the component, by project path, as hooks are:
  `"commands": { "agents": { "file": "src/pikit/agents-folders/generate.ts", "description": "…" } }`.
  `pikit upgrade` records the new manifest's; `pikit remove` takes the component and its commands.
- **One owner per name.** `pikit add` refuses, before it writes anything, a component whose command an
  installed component (or another in the same `add`) already declares, naming both.
- **Run in the project, never in the CLI's process** (`packages/cli/src/project/run.ts`): `pikit <name>
  [args…]` in a project whose `pikit.json` declares `<name>` runs `component-command.ts` in a child
  `bun`, in the project's directory, with its environment (`.env` under the process's), stdin and
  stdout inherited (a command may ask and print). The arguments after the name are the command's,
  passed as they are: the CLI's own flags are not parsed for it.
- **The file exports `command(io)`**, resolving with its problems (empty, or nothing, when it is done):

  ```ts
  export async function command({ args, config, get, say }: {
    args: readonly string[];                              // what follows `pikit <name>`
    config(): Promise<Readonly<Record<string, unknown>>>; // its config in pikit.config.ts (imported when asked)
    get(name: string): string | undefined;                // a variable of the environment or .env
    say(line: string): void;                              // a line for the person running it
  }): Promise<string[] | void>
  ```

  `config` is a function: importing `pikit.config.ts` imports every component, and a command that
  repairs the project (agent folders' generator, when `src/extensions/agents.ts` is broken) must run
  without it. Problems are printed and the command exits 1; a file that does not export `command`, or a
  command that throws, is a problem too. It runs as the project's code does: it may write the project's
  files.
- **Listed by `pikit help`** (and `pikit` alone) inside a project: the installed components' commands,
  each with its description and its component, after the CLI's own.
- **Outside a project**, or a name nothing declares, is the CLI's error as today (`unknown command`).

## Pi first
Pi's coding agent has extension commands (`/name`), run inside a session; nothing for a project's
tooling. Nothing to take from Pi.

## Tests
- `manifest.ts` / `registry validate`: a command named as a built-in, not kebab-case, or whose file is
  not the component's own is refused.
- `pikit add`: records the commands by project path; refuses a name another installed component (or
  one in the same batch) declares, writing nothing; `pikit upgrade` records the new ones; `pikit remove`
  drops them.
- The CLI: `pikit <name> a --b` runs the command with `["a", "--b"]` in the project; problems exit 1
  and are printed; no `command` export is a problem; `config()` reads the component's config;
  `pikit help` lists the commands; a name outside a project is `unknown command`.

## Open questions
- A command that runs where the app runs (`runScriptInApp`, as `pikit configure --login` does), for a
  maintenance task against the deployed storage: not needed by its first user.
