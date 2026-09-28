# Discord channel

**Public appeal:** ⭐ Agents where communities already talk. OpenClaw and Hermes both run on Discord.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
A Discord bot that answers in direct messages and, when mentioned, in server channels and threads.

## How it fits pikit
- `channel-discord`: authenticates, builds the key (`discord:<channel>[:<thread>]`), calls
  `admitInbound`, answers every outcome, passes `createChannelConformance` (SPEC §5, §14), and
  attaches its `ChannelTransport` to `outbound.queue`. Several bots are instances
  (`discord:<account>`, SPEC §5).
- Receiving messages needs the Gateway (a long-lived WebSocket with the message content intent):
  server first. The Interactions endpoint (signed webhooks) carries only slash commands and buttons.
- Sends: REST message create; `rate_limited` from Discord's `retry_after`. Whether a create with a
  `nonce` can be made idempotent is to check before the transport declares `idempotent`.
- Threads: [threads](threads.md). Slash commands: [slash commands](slash-commands.md). Editing a
  message as the answer streams: [streaming replies](streaming-replies.md).
- Senders are authorized (allowlist, roles, [pairing](pairing.md)); a public server is strangers.

## Pi first
Nothing in Pi: channels are pikit's (SPEC §6.2 table).

## Open questions
- Cloudflare: the Gateway socket needs a Durable Object that holds it, or the channel stays
  server-only.
- One conversation per channel, per thread, or per user in a channel.
