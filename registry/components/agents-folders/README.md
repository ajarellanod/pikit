# agents-folders

Each agent is a folder, its prompt and its skills files beside its `agent.ts`; the project's skills
are folders too. `pikit agents` turns them into the one file your App lists, and `pikit doctor` fails
while that file is out of date.
Design note: [features/agent-folders.md](https://github.com/ajarellanod/pikit/blob/main/features/agent-folders.md).

- **Provides:** nothing at run time. It writes `src/extensions/agents.ts`, your project's component,
  which provides `agent.definition` (one per folder), `agent.skill` (the catalog) and `agent.command`
  (one per prompt template's name).
- **Adds:** the command `pikit agents` (`generate.ts`) and a step of `pikit doctor` (`doctor.ts`).
  The kit's presets name this feature and its declared command in `agents.folders`: `pikit new` asks
  one or several agents and runs it once only if that feature was chosen. The CLI does not recognize
  this component's name; another preset can name another feature and command.
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
  prompts/review.md         # optional: a prompt template, the slash command /review
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
  (the dashboard's Settings, Agents) replaces the whole prompt, channel text included.
- **`skills/<skill>/SKILL.md`** (an agent's) and **`src/skills/<skill>/SKILL.md`** (the catalog) are
  Agent Skills folders; a skill's folder is its name. On a server, a skill whose folder holds more than
  its `SKILL.md` (scripts, references) gets the folder as its location, so the agent's tools reach them
  where the project runs; on Cloudflare a skill is its text only.
- **`prompts/<name>.md`** is a prompt template, in Pi's coding agent's format:

  ```markdown
  ---
  description: Review a part of the code
  argument-hint: "<part> [focus]"
  ---
  Review $1. Focus on ${2:-correctness, security and error handling}.
  ```

  `/review api "error handling"` typed in a chat (anyone the channel admits there: `audience: "user"`)
  sends the agent the text with its placeholders filled: `$1`, `$2`…, `$@` or `$ARGUMENTS` (all),
  `${1:-default}`, `${@:-default}`, `${@:N}` and `${@:N:L}` (from the Nth, L of them); arguments split
  at spaces, quotes keeping one whole. The description is the frontmatter's, else the first line (60
  characters). Each name is one command: in a conversation whose agent has no template of that name
  it answers `this agent has no template "<name>"`; the same name in two agents is one command, each
  conversation getting its own agent's text (the first agent's description is the menu's). The
  expanded text is the message: it goes through `admitInbound` as the typed message (its id, so a
  redelivery runs once), and waits for a run going as any message; from the dashboard's "/" it is an
  operator's message. Only the folder's own `.md` files are templates.
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
  cannot have, a `SKILL.md` `defineSkill` refuses, a channel file that names no channel, a template
  whose name is no command's (lowercase letters, digits, `-`, `:`), whose text is empty or whose
  description is more than one line or 200 characters, a `pikit.config.ts` that does not list the file.
- **A template named as another component's command** (runtime-pi's `/compact`, `/stop`…) stops
  the App where it is composed: `pikit doctor` (so `pikit dev` and `pikit up`) and the start say the
  key `agent.command` "<name>" is provided by both.
- **Do not edit it.** Change the folders and run `pikit agents` again.
- If the generated file cannot be imported any more (an agent's folder deleted), `pikit doctor` cannot
  compose the App: run `pikit agents`, which does not need it.

## With agents-live

The two work together: a folder's agent is the code's (`agent.definition`), an operator's is data
(`agent.directory`), and runtime-pi looks a name up in the code first.
- The catalog (`src/skills/`) is what a live agent's Skills switches offer; an agent's own skills
  (`src/agents/<name>/skills/`) are its alone. A new catalog skill is code (`pikit agents`, a deploy);
  giving it to a live agent is live.
- A live agent never takes a folder's name, and a folder added later under a live agent's name wins:
  the stored live agent is left out, and its conversations go to the folder's agent.
- Channel texts and own skills are a folder's: a live agent has neither.

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
- the command writing only when the text changes, and taking no arguments; stable output;
- prompt templates: each name one command for users, the conversation's agent's template with Pi's
  placeholders filled (quoted arguments, defaults, slices), another agent told it has none; a bad
  name, an empty template, a long description refused; a name another command has stopping the App.

`app.test.ts`, a repository test (not copied: it imports agents-live and runtime-pi), runs the
generated file with agents-live and runtime-pi in a real App: a live agent given a catalog skill loads
it in a run and knows no other, the folder's agent keeps its prompt, channel text and skills, a live
agent cannot take a folder's name, and a folder added under a live agent's name wins.
