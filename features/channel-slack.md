# Slack channel

**Public appeal:** ⭐ Agents in the team's workspace. OpenClaw and Hermes both run on Slack.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
A Slack app that answers in direct messages and, when mentioned, in channels and their threads.

## How it fits pikit
- `channel-slack`: authenticates, builds the key (`slack:<channel>[:<thread_ts>]`), calls
  `admitInbound`, answers every outcome, passes `createChannelConformance`
  (`@pikit/contracts/testing`). Workspaces are instances.
- Answers: it calls `startAnswerDelivery` in its `start` (`packages/contracts/src/delivery.ts`,
  [answer delivery](completed/outbound-delivery.md)) and gives only what is its platform's: its
  `ChannelTransport` (split, send one piece with its key, classify a failure), `route`, `text` and
  `policy`. So it requires `agent.submissions` and `storage.kv` (and `wakeups` on `durable`), and the
  engine enqueues to `outbound.queue` when one is installed.
- Two ways in:
  - **Events API**: signed webhooks (`X-Slack-Signature`), an ack within 3 seconds, retries marked
    by `X-Slack-Retry-Num`; deduplicated by `event_id` with [inbound dedup](inbound-dedup.md)
    (whose file already names it), and a public URL;
  - **Socket Mode**: a WebSocket, no public URL, the way `channel-telegram` polls.
- Sends: `chat.postMessage`, which has no idempotency key: at-least-once with a marker; `429` with
  `Retry-After` is `rate_limited`.
- Threads (`thread_ts`): [threads](threads.md). Block Kit is how the transport `draws` parts
  ([rich content](rich-content.md)). `chat.update` for [streaming replies](streaming-replies.md).
  Slash commands: [slash commands](slash-commands.md).

## Pi first
Nothing in Pi: channels are pikit's (SPEC P1).

## Open questions
- Events API or Socket Mode first; Cloudflare needs the Events API.
- Sender authorization in a workspace: every member, or an allowlist.
