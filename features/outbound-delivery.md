# Answer delivery: the outbound counterpart of `admitInbound`

**Public appeal:** —

**Specified:** design (this file; nothing built). Origin: the architecture audit's finding 7, as its
verifier corrected it: the two Telegram channels are two delivery models, not one copied protocol,
and a shared helper can be added without breaking them.

**Needed by:** nothing required. It should land before the second chat channel
([Slack](channel-slack.md), [Discord](channel-discord.md), [WhatsApp](channel-whatsapp.md),
[email](channel-email.md), [Google Chat](channel-google-chat.md)), and before the first
`outbound.prepare` stage ([pipeline anchors](pipeline-anchors.md)), which has nowhere to run today.

## What it gives
A chat channel gets durable, at-least-once answer delivery by supplying what is its platform's (which
bot and transport a conversation belongs to, what the user is told) and calling one function per
answer, as it calls `admitInbound` once per message. An `outbound.prepare` stage (redaction, policy,
formatting) runs once, in one place, on every path an answer leaves by: the queue, a direct send,
and an HTTP response.

## What exists today
- **Inbound has a protocol in code.** `admitInbound` (`packages/contracts/src/inbound.ts:100`) runs
  the path after authentication "the same for every producer of messages" and returns an outcome the
  channel acts on; "what is a platform's (authentication, the conversation key, commands, replies)
  stays in the channel" (`inbound.ts:16-20`). Its pipelines land in every channel at once, through
  the kit.
- **Outbound has only vocabulary.** `packages/contracts/src/outbound.ts` exports types, `answerKey`
  (`:30`) and `DeliveryError` (`:78`); the root index says it has "one protocol function
  (`admitInbound`) … No implementation, no policy" (`packages/contracts/src/index.ts:1-5`). Every
  channel turns a run's end into a delivery itself.
- **`channel-telegram` (server)** reads `agent.submissions`' `answers` feed
  (`submissions.ts:100`) with a long-running reader (`channel-telegram/answers.ts:108`): woken by
  events and every 30 s (`:39`), one lane per chat so a stuck chat holds up only itself
  (`:175-192`), a `WINDOW` of 200 answers past a stuck one (`:33`, `:203`), a saved cursor that
  moves only past a contiguous run of delivered answers (`:148-153`), retries after 1 s, 5 s, 30 s,
  60 s, an error from the 3rd failure (`:35-37`, `:155-173`), and a final save at halt (`:247-259`).
  The reader is already channel-neutral: its only channel-specific input is `deliver(answer)`
  (`:89-100`). That callback (`channel-telegram/index.ts:103-120`) enqueues under
  `answerKey(...)` with a queue, or sends directly with `sendOrFail` (`replies.ts:36-43`), which
  resends every piece on a retry, with no marks and a key of its own (`direct:<chat>:<i>`,
  `replies.ts:69`). Without the feed, the same `deliver` is called from `agent.settled` /
  `agent.failed` (`index.ts:127-165`).
- **`channel-telegram-webhook` (Cloudflare object)** runs the wakeup
  `channel-telegram-webhook.deliver` (`delivery.ts:49`) in slices (C4): each run reads from the saved
  cursor (`:207-244`), stops after 20 pieces or when its context is cancelled (`:53`, `:221`), and
  asks for the next run (`:260-276`). One object owns one conversation (C1), so it needs no lanes
  (`:20-23`). Its direct path marks each piece `sending` / `sent` in `storage.kv` (`:167-194`); a
  piece found `sending` goes again as a possible duplicate (`↻ `), a permanent refusal is logged and
  given up (`:181-188`), and the marks are deleted only after the cursor is saved past the answer
  (`:231-235`). With a queue it enqueues, like the server channel (`:158-165`).
- **Identical code in both:** `openCursors` (`answers.ts:59-80`, `delivery.ts:83-101`: key
  `answers-cursor`, the `""` sentinel for "before the first answer", start at the feed's end the
  first time) and `replyText` (`channel-telegram/index.ts:282-287`, `delivery.ts:285-290`, "so a
  chat reads the same on both targets", `:283`). The retry constants are the same values
  (`answers.ts:35-37`, `delivery.ts:55-57`). Everything else differs by target.
- **`channel-http`** returns the answer in the HTTP response, by decision (`channel-http/index.ts:39-45`):
  `outcome()` (`:96`) builds it from the run for the POST (`:191`), a repeated POST (`:182`) and the
  `GET` (`:209`). No `OutboundMessage` exists on that path.
- **`outbound-durable`** stores, splits with the attached transport (`queue.ts:65-72`), sends,
  retries and emits receipts. `enqueue(message)` takes no context (`outbound.ts:101`); the queue runs
  on its own background context (`outbound-durable/index.ts:67-76`).

## How it fits pikit

### What the channel supplies, what the helper owns
| The channel supplies | The helper owns |
|---|---|
| `address(conversationKey)`: the instance (`telegram:ops`) and the `ChannelTransport` of a conversation it made, or `undefined` for another channel's (today `find` / `findBot`, `channel-telegram/index.ts:90-96`, `bot.ts:39-45`) | Naming the answer: `answerKey(conversation, requestId)` (`outbound.ts:30`), the same key on every path and every retry |
| `text(answer)`: what the user is told, in the channel's words, or nothing (today `replyText`) | Running `outbound.prepare`, and refusing a stage that changes which answer or conversation it is (as `inbound.ts:104-108` does for `inbound.normalize`) |
| The transport (`split`, `send`, classifying failures into `DeliveryError`), its timeouts and formatting | The fork: enqueue when `outbound.queue` is installed, else send the pieces directly |
| The schedule: when to read (events, a timer, a wakeup), lanes, slice budgets, typing, commands | Direct sends: piece keys `${answerKey}#${i}`, the `sending` / `sent` marks in a store the channel names, `possibleDuplicate` for a piece found `sending`, deleting the marks once the answer is behind the cursor |
| Where its cursor and marks live (its namespace of `storage.kv`) | The cursor's format and first-open rule, identical to today's (`answers-cursor`, `""`, start at the feed's end) |
| What an outcome means to its user (logging, a message, an HTTP status) | An outcome per answer that says whether the cursor may pass it |

### One helper, or primitives
One helper cannot serve both models without taking a mode: the server reader keeps answers in memory
across calls, with lanes and a window, and the object's run keeps nothing in memory between wakeups
(`delivery.ts:1-5`) and needs a piece budget. A mode is a flag (P4). What the two share is **per
answer** and **per cursor**, not the schedule. So two layers:

1. **Primitives (the protocol, step 1).** Target-free, schedule-free, like `admitInbound`:

   ```ts
   // packages/contracts/src/answers.ts (proposed), exported from the root.
   declare module "@pikit/core" {
     interface AppPipelines {
       /** An answer as it leaves its channel. Stages may rewrite it; they keep idempotencyKey, channel and conversationKey. */
       "outbound.prepare": OutboundMessage;
     }
   }

   /** Runs `outbound.prepare`. Throws when a stage changed which answer or conversation it is. */
   export function prepareOutbound(ctx: AppContext, message: OutboundMessage): Promise<OutboundMessage | Halt>;

   export interface AnswerAddress { channel: string; transport: ChannelTransport }

   export interface DeliverAnswerOptions {
     address(conversationKey: string): AnswerAddress | undefined;
     text(answer: RunSettlement): string | undefined;
     queue: OutboundQueue | undefined;
     /** Without a queue: where pieces are marked `sending` / `sent`. Absent: no marks, best effort. */
     marks?: KeyValueStore;
     /** Without a queue: how many pieces this call may send (C4); the rest is `cut`. */
     budget?: number;
   }

   /** What became of one answer. All but `failed` and `cut` are settled: the cursor may pass them. */
   export type AnswerOutcome =
     | { kind: "not_ours" }                                   // another channel's conversation
     | { kind: "silent" }                                     // `text` said nothing (an aborted run)
     | { kind: "withheld"; stage: string; reason: string }    // an `outbound.prepare` stage halted it
     | { kind: "enqueued"; message: OutboundMessage }
     | { kind: "sent"; message: OutboundMessage; forget(): Promise<void> }  // forget: after the cursor is saved
     | { kind: "refused"; message: OutboundMessage; error: DeliveryError }  // permanent: given up, logged
     | { kind: "failed"; error: unknown; retryAfterMs?: number }            // try again later
     | { kind: "cut" };                                       // the budget or the context ended it

   export function deliverAnswer(ctx: AppContext, answer: RunSettlement, options: DeliverAnswerOptions): Promise<AnswerOutcome>;

   export interface AnswerCursor { get(): Promise<string | undefined>; save(cursor: string): Promise<void> }
   export function openAnswerCursor(store: KeyValueStore, answers: Feed<RunSettlement>): Promise<AnswerCursor>;
   ```

   `deliverAnswer` is today's `deliverOne` (`delivery.ts:152-195`) with `address` and `text` taken
   as parameters and `prepareOutbound` inserted before the fork; `openAnswerCursor` is today's
   `openCursors`, unchanged. `RunSettlement` is a `Pick` of `AgentResult` (`submissions.ts:39`), so
   the events-only path (`channel-telegram/index.ts:127-165`) calls the same function.

2. **Drivers (the schedule, step 2).** The server reader (`answers.ts:108-260`, already neutral)
   and the slice (`delivery.ts:207-244` plus the next-wakeup rule, `:260-276`), each calling
   `deliverAnswer` and treating its outcome. Step 2 moves them into `@pikit/contracts` too, with every
   constant (window, page, retries) an option with today's value as default, when the first new
   channel of each model is built: a contract's shape is "decided with two real parties"
   (`pipeline-anchors.md:23-24`), and today each driver has one. Until then a new channel copies the
   driver of its model, and only the driver, not the per-answer logic.

### Where `outbound.prepare` runs
In `prepareOutbound`, at the one point every path shares: the moment a run's settlement becomes an
`OutboundMessage`, before the fork between enqueue and direct send.
- **Not in `outbound-durable`.** The queue sees only the queue path, and `enqueue` has no context
  (`outbound.ts:101`): a stage would run on the queue's background context, without the caller's.
- **Not in the transport.** `split` and `send` run per piece and per retry, after the text is
  stored (`queue.ts:68`, `delivery.ts:167`).
- **Queue path:** `deliverAnswer` prepares, then enqueues. The stored text is the prepared one; a
  second enqueue after a crash changes nothing (`outbound.ts:98`), so the first prepared version wins.
- **Direct path:** `deliverAnswer` prepares, then splits and sends.
- **HTTP path:** `channel-http` calls `prepareOutbound` in `outcome()` (`channel-http/index.ts:96`)
  for a completed run, with `channel: "http"`, the conversation's key and
  `answerKey(run.conversation, run.requestId)`, and returns the prepared text. `outcome()` then
  becomes async and takes the context and the run's conversation: today it is synchronous and its
  `run` is a `Pick` of `kind`, `text` and `error` only, though each caller holds a whole
  `RunSettlement` or `AgentResult` (`:182`, `:191`, `:209`). It keeps its `[decision]` (no queue,
  no transport) and reuses only the prepare step.
- **Other producers** (a [scheduler](scheduler.md)'s routine answers travel "as any answer does",
  `scheduler.md:26-27`; an [approvals](approvals.md) card) enqueue through `deliverAnswer` or call
  `prepareOutbound` before `enqueue`.
- **A stage runs more than once per answer** (at-least-once): a direct send retried, a `GET` read
  again, a crash before the cursor is saved. The pipeline's doc says a stage returns the same message
  for the same input; a direct send's marks are per piece index, and a stage that answers
  differently each time would make a piece marked `sent` stand for a text never sent.
- Absent (no stage), `ctx.run` returns the message unchanged (`packages/core/src/pipeline.test.ts:72`).

### How the two Telegram channels adopt it
- **Step 1 is additive** to `@pikit/contracts` (0.x, K8): no shape of `OutboundMessage`,
  `ChannelTransport`, `OutboundQueue`, `Feed` or `agent.submissions` changes. A vendored channel,
  edited or not, compiles and behaves as before; it only does not run `outbound.prepare`.
- **Stored state is compatible.** `openAnswerCursor` keeps `answers-cursor` and `""`
  (`delivery.ts:67-69`), and the marks keep `piece:<answerKey>#<i>` = `sending` / `sent`
  (`delivery.ts:70-71`, `:170`). A project that upgrades mid-delivery neither resends history nor
  loses a mark.
- **`channel-telegram-webhook` first**, since its delivery already has the helper's shape:
  `deliverOne` and `forget` become one `deliverAnswer` call; `openCursors` goes; the slice loop,
  "typing…" (`delivery.ts:247-257`) and `kick` stay. `replyText` stays as its `text`. The
  per-send timeout it adds today (`within(TELEGRAM_TIMEOUT_MS, …)`, `delivery.ts:176`) moves into
  its transport. Its tests are the oracle, unchanged (`channel-telegram-webhook.test.ts:515-597`:
  pieces, delivery after no wakeup ran, `↻`, a refused send, the queue).
- **`channel-telegram` second:** `deliver` (`index.ts:103-120`) becomes `deliverAnswer`; the reader
  keeps calling it. Two behavior choices to make with it, each a CHANGELOG line:
  - direct sends get marks when the feed path is on (`storage.kv` is then installed,
    `index.ts:84`): a crash mid-answer resends only the unsent pieces, the one in flight marked `↻`,
    instead of the whole answer unmarked (`replies.ts:36-43`);
  - the address's transport keeps direct sends in the chat's line (`replies.ts:85`), so an answer's
    pieces and the channel's own short replies (commands) do not interleave;
  - a piece's retries: today `sendPiece` tries it 4 times in the process and waits Telegram's
    `retry_after` (`replies.ts:66-77`); `deliverAnswer` tries once and returns `failed` with
    `retryAfterMs`, which the reader's fixed backoff (`answers.ts:155-173`) does not read. Either the
    address's transport keeps retrying, or the reader learns `retryAfterMs`, as the object's does
    (`delivery.ts:141-149`).
- **C6 holds:** the channels still copy client, format and transport, and never import each other
  (`channel-telegram-webhook/index.ts:23-24`); they copy less.
- **P6 holds:** each migration ships as a new component version. A user who edited `answers.ts`,
  `delivery.ts` or `index.ts` gets a three-way merge with `pikit upgrade`
  (`packages/cli/src/commands/upgrade.ts`), with conflicts where they edited. A user who does not
  upgrade keeps a working channel without `outbound.prepare`.

### What the planned channels gain
Each writes `address`, its words and its transport, then picks a driver:

| Channel | Transport per its file | Driver |
|---|---|---|
| Slack | `chat.postMessage`, no idempotency key: a possible duplicate is marked by its transport; `429` `Retry-After` is `rate_limited` (`channel-slack.md:22-23`) | Socket Mode: server reader; Events API: slice on Cloudflare (`:17-21`, `:32`) |
| Discord | REST create, `retry_after`; `idempotent` only if `nonce` proves it (`channel-discord.md:19-20`) | server reader (Gateway, `:17-18`) |
| WhatsApp | no idempotency key, a visible marker (`channel-whatsapp.md:24-25`) | Cloud API on Cloudflare: slice; linked device: server reader (`:19-22`, `:32`) |
| Email | a provider's key makes it `idempotent`, else at-least-once (`channel-email.md:22-23`) | IMAP: server reader; Email Routing: slice (`:15-16`) |
| Google Chat | `idempotent` by `requestId` (`channel-google-chat.md:20-22`), which the helper's stable piece keys feed | slice on Cloudflare, or server reader |

All of them get, without writing it: delivery of answers that ended while the channel was stopped
(K3), the queue-or-direct fork, `answerKey` on every path, `outbound.prepare`, the scheduler's
routine answers, and, when [rich content](rich-content.md) lands, one place to fold the parts a
transport does not `draw` into their fallback before the split (`rich-content.md:64-66`).
[Streaming replies](streaming-replies.md)' previews stay outside it, as that file decides
(`streaming-replies.md:21-23`); the final answer goes through it.

## Trade-offs
- **For:** one place for `outbound.prepare`, as `admitInbound` is for the inbound pipelines; a
  delivery fix reaches every channel that calls the helper through a contracts upgrade instead of a
  three-way merge per copy; a new channel writes its address, its words and its transport, plus a
  driver until step 2; the stored formats do not change.
- **Against:**
  - the delivery protocol leaves the user's source for the kit package: less to edit (P3), the
    same trade `admitInbound` made;
  - `@pikit/contracts` gains its second protocol function, and the root header
    (`index.ts:1-5`) must say so; the drivers of step 2 carry policy constants, which the header
    now excludes. SPEC calls the package "the shared vocabulary" (`SPEC.md:45`) and delivery "a
    capability in `@pikit/contracts` and a component" (`SPEC.md:123`): step 1 stays within that as
    `admitInbound` does, while drivers in the package stretch it. A driver can instead be a
    component providing a capability, which keeps SPEC's wording as it is;
  - a channel copy that predates the helper silently skips `outbound.prepare`: a redaction stage
    would not apply to it;
  - a migrated copy needs a contracts version that has the helper, and nothing checks kit-package
    ranges at `pikit add` today;
  - determinism is a rule a stage must follow, not something the helper can check.

## Pi first
Nothing in Pi: channels and delivery are pikit's (SPEC P1). When the adapter moves to `pi-durable`,
`agent.submissions` may be bridged or deleted (`submissions.ts:21-22`); the helper reads only its
`answers` feed and `RunSettlement`, which is where that change would land.

## Decisions
- **A withheld answer is said, never silent.** When an `outbound.prepare` stage halts an answer, the
  user is told so in a fixed line, in the channel's words (silence reads as a bot that is down), and
  `channel-http` answers with a status of its own, distinct from a success and from a failed run. The
  cursor passes it; it is logged, never pretended delivered (P5).
- **`outbound.prepare`'s value type** is decided with its first real stage (a stage that rewrites a
  failure's words needs the run; a redaction stage needs only the message), per
  [pipeline anchors](pipeline-anchors.md).
- **Drivers (step 2) are copied per channel until a model has its second channel**, then become a
  component that provides a capability (SPEC §3.2's shape for delivery), not code in
  `@pikit/contracts`, whose root header keeps "no policy". Step 1's primitives are vocabulary plus
  one protocol function, as `admitInbound` is.
- **The words stay in each channel** (today's `replyText`): what a user is told is the project's to
  edit (P3), so `@pikit/contracts` gets no user-facing text.
- **`pikit doctor` notes a channel that skips the pipeline**: one that reads `agent.submissions`
  without the helper while an `outbound.prepare` stage is installed. A redaction stage that a copy
  silently skips is a leak, which a README line would not prevent.

## Open questions
- **Rich content with the queue:** the queue stores text split by the transport (`queue.ts:68`); once
  `parts` exist, the fold happens before `enqueue` or the queue stores parts too. Decided with
  [rich content](rich-content.md).
