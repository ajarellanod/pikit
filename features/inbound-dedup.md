# Inbound deduplication

**Public appeal:** —

**Specified:** specified (the design, the former SPEC §5's "Inbound deduplication is not core", is
kept below verbatim; the component's row moved from the former SPEC §18)

**Needed by:** nothing required today. The first webhook channel whose platform retries needs it
(Google Chat). `channel-telegram` by long polling does not: a redelivered update is the same request,
which the conversation recognises as a duplicate.

## What it gives
A platform that redelivers a webhook (a retry, a timeout on its side) gets one message into the
conversation, and a delivery whose first attempt crashed is retried instead of dropped.

## How it fits pikit
- `inbound-dedup` provides `inbound.dedup` (`InboundDedup`: claim, commit, release of platform
  delivery ids) on `storage.sql`. Its suite comes first.
- It claims in the last `inbound.normalize` stage and halts duplicates, commits once the message is
  durably accepted by the conversation, and releases on failure so the retry runs. Claims expire.
- The channel owns the key and the ack rule: acknowledged only after admission.
- Tombstones kept per transport class, as OpenClaw's durable ingress does (prior art, below).
- Absent: no deduplication, no table, no LRU.

## Pi first
Logical deduplication ("was this message answered?") is Pi's submission `requestId`, bridged by the
adapter until `pi-durable` ([pi-durable migration](pi-durable-migration.md)). This is transport
deduplication only; it never decides a duplicate from a record of its own.

## Open questions
- Retention of committed ids per platform (how long a platform may redeliver).
- On Cloudflare, per Durable Object or in the stateless Worker before routing.

## Moved from the former SPEC
The former SPEC §5, verbatim:

Inbound deduplication is **not core**. `[decision]` Platforms redeliver (webhook retries, polling
restarts), and both what identifies a redelivery (Telegram `update_id`, Slack `event_id`) and when
the platform may be acknowledged are channel-specific. A core table with an in-memory fallback would
break absence (MANIFESTO, "If you don't need it, it doesn't exist"), silently stop working after a
restart or hibernation, and — recorded before dispatch — drop the retry of a message whose first
attempt crashed. So:

- The **channel** owns the key (`InboundMessage.id` is the platform's delivery id) and the ack
  rule: a webhook is acknowledged only once the message is durably accepted.
- **`inbound-dedup`** is a component providing `inbound.dedup`, and it covers **transport
  deduplication only**: the platform delivery id and the ack. It claims the id in the last
  `inbound.normalize` stage and halts duplicates (the ingress emits `inbound.rejected
  { reason: "duplicate" }`); it commits once the message is durably accepted by the
  conversation, and releases on failure before that point, so the platform's retry runs
  again. In-flight claims expire, so a crash does not block a conversation forever.
- **Logical deduplication belongs to Pi.** Once a message reaches the conversation, it is
  submitted with `requestId = InboundMessage.id`; Pi deduplicates submissions per
  conversation and tracks each one to its answer (§6.4). pikit does not decide a duplicate
  from a record of its own. `[upstream]` — until Pi's durable runtime ships, the adapter
  hands the message to Pi with its `requestId` inside and finds duplicates in Pi's inbox and
  transcript (§6.1, §6.4). `agent.submissions` (§6.1) records what became of each message, to
  resume and deliver it across processes; it never decides a duplicate.
- The guarantee is **at-least-once**: a crash between effect and commit can repeat a reply.
  Effectful tools stay safe through idempotency keys (§8.4).
- Without `inbound-dedup` there is no deduplication — no table, no LRU, no half-measure.
- The component itself is a feature: `features/inbound-dedup.md`.

Prior art: OpenClaw's durable ingress (`docs/plugins/sdk-channel-plugins/durable-ingress.md`)
reached the same shape: ack after durable append, claim/commit, completion tombstones.

The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `inbound-dedup` | Transport deduplication (§5): claim / commit / release of platform delivery ids, duplicates halted, retries of crashed attempts allowed, stale claims expired. At-least-once by contract. Logical deduplication is Pi's. |
