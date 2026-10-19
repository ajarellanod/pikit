# Components

A component is a folder of a registry, `registry/components/<name>/`, copied into a project's
`src/pikit/<name>/` by `pikit add`. Once copied it is the user's source: readable, editable,
removable (P3), and upgradable with a three-way merge (P6).

How to build one is in [features/building-components.md](../features/building-components.md) and, as
steps for an agent, [.agents/skills/pikit-component/SKILL.md](../.agents/skills/pikit-component/SKILL.md).
This page says what a component is made of and how the CLI handles it.

## The folder

```
registry/components/<name>/
  component.json                       the manifest (below)
  README.md                            installed as src/pikit/<name>/README.md
  files/src/pikit/<name>/index.ts      export default defineComponent({ name, config?, setup })
  files/src/pikit/<name>/*.test.ts     its tests, installed and run in the project
  files/...                            other files it installs (a Dockerfile, wrangler.jsonc)
  view/index.tsx                       optional: its dashboard view
  chat/                                optional: its UI project (`ui`, below), a Vite app of its own
```

`registry validate` requires the README, `files/src/pikit/<name>/index.ts`, at least one `*.test.ts`
there, and no `package.json` with `scripts` anywhere in the folder but its UI project's (`checkLayout`
in [checks.ts](../packages/cli/src/registry/checks.ts)).

- **`index.ts`** default-exports the component. A component that runs the App rather than running in
  it (`deployment-*`) has no default export, provides nothing, and is not listed in `pikit.config.ts`.
  A component with a Worker half also exports it by the name `apps.worker` gives.
- **Tests** ship with the component and run in the project under `bun test`: its contract's
  conformance suite (`@pikit/contracts/testing`), `createLifecycleConformance` (`@pikit/core/testing`)
  when it owns resources, its own cases, and a test named "what setup declares" that pins
  `app.describe()` for it. A test that needs another component (runtime-pi) is the project's, never the
  component's.
- **`configure.ts`** (optional) exports `configure(io)`: the component's step of `pikit configure`. It
  is found by its path, not declared. It may ask, write `.env`, and set a key of its own config entry
  (`io.setConfig`, in both Apps' configs for a component in both). It runs on the machine, so it may
  import `node:*` whatever the component's targets.
- **Config** is a TypeBox schema in `defineComponent({ config })`, with defaults. A component whose
  declarations depend on its config (tool-mcp provides one tool per configured server tool) lists
  configs in the root schema's `examples`, so `generate` can see what it may provide.

## component.json

The shape is `ManifestSchema` in [manifest.ts](../packages/cli/src/registry/manifest.ts), written as
JSON Schema to [registry/schema/component.schema.json](../registry/schema/component.schema.json).
Some fields are generated from `setup` by `bun scripts/registry.ts generate` (the same as `pikit
registry generate`): it runs `setup` without starting anything, on the first declared target, and
reads the App's own `describe()` ([describe.ts](../packages/cli/src/registry/describe.ts)). `validate`
checks that the generated fields match, and that `setup` declares the same on every other declared
target (K1).

| Field | Written by | What it is |
|---|---|---|
| `$schema` | generated | the schema, relative to the file |
| `name` | hand | kebab-case, prefixed by its kind; equal to its directory |
| `version` | hand | semver |
| `title` | hand | "Name: what it is"; required for components that answer a preset's question (`choose`) |
| `description` | hand | one sentence |
| `license` | hand | optional |
| `targets` | hand | `server`, `durable` or both. Importing `node:*` or `bun:*` needs exactly `["server"]` |
| `requires.pikit` | hand | the `@pikit/core` range it accepts |
| `requires.contracts`, `requires.adapter` | hand | the `@pikit/contracts` / `@pikit/pi-adapter` ranges, when `dependencies` lists them |
| `requires.capabilities` | generated | its `use()` calls |
| `optional.capabilities` | generated | its `useOptional()` and `useKeyed()` calls |
| `provides` | generated | its `provide()` and `provideKeyed()` names (default config and every `examples` config) |
| `declares` | hand | new kinds (`declares.kinds`) and capabilities (`declares.capabilities`: mode, stability, summary, optional `offer`) this component defines for its registry |
| `apps` | hand | `{ "worker": "<export>" }`: the export that goes in the Worker's App on Cloudflare; `"default"` puts the default export in both Apps |
| `halves` | generated | when `apps.worker` names a half: what each App's half provides, requires and uses |
| `hooks` | hand | `doctor`, `beforeDeploy`, `afterDeploy`: each a file of `src/pikit/<name>/` exporting a function of that name (below) |
| `commands` | hand | `pikit <name>` commands it adds: name (kebab-case, never the CLI's own) → `{ file, description }`, the file of `src/pikit/<name>/` exporting `command` (below) |
| `compose` | hand | a Compose file of `src/pikit/<name>/` whose services run beside the app on a server: `deployment-docker` adds it after its compose.yaml (below) |
| `generated` | hand | files of `src/pikit/<name>/` a hook or build rewrites |
| `view` | hand | a folder holding its dashboard view |
| `ui` | hand | `{ "source": "<folder>", "target": "src/<name>" }`: a UI project of its own (below) |
| `replay.tools` | generated | each `agent.tool` it provides with the default config → `safe` or `unsafe` |
| `modelProviders` | generated | the `model.provider` keys it provides with the default config |
| `dependencies` | hand | exactly the npm packages its shipped files import, pinned |
| `devDependencies` | hand | packages only its tests import, and tools it runs (`wrangler`), pinned |
| `files` | hand | `{ source, target }` pairs; only `files/src` → `src` may map a directory |
| `environment` | hand | variables `pikit configure` sets in `.env`: `name`, `secret`, `required`, `description` |

`generate` also rewrites `registry/registry.json` (the index, sorted by name) and the schemas.

### Hooks

What a component asks of the CLI runs on the machine that configures or deploys, never in the App. A
hook gets a plain `io` (its config from `pikit.config.ts`, `get(name)` reading the environment and
`.env`; a `doctor` hook on Cloudflare also its Worker half's config, `workerConfig`) and resolves with its problems, one line each (SPEC §3.2). `pikit add` records each hook in
`pikit.json` by project path; only recorded hooks run.

| Hook | Called by | `io` | Notes |
|---|---|---|---|
| `doctor` | `pikit doctor` (so `pikit dev`), once the App composes | `config`, `workerConfig` (`<name>-worker` in the Worker's App, on Cloudflare only), `get` | may reach the network, writes nothing; may also return notes |
| `beforeDeploy` | the deployment's `up`, before it builds or bundles | `config`, `get`, `write`, `say` | `write(file, text)` writes only files of its own directory; a problem deploys nothing. `up` runs it instead of `doctor` |
| `afterDeploy` | the deployment's `up`, once the new version answers (C8); on Docker once the containers are healthy, with `PIKIT_PUBLIC_URL` (none without it) | `url`, `config`, `get`, `say` | a problem fails `up` but the version stays deployed |

In the registry today: `tool-mcp` has `doctor` and `beforeDeploy` (`deploy.ts` writes `seed.ts`,
listed in `generated`); `channel-telegram-webhook` has `afterDeploy` (sets the Telegram webhook);
`expose-cloudflare-tunnel` has `doctor` (no Cloudflare API token in `.env`);
`deployment-celld` has `doctor` (`commands.ts`: celld and esbuild installed, the config derived from `wrangler.jsonc`, the bucket);
`channel-google-chat` has `doctor` (on Cloudflare, its Worker half's config and the default export's
agree on what both read);
`admin-api` lists `dashboard-files.ts` in `generated` (written by the dashboard's build, not a hook).

A `generated` file is never reported as modified by `pikit doctor`, is kept as the project has it by
`pikit upgrade`, and is deleted by `pikit remove` without `--force`.

### A UI project

A component may ship a page of its own besides the dashboard (channel-web's chat page): a Vite app
with its own `package.json` and `bun.lock`, built at every deploy and served by the component from a
files module, as admin-api serves the dashboard ([dashboard.md](dashboard.md#building-and-embedding)).

```jsonc
"ui": { "source": "chat", "target": "src/chat" },
"generated": ["chat-files.ts"]
```

- **The folder** (`source`, never `files`) holds the app: `package.json` with a `build` script, its
  `bun.lock`, its sources. Its files are browser code with their own toolchain: `registry validate`
  checks neither their imports, targets nor dependencies, and its `package.json` may have scripts.
- **`target`** is a folder of `src/`, `src/<name>`: never `src/pikit`, `src/dashboard`, `src/agents` or
  `src/extensions`, and no other component's (`validate`, and `pikit add` for a registry that was not
  validated).
- **Its build** (`bun install --frozen-lockfile && bun run build` in it) writes the module
  `src/pikit/<name>/<target's name>-files.ts` (`src/chat` → `chat-files.ts`), which the component
  ships empty (its routes then say no page is built), lists in `generated` and serves.
- **`pikit add`** copies it, `node_modules/` and `dist/` aside, recorded as the component's files (so
  `pikit upgrade` merges your edits, P6), its lockfile `generated`, then runs `bun install` in it, and
  lists it in `tsconfig.json`'s `exclude` and `bunfig.toml`'s `pathIgnorePatterns`, so the project's
  `tsc` and `bun test` skip it. `pikit remove` deletes it with what its toolchain made, and takes it out
  of both. `pikit ui on` and `off` never touch it.
- **Every deploy builds it**: any folder of `src/` with a `package.json` (`src/pikit` aside) is a UI
  project, and deployment-docker's image and deployment-cloudflare's `build.command` build each one
  before they bundle; a build that fails stops the deploy. `pikit dev` builds it at start and again when
  its files change. `.gitattributes` marks every `src/pikit/*/*-files.ts` as generated.

### Commands

A command is a hook the user runs by name ([features/component-commands.md](../features/component-commands.md)):

```jsonc
"commands": {
  "agents": { "file": "generate.ts", "description": "Write src/extensions/agents.ts from src/agents/" }
}
```

The name is kebab-case and never one of the CLI's own (`BUILT_IN_COMMANDS` in
[manifest.ts](../packages/cli/src/registry/manifest.ts)); the file is the component's own; the
description is one line, which `pikit help` shows in the project. `pikit add` records the commands in
`pikit.json` by project path and refuses, before it writes anything, a name another installed
component (or another in the same `add`) declares; `pikit upgrade` records the new version's, `pikit
remove` takes them with the component.

`pikit <name> [args...]` runs the file's `command(io)` in a child `bun`, in the project's directory,
with stdin and stdout inherited ([component-command.ts](../packages/cli/src/project/component-command.ts),
`CommandIO`): `args` (what follows the name, as typed), `config()` (its config in `pikit.config.ts`,
imported only when asked, so a command that repairs the project runs without it), `get(name)` (the
environment and `.env`) and `say(line)`. It resolves with its problems (empty, or nothing, when done):
they are printed and the command exits 1, as is a file that does not export `command` or a command
that throws. It runs on the machine, so, like `configure.ts`, it may import `node:*` whatever the
component's targets, and may write the project's files.

### Services beside the app

`"compose": "compose.yaml"` names a Compose file of the component's own directory
([features/completed/expose.md](../features/completed/expose.md)). `pikit add` records it in `pikit.json` by project path,
and `deployment-docker` adds every recorded one after its own compose.yaml, in `pikit.json`'s order,
for `up`, `down`, `restart`, `logs` and `status` (`docker compose -f compose.yaml -f <it>…`; not for
`exec`'s one-off container). Its paths are relative to the project's directory. Only a component whose
targets include `server` has one (`registry validate`). `expose-cloudflare-tunnel`'s runs `cloudflared`.

### Views

`"view": "view"` names a folder whose `index.tsx` default-exports `defineView({ id: "<component
name>", … })` (`checkView`). When the project has a UI, `pikit add` (and later `pikit ui on`) copies
it to `src/dashboard/src/views/<name>/`, recorded as the component's files. `health-registry` is the
only component with one. See [dashboard.md](dashboard.md).

## Kinds and names

A name is `<kind>-<rest>`, and the kind must be one the kit knows (`KINDS` in
[manifest.ts](../packages/cli/src/registry/manifest.ts)) or one a component of the registry declares:

`channel`, `router`, `storage`, `workspace`, `execution`, `scheduler`, `deployment`, `tool`, `policy`,
`admin`, `inbound`, `outbound`, `log`, `conversations`, `credentials`, `provider`, `runtime`,
`secrets`, `server`, `mailbox`, `wakeups`, `actors`, `extension`, `health`, `settings`, `agents`,
`repo`, `proposals`, `expose`.

The kind carries rules: only `admin-*` may read `APP_DESCRIPTION`, only `deployment-*` is delegated
`up`/`down`/`logs`/`status` and is never listed in `pikit.config.ts`. An `expose-*` component gives a
server project its public URL with its command `pikit expose`; like a deployment it is not an app
component.


## Validation

`pikit registry validate [<root>]` (`bun run registry validate` here) checks, for every component:
the manifest's shape and that it matches its directory, the kit ranges against this repository's
packages, the layout, the view, the name's kind, that every capability provided or used is in the
catalogue ([capabilities.ts](../packages/cli/src/registry/capabilities.ts), plus what the registry
declares), the imports of every file per target (only the adapter imports Pi, no `node:*`/`bun:*`/
`cloudflare:*` for `durable` outside `configure.ts`, a deployment's commands and the files `commands`
names, no sibling component's files), that each hook's and command's file exists and exports its
function, that no command takes a name of the CLI's own, that a `compose` file is the component's own
and its targets include `server`, that `dependencies` are exactly what the
shipped files import, that a tool working on `api.env` uses `execution` or `execution.shell`, that only
`admin-*` reads `APP_DESCRIPTION`, that `setup` declares the same on every declared target (K1), and
the generated fields. It also checks presets and schemas.

## Install: `pikit add`

[add.ts](../packages/cli/src/commands/add.ts). Several names are one transaction.

1. Resolve the registry (`builtin`, or a local path) and read each component.
2. Check targets against `pikit.json`'s, the kit ranges (`requires.*`), that no other component owns
   one of its `commands`, and what is missing.
3. Show what it writes, and confirm (`--yes` skips; without a terminal it must be given).
4. Write its files and README. A file that exists and differs is refused without `--force`.
5. Add its npm `dependencies` and `devDependencies` to `package.json`; `bun install`.
6. List it in `pikit.config.ts`: an import and an entry in `components`. On Cloudflare also in the
   Worker's App as `apps.worker` says (config key `<name>-worker` in `workerConfig`).
7. Append its `environment` to `.env.example`.
8. Record it in `pikit.json` and keep a base of each file in `pikit-bases/`.
9. Run `pikit doctor`.

Every refusal comes before the first write. A failure after it puts back what was written; a marker
of an unfinished operation (`operation.ts`) stays until the person checks the project and deletes it,
and `doctor` reports it.

### pikit.json

[pikit-json.ts](../packages/cli/src/project/pikit-json.ts). Per installed component: the registry,
version and commit (`-dirty` when uncommitted), the kit ranges it accepts, each file with its
`sha256` hash, the npm packages it declared and those `add` put in `package.json` for it, its
`environment`, `hooks`, `commands`, `compose`, `generated`, `apps`, and `installedFor` when it came as an offer. Also the
project's `targets`, its `registries`, the vendored kit's commit, and the dashboard's files. Whether a
file is modified is never stored: it is computed from the hash.

### pikit-bases/

[bases.ts](../packages/cli/src/project/bases.ts). Every file a component installed, as installed,
content-addressed (`pikit-bases/<sha256 hex>`, no extension so nothing compiles or tests it), committed
with the project. `remove` and `upgrade` delete bases nothing names.

### Offers

[offers.ts](../packages/cli/src/project/offers.ts). When a component can use (`useOptional`) or
requires (`use`) a capability the catalogue marks `offer` (`outbound.queue`, `storage.kv`) and nothing
provides it, `add` and `new` offer its provider. The catalogue includes registry-declared capabilities;
a declared single capability can opt in with `offer: true`, under the same target/App and ambiguity
rules as the kit's. A capability an offered component requires comes too
(`outbound-durable` needs `storage.sqlite` and `wakeups`). Only when the registry has exactly one provider
that runs on every target of the project; with several, the choice is the user's and the CLI names the
candidates. What is provided is read from what `pikit.config.ts` composes now, per App. An offered
component is recorded `installedFor` the component that brought it, and leaves with the last of them.

## Upgrade: `pikit upgrade`

[upgrade.ts](../packages/cli/src/commands/upgrade.ts). Each file of the new version, against its base
and the project's copy:

| The project's copy | What happens |
|---|---|
| not modified | replaced when the registry changed it |
| modified, and changed by the registry | `git merge-file` of yours, the base and the new one ([merge.ts](../packages/cli/src/project/merge.ts)); a conflict is written with markers and the command exits 1 |
| new in this version | added, unless another component owns the path or it exists and differs |
| no longer shipped | deleted when not modified, else kept and still recorded |
| deleted by the user | not restored |
| `generated` | kept |

Manifest changes follow as `add` makes them (`.env.example`, npm packages, hooks, the Worker's App,
offers). The vendored kit (`vendor/`: `@pikit/core`, `@pikit/contracts`, `@pikit/pi-adapter`) becomes
this CLI's. Without names it upgrades every component that changed, then the dashboard.

## Remove: `pikit remove`

[remove.ts](../packages/cli/src/commands/remove.ts). The install in reverse: files, bases, config
entries (both Apps), `.env.example` block, npm packages it added that nothing else needs, the
`pikit.json` record. It refuses when another component `use`s a capability only this one provides;
without `--force`, also when an agent names a key only it provides (a tool, a model provider), when it
would leave a channel without a router or routes without a server, or when a file is modified. What
was installed for it goes too, unless something else uses it.

## Presets

A preset ([registry/presets](../registry/presets)) is a YAML list of `pikit add` calls, with optional
`choose` (a question answered by every component of a kind, `--with` answers it), `model` (the
starter agent's), `features` (what `pikit new` offers to add: a component, or a group of them named by
its first, `[agents-live, router-rules, settings-store]`), or `extends` + `with` (an alias). `pikit new
--preset` runs them; nothing reads the preset's name.
