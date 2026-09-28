# channel-telegram

Talk to your agent in Telegram: send your bot a message, get the answer in the chat.

- **Provides:** nothing to other components. It receives messages and sends answers.
- **Requires:** `secrets` (the bot token and the allowed users), `conversations.registry`,
  `agent.runtime`. A router (such as `router-basic`) picks the agent.
- **Uses, if installed:** `outbound.queue` (durable sending), and `agent.submissions` with
  `storage.kv` (no answer lost while the channel is stopped): "Sending" below.
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
- **The way to the agent** is the inbound path every channel takes (`admitInbound`: your stages in
  `inbound.normalize`, the router, the conversation). When the agent will not answer, the chat is
  told: "I can't take that message." when a stage stops it (a policy, a routing rule), "Sorry, I
  can't answer that here." when the router denies it, and "This bot is not set up to answer yet."
  when no router is installed.
- **While the agent works**, the chat shows "typing…".
- **Answers:**
  - Markdown is converted to Telegram's formatting (bold, italics, code, links); if Telegram
    refuses it, the same words are sent as plain text.
  - Answers longer than Telegram's 4096 characters are sent in pieces.
  - A failed run says so in the chat, with its error code. A message the runtime abandoned (code
    `abandoned`) gets "Sorry, we could not answer your message. Please send it again."
- **A message is acknowledged to Telegram only once its conversation has it.** A message delivered
  again after a crash is recognised by its id (`telegram:<chat>:<message>`) and answered once.
- **Sending:**
  - With `outbound-durable` installed (`pikit add channel-telegram` and `pikit new` offer it, with the `storage-sqlite` it needs), every answer is stored before it
    is sent and delivered even across crashes, outages and rate limits: see its README. A piece sent
    again after a crash starts with `↻ `, since Telegram cannot tell a repeated send apart.
  - Without it, answers are sent directly, retried in the process: after `retry_after` for
    Telegram's 429, and with backoff for network errors and 5xx. A reply lost to a crash while
    sending is not sent again, but the answer is in the conversation's session.
- **Answers that end while the channel is stopped.** A deploy stops the channel before the runtime,
  so a long answer can end in between.
  - With `submissions-sql` installed (`pikit add runtime-pi` offers it, with `storage-sqlite`) and
    `storage-kv-sql` (`pikit add channel-telegram` offers it), the channel reads every run's outcome
    from its `answers` feed, from a cursor it keeps in `storage.kv` (the key `answers-cursor` of its
    namespace, `channel-telegram`): when it starts, whenever a run ends, and
    every 30 seconds. That answer is sent when the channel starts again; one the outbox could not
    store, or Telegram could not take, is tried again (after 1 s, 5 s, 30 s, then every minute)
    instead of being dropped, and logged as an error with its conversation from the 3rd failure.
    Each chat's answers go in order, and chats do not wait for each other; the cursor never moves
    past an answer not delivered, so other chats go on for at most 200 answers past a stuck one.
    With the outbox, an answer read twice after a crash is stored once; without it, it may be sent
    twice (one sent just before a crash, or those other chats got past a stuck one). The first time
    the channel reads the feed it starts at its end: installing it in a project that already had
    `submissions-sql` does not send old answers again.
  - Without either of them, answers come from the runtime's events only: one that ends while the
    channel is stopped is not sent, and a warning says so.

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
  accounts: [],                        // more bots besides the default one, by name
}
```

## Several bots

Each Telegram bot is an identity, so a team that wants one bot per agent runs several. The default
bot is `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_USERS`, and its conversations are `telegram:<chat>`.
Each name in `accounts` adds a bot of its own:

| `accounts: ["ops"]` | |
|---|---|
| instance | `telegram:ops` (what routers match and the outbox delivers by) |
| token | `TELEGRAM_OPS_BOT_TOKEN` |
| allowed users | `TELEGRAM_OPS_ALLOWED_USERS` |
| conversations | `telegram:ops:<chat>` |

`pikit configure` sets up each bot in turn. To give each bot its own agent, install `router-rules`:

```ts
"router-rules": { rules: [{ channel: "telegram:ops", agent: "ops" }] }, // the rest: router-basic's
```

If one bot cannot start (a missing token, a webhook), the channel does not start, and no bot keeps
polling.

## Tests

The tests are copied with the component and run in your project against `fake-telegram.ts`, a
local stand-in of the Bot API: no bot, token or network needed.
- `channel-telegram.test.ts` covers the whole conversation: allowed and refused users, commands,
  "typing…", formatting and splitting, retries, a redelivered message answered once, the
  acknowledgement at stop, the lifecycle conformance suite and the start failures; with
  `agent.submissions`, answers from its feed, one that ended while the channel was stopped delivered
  at the next start (and only then), a failed enqueue or send tried again, answers of other channels
  skipped; without it, the warning for an answer that could not be sent.
- `answers.test.ts` covers the feed's reader alone: a stuck chat holds up only itself and the cursor,
  each gap reported, backoff when storage fails, and where a new cursor starts.
- `conformance.test.ts` runs the channel conformance suite from `@pikit/contracts/testing`: what every
  channel does with a message (routed, deduplicated, stopped, denied, no router), through Telegram.
- `configure.test.ts` covers the setup: a checked token, allowing whoever messages the bot, and
  the same without a terminal.

`component.json` is generated from `setup` by `pikit registry generate`; "what setup declares" pins
it in the tests.
