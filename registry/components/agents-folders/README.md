# agents-folders

Each agent is a folder, its prompt and its skills files beside its `agent.ts`; the project's skills
are folders too. `pikit agents` turns them into the one file your App lists, and `pikit doctor` fails
while that file is out of date.
Design note: [features/agent-folders.md](https://github.com/ajarellanod/pikit/blob/main/features/agent-folders.md).

- **Provides:** nothing at run time. It writes `src/extensions/agents.ts`, your project's component,
  which provides `agent.definition` (one per folder) and `agent.skill` (the catalog).
- **Adds:** the command `pikit agents` (`generate.ts`) and a step of `pikit doctor` (`doctor.ts`).
- **Targets:** `server` and `durable`. The command and the check run on your machine, in the project;
  what they write is the same on both targets.
- **Installs to:** `src/pikit/agents-folders/`.
- **npm dependencies:** `@pikit/contracts`.

```sh
pikit add agents-folders
pikit agents        # writes src/extensions/agents.ts from the folders; commit it with them
```

## The folders

```
src/agents/support/
  agent.ts                  # what it may do: model, tools, extensions, skills by name, steward
  SYSTEM.md                 # optional: its system prompt
  channels/telegram.md      # optional: appended to its prompt in Telegram's conversations
  channels/telegram.ops.md  # the instance telegram:ops (":" written ".")
  skills/notes/SKILL.md     # optional: skills of this agent only
src/skills/
  review/SKILL.md           # the project's catalog: an agent knows it by naming it, skills: ["review"]
```

- **`agent.ts`** stays TypeScript: `defineAgent({ name, model, tools, extensions, skills, prepare })`.
  What an agent may use is written there, and the runtime refuses to start on a name nothing provides.
  Its `name` is its folder's.
- **`SYSTEM.md`** is its system prompt. An `agent.ts` with a `systemPrompt` and a `SYSTEM.md` beside it
  stops the App, naming both: one source.
- **`channels/<channel>.md`** is appended to the prompt in that channel's conversations
  (`ConversationRef.channel`), after what the agent's own `prepare` gives. An operator's prompt override
  (the dashboard's Agent section) replaces the whole prompt, channel text included.
- **`skills/<skill>/SKILL.md`** (an agent's) and **`src/skills/<skill>/SKILL.md`** (the catalog) are
  Agent Skills folders; a skill's folder is its name. On a server, a skill whose folder holds more than
  its `SKILL.md` (scripts, references) gets the folder as its location, so the agent's tools reach them
  where the project runs; on Cloudflare a skill is its text only.
- There is no `AGENTS.md`: a coding agent working in `src/agents/support/` would read it as its own
  instructions. The agent's context is `SYSTEM.md`.

## What it writes

`src/extensions/agents.ts`, the project component `pikit.config.ts` already lists (the starter's), in
full: one import per `agent.ts`, the folders' texts as strings, and a small `fromFolder` that puts them
together. Following the imports from `pikit.config.ts` still shows everything that runs, and a change
to a folder shows in the same diff as the file's. It needs no `.md` loader, so it is the same on a
server and on Cloudflare.

- **Out of date is loud.** `pikit doctor`, so `pikit dev` and `pikit up`, fails while the file is not
  what the folders say, naming `pikit agents`. Nothing regenerates it at deploy: what was reviewed is
  what runs (SPEC §6). A steward that adds an agent runs `pikit agents` in its branch.
- **Every problem at once, nothing written:** a folder without `agent.ts`, a name an agent or a skill
  cannot have, a `SKILL.md` `defineSkill` refuses, a channel file that names no channel, a
  `pikit.config.ts` that does not list the file.
- **Do not edit it.** Change the folders and run `pikit agents` again.
- If the generated file cannot be imported any more (an agent's folder deleted), `pikit doctor` cannot
  compose the App: run `pikit agents`, which does not need it.

## Removing it

`pikit remove agents-folders` removes the command and the check. `src/extensions/agents.ts` stays as it
was last written: plain code that needs nothing of this component, kept by hand from then on.

## Tests

`agents-folders.test.ts` is copied with the component and runs in your project. Each test writes a
small project next to it and runs the command there:
- a folder's agent (its `SYSTEM.md`, its own skills after the ones it names) and the catalog, read from
  a real App;
- a channel's text in that channel's conversations only, after the agent's own `prepare`;
- one source per field: a `systemPrompt` beside `SYSTEM.md`, or a folder named after another agent,
  stops the App;
- every problem said at once, nothing written; a `pikit.config.ts` that does not list the file;
- a skill's location on a server, none on Cloudflare;
- `doctor` passing when the file is current and failing, naming the command, once a folder changed;
- the command writing only when the text changes, and taking no arguments; stable output.
