# Slash commands

**Public appeal:** —

**Specified:** partly built. The registry is: `agent.command` (`packages/contracts/src/command.ts`),
modelled on Pi's `registerCommand`, listed and run by admin-api for the dashboard's "/". Channels
running them (`/name args` typed in a chat) is not.

**Needed by:** nothing required.

## What it gives
`/name args` typed in a chat runs a command a Pi extension registered, or one a channel owns, in
that conversation.

## How it fits pikit
- Commands are the channel's today: `channel-telegram` handles its own (`/new` resets), and
  `packages/contracts/src/inbound.ts` keeps commands out of `admitInbound`.
- A channel would run them through the same registry (`runAgentCommand`), in the conversation's App;
  pi-durable's own extensions registering commands per conversation would need the runtime to list
  and run those too (a runtime-side addition to the registry, suite first).
- Platforms that list commands (Telegram `setMyCommands`, Slack and Discord slash commands) are
  told the names by the channel's `configure` step.
- Absent: no extension registers commands. Running Pi coding-agent extensions was dropped with the
  move to pi-durable; pi-durable's own extensions will replace it.

## What is built: the registry, and the dashboard's "/"
- **The contract**: the keyed capability `agent.command`, one command per name (Pi's rule,
  `COMMAND_NAME`), `{ description, argumentHint?, run(conversation, args, ctx) }` answering
  `{ text? }`; `runAgentCommand` and `listAgentCommands` run and list them, the same for every
  runner; `createAgentCommandConformance` is its suite. A command runs in the App that holds the
  conversation (on Cloudflare its object) and acts only through contracts.
- **The built-ins**, registered through it like any component's, are Pi's that pikit does for real:
  `/new` (the key's reset) and `/name <title>` (the conversation's title) in admin-api, `/compact`
  (pi-durable's manual compaction) in runtime-pi. Pi's others are its terminal's (`/model`,
  `/settings`, `/tree`…) and have no pikit meaning yet.
- **The dashboard** lists only these (`GET /admin/api/commands`) and runs one in a conversation
  (`POST /admin/api/conversations/:id/commands/:name`), its answer a quiet note for the operator. Its
  own actions (stop, reset, images, web search, the assistant, the views) are buttons, not commands.

## Pi first
Pi's `registerCommand` defines the commands and their handlers; `/skill:name` loads a skill. pikit
only routes the text to them and builds no command system of its own.

## Open questions
- A command sent to a busy conversation: now, or after the run?
- Who may run which command ([policy tools](policy-tools.md)).
