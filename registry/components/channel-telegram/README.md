# channel-telegram

Talk to your agent in Telegram: send your bot a message, get the answer in the chat.

- **Provides:** nothing to other components. It receives messages and sends answers.
- **Requires:** `secrets` (the bot token and the allowed users), `conversations.registry`,
  `agent.runtime`. A router (such as `router-basic`) picks the agent.
- **Target:** `server`: it receives messages by long polling, which needs a process that keeps
  running.
- **Installs to:** `src/pikit/channel-telegram/`.
- **npm dependencies:** `typebox`.
- **Environment:**
  - `TELEGRAM_BOT_TOKEN` (secret, required): the bot's token from @BotFather.
  - `TELEGRAM_ALLOWED_USERS` (required): the Telegram user ids allowed to talk to the bot,
    separated by commas.

## Set it up

```sh
pikit add channel-telegram
pikit configure
pikit up          # or pikit dev
```

`pikit configure` walks you through it:
1. If you have no bot yet, it explains @BotFather in three lines. Paste the token; it is checked
   at once, and it shows your bot's name and link.
2. It asks you to open your bot and send it any message. It shows who wrote ("Ada (@ada), id
   1001"), and on "y" that person is allowed. The bot answers in Telegram that it worked.

You never look up a user id, set a webhook, open a port or buy a domain.

## What it does

- **Receiving messages** uses long polling (`getUpdates`): the bot asks Telegram for new messages.
  It works on a laptop and on a VPS without a public URL.
- **Who may talk** is the list in `TELEGRAM_ALLOWED_USERS`. Anyone can find a bot, and an agent
  with tools must not answer strangers. A stranger is told their user id once, so you can add it,
  and nothing reaches the agent. To let someone in, add their id to that line in `.env` and restart.
  It is read through `secrets`, like the token, because it lives in `.env` next to it.
- **Conversations:** each private chat is one conversation, `telegram:<chat id>`. Group messages
  are ignored for now.
- **Messages sent while the agent is working** change its course (Pi steers the run), and the
  run's answer covers them all.
- **Commands:** `/new` starts a new conversation; the old one is kept in its session. `/start` and
  `/help` explain. Any other command goes to the agent as text.
- **While the agent works**, the chat shows "typing…".
- **Answers:**
  - Markdown is converted to Telegram's formatting (bold, italics, code, links); if Telegram
    refuses it, the same words are sent as plain text.
  - Answers longer than Telegram's 4096 characters are sent in pieces.
  - A failed run says so in the chat, with its error code.
- **A message is acknowledged to Telegram only once its conversation has it.** A message delivered
  again after a crash is recognised by its id (`telegram:<chat>:<message>`) and answered once.
- **Sending** retries in the process: after `retry_after` for Telegram's 429, and with backoff for
  network errors and 5xx. A reply lost to a crash while sending is not sent again, but the answer
  is in the conversation's session. Durable delivery comes with `durable-outbox` (M2).

It refuses to start:
- without a token, or with a token Telegram does not know;
- with no allowed user;
- when the bot has a webhook: Telegram delivers either to a webhook or by polling, never both.
  Only one process can poll a bot at a time.

## Config

```ts
"channel-telegram": {
  apiBase: "https://api.telegram.org", // default; a local Bot API server, or a test double
  pollTimeoutSeconds: 30,              // default; how long one getUpdates waits
}
```

## Tests

The tests are copied with the component and run in your project against `fake-telegram.ts`, a
local stand-in of the Bot API: no bot, token or network needed.
- `channel-telegram.test.ts` covers the whole conversation: allowed and refused users, commands,
  "typing…", formatting and splitting, retries, a redelivered message answered once, the
  acknowledgement at stop, the lifecycle conformance suite and the start failures.
- `configure.test.ts` covers the setup: a checked token, allowing whoever messages the bot, and
  the same without a terminal.

`component.json` is generated from `setup` by `pikit registry generate`; "what setup declares" pins
it in the tests.
