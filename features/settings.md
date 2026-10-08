# Settings

**Public appeal:** ⭐ Change your assistant from the dashboard, without code: the agent's prompt
and model, which agent answers where, a component's options. Each installed component brings its own
settings, and only those.

**Specified:** yes: the `settings` contract, its suite, its provider `settings-store` (both targets),
the dashboard's Settings dialog and router-basic's Agent section (with runtime-pi's live overrides)
are built ("What is built", below); multi-agent and the open questions at the end are not. SPEC §5
and §6 name it.

**Needed by:** the launch (the agent's prompt from the dashboard); multi-agent (agents and rules from
the dashboard).

## What it gives

A **Settings** dialog in the dashboard: a searchable list of sections on the left, grouped (the
dashboard's own first, then one per installed component), and on the right each section's rows: a
label, a line saying what it does, and its control (a segmented choice, a select, a switch, a text,
a prompt editor). A change applies to the next run, with no deploy and no restart.

- **router-basic** (always installed) brings **Agent**: which agent answers by default, and that
  agent's system prompt, model and tools (among those its definition names). The basic version.
- **The multi-agent feature** (below) brings **Agents** (create, edit, remove agents as data) and
  **Routing** (router-rules' rules: this channel, chat or person → that agent, or denied). Without
  it these sections do not exist: one agent needs neither.
- Any component may bring a section (a channel's options, a tool's limits), the same way.

## How it fits pikit

**Config or setting, never both.** Config (`pikit.config.ts`) is what is deployed and read at start:
it changes through a commit (by a person, or the steward's proposal). A setting is what an operator
changes live, read when used. A component says which of its values are settings; a setting's default
may come from its config.

**A section is installed with its component**, as a view is (`pikit-view`):

- the component has a `settings/` folder (`"settings": "settings"` in `component.json`);
- `pikit add` copies it to `src/dashboard/src/settings/<component>/` when the project has a UI
  (`pikit ui on` later), recorded as the component's files: `pikit upgrade` merges it, `pikit remove`
  takes it away;
- its `index.tsx` default-exports `defineSettings({ id, title, icon, group, order, requires,
  component })`, found when the dashboard is built (nothing loaded at run time), shown only when its
  `requires` are provided, like `defineView`.

**The values: a `settings` contract** (new, `@pikit/contracts`), with its conformance suite:

- a component declares its settings at setup: `settings.declare(component, schema, defaults)`, the
  schema in TypeBox, as its config's;
- `get(component, ctx)` returns the stored value over the defaults, validated; `set(component,
  value, ctx)` validates, stores, and is logged with the operator, never the value of a field marked
  secret (a setting is never a secret: secrets stay in `secrets`);
- one admin route serves every section: `GET` and `PUT /admin/api/settings/:component`, behind
  `admin.auth`, answering the schema with the value, so a simple section renders from the schema
  and a custom one only places its controls.

Its provider, `settings-store`, on both targets:

- **server:** a table of the App's `storage.sql`;
- **Cloudflare:** one object, `settings`, reached by `actor.mailbox` (as admin-api's conversation
  index is): the Worker's route writes to it; a conversation's object reads it when it admits a
  message, and keeps it until the version changes (one call per admission at most).

**The agent's overrides (option B).** The definition still owns the agent (SPEC §6), and the
operator's overrides are data on top of it: runtime-pi reads them at every admission, where it
already rebuilds `pi.agent` from the definition, and applies them after `prepare(state)`: system
prompt, model (one an installed provider has), tools (only names the definition gives, on or off).
So a restart, a reopened Harness and an evicted object build the same agent, and a prompt changed in
the dashboard applies to the next run of every conversation.

## What is built

- **The contract** (`packages/contracts/src/settings.ts`, suite `createSettingsConformance`, catalogue
  `settings`, experimental): `declare(component, schema, defaults)`, `get(component, ctx)`,
  `set(component, value, operator, ctx)`, `sections(ctx)`; refusals are `SettingsError`
  (`unknown_component`, `invalid_value`).
- **settings-store** (`registry/components/settings-store/`), both targets: a `settings_store` table of
  `storage.sql` on a server; on Cloudflare the object `settings-store:settings` (`SETTINGS_KEY`) keeps
  it, the Worker's half (`settings-store-worker`) serves the routes as calls to it (and provides
  `settings` to the Worker's App, read the same way: admin-proposals' routes are the Worker's), and each
  conversation's object reads it when used, cached with its version for `freshMs` (1 s). The routes:
  `GET /admin/api/settings`, `GET` and `PUT /admin/api/settings/:component`, behind `admin.auth`.
- **The CLI**: `component.json`'s `settings` (a folder) is copied to `src/dashboard/src/settings/<name>/`
  as a view is (add, `ui on`, upgrade, remove, `ui off`), checked by `registry validate`, built by
  `scripts/dashboard-build.ts`, published as `@pikit/<name>-settings`. `UI_COMPONENTS` (what `pikit ui
  on` and `pikit new --ui` install) now has settings-store.
- **The dashboard**: the Settings dialog (`components/pikit/settings-dialog.tsx`), General (theme,
  sounds), `defineSettings` and `useSettings` (`lib/settings.ts`), the rows and controls and
  `SchemaSettings` (`components/pikit/settings.tsx`). Opened from the sidebar's foot menu.
- **router-basic**: `defaultAgent` is also its setting (default: the config's), used while it names an
  agent; its section, Agent: the default agent, then any agent's system prompt, model and tools.
- **runtime-pi** (`overrides.ts`): its settings are an override per agent; read before every
  admission, resume, `/compact` and driving wakeup (on a server also at start), applied after
  `prepare`.

## Decisions taken while building it

- **Declared in `start`, not `setup`.** Setup only registers, and a handle is read from start on; a
  component's `start` comes after its provider's, so the declarations are all there once the App is
  up. Every App of a deployment declares the same (the same components run in each).
- **Values are top-level keys over the defaults.** `set` stores the component's whole value; `get`
  puts each stored key over the defaults while the schema accepts it, so a deploy that makes one key
  invalid (a model gone, an agent removed) loses that key only, logged. runtime-pi's settings are
  therefore keyed by agent at the top (`{ assistant: { systemPrompt?, model?, tools? } }`), not under
  one `agents` key.
- **The schema's `default` keywords are annotations, never applied.** runtime-pi puts each agent's
  definition there (what the dashboard shows when nothing is overridden), while its `defaults` are
  `{}`: an override exists only when an operator set one, and a field equal to the definition's is not
  stored (the section's `storedOf`, "Use the definition").
- **Overrides go through `prepare`.** runtime-pi wraps an overridden definition's `prepare` (its own,
  then the override over it): the adapter needs no change, and an override the runtime cannot resolve
  falls back to the definition as a failing `prepare` does. Tools are "on" names among the
  definition's: a tool `prepare` adds beyond them stays.
- **Cloudflare: one call per admission at most, by time, not by admission.** An object answers `get`
  from what it read for `freshMs` (1 s) after its last call, and the call carries the values only when
  the version changed: router-basic's read and runtime-pi's, in one admission, cost one call. An
  object's own `set` forgets its cache. A Durable Object's start (inside `blockConcurrencyWhile`) never
  calls the settings object: runtime-pi reads there at its first admission or wakeup.
- **settings-store comes with the dashboard** (`UI_COMPONENTS`), not as an offer: the dialog is the
  dashboard's and router-basic's section needs it; it requires nothing admin-api does not. A project
  without a UI has no settings and behaves as before.
- **The section, not the store, decides what is shown**: a declared component without a section in
  `src/settings/` shows nothing (runtime-pi's settings are edited in router-basic's Agent section).
- **Routes are the provider's** (settings-store), served in both Apps on Cloudflare as admin-api's; a
  `PUT` is at most 256 KiB.

## Multi-agent

A feature component (`agents-live`, with `router-rules`), offered by `pikit new`'s feature step
(`features/cli-features.md`) and by `pikit add`:

- **Agents as data:** name, description, system prompt, model, tools and extensions (installed ones
  only), created and edited in the dashboard. The project's code agents (`src/agents/`) stay, and are
  listed too, editable through their overrides.
- **Routing as data:** router-rules' rules, edited in the dashboard, read from `settings` instead of
  config; its config keeps the rules a project deploys with.
- **Subagents** (`features/subagents.md`) fit here: one agent delegating to another, by name.

## Pi first

Pi has settings files and `/reload`; neither applies to a service of many conversations and
processes. Nothing of Pi's is replaced: the overrides become the agent's `TurnConfig`, as
`prepare`'s changes do.

## Open questions

- **Not built yet:** `agents-live`, agents created at run time, router-rules' rules from settings
  (the multi-agent feature above).
- A section for a declared component that brings none (an automatic one from its schema), or none,
  as now.

- **Agents created at run time.** `agent.definition` is keyed, and keys are fixed at setup; an agent
  made in the dashboard is a name no component provided. Either an optional capability the runtime
  asks for names it does not have (`agent.directory`), or `agents-live` provides one definition that
  stands for every live agent. The first is a contract change: proposed in `SPEC.md` first.
  router-rules and runtime-pi check names at start; a live agent is checked when a rule or a message
  names it.
- On Cloudflare, a conversation already running keeps the agent it was admitted with until its next
  admission: is that enough, or does a change ping the objects?
- History: keep each setting's previous values (who, when), to undo from the dashboard.
- The dashboard's own preferences (theme, text size) are the browser's (`localStorage`), not
  settings: they change nothing in the service.
