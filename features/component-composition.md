# Component composition: what a project's deployment supports, and presets that own their policy

**Specified and built** in one change: deployment requirements in the manifests and in `pikit.json`,
one pure planner every command asks (`packages/cli/src/project/composition.ts`), the creation policy
in the presets (`project/preset-plan.ts`), and each registry's dashboard descriptor
(`project/dashboard-manifest.ts`, `registry/dashboard/dashboard.json`).

**Needed by:** nothing required. It closes a hole: a project with `deployment-local` and
`proposals-local` could be created, since both run on `server`, although the first runs neither
Compose files nor the deployer the second needs. `pikit up` then failed on a Compose file. Now the
CLI refuses that composition, before it writes anything, and says why.

## What it gives

- **The same answer everywhere.** `pikit new`, the wizard, `add`, `remove`, `upgrade`, `ui`,
  `doctor`, the checks before `dev` and `up`, and `registry validate` ask one planner about the same
  set of components and get the same problems. The wizard shows alternatives and reasons; it holds
  no second copy of the rules.
- **No decision by a component's name.** What the steward is granted, the config a new project
  starts with, the agent layout and which features bring the dashboard are the preset's to say; which
  components a dashboard needs is its registry's. The CLI keeps no list of the kit's components for
  any of it (`NAMED_FOR`, `NEEDS_DASHBOARD`, `STARTER_EXTENSIONS`, `NOT_NAMED`, `STARTER_CONFIG`,
  `UI_COMPONENTS` and `UI_DEFAULT_FOR` are gone). A registry with other names works the same.

## Deployment requirements

A project has one deployment: its `deployment-*` component (a kind, never a name). Two hand-written
manifest fields say what it must do besides running the App:

```jsonc
// deployment-docker/component.json
"deployment": { "supports": ["services.compose", "proposals.deployer"] }

// proposals-local/component.json
"requires": { "pikit": "0.0.1", "contracts": "0.0.1", "capabilities": [], "deployment": ["proposals.deployer"] },
"compose": "compose.yaml"
```

- **`deployment.supports`**, only on a `deployment-*` component: the protocols it implements beside
  running the App.
- **`requires.deployment`**, on any other component: what its one deployment must support for it to
  work. A deployment needs nothing of a deployment (it would need itself).
- **A `compose` file implies `services.compose`.** Writing it in `requires.deployment` as well is
  refused as redundant. A deployment ships its own Compose file, never a `compose` contribution.
- **Names of protocols, never of components**, and an open set: lowercase words joined by `.` or `-`
  (`DEPLOYMENT_REQUIREMENT` in `registry/manifest.ts`). The CLI knows one by name,
  `services.compose`, because the `compose` field implies it. A registry may use its own
  (`acme.review-host`) without changing the CLI; a requirement nothing supports is a problem when it
  is composed, wherever its provider would live.
- **What the two kit names mean.** `services.compose`: the deployment runs the Compose files
  components record, with today's protocol (deployment-docker adds each after its own compose.yaml).
  `proposals.deployer`: it can activate a controller of `@pikit/contracts/deployer` (decisions in,
  outcomes out), not merely that Docker is installed.
- **Only what is real.** deployment-docker supports both. deployment-local, deployment-cloudflare and
  deployment-celld support neither and declare nothing. proposals-local requires
  `proposals.deployer` and ships a Compose file; expose-cloudflare-tunnel ships a Compose file.
  proposals-github requires nothing of its deployment (GitHub and Workers Builds deploy).
- **Recorded.** `pikit add` keeps both fields in the component's record in `pikit.json`, beside
  `compose`, so `doctor` and `remove` check a project without its registry. Absent means "declares
  nothing": no built-in name fills it in.
- **Kit ranges stay as they are** (`requires.pikit`, `contracts`, `adapter`): requirements carry no
  version.
- A declaration proves nothing about the provider. The provider's own checks and the deployer
  protocol's conformance suite (`createDeployerProtocolConformance`) still do that.

`deploymentProblems` (`registry/manifest.ts`) holds the rules the schema cannot state, by kind:
`deployment` only on a deployment, no `requires.deployment` or `compose` on one, no
`services.compose` written by hand.

## The planner

```ts
planComposition(components: readonly DeploymentFacts[]): CompositionPlan;
introducedIssues(before: CompositionPlan, after: CompositionPlan): readonly CompositionIssue[];
formatCompositionIssue(issue: CompositionIssue): string;
```

`DeploymentFacts` is what a manifest and an install record have alike: `name`, `compose`,
`deployment.supports`, `requires.deployment`. A plan is the one deployment, when there is one, and
its issues:

| Code | When |
|---|---|
| `deployment_ambiguous` | more than one deployment: a project has one, and what each supports is never added together |
| `deployment_missing` | a component needs something of a deployment and none is installed |
| `deployment_requirement_unmet` | the one deployment does not support what a component needs (with `via`: `requires`, or `compose` for a Compose file) |

- No deployment is fine while nothing needs one (an unfinished project); it is never read as
  "every requirement met".
- An issue is identified by its code and fields (consumer, requirement, deployment), never by its
  wording, and the list is sorted: the same composition always gives the same list.
- Pure and linear: no file read, no component imported, no Docker, no App started, no solver.
- It is not the runtime's capability graph. What each App provides and uses is still checked by
  composing it (`doctor`, offers, the dashboard's providers). The planner covers what the deployment
  does beside the App.
- The selection of the one deployment (`deploymentsOf`, by kind) is shared with
  `deployment-module.ts`: one cardinality rule.

### What each command does with it

| Command | Check |
|---|---|
| `pikit new` | the whole candidate (the preset with its answers, the features chosen, the providers offered, the dashboard's components) before the directory is made |
| the wizard | the plan again after each answer: a feature that would add an issue is shown disabled with the reason; the deployment the person chose is never changed for them |
| `pikit add` | the components named, before the confirmation; then the whole draft once the offered providers are accepted, before any write, hook or `bun install` |
| `pikit remove` | what remains: it may not introduce an issue (removing the only deployment that supports what another component needs) |
| `pikit upgrade` | every component asked, as one set, before writing; `--dry-run` reports the same |
| `pikit ui on` | the dashboard's components added to the project, as `add` does |
| `pikit doctor` | the installed records, before any component's `doctor` hook |
| `dev`, `up` | through `doctor`, so an incompatible composition stops before a hook or Docker runs |
| `registry validate` | every preset's default, each alternative and feature, and their combinations (below) |

- **Only what an operation introduces is refused** (`introducedIssues`): a need left unmet that was
  met before, or a new set of deployments. A need already unmet stays the same problem when the
  deployment failing it changes (removed, or swapped for another that does not support it either), so
  a project that is already wrong can still be repaired step by step: removing the incompatible
  consumer, or one of two deployments, or the deployment that cannot run it, goes through. What remains wrong is still a problem in `doctor`; finishing an operation never prints
  green on its own.
- **`--force` does not bypass it.** It keeps its meaning for files and kit ranges; it never makes an
  impossible composition runnable. A confirmation is not permission either.
- **A refusal changes nothing**: no source, config, `pikit.json`, `package.json`, lockfile, base or
  vendored kit, and no hook, install or deploy runs.
- **Changing deployment** is removing the old one (its dependents first, when it is the only one that
  supports them) and adding the new one. There is no `swap` command.

### Doctor's operation

`doctor` hooks and `DoctorOptions` carry `operation`: `"doctor"`, `"dev"` or `"up"`. The public
`pikit doctor` passes `doctor`; the checks before `pikit dev` and `pikit up` pass theirs to the child
that runs the hooks. No public flag was added.

proposals-local's hook uses it: under `dev` it says that approved proposals are not applied in that
mode (no deployer runs) and runs no Docker; under `doctor` and `up` it keeps its Compose checks. Its
note about `execution-local` stays. The approval gate is unchanged, and nothing reports a proposal as
deployed that was not.

## Presets own the creation policy

A component never grants a tool by asking for one. What the starter agent (the steward) may use
belongs to the chosen preset, then to the project's code. A preset says it in four fields
(`registry/schema/preset.schema.json`):

```yaml
steward:
  tools: [read, write, edit, fetch, websearch]
  extensions: [pikit-self]

config:
  router-basic:
    defaultAgent: steward

agents:
  folders:
    feature: agents-folders
    command: agents

features:
  - components: [agents-folders]
  - components: [admin-proposals, proposals-local]
    ui: true
    steward:
      tools: [bash]
```

- **`steward.tools` and `steward.extensions`**: explicit keys, the steward's grants. A chosen
  feature's `steward` adds its own, shown in its hint before it is chosen; in a script, choosing the
  preset and the feature by flags is the explicit decision. Nothing else grants: a tool provider
  installed under any name (a shell called something else) is not named by the steward because it is
  there. Each key must be an `agent.tool` (or `agent.extension`) key that a chosen component provides,
  read from the candidate's description (setup, never start; `replay.tools` and the generated
  `extensions` field). Grants apply only to the steward `pikit new` writes: `add`, `upgrade` and
  `ui on` never rewrite an existing agent.
- **`config`**: project values (never code), for components of the preset or its alternatives,
  applied only to those chosen, and checked against the component's own schema. It replaces the
  CLI's default for router-basic.
- **`agents.folders`**: the one-or-several-agents question. `feature` names one of the preset's
  features (by its first component), `command` a command that feature's component declares
  (`commands`). Several agents chooses that feature; `pikit new` runs that command once, through the
  installed component's command, after installing and before `doctor`, and its README names it. No
  creation hook of another kind exists. A feature or command that does not exist, or is ambiguous, is
  refused before anything is written. The CLI does not know the name agents-folders.
- **`features`**: every entry is `{ components, ui?, steward? }`, named by its first component
  (`--with <first>`) and shown by its title. `ui: true` brings the dashboard when the feature is
  chosen; it makes no component depend on a UI (admin-proposals' API still works without one). The
  old forms (a name, a list) are gone, with no reader for them (pikit 0.0.x promises no
  compatibility).
- Aliases (`extends` + `with`) inherit all of it. A feature not chosen brings no UI, grant, config or
  command.

`resolvePresetPlan(registry, { preset, targets, choices, ui })` resolves a preset once, for the
wizard (at each answer), `pikit new` (with its final answers) and `registry validate`. It returns the
components, config, UI and its components, the steward's grants, the agent layout, each feature with
`available` and the reasons it is not, the composition plan, and every problem that refuses the plan.
It calls `planComposition`; it holds no deployment rule of its own.

Tables that only decorate (a label, a hint) may stay, with a generic fallback to a component's title
or name; a name never decides a grant, a compatibility, a default or a command run.

## The dashboard descriptor

Each registry with a dashboard (`dashboard/files/`) describes it in `dashboard/dashboard.json`:

```json
{
  "components": ["admin-auth-token", "admin-api", "settings-store"],
  "defaultFor": { "admin-auth-token": "admin.auth", "settings-store": "settings" }
}
```

- `components`: what a project with this dashboard needs, in the order it is installed. `defaultFor`:
  the capability each default stands for.
- A default is installed only when the project's Apps lack its capability. Another provider of it in
  every App keeps its place; one in some Apps only, or a composition that cannot be described, is
  refused rather than guessed (the same per-App check as before).
- `registry validate` refuses a descriptor of the wrong shape, a component the registry does not
  have, and a default that is not one of `components` or does not provide its capability.
- `pikit new --ui`, a feature with `ui: true` and `pikit ui on` read the same descriptor and get the
  same components. `pikit ui off` removes only what the dashboard installed, from `pikit.json`, without
  the registry.
- The dashboard and its defaults are those of the registry the project comes from, as before:
  nothing here composes registries.

## Registry validation

Besides each manifest's `deploymentProblems` and the descriptor, `registry validate` checks each
preset's policy (grants, config, layout) and its alternatives together, not one at a time:

- the base preset with its defaults is valid;
- every feature the wizard would offer as available is valid with each alternative of the
  deployment question, and every one shown unavailable has its reason;
- an incompatible feature does not make a preset that offers alternatives invalid (base offers
  self-improvement, which deployment-local cannot run);
- an explicit `--with` that cannot be composed fails; it never silently drops out of the selection.

## Decisions

- **One deployment, never a union.** Two deployments are an ambiguity of their own, even when
  together they would support everything.
- **Requirements are an open set of protocol names**, checked for shape and duplicates only. No
  closed enum in the CLI, no semver of their own.
- **Refused before the first write**, in every command, and repairs allowed when they add no issue.
- **The preset grants, never a component.** Unknown manifest fields cannot grant tools or extensions;
  the schema refuses them.
- **Metadata changes are upgrades.** `upgrade` sees a change of `requires.deployment`,
  `deployment.supports` or `compose` even when the version string did not move, and records it with
  the rest.
- **No aliases, migrations or readers for older 0.0.x shapes** of presets or records.
- **The guards inside providers stay.** deployment-local's `up` still refuses a Compose file: defence
  in depth, without importing the CLI.

## Tests

Pure cases for the planner (`composition.test.ts`), and cases through the public commands that check
effects and their absence:

1. **The real case.** With deployment-local, self-improvement (proposals-local) is shown unavailable;
   choosing it by flags fails before any file is made and before any login, and so does adding
   proposals-local or expose-cloudflare-tunnel to such a project. deployment-docker with
   self-improvement stays valid.
2. **An external registry** with other names for hosts and consumers, and a protocol of its own
   (`acme.review-host`): no built-in enum.
3. **Two deployments** cannot satisfy a feature by adding what each supports: ambiguity.
4. **Direct commands** (`new`, `add`, `remove`, `upgrade`, `ui on`) give the wizard's codes. A refusal
   leaves config, `pikit.json`, `package.json`, lockfile, bases and `vendor/` byte for byte, and runs
   no hook and no `bun install`: also when what the deployment cannot run comes with an offered
   provider `add` accepted, or with a dashboard component of the registry's descriptor. Each of those
   two tests fails when its check in `add` is taken out.
5. **Upgrade:** a provider losing a protocol blocks it; changed metadata with the same version is
   seen; `--dry-run` writes nothing; several components are checked as one set.
6. **Repairs:** removing an incompatible consumer, or resolving two deployments, goes through, and
   what remains is still reported. Removing the only supporting deployment is refused.
7. **Without the registry:** `doctor` and `remove` check from `pikit.json` and the installed files.
8. **Modes:** an incompatible local project fails before Docker; a valid Docker project under `dev`
   applies no proposals, starts no sidecar and says so; `doctor` and `up` keep their real checks.
9. **Grants:** a shell tool of another name is not granted by being installed; unknown manifest
   fields grant nothing; only the preset and chosen features grant, to the new steward only.
10. **Agent folders:** a catalogue provider with another name and command keeps the question and
    writes the files; an undeclared or ambiguous command fails before any write.
11. **Dashboard:** external names in the descriptor, alternative auth and settings providers, an
    unknown composition, partial providers, the Worker and the object; `ui off` keeps providers that
    were there before, and the data.
12. **Aliases and config:** aliases inherit the policy, router alternatives get only their config, a
    feature not chosen contributes nothing.
13. **Sensitivity:** breaking the single selection, the Compose inference or the persistence makes
    their cases fail; renaming providers and consumers changes no answer.
14. **Regression:** the kit's presets, two durable Apps, add/remove/upgrade, the installer and the
    wizard end to end.

## Not in this change

- **A deployer for deployment-local** (launchd or systemd): decided against, not built. Safe
  self-improvement needs Docker; on deployment-local code changes by editing the project in place.
  The CLI refuses the combination with a reason instead of failing later on a Compose file
  ([deployment-local.md](deployment-local.md#self-improvement-without-docker-decided-not-built)).
- **Services beside the app without Compose** (`cloudflared` as a unit): `compose` still means
  "a deployment that supports `services.compose`".
- Git and HTTP registries, component namespaces, contract packages and presets that mix registries
  ([registries-plan.md](registries-plan.md)).
- A plugin engine, a condition language, new kinds of install hooks, or a second agent runtime.
- Any change to `@pikit/core`, its exports, the two targets or Pi's protocols.
- A `swap` command for deployments, and a feature menu for `pikit add` without names.

## Open questions

- **Requirements of runtime capabilities.** The planner is about the deployment; a component that
  needs, say, a shell in the App still relies on `use()` and composing. Nothing has needed both yet.
- **More protocols.** A second consumer of a deployment protocol (a tunnel as a unit, a native
  deployer) names its own; the CLI needs no change, only the deployment's honest `supports`.
