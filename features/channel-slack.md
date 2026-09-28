# Slack channel

**Public appeal:** ⭐ Agents in the team's workspace. OpenClaw and Hermes both run on Slack.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
A Slack app that answers in direct messages and, when mentioned, in channels and their threads.

## How it fits pikit
- `channel-slack`: authenticates, builds the key (`slack:<channel>[:<thread_ts>]`), calls
  `admitInbound`, answers every outcome, passes `createChannelConformance` (SPEC §5, §14), and
  attaches its `ChannelTransport` to `outbound.queue`. Workspaces are instances (SPEC §5).
- Two ways in:
  - **Events API**: signed webhooks (`X-Slack-Signature`), an ack within 3 seconds, retries marked
    by `X-Slack-Retry-Num`; deduplicated by `event_id` with [inbound dedup](inbound-dedup.md)
    (SPEC §5 already names it), and a public URL;
  - **Socket Mode**: a WebSocket, no public URL, the way `channel-telegram` polls.
- Sends: `chat.postMessage`, which has no idempotency key: at-least-once with a marker; `429` with
  `Retry-After` is `rate_limited`.
- Threads (`thread_ts`): [threads](threads.md). Block Kit is how the transport `draws` parts
  ([rich content](rich-content.md)). `chat.update` for [streaming replies](streaming-replies.md).
  Slash commands: [slash commands](slash-commands.md).

## Pi first
Nothing in Pi: channels are pikit's (SPEC §6.2 table).

## Open questions
- Events API or Socket Mode first; Cloudflare needs the Events API.
- Sender authorization in a workspace: every member, or an allowlist.
