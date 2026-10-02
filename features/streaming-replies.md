# Streaming replies

**Public appeal:** ⭐ The answer appears as it is written instead of after a silent minute: what
users of ChatGPT-style apps expect, and what gateway agents offer in chats that allow editing.

**Specified:** partly (moved from the former SPEC §16)

**Needed by:** nothing required. The dashboard's live view streams `agent.*` events over its own
stream (SPEC §5), which is not this.

## What it gives
In a chat that can edit messages (Telegram, Slack, Discord, Google Chat), a preview message is
posted and edited as the model writes, then replaced by the final answer.

## How it fits pikit
- An optional `edit` on `ChannelTransport` (additive to an `experimental` contract), declared as
  transports declare `draws` ([rich content](rich-content.md)): a transport without it gets no
  preview, and no flag says so.
- A component (the `stream-to-edit` of the moved text; `outbound-stream` fits the naming table)
  listens to the runtime's message updates and edits the preview, throttled per platform.
- Previews never go through the outbox: "losing one costs nothing" (the former SPEC §5). The final
  answer is still the outbox's, keyed by `answerKey`: it edits the preview into the answer, or sends
  it and deletes the preview, and the receipt says which message holds it.
- On Cloudflare, the dashboard's live updates use the Durable Object's hibernating WebSocket
  (SPEC §5).
- Absent: "typing…", then the answer, as today.

## Pi first
Pi streams: `message_update` events carry the deltas (pi-agent-core 0.99.0's `AgentHarness` emits them,
and the adapter forwards them to extensions), and Pi 0.99.0 adds `provider_stream_event` to its
extension API and `onProviderStreamEvent` to pi-agent-core and pi-ai, for the provider's parsed events
before normalization. pikit forwards what Pi emits; it builds no streaming of model calls. The adapter
needs to re-emit message updates as an `agent.*` event, which today it does not. With the move to
`pi-durable` ([pi-durable migration](pi-durable-migration.md)), `AgentHarness` is gone: pi-durable
commits the partial answer to the conversation's live state (`pi.live`) as it streams, throttled,
which a preview can read (a conversation's `watch()`).

## Open questions
- Edit rate limits (Telegram allows about one edit per second per chat) and long answers split
  into pieces.
- Telegram's newer draft-message API, if it exists for bots in the pinned API, instead of edits.
- Whether the final answer edits the preview (one message) or replaces it (a clean notification).

## Moved from the former SPEC
The former SPEC §16, "Open questions":

- Streaming to channels that support message editing (Telegram, Google Chat): a
  `channel.transport` optional `edit()` + a `stream-to-edit` component, or core support.
