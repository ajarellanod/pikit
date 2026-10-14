# Threads

**Public appeal:** —

**Specified:** partly (the key `<instance>:<conversation id>[:<thread id>]` was decided in the former
SPEC §5; today `ConversationRef.key` is the channel's own opaque address, which a channel with threads
extends. Decided since: no `InboundMessage.threadId` and no `thread` in `router-rules`; a thread is
the channel's, in its key)

**Needed by:** nothing required.

## What it gives
In Slack, Discord, Google Chat and email, a thread can be a conversation of its own, and the answer
lands in the thread it answers. A later reply can quote an earlier answer.

## How it fits pikit
- **No contract change.** The channel builds the key (`AdmitOptions.key`) apart from
  `InboundMessage.conversationId`, and is the only one that reads it back
  ([conversation routing](conversation-routing.md)). A channel with threads keeps `conversationId` the
  chat or space (what routing matches: an agent per space is one `router-rules` rule) and puts the
  thread in the key (`googlechat:spaces/AAA:threads/BBB`) when a thread is its own conversation, a
  value in the channel's config. [Google Chat](channel-google-chat.md) is the first.
- **Why not `InboundMessage.threadId`.** Only the channel interprets a thread: it builds the key, and
  it finds the thread to answer in from the key (or, for a whole-chat conversation, from what it kept of
  the message it answers). A field every other component would carry and none would read is the
  speculative generality the contract rules refuse. It becomes a field when a component that is not
  the channel needs the thread to work (a rule per thread, memory per chat across its threads), added
  with that component.
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
