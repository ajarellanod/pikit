# Slash commands

**Public appeal:** —

**Specified:** partly built. The registry is: `agent.command` (`packages/contracts/src/command.ts`),
modelled on Pi's `registerCommand`, listed and run by admin-api for the dashboard's "/", and run
when typed in a chat by channel-google-chat, channel-telegram, channel-telegram-webhook and
channel-web (2026-10-21). Team commands (`/stop`, `/status`, `/tasks`, `/cancel`) and prompt
templates per agent (agents-folders) are built. Pi extensions' own commands are not.

**Needed by:** nothing required.

## What it gives
`/name args` typed in a chat runs a command a Pi extension registered, or one a channel owns, in
that conversation.

## How it fits pikit
- A channel's own built-ins come first and stay its own (`/new`, `/reset`, Telegram's `/start`,
  Google Chat's app commands). Then `admitInbound`'s `commands` (the App's `agent.command`, cut to the
  channel's config `commands` with `allowedCommands`): a registered `/name args` is routed like any
  message (a denied sender runs nothing), runs in its conversation with the sender (`run`'s `sender`:
  memory-recall's `/prefs` acts for that person) and is never dispatched; the channel tells the sender
  the note or why it failed. An unknown or disallowed `/word` goes to the agent as text. Each channel
  runs a command once per platform message (Google Chat keeps what it said under
  `command:<message name>`, Telegram the last command's message id per chat, channel-web the request
  id). Who a command is for is its own to say (`audience`: `"user"` or `"operator"`, the operator's
  when absent), so a channel names none: every channel's default, `"user"`, offers the commands for
  users (memory-recall's `/rules`, `/prefs`, runtime-pi's `/stop`, `/status`, `/tasks`, `/cancel`, the
  prompt templates) and none of the operator's (`/new`, `/name`, `/compact`); `"all"` or a list of
  names allows more.
- **A command may answer a prompt instead of a note** (`{ prompt }`: a prompt template's expansion).
  Its runner dispatches that prompt in place of the typed message: `admitInbound` with the message's
  id as the request id and its sender (the outcome is `admitted` or `duplicate`, as for any message),
  admin-api as an operator's message (`dashboard:<uuid>`). So a platform's redelivery of a typed
  `/review x` runs the command again but dispatches a duplicate: one run. No crash window is left
  between the command and its dispatch: the command writes nothing, and the dispatch is idempotent by
  the message's id.
- pi-durable's own extensions registering commands per conversation would need the runtime to list
  and run those too (a runtime-side addition to the registry, suite first).
- Platforms that list commands (Telegram `setMyCommands`, Slack and Discord slash commands) are
  told the names by the channel's `configure` step: not built (Telegram's menu is set with
  @BotFather's `/setcommands`).
- Absent: no extension registers commands. Running Pi coding-agent extensions was dropped with the
  move to pi-durable; pi-durable's own extensions will replace it.

## What is built: the registry, and the dashboard's "/"
- **The contract**: the keyed capability `agent.command`, one command per name (Pi's rule,
  `COMMAND_NAME`), `{ description, argumentHint?, audience?, run(conversation, args, ctx, sender?) }` answering
  `{ text? }` or `{ prompt }`; `runAgentCommand` and `listAgentCommands` run and list them, the same for every
  runner; `createAgentCommandConformance` is its suite. A command runs in the App that holds the
  conversation (on Cloudflare its object) and acts only through contracts.
- **The built-ins**, registered through it like any component's, are Pi's that pikit does for real:
  `/new` (the key's reset) and `/name <title>` (the conversation's title) in admin-api, `/compact`
  (pi-durable's manual compaction) in runtime-pi. Pi's others are its terminal's (`/model`,
  `/settings`, `/tree`…) and have no pikit meaning yet. memory-recall adds `/rules` and `/prefs`
  ([memory](memory.md)).
- **Team commands** (runtime-pi's, `audience: "user"`: anyone the channel admits in that chat, since
  the person in the thread is who sees the agent stuck): `/stop` aborts the conversation's run going
  (`agent.runtime`'s `abort`; the messages waiting go too, background tasks go on), or says nothing
  runs; `/status` says the agent, running or idle, the messages waiting and the background tasks
  running, from pi-durable's records (`pi.live`, `pi.inbox`), writing nothing; `/tasks` lists the
  conversation's background tasks (tool-delegate's `delegate` with `wait: false`: id, agent, status,
  when it started, its latest step) and `/cancel <id>` stops one as `delegate_cancel` does (the
  conversation hears once it stopped). They are runtime-pi's, not tool-delegate's: runtime-pi uses
  every `agent.tool`, so a tool's component cannot use what runtime-pi provides (a dependency cycle).
  The tasks are the runtime's `DurableRuntime.delegations`, the code path the tools take, scoped to
  the conversation given: another conversation's id is not found. **Scope is the conversation**: in
  Google Chat each thread is one, so `/tasks` in a thread lists that thread's tasks only. A space-wide
  view would need an index of the space's conversations' tasks (open).
- **Prompt templates** (agents-folders): `src/agents/<agent>/prompts/<name>.md` in Pi's format (a
  frontmatter `description` and `argument-hint`, placeholders `$1`, `$@`, `$ARGUMENTS`,
  `${1:-default}`, `${@:N}`, `${@:N:L}`, arguments split as a shell does). `pikit agents` makes each
  name one `agent.command` (`audience: "user"`) in the generated file, whose `run` answers the
  conversation's agent's template, expanded, as the prompt; a conversation whose agent has no template
  of that name is told `this agent has no template "<name>"`. The same name in two agents is one
  command (the first agent's description is the menu's). A name that is no `COMMAND_NAME` (or an
  empty template, a description of more than one line) is refused by `pikit agents` and `pikit
  doctor`; one named as another component's command, where the App is composed (`pikit doctor`, the
  start): one key, two providers.
- **The dashboard** lists only these (`GET /admin/api/commands`) and runs one in a conversation
  (`POST /admin/api/conversations/:id/commands/:name`), its answer a quiet note for the operator. Its
  own actions (stop, reset, images, web search, the assistant, the views) are buttons, not commands.

## Pi first
Pi's `registerCommand` defines the commands and their handlers; `/skill:name` loads a skill. pikit
only routes the text to them and builds no command system of its own. Prompt templates are Pi's
coding agent's (`prompts/<name>.md`, its `parseCommandArgs` and `substituteArgs`, written into the
generated file), per agent instead of per user.

## Open questions
- A command sent to a busy conversation: now, or after the run? (A template's prompt is a message: it
  waits for the run, as any follow-up.)
- A space-wide `/tasks` (every thread of a Google Chat space): needs an index of the tasks per space.
- Who may run which command ([policy tools](policy-tools.md)).
