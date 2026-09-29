# WhatsApp channel

**Public appeal:** ⭐ The chat app most people already have open. OpenClaw and Hermes both talk over
WhatsApp.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
Talk to an agent from WhatsApp, in private chats first.

## How it fits pikit
- `channel-whatsapp`: authenticates its platform its own way, builds the `InboundMessage` and the
  key (`whatsapp:<chat>`), calls `admitInbound`, answers every outcome, and passes
  `createChannelConformance` (`@pikit/contracts/testing`). It attaches its `ChannelTransport` to
  `outbound.queue` when installed. Its own `configure` step checks the credentials.
- Two ways in, to choose:
  - the **WhatsApp Business Cloud API**: official, signed webhooks (so a public URL, `pikit expose`
    and [inbound dedup](inbound-dedup.md)), and outside a 24-hour window only template messages;
  - the **linked-device (WhatsApp Web) protocol**, through a library: a personal number, no public
    URL, but unofficial, a long-lived socket (server only) and a terms-of-service risk.
- Senders are authorized, as `channel-telegram` does with its allowlist, or by [pairing](pairing.md).
- Sends have no idempotency key: at-least-once with a visible marker, as Telegram
  (`outbound-durable`'s README).
- Media and voice notes: [rich content](rich-content.md), [voice](voice.md).

## Pi first
Nothing in Pi: channels are what one Pi process cannot give itself (SPEC P1).

## Open questions
- Which API first. On Cloudflare only the Cloud API fits (no long-lived socket in a Worker).
- The 24-hour window against [scheduled](scheduler.md) messages.
- Groups: mention rules, as for Telegram groups.
