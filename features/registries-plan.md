# Registries plan

**Public appeal:** -

**Specified:** no. A plan of work for [open registries](open-registries.md) and
[contract packages](contract-packages.md), so that pikit can be the base of someone else's assistant
platform: their own registry, presets, contracts and dashboard, installed beside the kit's.

**Needed by:** nothing required. It is built when registries other than the official one are
expected (the condition both notes above set).

## Where it starts

What a third party can do today:
- `pikit add <name> --registry <path>` and `pikit new --registry <path> --preset <p>`, from a local
  folder with `registry.json`; `pikit.json` records each component's registry (`builtin`,
  `./relative`, or an absolute path that works only on one machine).
- A registry may add kinds and capabilities (`declares` in `component.json`); `registry validate`
  checks it against the kit's catalogue plus what it declares (`packages/cli/src/registry/declares.test.ts`).
- Components may bring hooks, commands, Compose services, a view and a UI project, all generic.

What stops another registry being an equal:
1. **A registry's own contract is shared by copy.** `memory`, `scheduler` and `approvals` each have
   a `contract.ts` copied into every user; across registries there is no version, no shared suite,
   and a mismatch surfaces only as a TS2717 in the user's project.
2. **No namespaces.** Component names, capability names, view folders and commands are global. Two
   registries declaring one capability are caught only inside one registry
   (`registryCatalogue`, `packages/cli/src/registry/capabilities.ts`), and `add --force` of a
   same-named component silently switches its recorded registry.
3. **`pikit add` does not validate.** From any registry it checks the manifest's shape, paths,
   targets and kit ranges, not imports, `APP_DESCRIPTION` readers or the catalogue; and `add` runs
   `doctor`, so a component's `doctor` hook runs at install.
4. **One registry per preset.** `pikit new --registry X` makes X the project's only `default`
   (`commands/new.ts`); a preset cannot mix the kit's components with its own, and offers look only
   in the registry an operation reads (`catalogueOf`, `project/offers.ts`).
5. **The dashboard is the registry's, its namespace the kit's.** Which components a dashboard needs,
   and the capability each default stands for, are its registry's data now
   (`dashboard/dashboard.json`, [component composition](component-composition.md)), read from the
   registry a project comes from. What stays fixed is the `@pikit` shadcn namespace in the
   dashboard's `components.json`.
6. **Component ids in the CLI: only labels left.** The rules are gone: the steward's grants, the
   starting config, the agent layout and which features bring the dashboard are the preset's
   (`steward`, `config`, `agents`, `features[].ui`), and what a deployment supports is its manifest's
   ([component composition](component-composition.md)). `DEPLOYMENT_TEXT` (`commands/starter.ts`,
   `commands/wizard.ts`) remains: the wording of the next steps per deployment, with a generic
   fallback for any other.
7. **Local folders only.** No Git or HTTP registries, no `pikit registry add|list|remove`.

The kernel needs no change in any phase below. Everything goes through a few places of the CLI:
`openRegistry` (`project/registry-source.ts`), `registryPath` / `recordedLocation`
(`project/registry-location.ts`), `registryKey` (`commands/add.ts`), `registryCatalogue`,
`catalogueOf` and `project/vendor.ts`.

## How each phase is done

Each phase ships on its own, in a worktree (`../pikit-<branch>`), committed by explicit paths. It
follows the contract rules of `AGENTS.md`: SPEC first, negative cases in the tests (and a mutation
that shows each new case catches a broken implementation), the catalogue, `docs/contracts.md`,
`docs/components.md`, `docs/cli.md`, the `pikit` skill (`references/component.md`) and every affected README in the
same change, then `bun run registry generate` and `validate`, `bun run typecheck`, `bun run lint`,
the bounded `bun test` and, where a durable component changes, `bun run test:workerd`. pikit is
0.0.x: no compatibility with the previous shape (no aliases, no readers of old `pikit.json` fields).

## Phase 0: decisions and cleanup (S)

- SPEC 3.2 and 3.3: where a contract lives (the kit's package, or a contract package of its
  registry) and how one evolves (the rules in [contract packages](contract-packages.md)).
- Write the decisions below into [open registries](open-registries.md) and
  [contract packages](contract-packages.md).
- Fix what is stale: `contract-packages.md` says no component uses `declares` (approvals-sql,
  memory-sql and scheduler-sql do); `channel.transport` in `packages/core/src/capabilities.ts`'s
  example is no capability; the adapter's header says pi 1.0 while it pins 1.2.0.

## Phase 1: registry identity and management (S-M)

- `registry.json` gains `name`, the registry's namespace (`"acme"`); the official one is `pikit`.
  `registry validate` requires it (kebab-case, and `pikit` only for the kit's own).
- `pikit.json`'s `registries` are keyed by that name, not `local`, `local-2`.
- `pikit registry add <name> <location>`, `pikit registry list`, `pikit registry remove <name>`
  (refused while an installed component comes from it).
- Qualified names in the CLI: `pikit add acme/tool-crm`. The installed name stays `tool-crm`
  (`src/pikit/tool-crm/`). A component of that name from another registry is refused, with `--force`
  too (it no longer switches the recorded registry).
- Tests: add, list and remove; a qualified add; a cross-registry name clash refused before any
  write; a project cloned elsewhere resolves every registry it records.

## Phase 2: trust at install (S)

From a registry other than `builtin`, before anything is written or run:
- `add` runs the static checks of `registry validate` on the components it installs (imports per
  target and file kind, `APP_DESCRIPTION` readers, target readers, kind, catalogue). Not the drift
  check: it imports and runs `setup`, which is the third party's code.
- `add`'s plan lists what will run code on the machine: `hooks`, `commands`, `configure.ts`, and the
  services of a `compose` file. The confirmation `add` already asks covers it; `--yes` accepts it.
- Tests: a component that imports Pi itself is refused before any write; the list names every hook,
  command, `configure.ts` and Compose file.

## Phase 3: contract packages (L)

The decided option B of [contract packages](contract-packages.md):
1. **Shape.** `registry/contracts/<name>/`: a package whose `package.json` has
   `"pikit": { "capabilities": { ... } }`, `@pikit/core` (and `@pikit/contracts` when used) as
   `peerDependencies`, and a `./testing` export with its suite and doubles. Neutral: no `node:*`,
   `bun:*` or `cloudflare:*`.
2. **Vendoring.** `project/vendor.ts` packs, besides the kit's three packages, the contract packages
   a component depends on, from its registry, into `vendor/`, with `overrides` keeping one copy each.
3. **Catalogue.** Built from the kit's and from the contract packages' `pikit` fields;
   `declares.capabilities` is removed (`declares.kinds` stays: a kind is a name's prefix).
   `add`, `doctor` and `upgrade` require one version of each contract package per project (the
   ranges intersect, as `checkKit` does for the kit) and refuse two packages declaring one name.
   `pikit registry capabilities` shows `definedIn` as `<package>@<version>`.
4. **The kit's first move: `proposals`**, to prove the mechanism on a real case.
5. **The copies of today:** `memory` (memory-sql, memory-recall, memory-summaries), `scheduler`
   (scheduler-sql, tool-schedule, scheduler-admit, scheduler-routines) and `approvals` (approvals-sql,
   extension-approvals, admin-approvals) become packages; their copied `contract.ts` and the
   `RegistryDeclared` exclusion in `capabilities.ts` go.
6. **Then** `repo.github` and `agent.directory`, with their providers and users.
7. **A fixture with two registries** sharing one contract package: a version conflict refused before
   any write, a name clash refused, the suite imported from the package by a provider of the other
   registry, one `@pikit/core` in `node_modules`. memory-sql's suite also in the workerd lane.

## Phase 4: composing several registries (M)

- A preset may name `pikit/channel-telegram` beside its own components; an unqualified name is the
  preset's own registry. `checkPresets` composes them with every registry they name.
- `pikit new --registry acme=<location>` (repeatable) adds registries; `pikit` is always there.
  `pikit new --preset acme/support-bot` takes the preset from `acme`.
- Offers search every registry of the project; with several candidates the choice is the user's,
  as it is today with several providers.
- `doctor` reports a capability declared by more than one registry.
- Tests: a preset mixing two registries composes on each target it declares; an offer found in a
  second registry; an ambiguous offer named, not chosen.

## Phase 5: Git registries (M)

- Locations `github:acme/repo#v1.4.0` and `git+ssh://...#<ref>`, cloned with the user's own Git
  credentials (private registries over SSH) into a cache, `~/.pikit/registries/<host>/<repo>/<commit>`.
- `pikit.json` records the URL and the **resolved commit**: a registry is pinned.
  `pikit registry update <name>` moves the pin; `upgrade` reads the pinned commit, never a branch.
- Contract packages need nothing more: they are vendored from the cached checkout (bun cannot
  install a package from a subdirectory of a Git repository, which is why phase 3 vendors).
- Tests offline, against a local bare repository (`file://`): add, a pin that does not move by
  itself, `registry update`, a clone elsewhere resolving the same commit.

## Phase 6: distributions (M)

- A registry's dashboard already says its components (`dashboard/dashboard.json`); it may also
  declare its shadcn namespace and URL, written into the dashboard's `components.json`. The fixed
  `@pikit` goes; without a declaration, the `pikit` registry's is used. With several registries, the
  dashboard and its descriptor are those of one registry the project names.
- The last component ids of the CLI, `DEPLOYMENT_TEXT`, become the deployment's own text (its
  `title`, or a field of its manifest). The others are already fields of the preset.
- A guide, "Your own distribution" (a registry, presets, contract packages, a dashboard), with an
  `acme` fixture registry, and the `pikit` skill (`references/component.md`) updated.
- [Multi-tenant isolation](multi-tenant-isolation.md) records the recommendation for many clients:
  a fleet, one project per client made from a distribution's preset (real isolation, the actor model
  as it is), not tenants inside one App.

Later, only if demanded: signatures, static HTTP registries, a gallery.

## Order

0, 1, 2, 3, 4, 5, 6. Phases 1 and 2 are cheap and make sharing a registry safe; phase 3 is what
keeps registries from breaking each other; phase 5 comes after it because contract packages are
vendored, which a Git registry needs.

## Open decisions

- **Third-party capability names.** (a) Global, a clash refused; or (b) a prefix of the declaring
  registry's name (`acme.memory`) for every registry but `pikit`. Proposed: (b). With (a), two third
  parties that chose one name can never be installed together, and the user can do nothing about it.
- **The kit's own feature contracts in phase 3.** Moving `memory`, `scheduler`, `approvals`,
  `proposals`, `repo.github` and `agent.directory` to packages touches about fifteen components.
  Proposed: yes, as the real proof of the mechanism.
- **Git registries before contract packages.** Visible sooner, but contracts would still be copied
  across registries. Proposed: no.
- **Phase 6 now or later.**
- From [contract packages](contract-packages.md): the package name convention; whether a component's
  `dependencies` range for `@pikit/contracts` replaces `requires.contracts`; where the kit's own
  contract packages live (`registry/contracts/` or `packages/`).
