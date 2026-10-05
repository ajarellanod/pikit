# Email channel

**Public appeal:** ⭐ Write to your agent as you would to a person, and forward it things. Hermes'
gateway talks over email.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
An address for the agent: an email starts or continues a conversation, and the answer is a reply in
the same thread.

## How it fits pikit
- `channel-email`: receives by IMAP polling (server, no public URL) or a provider's inbound webhook
  (on Cloudflare, Email Routing hands a message to a Worker). It builds the key from the thread
  (`Message-ID`, `In-Reply-To`, `References`), calls `admitInbound`, and passes
  `createChannelConformance` (`@pikit/contracts/testing`).
- Answers: it calls `startAnswerDelivery` in its `start` (`packages/contracts/src/delivery.ts`,
  [answer delivery](completed/outbound-delivery.md)) and gives only what is its platform's: its
  `ChannelTransport` (split, send one piece with its key, classify a failure), `route`, `text` and
  `policy`. So it requires `agent.submissions` and `storage.kv` (and `wakeups` on `durable`), and the
  engine enqueues to `outbound.queue` when one is installed.
- `Message-ID` is the delivery id; a redelivered message is a duplicate by request id.
- `From` can be forged: senders are authorized by an allowlist plus the receiving server's SPF,
  DKIM and DMARC results, never by `From` alone.
- Sends by SMTP or a provider's API; a provider's idempotency key makes the transport `idempotent`,
  otherwise at-least-once. Replies keep the thread headers ([threads](threads.md)).
- Attachments: [rich content](rich-content.md).

## Pi first
Nothing in Pi: channels are pikit's (SPEC P1).

## Open questions
- HTML to text, and stripping quoted history before it reaches the model.
- Sending from Cloudflare: which service, and its limits.
- One conversation per thread or per sender.
