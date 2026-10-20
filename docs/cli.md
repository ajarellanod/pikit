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
  project's name, where it runs, the preset, **its channels** (every `channel-*` of the target,
  several at once), **one agent or several**, and **optional features**. Full presets include the
  dashboard; `cloudflare` and `celld` start with no external channel and accept an empty selection.
  The one-or-several question is the preset's (`agents.folders`): several chooses the feature it
  names (`agents-folders` in the kit's presets); one keeps the simple code registry. After each
  answer it plans the project again: a feature the composition cannot run (self-improvement with
  `deployment-local`) is shown disabled with the reason, and the deployment you chose is never
  changed for you. Then it runs
  `new`, `configure`, and `up` or `dev`, and prints the same as one command. Flags answer its
  questions. Running it again with the same name continues.
- With `<dir>` ([new.ts](../packages/cli/src/commands/new.ts)): writes the project's own files
  ([starter.ts](../packages/cli/src/commands/starter.ts): `pikit.config.ts` (two Apps on `durable`),
  Steward (`src/agents/steward/agent.ts`, `steward: true`) provided by `src/extensions/agents.ts`, `package.json`,
  `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.gitattributes`, a README, the skills in
  `.agents/skills/`), vendors the kit packages into `vendor/` as tarballs, adds every component of the
  preset as `pikit add` does, runs `bun install` once, and ends with `pikit doctor`. Steward names
  exactly the preset's `steward` grants and those of the chosen features. With the preset's
  agent-folders feature chosen, the prompt is in `SYSTEM.md` and creation runs the command the preset
  names (`pikit agents`) once before doctor; later folder changes need that command explicitly. On
  `server` it
  then makes the project a git repository on `main`, everything committed (self-improvement's deployer
  merges there); without git it says so and goes on.
- `--target` is recorded in `pikit.json` (`server` by default). A preset for another target is refused.
- `--with` answers both steps. For a kind the preset asks with `multiple: true` (channels), the
  `--with`s of that kind are the whole answer: `--preset base --with channel-telegram` is Telegram
  alone, `--with channel-http --with channel-telegram` both. Another kind's `--with` replaces the
  preset's component of that kind; a feature's `--with` adds it. `--ui` adds the dashboard
  ([dashboard.md](dashboard.md)) for presets that do not already include it. A preset declares
  `ui: true`; aliases inherit it. A multiple choice may have no default component: selecting a
  channel then adds it rather than replacing one. `--registry` uses another registry folder.
- A preset's `features` ([features/cli-features.md](../features/cli-features.md)) are opt-in
  components or groups: `agents-folders`, `router-rules`, `agents-live`, `tool-mcp`, `health-registry`
  and Self-improvement (`--with admin-proposals`: with `proposals-local` on `base` and `telegram`;
  on `cloudflare` and `celld`, with
  `proposals-github` and `repo-github-app`). `--with agents-folders` selects several code agents
  without a terminal. What a feature brings besides its components is the preset's to say: base's
  Self-improvement has `ui: true` (the dashboard) and grants Steward `bash` (it runs git and the
  tests in its shell). It needs a deployment that runs the deployer (`proposals.deployer`): with
  `deployment-local` it is unavailable, and `--with admin-proposals` fails. `registry validate`
  checks each feature with each answer of the deployment question, alone and together.
- Everything refusable is refused before the first write (and before any login): a deployment issue
  ([components.md](components.md#what-it-needs-of-its-deployment)), a grant no chosen component
  provides, a `config` entry or agent layout that does not fit. A failure after it leaves the
  directory marked `UNFINISHED`.

Presets in [registry/presets](../registry/presets): `base` (server, HTTP and dashboard), `telegram`
(an alias of `base` with Telegram polling and the same dashboard), `cloudflare` (durable on
Cloudflare) and `celld` (durable on your fleet), both with a dashboard and no default external
channel; `base-cloudflare` is storage-only infrastructure, with no runtime or dashboard.

For Telegram on Cloudflare, opt in explicitly:
`pikit new my-bot --target durable --preset cloudflare --with channel-telegram-webhook`.

## pikit add

```
pikit add <component>... [--registry <path>] [--force] [--yes]
```

Copies components and wires them, as one transaction: files and README into `src/pikit/<name>/`, npm
packages, the entry in `pikit.config.ts` (both Apps on Cloudflare), `.env.example`, the record in
`pikit.json`, the bases in `pikit-bases/`, a view into `src/dashboard/` when the project has a UI, its
UI project into `src/<name>/` when it ships one (listed in `tsconfig.json` and `bunfig.toml` so `tsc` and
`bun test` skip it); then `bun install` (and in that UI project) and `doctor`. It offers missing providers. `--yes` skips the confirmation (needed
without a terminal). Before confirming it plans the whole project as it would be, offers included,
and refuses a deployment issue it would introduce: a second deployment, or a component its
deployment does not support (proposals-local or expose-cloudflare-tunnel with `deployment-local`).
`--force` reinstalls an installed component (overwriting your edits), overwrites differing files, and
accepts a kit it would otherwise refuse; it never bypasses the deployment check. It grants no agent
a tool. Details: [components.md](components.md#install-pikit-add).

## pikit remove

```
pikit remove <component> [--force]
```

The install in reverse, both Apps, plus what was installed for it when nothing else uses it. Refuses
when another component requires a capability only this one provides. `--force` deletes your modified
files and removes it even when an agent names one of its keys, when it leaves a channel without a
router or routes without a server, or when the App does not compose. Not even with `--force` does it
remove the only deployment that supports what another component needs (remove that one first);
removing what makes a project wrong (a component its deployment cannot run, one of two deployments,
a deployment that cannot run what is installed) is allowed, and `doctor` keeps reporting what
remains (exit 1). To change deployment, remove the old one, then
add the new one.

## pikit upgrade

```
pikit upgrade [<component>...] [--dry-run] [--force] [--yes]
```

Takes the registry's version, merging your edits file by file (`git merge-file` against the base kept
at install). Without names: every component that changed, the vendored kit, then the dashboard.
`--dry-run` only says what it would do. A conflict is written with markers and exits 1. `--force`
accepts a downgrade or a kit range it would refuse, and overwrites new files that exist and differ.
A change of what a component needs of its deployment, or what a deployment supports, counts as a
change even at the same version; everything asked is checked as one set before any write (and by
`--dry-run`), and a deployment issue it would introduce is refused, `--force` or not.

## pikit ui on | off

```
pikit ui on | off [--force] [--yes]
```

`on` installs the components the registry's dashboard descriptor lists
(`registry/dashboard/dashboard.json`: `admin-auth-token`, `admin-api`, `settings-store` in the kit's),
a default among them only when the project's composition does not already provide the capability
it stands for (`admin.auth`, `settings`), and checks the result as `add` does. On Cloudflare
each capability must be present in both Apps; a partial provider is refused rather than duplicated.
A composition it cannot probe is not guessed: fix it with `pikit doctor` first. `new --ui` and a
preset feature with `ui: true` make the same decision from the same descriptor and the chosen
manifests, target and Apps. An alternative settings provider still
owns its operator surface: `settings` alone does not promise the dashboard's settings HTTP API.

It writes `src/dashboard/` from `registry/dashboard/files` (recorded in `pikit.json`'s `dashboard`,
with bases), and runs `bun install` there. `off` removes only the components the dashboard added,
never providers chosen by the preset or installed before it, and refuses without `--force` when
you modified or added a dashboard file.

## pikit doctor

Everything up to `setup`, never a `start` ([doctor.ts](../packages/cli/src/commands/doctor.ts)). It
composes `pikit.config.ts` in a child process and prints, for each App, the components in start order
(provides, requires, uses if present), each capability's provider or keys, each pipeline's stages with
priorities, and the config (secrets redacted). Then it checks:

| Check | Kind |
|---|---|
| no `add`, `remove` or `upgrade` left unfinished | problem |
| one deployment, supporting what every component needs of it (`requires.deployment`, a `compose` file), read from `pikit.json`: checked before any hook runs | problem |
| `node_modules` exists; `bun.lock` matches `package.json` (offline) | problem |
| the App composes: every required capability provided, selections valid, config valid | problem |
| every tool and model provider an agent names is installed (names the registry component that provides a missing one) | problem |
| the App answers someone: a channel has a `route.resolve` stage, `http.route`s have a server (in the Worker's App, the host serves them) | problem |
| only `@pikit/pi-adapter` imports `@earendil-works/*` in the project's sources | problem |
| each component's own `hooks.doctor` (the only checks that may use the network), told the operation: `doctor`, or `dev` / `up` when run before those | problem or note |
| every required `environment` variable is set in the environment or `.env` (names only) | unconfigured |
| a config value that looks like a secret | warning |
| modified or deleted installed files, a component installed but not listed, a provider nothing uses, a vendored kit that is not this CLI's | note |

It exits 1 on any problem or unconfigured variable, and prints `pikit doctor: green` otherwise.

## pikit configure

```
pikit configure [--yes] [--generate <NAME>]... [--login <provider> [--login-method browser|code] [--local]]
```

Writes `.env` (mode 0600). In order: each component's own step (`src/pikit/<name>/configure.ts`:
checks a token, discovers an id, connects GitHub; a step may also set a key
of its own entry in `pikit.config.ts`), then the other `environment` variables the components declare (a
secret is asked without echo; a required `*_TOKEN` can be generated), then model credentials for each
provider an agent names that has none: an OAuth login (stored by `credentials-file`; on Cloudflare,
by `credentials-do` in the deployed app) or the API key in the variable the provider's component
declares first.

- `--yes`, or no terminal: asks nothing; values come from the environment or `--generate`, and a
  missing required one fails.
- `--generate NAME`: fill `NAME` with 32 random bytes in hex (`PIKIT_ADMIN_TOKEN`, a webhook secret).
- `--login <provider>`: run that provider's OAuth login. It logs in where the app runs (through the
  deployment's `exec`, in Docker's volume) unless `--local` (this machine, for `pikit dev`).
  `--login-method` picks `browser` or `code`. On Cloudflare (`durable`, with `credentials-do`) it
  logs in on this machine (`code` unless told) and uploads the credential to the deployed app
  (`PUT /admin/api/credentials-do/<provider>`, at the URL the last `pikit up` from here recorded,
  with `.env`'s `PIKIT_ADMIN_TOKEN`); nothing of it stays here. Deploy first.

It never prints a value, and never touches Pi's own `~/.pi/agent/auth.json`.

## pikit dev

Runs the project here after `doctor` passes (its hooks told `dev`: proposals-local's then only says
that no deployer applies proposals here, and runs no Docker) and the model credentials of this
machine are checked:
the deployment's `dev` when it exports one (`wrangler dev` on Cloudflare, `celld dev` with deployment-celld; deployment-local's
refuses while its service runs, then runs `main.ts` as below), else `bun --watch
src/pikit/<deployment>/main.ts` with `.env` loaded (deployment-docker). Either way, a UI project (the
dashboard, a component's `src/chat/`) is built again (`bun run build` in it) when one of its files
changes, and the app reloads with the module its build writes. On a server each is also built once at
start, alongside the app (wrangler's build command does it on Cloudflare, deployment-celld's `dev` with celld), so a fresh project serves
its pages before any edit. Ctrl-C stops it; so does a SIGTERM to `pikit dev` alone, which the CLI
passes on (to `main.ts`, or as the deployment's `dev` `signal`, so `celld dev` stops and its
`.dev.vars` is deleted), exiting with the app's code.

## pikit up | down | restart | logs | status

```
pikit up | down | restart | status
pikit logs [--follow] [--tail <n>]
```

Delegated to the installed `deployment-*` component's exported functions
([deployment.ts](../packages/cli/src/commands/deployment.ts); see [targets.md](targets.md#deployment-components)).
`up` first runs `doctor` (skipping the `doctor` hook of a component that has a `beforeDeploy`, which
`up` runs right before the build) and checks model credentials where the app runs. `restart` exists
only where the deployment exports it (Docker, deployment-local). deployment-local runs the app as a
systemd or launchd service of this machine instead of a container: it supports neither Compose files
nor the deployer, so `doctor` (and `new`, `add`) refuse a component that needs them before its
own `up` would. With self-improvement on a server (`proposals-local`),
proposals-local contributes a Compose override that activates the deployer next to the app, so `up`
builds and starts it too (no separate command or host service). The commands do not inspect provider
names: they add the Compose file of every component that declares one (`compose`, also used for
expose-cloudflare-tunnel's `cloudflared`), and its `up` runs the components'
`afterDeploy` hooks once the containers are healthy, with the project's public URL
(`PIKIT_PUBLIC_URL`), or says it ran none without one.

### pikit expose

Not the CLI's: the command of the installed `expose-*` component, which gives a server project a public
HTTPS URL ([features/completed/expose.md](../features/completed/expose.md)). `expose-cloudflare-tunnel`'s: `pikit expose`
(the tunnel, its routes and its DNS record; writes `PIKIT_PUBLIC_URL`), `pikit expose status`,
`pikit expose quick [port]` (a temporary tunnel while `pikit dev` runs) and `pikit expose delete`.
Its step of `pikit configure` asks the hostname and the paths and offers to create the tunnel at once
(the Cloudflare API token asked without echo, never stored). Without one installed, `expose` is an
unknown command.

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

## pikit <command>

```
pikit <command> [args...]
```

A command an installed component adds (`commands` in its `component.json`, recorded by `pikit add`
in `pikit.json`; see [components.md](components.md#commands)). In a project whose `pikit.json`
declares it, `pikit <command>` runs the component's file in a child `bun`, in the project's directory,
with its environment (`.env` under the process's) and stdin and stdout inherited
([component-commands.ts](../packages/cli/src/commands/component-commands.ts)). The arguments after
the name are the command's, passed as typed: the CLI parses none of them. Its problems are printed and
it exits 1. `pikit help` (and `pikit` alone) in a project lists them after the CLI's own, each with
its description and its component. Outside a project, or a name nothing declares, it is an unknown
command (exit 2). No component's command takes a name of the CLI's own, nor one kept for later.

## Not built

`init`, `create`, `outdated`, `diff` and `config` answer "not built yet" (some
with the design note that specifies them) and exit 1. [features/cli-features.md](../features/cli-features.md)
is a design note.

`pikit --version` prints the CLI's version and the commit of its checkout.
