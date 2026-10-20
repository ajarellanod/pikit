# Choosing features in `pikit new`

**Specified and built:** presets (`registry/schema/preset.schema.json`) and the guided creation flow
(`packages/cli/src/commands/wizard.ts`): channels, one or several agents, optional features and groups.

## What it gives

After the project's name, target and preset (when several full bases run there), `pikit new` asks:

1. **Channels.** Every channel that runs on the target, several at once, the preset's defaults
   checked. `base` starts with HTTP; `telegram` is its alias selecting Telegram polling instead.
   `cloudflare` and `celld` start with no external channel: their dashboard is enough to talk to
   Steward, so Enter accepts none. A single optional channel is still offered, not silently selected.
2. **One agent or several.** One starts with Steward (`steward`), whose instructions live in
   `src/agents/steward/agent.ts`. Several selects `agents-folders`: the prompt is in `SYSTEM.md`,
   and creation runs `pikit agents` once to write `src/extensions/agents.ts`. Adding another agent
   later is adding a folder and running that command. No other agents are invented at creation.
3. **Optional features.** None checked: routing rules (`router-rules`), agents from the dashboard
   (`agents-live`, with routing and settings), MCP tools (`tool-mcp`), health (`health-registry`),
   self-improvement (`admin-proposals` with `proposals-local` on server, or `proposals-github` and
   `repo-github-app` on durable). Agent folders have their own question, not a duplicate menu entry.
4. Configure and start.

`base`, its `telegram` alias, `cloudflare` and `celld` include the dashboard by default. It is still
an optional feature for a custom preset that does not include it. `base-cloudflare` is deliberately
storage-only: no runtime, channel, dashboard or optional features, and not offered by the wizard
when full durable bases are available.

Every selected feature is installed as `pikit add` does, with the providers it brings. The wizard
prints the equivalent noninteractive command:

```sh
pikit new my-agent --preset base --with channel-http --with channel-telegram --with agents-folders --with tool-mcp
pikit new my-agent --target durable --preset cloudflare
pikit new my-bot --target durable --preset cloudflare --with channel-telegram-webhook
```

## Preset rules

- A base lists `components`, and may declare `choose`, `features`, `model` and `ui: true`. An alias
  `extends` a base and selects its answers through `with`; it inherits the model and dashboard.
- A single-choice kind has exactly one default component. A `multiple: true` kind may have zero or
  one default: zero makes the question optional. Several defaults in a base are refused.
- Explicit `--with` answers replace all defaults of that kind. On `base`, Telegram alone replaces
  HTTP; both require both flags. With no default, selected components are appended once.
- Features are components or groups, installed after the base's components. A group is selected by
  its first component, whose title is shown: `--with agents-live` selects `agents-live`,
  `router-rules` and `settings-store`. No group member may already be a base component or belong to
  a kind its `choose` asks for. Shared members are installed once.
- `ui: true` installs the dashboard as `--ui` does. The dashboard is source in `src/dashboard/`, not
  a component: its missing `admin-api`, `admin.auth` and `settings` providers are decided per App,
  through the same helper at creation and preset validation. No default duplicates an alternative
  provider. `pikit ui off` can remove what the dashboard installed later.
- Selecting a dashboard-only feature (`NEEDS_DASHBOARD`, self-improvement) brings it even for a
  custom preset without `ui: true`. On a server, proposals-local also enables Steward's `bash` so
  it can run git and tests. Its deployer requires Docker, not deployment-local.
- The one-or-several question is offered only when the preset offers `agents-folders` and is skipped
  when `--with agents-folders` already selected it. With a directory argument there are no questions:
  the component is opt-in through that flag. Folder changes after creation must be regenerated
  explicitly; doctor refuses stale output. Nothing regenerates silently at deploy.
- `--ui`, or a `--with` naming a feature, answers the optional-features step without showing it.
  The dedicated agents question remains separate unless `--with agents-folders` answered it.

## Validation and tests

`registry validate` checks every default composition including its dashboard, every channel and
feature independently, and all multiple choices and features together on each supported target.
Missing dashboard source, duplicate providers and incompatible targets fail before a user creates
an unusable project. `new` refuses invalid choices before writing and marks a failed creation as
unfinished.

The resolver tests cover optional channels, alias inheritance and deduplication. CLI tests inspect
projects made without `--ui`: dashboard components in both durable Apps, Steward as the default
agent, and no Telegram variables unless selected. Pseudo-terminal e2e tests cover the actual menus,
one and several agents, no external channel, feature selection and the printed command.

The explicit `telegram-cloudflare` Deploy template remains Telegram-specific: it selects
`cloudflare` with `channel-telegram-webhook` and `admin-proposals`. The generic installer
`--durable` selects `cloudflare`, not a bot-specific composition.

## Open questions

- `pikit add` without names, in a terminal: a similar feature menu for an existing project.
