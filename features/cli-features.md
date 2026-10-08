# Choosing features in `pikit new`

**Public appeal:** ⭐ One guided setup gives you the assistant you want: Telegram and HTTP and
another channel at once, a dashboard, several agents with routing rules, subagents, MCP tools.

**Specified:** this note. It extends presets (`registry/schema/preset.schema.json`) and the wizard
(`packages/cli/src/commands/wizard.ts`). **Built:** several channels, and a features step of single
components with the dashboard (below); groups of components (`agents-live`) and features that do
not exist yet (subagents, agents from the dashboard) are not.

**Needed by:** the launch.

## What it gives

`pikit new` asks, after the target (and the preset, when several run there):

1. **Where you talk to it**: every channel of the target, several at once (Telegram, HTTP, …), the
   preset's checked. Space checks one, Enter answers; one at least. A target with one channel
   (Cloudflare: the Telegram webhook) is not asked.
2. **What it can do**: any of the features, none checked, each a line saying what it gives (its
   component's `title`): the dashboard, then the preset's `features`. Today, on a server (`http`,
   `telegram`): routing rules (`router-rules`), MCP tools (`tool-mcp`), web pages (`tool-fetch`),
   web search (`tool-websearch-brave`), health (`health-registry`); on Cloudflare
   (`telegram-cloudflare`): routing rules, MCP tools, health (it installs fetch and web search
   already).
3. Then, as before, configure and start.

Each answer is a component that `new` installs as `pikit add` does, with the providers it brings
(`withOffers`), so a feature skipped now is one `pikit add` later, and one chosen is one
`pikit remove` away (P3). The flags say the same, and the wizard prints them:
`pikit new my-agent --preset http --with channel-http --with channel-telegram --with tool-mcp --ui`.

## How it fits pikit

- **Presets say which questions allow several answers.** A `choose` entry gets `multiple: true` (a
  channel: any of them; a router: one), and a preset gets `features`: the components offered in
  step 2, each with its title from its manifest. What a preset installs without asking stays in
  `components`. `features` lists no component of `components` and none of a kind it `choose`s
  (`readPreset` refuses either), so a `--with` is always one or the other.
- **Several answers replace the preset's one.** `--with` of a `multiple` kind is the whole answer:
  `--preset http --with channel-telegram` is Telegram alone (as the `telegram` alias says), and
  both are `--with channel-http --with channel-telegram`. A `--with` of a feature adds it after the
  preset's components (the kernel starts providers first whatever the order).
- **A feature is a component**, resolved by the same offers `pikit add` makes (`withOffers`): a
  feature that needs another capability brings its provider, and one that does not run on the
  target is not offered (`Registry.features(preset, targets)`).
- **The dashboard is in step 2 on both targets**, not its own question. It is not a component (the
  files of `src/dashboard/` and `UI_COMPONENTS`, `ui.ts`), so `--ui` answers it, not `--with`.
- **Several channels need what each needs**: HTTP needs a server component (`server-bun`, already
  in the server presets), Telegram's polling none, and brings durable delivery (`outbound-durable`,
  `wakeups-timers`) as with `pikit add`. `registry validate` (`checkPresets`) composes, on each
  target, every answer and every feature alone, and all of them at once (every answer of a
  `multiple` question and every feature); the e2e suite makes `--with channel-telegram --with
  channel-http`, every server feature and `--ui`, and doctor is green once configured.
- **Without a terminal** nothing is asked: `--with` answers both steps, `--ui` the dashboard. In the
  wizard, `--ui` or a `--with` that names a feature answers step 2 whole (it is not asked), as a
  `--with` of a kind answers its question.

## Decisions taken

- The features offered are existing components only, those that make sense to opt into: no
  `wakeups-timers` (infrastructure, brought by what needs it), no `extension-house-rules` (an agent
  must name it, which the starter does not), no `workspace-local` (useful with several agents,
  which no step makes yet). `cloudflare-minimal` offers none: it has no runtime for them.
- `telegram-cloudflare` has the same `choose: channel, multiple` as `http`: unasked with one channel,
  asked as soon as Cloudflare has a second.
- Step 1 needs one channel at least: an agent nobody can talk to is not a start (the dashboard
  alone would be one, but it is a feature, chosen after).
- The dashboard is offered whenever the registry ships one; with `--preset cloudflare-minimal` (no
  runtime) choosing it fails in `new`'s doctor, as `--ui` did.
- The Deploy to Cloudflare template (`scripts/template.ts`) is unchanged: it makes
  `telegram-cloudflare --ui`, no features.

## Pi first

Nothing of Pi's: this is pikit's CLI.

## Open questions

- Groups: a feature as several components (`agents-live`: `router-rules` and `settings-store`), as
  presets of their own (`registry/presets/features/*.yaml`) or a field in each component's manifest
  (`feature: { group, title }`). Needed once a feature is more than one component.
- Features that do not exist yet: agents and routing from the dashboard (`features/settings.md`),
  subagents (`features/subagents.md`); a feature's views and settings sections installed only when
  the dashboard is.
- Which features the launch presets offer on each target (Cloudflare has no `channel-http` yet, so
  step 1 is never asked there).
- `pikit add` without names, in a terminal: the same step 2 for an existing project.
