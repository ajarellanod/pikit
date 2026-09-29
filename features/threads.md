# Threads

**Public appeal:** —

**Specified:** partly (the key `<instance>:<conversation id>[:<thread id>]` was decided in the former
SPEC §5, and `ConversationRef.key` documents its thread part; `InboundMessage.threadId` and
`router-rules`' `thread` are `[planned]`)

**Needed by:** nothing required.

## What it gives
In Slack, Discord, Google Chat and email, a thread can be a conversation of its own, and the answer
lands in the thread it answers. A later reply can quote an earlier answer.

## How it fits pikit
- `InboundMessage.threadId` arrives with the first channel that produces it, and the key gains the
  thread. Whether a thread is its own conversation is a value in the channel's config.
- `router-rules` accepts `thread` in a rule once `threadId` exists; until then a rule naming it is
  invalid config.
- Replies find their thread from `conversationKey`; the receipts of `outbound.queue` say which
  message and thread an answer landed in (`DeliveryReceipt`, `packages/contracts/src/outbound.ts`),
  so a reply can quote or thread against it with `replyTo`.
- Absent: one conversation per chat, as today.

## Pi first
A platform thread is not a Pi fork: one pikit conversation is one Pi session, and Pi's forks are
transcript scopes inside it. Whether a thread should start as a fork of its channel's
conversation, sharing context, is open.

## Open questions
- Thread as a Pi fork of the channel conversation, or a fresh session.
- Channels: [Slack](channel-slack.md), [Discord](channel-discord.md),
  [Google Chat](channel-google-chat.md), [email](channel-email.md).

## Moved from the former SPEC
The former SPEC §18, "Higher-level components". `outbound-durable` is built (its README);
what it did not build is quoting and threading against its records:

| Component | What it encodes |
|---|---|
| `outbound-durable` | Outbound intents persisted before send, retried with backoff, dead-lettered, and recorded so later replies can quote or thread against them (its `receipts`, §5). |
