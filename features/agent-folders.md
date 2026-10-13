# Agent folders: an agent is its directory

**Public appeal:** — (pi-hive's `agents/{name}/`: `system-prompt.md`, `skills/`, `extensions/`,
`context/`, each found by convention)

**Specified:** no. Today an agent is `src/agents/<name>/agent.ts` (`defineAgent`, its prompt a
string in it), registered by hand in the project's `src/extensions/agents.ts`
(`provideKeyed("agent.definition", …)`), and a skill is imported and passed by hand
(`defineSkill(text)`, `packages/contracts/src/skill.ts`).

**Needed by:** nothing required. [Channel context](channel-context.md) and the
[skills catalog](skills-catalog.md) use it when both are built.

## What it gives
What an agent may do is written in one place, and what it knows sits next to it, as files:

```
src/agents/support/
  agent.ts                  # what it may do: model, tools, extensions, skills by name, steward
  SYSTEM.md                 # its system prompt
  AGENTS.md                 # optional: context appended to it (conventions, who it serves)
  channels/telegram.md      # optional: appended when the conversation is Telegram's
  skills/review/SKILL.md    # optional: skills of this agent only
  context/                  # optional: files its workspace starts with
```

Adding an agent is adding a folder; nothing is registered by hand. An agent without a folder entry
keeps today's form: `agent.ts` alone, its prompt in it.

## How it fits pikit
- **What it may do stays TypeScript.** `agent.ts` keeps `defineAgent`'s allow-lists (`tools`,
  `extensions`, and skills by name once the [skills catalog](skills-catalog.md) is built): installing
  a tool, an extension or a skill gives no agent anything until it names it, and the runtime refuses to
  start on a name nothing provides. A YAML file would lose both checks ([config files](config-files.md)
  is undecided and holds values, never strategies).
- **The texts are files, read where the App is built, not where it runs.** Cloudflare has no project
  files at run time, so a server-only `readFile` at setup would split the targets. One index for both:
  `src/agents/index.ts`, generated from the folders, imports each text `with { type: "text" }` (the
  Text rule `deployment-cloudflare` already has for `.md`) and provides one `agent.definition` per
  folder: `defineAgent({ ...agent, systemPrompt: SYSTEM + AGENTS, skills: [...] })`. It replaces
  `src/extensions/agents.ts`. The index is generated and committed; `pikit doctor` fails when it is
  stale (a folder added, a file removed), so an App never runs other agents than its folders say.
- **One source per field.** An `agent.ts` that sets `systemPrompt` while its folder has `SYSTEM.md`
  is refused, saying which to keep.
- **Skills of the folder** are `defineSkill(text, { name: <its folder> })`; on a server their
  `location` is the folder's path in the deployed image, so the scripts they name run there
  (`deployment-docker`'s image copies the project, `COPY . .`); on Cloudflare a skill is its text only, as `skill.ts` says.
- **`channels/<channel>.md`** is appended for that channel's conversations: an extension section that
  reads `CONVERSATION`'s `channel` ([channel context](channel-context.md)), installed by the index for
  the agents that have such files.
- **`context/`** seeds the agent's workspace: copied into its directory the first time the workspace
  makes it, never over a file the agent changed. That is `workspace-local`'s (a `seed` per agent),
  server only; on Cloudflare `execution-do` would seed its object's files the same way.
- **Live agents stay data** ([agents-live](../registry/components/agents-live/README.md)): an operator's
  agent is a name, a prompt and allow-lists in the dashboard, not a folder.
- **It is source**, so the steward changes it as any source: a proposal, approved, deployed (SPEC §6).

## Pi first
Pi's coding agent already reads these names: `SYSTEM.md` replaces its system prompt, `AGENTS.md` is
appended as context, skills are `SKILL.md` folders (the Agent Skills format), and packages ship them
(`pi-coding-agent`'s README, "Context Files" and "Skills"). pikit takes the names and the format, not
the loader: Pi's reads the disk where it runs, which Cloudflare cannot. pi-durable has no skills nor
context files; pikit's runtime adds both (`packages/pi-adapter/src/agent.ts`).

## Tests
- The generator: a folder gives its definition (prompt, context, skills, channel files); a folder
  without `SYSTEM.md` keeps `agent.ts`'s prompt; both is refused; a skill whose folder name differs
  from its `name` is refused (`defineSkill`'s check); output is stable (same folders, same file).
- `pikit doctor`: a stale index fails, naming the folder.
- The App: runtime-pi's tests with a generated index, on both targets (workerd for `durable`).

## Open questions
- Where the generator lives: a `pikit agents` command, a step of `pikit dev` and `pikit up`, or both.
- Whether `extensions/` per agent (pi-hive's) has a place: an extension is a component today, named by
  agents; an agent-private one could be a file the index provides under the agent's own name.
- `AGENTS.md` beside the project's own `AGENTS.md` (the one for the developer's AI agent): the name
  clashes only in meaning; another name (`CONTEXT.md`) would avoid confusing the two.
