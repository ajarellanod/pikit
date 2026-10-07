# Google Chat channel

**Public appeal:** — (OpenClaw has it; it is not what draws the public)

**Specified:** partly (moved from the former SPEC §18; keys and idempotency decided in the former
§5)

**Needed by:** nothing required. As the first webhook channel it would bring
[inbound dedup](inbound-dedup.md) and `pikit expose` with it.

## What it gives
A Google Chat app: an agent per space, answering in the space's threads, with cards.

## How it fits pikit
- `channel-google-chat`: verifies the webhook's JWT, builds the key
  (`googlechat:spaces/AAA:threads/BBB`), calls `admitInbound`, answers every outcome, and passes
  `createChannelConformance` (`@pikit/contracts/testing`). Several apps are instances.
- Answers: it calls `startAnswerDelivery` in its `start` (`packages/contracts/src/delivery.ts`,
  [answer delivery](completed/outbound-delivery.md)) and gives only what is its platform's: its
  `ChannelTransport` (split, send one piece with its key, classify a failure), `route`, `text` and
  `policy`. So it requires `agent.submissions` and `storage.kv` (and `wakeups` on `durable`), and the
  engine enqueues to `outbound.queue` when one is installed.
- Acknowledges the webhook only once the message is admitted (P5); Google retries, so it needs
  [inbound dedup](inbound-dedup.md).
- Its transport is `idempotent`: a create with the same `requestId` is dropped by Google
  (`ChannelTransport.idempotent`, `packages/contracts/src/outbound.ts`), so a retried piece is
  effectively once.
- An agent per space is `router-rules` matching the conversation.
- Threads: [threads](threads.md); cards: [rich content](rich-content.md); message patch:
  [streaming replies](streaming-replies.md).
- It needs a public URL: `pikit expose` on a server, a Worker route on Cloudflare.

## Pi first
Nothing in Pi: channels are pikit's (SPEC P1).

## Open questions
- Whether a thread is its own conversation (a value in the channel's config).
- Workspace (domain) restrictions as sender authorization.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `channel-google-chat` | Google Chat app: JWT-verified webhook ingress, REST transport with message create/patch, cards, threads, media. |
