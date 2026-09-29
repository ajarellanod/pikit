# channel-telegram-webhook

Talk to your agent in Telegram when it runs on Cloudflare: Telegram posts each message to your Worker.

- **Provides:** `http.route` (`POST /telegram`, and `POST /telegram/<name>` per extra bot) and the
  `actor.inbox` handler of `telegram.update`.
- **Requires:** in the Worker's half, `secrets` and `actor.mailbox`; in the object's half, `secrets`,
  `conversations.registry`, `agent.runtime`, `agent.submissions`, `storage.kv` and `wakeups`. A router
  (such as `router-basic`) picks the agent.
- **Uses, if installed:** `outbound.queue` (durable sending).
- **Target:** `cloudflare`. On a server, use `channel-telegram` (long polling, no public URL needed):
  absence, not flags (SPEC §4.1, C6).
- **Installs to:** `src/pikit/channel-telegram-webhook/`.
- **npm dependencies:** `typebox`.
- **Environment:**
  - `TELEGRAM_BOT_TOKEN` (secret, required): the bot's token from @BotFather.
  - `TELEGRAM_ALLOWED_USERS` (required): the Telegram user ids allowed to talk to the bot,
    separated by commas.
  - `TELEGRAM_WEBHOOK_SECRET` (secret, required): what Telegram sends with every update, so only
    Telegram reaches your agent. `pikit configure` generates it.

## Two halves, one per App

On Cloudflare a project has two Apps in `pikit.config.ts` (SPEC §4.1, C1): the Worker's, which checks
and routes, and the Durable Object's, which owns one conversation. This component has a half for each:

| | The Worker's half | The object's half |
|---|---|---|
| Export of `index.ts` | `worker` (named in `component.json`'s `apps.worker`) | the default export |
| Component name, and its config's key | `channel-telegram-webhook-worker` | `channel-telegram-webhook` |
| Does | the route, the secret, the allowed users, strangers, `actor.mailbox` | commands, `admitInbound`, delivering answers |

```ts
import channelTelegramWebhook, { worker as channelTelegramWebhookWorker } from "./src/pikit/channel-telegram-webhook/index.ts";

// The Worker's App: secrets, actor.mailbox (an RPC to the object), http.route's server…
export const worker = defineApp({ components: [/* … */ channelTelegramWebhookWorker], config: workerConfig });
// The Durable Object's App: the router, the runtime, sessions, storage, submissions, wakeups…
export default defineApp({ components: [/* … */ channelTelegramWebhook], config });
```

Both halves take the same `apiBase` and `accounts` in their own config.

The object's half registers its `actor.inbox` handler in `actor-inbox.ts` only (`registerInbox`):
today a keyed capability provided in `setup`; when `actor.inbox` becomes a single capability with
`handle(type, handler)`, that file alone changes (and `component.json` then lists `actor.inbox` under
`requires` instead of `provides`).

It also runs with both halves in one App on a server (with `mailbox-local`, `wakeups-timers`, and
`server-bun` behind HTTPS): its tests run it that way. Its target stays `cloudflare`, since on a server
`channel-telegram` needs no public URL.

## Set it up

```sh
pikit add channel-telegram-webhook
pikit configure
pikit up
```

`pikit configure` walks you through it:
1. If you have no bot yet, it explains @BotFather in three lines. Paste the token; it is checked
   at once, and it shows your bot's name and link.
2. It generates `TELEGRAM_WEBHOOK_SECRET` into `.env`, or keeps the one there if Telegram accepts it
   (16 to 256 of `A-Z a-z 0-9 _ -`). Nobody types it.
3. It asks you to open your bot and send it any message, shows who wrote ("Ada (@ada), id 1001"),
   and on "y" that person is allowed. It reads that message with `getUpdates`, which Telegram
   refuses while the bot has a webhook: if a deploy already set one, it offers to remove it (the
   Worker answers nobody while nobody is allowed, and the next `pikit up` sets it again).

`pikit up` deploys, waits until the new version answers, then registers the webhook: see
"Registering the webhook" below.

## What it does

- **Receiving messages.** Telegram posts each update to `POST /telegram` with the secret in
  `X-Telegram-Bot-Api-Secret-Token`. A request without it, or with another, is `401` (compared in
  constant time, as SHA-256 digests).
- **What gets through:** messages with text from people in private chats. Group messages, bots and
  other updates are acknowledged (`200`) and dropped. A message without text gets "I can only read
  text messages for now."
- **Who may talk** is the list in `TELEGRAM_ALLOWED_USERS`, checked in the Worker. A stranger is
  told their user id, so you can add it, and nothing reaches the agent. The Worker keeps no state, so
  a stranger who keeps writing may be told again after its isolate is recycled.
- **The way to the conversation.** The Worker sends the update to the conversation's actor,
  `actor.mailbox.send("telegram:<chat>", "telegram.update", update)`: on Cloudflare, the Durable
  Object `idFromName("telegram:<chat>")`. It answers Telegram `200` once the conversation holds the
  message durably, and `500` when it could not, so Telegram delivers it again.
- **Acknowledged as soon as the message is durable, never after the run.** Telegram does not
  publish how long it waits for a webhook, and a run takes as long as the agent does.
- **A message delivered twice is answered once.** Its request id is `telegram:<chat>:<message>`, as
  in `channel-telegram`: the runtime answers the second one `duplicate`. A command Telegram delivers
  again is recognised by its message id and not run twice.
- **Conversations:** each private chat is one conversation, `telegram:<chat id>`, the keys
  `channel-telegram` makes.
- **Commands:** `/new` (or `/reset`) starts a new conversation; the old one is kept in its session.
  `/start` and `/help` explain. Any other command goes to the agent as text.
- **The way to the agent** is the inbound path every channel takes (`admitInbound`). When the agent
  will not answer, the chat is told: "I can't take that message." when a stage stops it, "Sorry, I
  can't answer that here." when the router denies it, "This bot is not set up to answer yet." when no
  router is installed.
- **While the agent works**, the chat shows "typing…", renewed every 4 seconds for at most 10
  minutes per message.
- **Answers** are channel-telegram's: Markdown converted to Telegram's formatting (plain text if
  Telegram refuses it), split under 4096 characters, a failed run told with its error code, an
  abandoned message asked to be sent again.

### Delivering answers

Nothing waits for a run in memory: an object keeps running only while an event is in progress (C4).
Answers are delivered by the wakeup `channel-telegram-webhook.deliver`, which the object's half
registers with `wakeups.handle` at start, and asks for at every start, whenever a message arrives, and
whenever a run of its conversations ends.

- It reads every run's outcome from `agent.submissions`' `answers` feed, from a cursor it keeps in
  `storage.kv` (the key `answers-cursor` of its namespace, `channel-telegram-webhook`). The cursor
  moves only past answers delivered. An answer that ended while no wakeup ran (an eviction, a
  restart, a deploy) is delivered at the next one.
- Without `outbound.queue`, each piece is marked in `storage.kv`, `sending` before it goes and `sent`
  after. A piece found `sending` (the object died during the send, or it timed out) is sent again
  starting with `↻ `, since Telegram cannot tell a repeated send apart; one Telegram refused outright
  goes again unmarked. With `outbound-durable` installed, the answer is enqueued under its answer key
  instead: stored once, sent through the queue.
- A failure waits: Telegram's `retry_after` for a 429; 1 s, 5 s, 30 s, then every minute otherwise,
  logged as an error from the 3rd in a row. A permanent refusal (the user blocked the bot) is logged
  and the answer given up.
- Answers go in the feed's order, so one that cannot be delivered holds up the ones after it. On
  Cloudflare each object owns one conversation, so it holds up only its own chat; with both halves in
  one App on a server, it holds up every chat.
- One run stops at its slice's deadline or after 20 pieces, and asks to run again at once.
- The first time it opens its cursor, it starts at the feed's end: answers already there ended before
  the channel was installed.

It refuses to start: the Worker's half without a token, an allowed user, or a usable webhook secret;
the object's half without a token. Neither calls Telegram to start: on Cloudflare every object runs
the start, and each call is a subrequest.

## Registering the webhook

Telegram must be told where to post (`setWebhook`), and only once the new version answers: right after
a deploy the previous version still answers for a few seconds, and would refuse the new secret (C8). So
`deploy.ts` exports `afterDeploy`, for `deployment-cloudflare`'s `up` to call once `/health` answers
with the version it deployed, the way `pikit configure` calls `configure(io)`:

```ts
import { afterDeploy } from "./src/pikit/channel-telegram-webhook/deploy.ts";

const problems = await afterDeploy({
  url: "https://my-agent.example.workers.dev", // the deployed Worker's public base URL
  config,                                      // this component's config in pikit.config.ts
  get: (name) => env[name],                    // .env or the environment: tokens and webhook secrets
  say: (line) => console.log(line),
});
```

For each bot it calls `setWebhook` with `<url>/telegram[/<name>]`, its secret and
`allowed_updates: ["message"]`, then checks the URL with `getWebhookInfo`. It resolves with one line
per bot that failed (empty when done), and throws only when Telegram cannot be reached. Updates Telegram
holds are kept, not dropped. Setting the same webhook again is harmless, so every deploy calls it.

The secrets reach the Worker as Worker secrets (`deployment-cloudflare` puts the `.env` ones there):
`secrets-cloudflare` reads them in both Apps.

## Config

```ts
"channel-telegram-webhook": {
  apiBase: "https://api.telegram.org", // default; a local Bot API server, or a test double
  accounts: [],                        // more bots besides the default one, by name
},
"channel-telegram-webhook-worker": {   // in the Worker's App: the same values
  apiBase: "https://api.telegram.org",
  accounts: [],
},
```

## Several bots

As in `channel-telegram`, the default bot is `TELEGRAM_BOT_TOKEN` and its conversations are
`telegram:<chat>`. Each name in `accounts` adds a bot of its own, in both halves:

| `accounts: ["ops"]` | |
|---|---|
| instance | `telegram:ops` (what routers match and the outbox delivers by) |
| token | `TELEGRAM_OPS_BOT_TOKEN` |
| allowed users | `TELEGRAM_OPS_ALLOWED_USERS` |
| webhook secret | `TELEGRAM_OPS_WEBHOOK_SECRET` |
| webhook | `POST /telegram/ops` |
| conversations | `telegram:ops:<chat>` |

An update for a bot the object's half does not run is refused (`500`, and an error in the log): keep
`accounts` equal in both halves.

## Where its code comes from

`api.ts`, `format.ts`, `transport.ts` and `account.ts` are copies of `channel-telegram`'s, since
components never import each other: `api.ts` adds `setWebhook`, `deleteWebhook` and the rest of
`getWebhookInfo`; `account.ts` adds each bot's webhook secret and path. `configure.ts` is
`channel-telegram`'s step with the webhook's secret and an existing webhook added. The delivery follows
the Cloudflare spike that ran in production (September 2026).

## Tests

The tests are copied with the component and run in your project against
`fake-telegram.test-support.ts`, a local stand-in of the Bot API extended with `setWebhook`,
`getWebhookInfo` and `deleteWebhook`, which posts each update to the webhook with its secret: no bot,
token or network needed. Only tests import it.
- `channel-telegram-webhook.test.ts` covers the whole conversation, with the in-memory doubles of
  `actor.mailbox`, `wakeups`, `storage.kv` and `agent.submissions`: a bad secret (`401`), strangers,
  groups and messages without text, a message reaching the runtime and its answer delivered,
  "typing…", a redelivered update answered once, a conversation that cannot take a message (`500`),
  commands, failed runs, long answers split, an answer that ended while no wakeup ran delivered at the
  next one, a piece found `sending` sent again with `↻ `, a refused send tried again, the outbox,
  several bots, the halves in two Apps as on Cloudflare, the start failures, the lifecycle suite
  for each half, and `registerInbox` reached through the mailbox.
- `conformance.test.ts` runs the channel conformance suite from `@pikit/contracts/testing`.
- `configure.test.ts` covers the setup: a checked token, the generated secret, allowing whoever
  messages the bot, a bot that already has a webhook, and the same without a terminal.
- `deploy.test.ts` covers `afterDeploy`: every bot's webhook set and checked, and what it reports.
- `format.test.ts` is `channel-telegram`'s, for the copied `format.ts`.

`component.json` is generated from `setup` by `pikit registry generate`, from both halves; "what
setup declares" pins them in the tests.
