# The CLI

`pikit` is [packages/cli](../packages/cli) (entry: [main.ts](../packages/cli/src/main.ts), commands in
[commands/](../packages/cli/src/commands)). It needs Bun ≥ 1.4.0. It copies components into a project,
edits the project's files and runs the project's code in child processes; it never imports Pi. The
installer ([installer/install.sh](../installer/install.sh)) puts it in `~/.pikit/bin/pikit` from a
checkout in `~/.pikit/pikit` and runs `pikit new`.

Project commands run in the current directory. `add`, `upgrade`, `ui` and `remove` refuse to start
while a previous one was left unfinished (its marker is reported by `doctor` until you delete it).
Exit codes: 0 done, 1 a problem, 2 a usage error, 130 cancelled.

## pikit new

```
pikit new [--target <t>] [--preset <p>] [--with <component>]... [--ui]      guided, in a terminal
pikit new <dir> [--target server|durable] [--preset <name> [--with <component>]...] [--ui] [--registry <path>]
```

- Without `<dir>`, the guided path ([wizard.ts](../packages/cli/src/commands/wizard.ts)) asks the
  agent's name, where it runs, the preset, then two multi-selects: **where you talk to it** (every
  `channel-*` of the target, several at once, the preset's checked; skipped when the target has one)
  and **what it can do** (the dashboard and the preset's `features`, none checked). Then it runs
  `new`, `configure`, and `up` or `dev`, and prints the same as one command. Flags answer its
  questions. Running it again with the same name continues.
- With `<dir>` ([new.ts](../packages/cli/src/commands/new.ts)): writes the project's own files
  ([starter.ts](../packages/cli/src/commands/starter.ts): `pikit.config.ts` (two Apps on `durable`),
  the agent `src/agents/assistant/agent.ts` provided by `src/extensions/agents.ts`, `package.json`,
  `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.gitattributes`, a README, the skills in
  `.agents/skills/`), vendors the kit packages into `vendor/` as tarballs, adds every component of the
  preset as `pikit add` does, runs `bun install` once, and ends with `pikit doctor`.
- `--target` is recorded in `pikit.json` (`server` by default). A preset for another target is refused.
- `--with` answers both steps. For a kind the preset asks with `multiple: true` (channels), the
  `--with`s of that kind are the whole answer: `--preset http --with channel-telegram` is Telegram
  alone, `--with channel-http --with channel-telegram` both. Another kind's `--with` replaces the
  preset's component of that kind; a feature's `--with` adds it. `--ui` adds the dashboard
  ([dashboard.md](dashboard.md)). `--registry` uses another registry folder.
- A preset's `features` ([features/cli-features.md](../features/cli-features.md)) are opt-in
  components: on `http`, `router-rules`, `tool-mcp`, `tool-fetch`, `tool-websearch-brave`,
  `health-registry`; on `telegram-cloudflare`, `router-rules`, `tool-mcp`, `health-registry`.
  `registry validate` checks each one composes alone and all together.
- Everything refusable is refused before the first write. A failure after it leaves the directory
  marked `UNFINISHED`.

Presets in [registry/presets](../registry/presets): `http` (server, channel-http), `telegram` (an
alias of `http` with channel-telegram), `telegram-cloudflare` (durable), `cloudflare-minimal` (durable,
storage only).

## pikit add

```
pikit add <component>... [--registry <path>] [--force] [--yes]
```

Copies components and wires them, as one transaction: files and README into `src/pikit/<name>/`, npm
packages, the entry in `pikit.config.ts` (both Apps on Cloudflare), `.env.example`, the record in
`pikit.json`, the bases in `pikit-bases/`, a view into `src/dashboard/` when the project has a UI; then
`bun install` and `doctor`. It offers missing providers. `--yes` skips the confirmation (needed
without a terminal). `--force` reinstalls an installed component (overwriting your edits), overwrites
differing files, and accepts a kit it would otherwise refuse. Details: [components.md](components.md#install-pikit-add).

## pikit remove

```
pikit remove <component> [--force]
```

The install in reverse, both Apps, plus what was installed for it when nothing else uses it. Refuses
when another component requires a capability only this one provides. `--force` deletes your modified
files and removes it even when an agent names one of its keys, when it leaves a channel without a
router or routes without a server, or when the App does not compose.

## pikit upgrade

```
pikit upgrade [<component>...] [--dry-run] [--force] [--yes]
```

Takes the registry's version, merging your edits file by file (`git merge-file` against the base kept
at install). Without names: every component that changed, the vendored kit, then the dashboard.
`--dry-run` only says what it would do. A conflict is written with markers and exits 1. `--force`
accepts a downgrade or a kit range it would refuse, and overwrites new files that exist and differ.

## pikit ui on | off

```
pikit ui on | off [--force] [--yes]
```

`on` installs `admin-auth-token` and `admin-api` if missing, writes `src/dashboard/` from
`registry/dashboard/files` (recorded in `pikit.json`'s `dashboard`, with bases), and runs `bun install`
there. `off` deletes `src/dashboard/` and removes what `on` installed; it refuses without `--force`
when you modified or added a file there.

## pikit doctor

Everything up to `setup`, never a `start` ([doctor.ts](../packages/cli/src/commands/doctor.ts)). It
composes `pikit.config.ts` in a child process and prints, for each App, the components in start order
(provides, requires, uses if present), each capability's provider or keys, each pipeline's stages with
priorities, and the config (secrets redacted). Then it checks:

| Check | Kind |
|---|---|
| no `add`, `remove` or `upgrade` left unfinished | problem |
| `node_modules` exists; `bun.lock` matches `package.json` (offline) | problem |
| the App composes: every required capability provided, selections valid, config valid | problem |
| every tool and model provider an agent names is installed (names the registry component that provides a missing one) | problem |
| the App answers someone: a channel has a `route.resolve` stage, `http.route`s have a server (in the Worker's App, the host serves them) | problem |
| only `@pikit/pi-adapter` imports `@earendil-works/*` in the project's sources | problem |
| each component's own `hooks.doctor` (the only checks that may use the network) | problem or note |
| every required `environment` variable is set in the environment or `.env` (names only) | unconfigured |
| a config value that looks like a secret | warning |
| modified or deleted installed files, a component installed but not listed, a provider nothing uses, a vendored kit that is not this CLI's | note |

It exits 1 on any problem or unconfigured variable, and prints `pikit doctor: green` otherwise.

## pikit configure

```
pikit configure [--yes] [--generate <NAME>]... [--login <provider> [--login-method browser|code] [--local]]
```

Writes `.env` (mode 0600). In order: each component's own step (`src/pikit/<name>/configure.ts`:
checks a token, discovers an id), then the other `environment` variables the components declare (a
secret is asked without echo; a required `*_TOKEN` can be generated), then model credentials for each
provider an agent names that has none: an OAuth login (stored by `credentials-file`) or the API key in
the variable the provider's component declares first.

- `--yes`, or no terminal: asks nothing; values come from the environment or `--generate`, and a
  missing required one fails.
- `--generate NAME`: fill `NAME` with 32 random bytes in hex (`PIKIT_ADMIN_TOKEN`, a webhook secret).
- `--login <provider>`: run that provider's OAuth login. It logs in where the app runs (through the
  deployment's `exec`, in Docker's volume) unless `--local` (this machine, for `pikit dev`).
  `--login-method` picks `browser` or `code`.

It never prints a value, and never touches Pi's own `~/.pi/agent/auth.json`.

## pikit dev

Runs the project here after `doctor` passes and the model credentials of this machine are checked:
the deployment's `dev` when it exports one (`wrangler dev` on Cloudflare), else `bun --watch
src/pikit/<deployment>/main.ts` with `.env` loaded (deployment-docker).

## pikit up | down | restart | logs | status

```
pikit up | down | restart | status
pikit logs [--follow] [--tail <n>]
```

Delegated to the installed `deployment-*` component's exported functions
([deployment.ts](../packages/cli/src/commands/deployment.ts); see [targets.md](targets.md#deployment-components)).
`up` first runs `doctor` (skipping the `doctor` hook of a component that has a `beforeDeploy`, which
`up` runs right before the build) and checks model credentials where the app runs. `restart` exists
only where the deployment exports it (Docker).

## pikit registry

```
pikit registry validate | generate | capabilities [<registry-root>]
```

In this repository also `bun run registry …` ([scripts/registry.ts](../scripts/registry.ts)), which
defaults to `registry/`.

- `generate`: rewrites the fields of each `component.json` that `setup` declares, `registry.json`,
  and the JSON Schemas.
- `validate`: checks every component, preset and schema ([components.md](components.md#validation));
  exits 1 on any problem.
- `capabilities`: each capability with its mode, where it is defined, its stability, its summary,
  and who provides and uses it.

## Not built

`init`, `create`, `outdated`, `diff`, `config`, `expose` and `deploy` answer "not built yet" (some
with the design note that specifies them) and exit 1. [features/cli-features.md](../features/cli-features.md)
is a design note.

`pikit --version` prints the CLI's version and the commit of its checkout.
