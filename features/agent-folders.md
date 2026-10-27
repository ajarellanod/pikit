# Agent folders: an agent is its directory

**Public appeal:** — (an agent as a folder: `agents/{name}/` with `system-prompt.md`, `skills/`,
`extensions/`, `context/`, each found by convention)

**Specified:** this note; built as the component `agents-folders` (its name's kind is `agents`, as
agents-live's), the first user of
[component commands](component-commands.md) (`pikit agents`).

**Needed by:** the optional several-agents path in `pikit new`. It fills the [skills catalog](completed/skills-catalog.md) and the
per-channel prompt of [channel context](channel-context.md) from files.

## What it gives
What an agent may do is written in one place, and what it knows sits next to it, as files:

```
src/agents/support/
  agent.ts                  # what it may do: model, tools, extensions, skills by name, steward
  SYSTEM.md                 # optional: its system prompt
  channels/telegram.md      # optional: appended when the conversation is Telegram's
  channels/telegram.ops.md  # the instance telegram:ops (":" written ".", as workspace-local does)
  skills/notes/SKILL.md     # optional: skills of this agent only
  prompts/review.md         # optional: a prompt template (Pi's format), the slash command /review
src/skills/
  review/SKILL.md           # the project's catalog (agent.skill): agents name "review"
```

Adding an agent is adding a folder and running `pikit agents`; adding a skill is adding a folder of
`src/skills/` and naming it in the agents that should know it.

## How it fits pikit
- **A component, not the CLI.** Everything that is not the kernel is source the project owns (MANIFESTO
  §4): `pikit add agents-folders` copies the generator into `src/pikit/agents-folders/`, where it is read
  and edited like any component; a project that wants another layout edits it, and one that does not
  want it never installs it (§5). It adds `pikit agents` ([component commands](component-commands.md))
  and a `doctor` hook. No new contract: what it writes provides `agent.definition`, `agent.skill` and
  `agent.command`, which exist and are the project's to provide.
- **Folders in, one plain file out.** `pikit agents` writes `src/extensions/agents.ts`, the project
  component `pikit.config.ts` already lists (the starter's hand-written one, replaced): one import per
  `agent.ts`, the texts of the folders in it as strings, and one `agent.definition` per folder and one
  `agent.skill` per catalog skill. Following the imports from `pikit.config.ts` still shows everything
  that runs (§9): the generated file is that list, readable and reviewed in a diff like any source.
- **Texts inlined, not imported.** A `.md` imported `with { type: "text" }` needs a `declare module
  "*.md"` (TypeScript 7.0 does not type it), and two components declaring it fail `tsc` (TS2300:
  extension-pikit-self declares it). Strings in the generated file need no declaration, no bundler
  rule, and are the same on a server and on Cloudflare.
- **Stale is loud, never fixed behind your back.** The `doctor` hook generates in memory and compares:
  a file that differs fails `pikit doctor`, so `pikit dev` and `pikit up` stop before they start, naming
  `pikit agents`. Nothing regenerates at deploy: what the operator approved in a diff (SPEC §6, a
  steward's proposal includes the regenerated file) is what runs.
- **One source per field.** `agent.ts` with a `systemPrompt` and a `SYSTEM.md` beside it is refused when
  the App starts, naming both; so is a folder whose `agent.ts` names another agent.
- **Channel texts** go through `prepare`, which knows the conversation's channel
  (`ConversationRef.channel`): the agent's own `prepare` first, then the channel's text appended to the
  system prompt it gives. An operator's prompt override (runtime-pi's settings) replaces the whole
  prompt, channel text included, as it replaces what `prepare` gives.
- **Skills.** A folder's `skills/<name>/SKILL.md` is the agent's own (`defineSkill`, in its `skills`);
  `src/skills/<name>/SKILL.md` is the catalog, which an agent names in `agent.ts` (`skills: ["review"]`).
  On a server a skill whose folder holds more than its `SKILL.md` gets its `location`, the folder's path
  where the project runs (`fileURLToPath(new URL(…, import.meta.url))`: deployment-docker runs the
  project's source), so the scripts it names run there; on Cloudflare a skill is its text only.
- **Prompt templates.** A folder's `prompts/<name>.md` is a template in Pi's coding agent's format
  (frontmatter `description`, else its first line; `argument-hint`; placeholders `$1`, `$@`,
  `$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`; arguments split as a shell does, quotes keep
  spaces). Each name is one `agent.command` (`audience: "user"`) in the generated file, whose `run`
  answers the conversation's agent's template, expanded, as `{ prompt }`: the runner dispatches it as
  the typed message (`admitInbound`: its id is the request id, so a redelivery is a duplicate; the
  dashboard: an operator's message). A conversation whose agent has none of that name is told `this
  agent has no template "<name>"`. The same name in two agents is one command, the first agent's
  description the menu's. `pikit agents` and `pikit doctor` refuse a name that is no `COMMAND_NAME`, an
  empty template, a description of more than one line or 200 characters; a name another component's
  command has is refused where the App is composed (`pikit doctor`, the start: one key, two
  providers). Pi's expansion code (`splitArgs`, `expand`, `templateCommand`) is written into the file,
  so it still needs nothing of the component. A template's command is not the agent's: its prompt is
  a message like any other (it waits for a run going), so it never needs `agent.runtime` (the
  generated component cannot use it: runtime-pi uses its agents).
- **Removing it** (`pikit remove agents-folders`) leaves `src/extensions/agents.ts` as it was last
  generated: plain code that needs nothing of the component, kept from then on by hand (§7).
- **Live agents stay data** ([agents-live](../registry/components/agents-live/README.md)): an
  operator's agent is not a folder. The two work together: the catalog is what a live agent's Skills
  switches offer, a live agent never takes a folder's name, and a folder added later under a live
  agent's name wins (runtime-pi looks the code up first; agents-live leaves the stored one out).

## Pi first
Pi's coding agent reads `SYSTEM.md` (it replaces its system prompt), Agent Skills folders
(`SKILL.md`), which pikit's runtime already reads as `defineSkill`, and prompt templates
(`prompts/<name>.md`, its `docs/prompt-templates.md` at v1.3.0). pikit takes the names and the
format, not the loader: Pi's reads the disk where it runs, which Cloudflare cannot. `AGENTS.md` is left
out on purpose: a coding agent working in `src/agents/support/` reads an `AGENTS.md` there as its own
instructions, so the agent's context lives in `SYSTEM.md`.

## Tests
- The generator: a folder gives its definition (prompt, channel texts, own skills); `src/skills/` gives
  the catalog; a folder without `agent.ts` and unsafe folder names are problems; the output is stable
  (same folders, same text) and inlines texts as strings; on a server a skill with files gets a
  location, on Cloudflare none.
- The generated file in a real App: the prompt from `SYSTEM.md`, a channel's text appended for its
  conversations only (after the agent's own `prepare`), `SYSTEM.md` beside a `systemPrompt` refused, a
  folder named after another agent refused, the catalog provided as `agent.skill`.
- The hooks: `pikit agents` writes the file and says so; `doctor` passes when current and fails, naming
  the command, when a folder changed.
- Prompt templates: each name one command for users, the conversation's agent's template with Pi's
  placeholders filled (quoted arguments, defaults, slices), another agent's name told it has none; a
  bad name, an empty template, a long description are problems; a name another command has stops the
  App.
- With agents-live and runtime-pi (`app.test.ts`, a repository test): a live agent given a catalog
  skill loads it in a run and knows no other; the folder's agent keeps its own; the names' rules.

## Open questions
- `context/`, files an agent's workspace starts with: a `seed` of workspace-local, copied the first
  time it makes an agent's directory, server only.
- Built: full presets offer `agents-folders`; `pikit new` asks one agent or several. Several installs
  the component, writes Steward's prompt to `SYSTEM.md` and runs `pikit agents` once at creation.
  With a directory argument, `--with agents-folders` selects that path. One keeps the direct registry.
- `extensions/` per agent: an extension is a component today; an agent-private one could be
  a file the generated component provides under the agent's name.
