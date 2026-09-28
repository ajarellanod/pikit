# Inbound deduplication

**Public appeal:** —

**Specified:** specified (the design is SPEC §5, "Inbound deduplication is not core", and stays there;
the component's row moved from SPEC §18)

**Needed by:** nothing required today. The first webhook channel whose platform retries needs it
(ROADMAP M2, "Moved": Google Chat). `channel-telegram` by long polling does not (SPEC §5).

## What it gives
A platform that redelivers a webhook (a retry, a timeout on its side) gets one message into the
conversation, and a delivery whose first attempt crashed is retried instead of dropped.

## How it fits pikit
- `inbound-dedup` provides `inbound.dedup` (`InboundDedup`: claim, commit, release of platform
  delivery ids, SPEC §4.5) on `storage.sql`. Its suite comes first; S10 already names it.
- It claims in the last `inbound.normalize` stage and halts duplicates, commits once the message is
  durably accepted by the conversation, and releases on failure so the retry runs. Claims expire.
- The channel owns the key and the ack rule (SPEC §5): acknowledged only after admission.
- Tombstones kept per transport class, as OpenClaw's durable ingress does (AGENTS.md, references).
- Absent: no deduplication, no table, no LRU (SPEC §5).

## Pi first
Logical deduplication ("was this message answered?") is Pi's submission `requestId`, bridged by
the adapter until `pi-durable` (SPEC §6.4). This is transport deduplication only; it never decides a
duplicate from a record of its own.

## Open questions
- Retention of committed ids per platform (how long a platform may redeliver).
- On Cloudflare, per Durable Object or in the stateless Worker before routing.

## Moved from SPEC
SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `inbound-dedup` | Transport deduplication (§5): claim / commit / release of platform delivery ids, duplicates halted, retries of crashed attempts allowed, stale claims expired. At-least-once by contract. Logical deduplication is Pi's. |
