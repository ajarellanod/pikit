# Google Chat channel

**Public appeal:** — (OpenClaw has it; it is not what draws the public)

**Specified:** partly (moved from SPEC §18; keys and idempotency decided in SPEC §5)

**Needed by:** nothing required. ROADMAP M2 ("Moved") places it after M1.5 as the first webhook
channel, bringing [inbound dedup](inbound-dedup.md) and `pikit expose` with it.

## What it gives
A Google Chat app: an agent per space, answering in the space's threads, with cards.

## How it fits pikit
- `channel-google-chat`: verifies the webhook's JWT, builds the key
  (`googlechat:spaces/AAA:threads/BBB`, SPEC §5), calls `admitInbound`, answers every outcome, and
  passes `createChannelConformance` (SPEC §5, §14). Several apps are instances.
- Acknowledges the webhook only once the message is admitted (rule 7); Google retries, so it needs
  [inbound dedup](inbound-dedup.md).
- Its transport is `idempotent`: a create with the same `requestId` is dropped by Google (SPEC §5
  names it as the idempotent case), so a retried piece is effectively once.
- An agent per space is `router-rules` matching the conversation (SPEC §5).
- Threads: [threads](threads.md); cards: [rich content](rich-content.md); message patch:
  [streaming replies](streaming-replies.md).
- It needs a public URL: `pikit expose` on a server, a Worker route on Cloudflare.

## Pi first
Nothing in Pi: channels are pikit's (SPEC §6.2 table).

## Open questions
- Whether a thread is its own conversation (a value in the channel's config, SPEC §5).
- Workspace (domain) restrictions as sender authorization.

## Moved from SPEC
SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `channel-google-chat` | Google Chat app: JWT-verified webhook ingress, REST transport with message create/patch, cards, threads, media. |
