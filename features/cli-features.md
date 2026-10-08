# Choosing features in `pikit new`

**Public appeal:** ⭐ One guided setup gives you the assistant you want: Telegram and HTTP and
another channel at once, a dashboard, several agents with routing rules, subagents, MCP tools.

**Specified:** this note. It extends presets (`registry/schema/preset.schema.json`) and the wizard
(`packages/cli/src/commands/wizard.ts`).

**Needed by:** the launch.

## What it gives

`pikit new` asks, after the target:

1. **Where you talk to it**: every channel of the target, several at once (Telegram, HTTP, …),
   the preset's checked.
2. **What it can do**: the features, several at once, each a line saying what it gives: the
   dashboard, multi-agent (agents and routing from the dashboard), subagents, MCP tools, web
   search, …
3. Then, as today, configure and start.

Each answer is a component (or a few) that `pikit add` installs, so a feature skipped now is one
`pikit add` later, and one chosen is one `pikit remove` away (P3). The flags say the same:
`pikit new my-agent --preset telegram --with channel-http --with agents-live --ui`.

## How it fits pikit

- **Presets say which questions allow several answers.** A `choose` entry gets `multiple: true`
  (a channel: any of them; a router: one), and a preset gets `features`: the components (or named
  groups of them) offered in step 2, each with its title from its manifest. What a preset installs
  without asking stays in `components`.
- **A feature is a component, or a small group** (`agents-live` brings `router-rules` and
  `settings-store`), resolved by the same offers `pikit add` makes (`withOffers`): a feature that
  needs another capability brings its provider, and one that does not run on the target is not
  offered.
- **The dashboard is a feature like the others** (step 2), not its own question. A feature's views
  and settings sections (`features/settings.md`) are installed only when the dashboard is.
- **Several channels need what each needs**: HTTP needs a server component (`server-bun`, already in
  the server presets), Telegram's polling none; on Cloudflare every channel is a Worker half. The
  offers and `pikit doctor` (serving checks) already say what is missing.
- **Without a terminal** nothing is asked: `--with` answers both steps, as it answers a question
  today.

## Pi first

Nothing of Pi's: this is pikit's CLI.

## Open questions

- Which features the launch presets offer on each target (Cloudflare has no `channel-http` yet).
- Groups as presets of their own (`registry/presets/features/*.yaml`) or a field in each
  component's manifest (`feature: { group, title }`).
- `pikit add` without names, in a terminal: the same step 2 for an existing project.
