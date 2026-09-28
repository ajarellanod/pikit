# Slash commands

**Public appeal:** —

**Specified:** idea (SPEC §6.2b, tier B: `registerCommand`, "slash commands from a channel")

**Needed by:** nothing required.

## What it gives
`/name args` typed in a chat runs a command a Pi extension registered, or one a channel owns, in
that conversation.

## How it fits pikit
- Commands are the channel's today: `channel-telegram` handles its own (`/new` resets), and SPEC §5
  keeps commands out of `admitInbound`.
- Extension commands are registered per conversation, when it opens (SPEC §6.2b), so a channel
  cannot know them in advance: it asks the runtime to run a command in a conversation. That is a
  new method or capability on the `agent.runtime` side (a contract change, suite first).
- Platforms that list commands (Telegram `setMyCommands`, Slack and Discord slash commands) are
  told the names by the channel's `configure` step.
- Absent: a command from an extension stays tier C (a warning when it loads).

## Pi first
Pi's `registerCommand` defines the commands and their handlers; `/skill:name` loads a skill. pikit
only routes the text to them and builds no command system of its own.

## Open questions
- A command sent to a busy conversation: now, or after the run?
- Who may run which command ([policy tools](policy-tools.md)).
