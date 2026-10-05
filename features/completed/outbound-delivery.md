# Answer delivery: the outbound counterpart of `admitInbound`

**Public appeal:** —

**Specified:** built (`startAnswerDelivery`, `packages/contracts/src/delivery.ts`; the channel
suite's durability cases, `packages/contracts/src/testing/channel.ts`). Origin: the architecture
audit's finding 7, and the audit of "durability for free" (MANIFESTO principle 13): every channel
rewrote the same delivery engine, the channel suite tested none of it.

**Needed by:** every chat channel ([Slack](../channel-slack.md), [Discord](../channel-discord.md),
[WhatsApp](../channel-whatsapp.md), [email](../channel-email.md), [Google Chat](../channel-google-chat.md)),
and the first `outbound.prepare` stage ([pipeline anchors](../pipeline-anchors.md)), which now has one
place to run.

## What it gives
A chat channel gets durable, at-least-once answer delivery by supplying only what is its platform's
and calling one function in its `start`, as it calls `admitInbound` once per message. The channel
conformance suite then proves it: an answer that ends while the channel is stopped, or whose event is
lost, reaches its sender once; a failed send is retried and its conversation's later answers wait; a
send cut mid-flight goes again at most once, marked or under the same key; one conversation's
failures hold up no other.

## What a channel writes
Its inbound path (`admitInbound`, unchanged), and for its answers:

```ts
// In start, once its transports work.
const answers = await startAnswerDelivery(ctx, {
  name: "channel-whatsapp",                                   // its wakeup and log lines
  answers: pikit.use("agent.submissions").get().answers,       // every run's end (K3)
  store: pikit.use("storage.kv").get().namespace("channel-whatsapp"), // its cursor and marks
  transports: new Map([["whatsapp", transport]]),             // by instance: split, send(piece, signal), DeliveryError
  route: (conversationKey) => (conversationKey.startsWith("whatsapp:") ? "whatsapp" : undefined),
  text: replyText,                                            // its words, or undefined to say nothing
  queue: pikit.useOptional("outbound.queue").get(),           // enqueue when installed
  wakeups: pikit.use("wakeups").get(),                        // on `durable`; omit on `server` (a timer)
  policy: { retryMs: [1_000, 5_000, 30_000, 60_000], blockedAfter: 3, window: 200, piecesPerRun: 20, sendTimeoutMs: 30_000 },
});
pikit.on("agent.settled", (_, ctx) => answers.wake(ctx));    // and "agent.failed": a run ended, read now
// In stop:
await answers.stop(ctx.abortSignal);
```

What it gets, the same on both targets: reading the `answers` feed from its own cursor (at start, on
every wake, when a retry comes due), one ordered lane per conversation running beside the others,
retries with the channel's waits (a `rate_limited` waits what the platform asked and is no failure; a
`permanent` refusal is logged and given up), idempotency keys (`answerKey(conversation, requestId)`,
pieces `${key}#${index}`), the queue-or-direct fork with the transports attached to the queue while it
runs, slices on a Durable Object (a run stops at its context's deadline or after `piecesPerRun`
sends, and asks for the next), and a timer in the process on a server.

Lines of delivery code per channel, before and after:

| Channel | Before | After |
|---|---|---|
| `channel-telegram` | `answers.ts` 260, plus about 90 in `index.ts` and `replies.ts` (`deliver`, the events-only fallback, `sendOrFail`) | about 25 in `index.ts`: the call (13), `DELIVERY`, the wake on a run's end, the stop, `replyText` (7) |
| `channel-telegram-webhook` | `delivery.ts` 290 (its "typing…" and `replyText` included) | about 25 in `index.ts`, the same parts; "typing…" is its own wakeup (`typing.ts`, 50) |
| `channel-http` | none, by decision (its answer is the HTTP response) | unchanged |

## Decisions
- **A protocol function in `@pikit/contracts`, with the policy passed in.** The correctness-critical
  loop (the cursor that never passes an undelivered answer, the marks, the keys, the order of writes,
  lanes, slices) is written and tested once, in the kit package, and reaches every channel by a
  contracts upgrade instead of a three-way merge per copy, as `admitInbound` does for the inbound
  path. What a user may want to change stays in the channel's own source: the words (`text`), the
  addressing (`route`), the transport, and every wait and budget (`policy` has no defaults in the
  package, so the values are where the user reads them). A component providing a delivery capability
  was the other way: its source would be the user's too, but it needs a new capability and catalogue
  entry, every channel would require it, and one copy of a correctness-critical loop per project
  invites edits that break at-least-once with nothing but the suite to say so. The earlier draft of
  this note split it into per-answer primitives plus a driver per runtime model; one loop over
  `wakeups` (or a timer where none is installed) serves both models, so there is no mode and no
  second driver.
- **No transaction spans the cursor and the queue; each step is idempotent, in order.** The cursor is
  in the channel's `storage.kv`, the queue's records in `storage.sql` behind another component's
  contract, and a platform has no transaction at all. So: (1) enqueue under the answer's key, or mark
  each piece `sending`, send, mark `sent`; (2) mark the answer done (`answer:<key>`); (3) save the
  cursor past the answers done in a row, then delete their marks. A crash between any two repeats only
  an idempotent step: an enqueue the queue absorbs, a done answer skipped, a piece marked `sent` never
  sent again. The at-least-once window is exactly one piece whose send was cut (a crash, a stop, a
  slice's deadline, a timeout): it goes again once, with `possibleDuplicate` and the same key. A crash
  between the cursor's save and the deletes leaves a few marks behind, never a second send.
  `Feed`'s doc (`feed.ts`) states both ways a reader may save its cursor, this one included.
- **No "start at the feed's end".** A channel opened for the first time reads from the feed's oldest
  answer: pikit is unreleased, and there is no older delivery path whose answers it could resend.
- **Channels require `agent.submissions`, `storage.kv` (and `wakeups` on `durable`).** The events-only
  path, which lost an answer that ended while the channel was stopped, is gone: durability is not an
  option a channel may lack.
- **The words stay in each channel** (`replyText`): what a user is told is the project's to edit (P3).
- **"typing…" is not delivery.** It stays in the channel (an interval on a server, its own wakeup on a
  Durable Object), so a channel without it writes nothing.
- **`channel-http` keeps its answer in the response.** It has no transport to push to; its durability
  is the runtime's record: a client that sends the same message again (or `GET`s it) gets the outcome
  of a run that ended while the channel was stopped. The suite runs on it with
  `answers: "in-response"`, which skips only the cases about a platform's sends.

## The conformance suite
`createChannelConformance` provides what a real deployment does, durable across the restarts of a
case: `agent.runtime` and `conversations.registry` fakes, `agent.submissions` (its `answers` feed
written before the run's events, as runtime-pi does), `storage.kv` and `wakeups` in memory. A channel
whose answers are pushed gives the suite its `platform` (`fail(conversation, count)`,
`hang(conversation)`, `received(conversation)`). The durability cases, every channel's to pass:
1. an answer that ends while the channel is stopped reaches its sender once it runs again, once;
2. a run's end whose event was lost reaches its sender once after a restart;
3. a send the platform fails is tried again, and the conversation's later answers wait (order);
4. a send cut after it left goes again at most once, as a possible duplicate or under the same key;
5. a conversation whose sends keep failing holds up no other.

The engine's own tests (`packages/contracts/src/delivery.test.ts`) cover the rest: a cursor past
others' answers and silent runs, marks deleted once passed, timeouts, rate limits, permanent refusals,
an answer delivered past a stuck one not resent after a restart, the queue path, gaps, storage
failures, and runs as wakeups cut by budget and by the slice's deadline.

## Not built yet
- **`outbound.prepare`** (redaction, policy, formatting): it belongs in `startAnswerDelivery`, after
  `text` and before the fork, where every pushed answer passes; `channel-http` would call the same
  stage on its response. Its value type is decided with its first real stage
  ([pipeline anchors](../pipeline-anchors.md)). A stage must answer the same for the same input: a piece
  marked `sent` must stand for the text a retry would send.
- **Answers and the channel's own replies share no line.** A command's reply can go out between two
  pieces of an answer (rare: a run takes longer than a command). A channel that needs them ordered
  sends its replies through the same transport and lane, which the engine does not expose yet.

## Pi first
Nothing in Pi: channels and delivery are pikit's (SPEC P1). It reads only `agent.submissions`'
`answers` feed and `RunSettlement`, which is where a change of the runtime's records would land.

## Open questions
- **Rich content with the queue:** the queue stores text split by the transport; once `parts` exist,
  the fold happens before `enqueue` or the queue stores parts too. Decided with
  [rich content](../rich-content.md).
- **A stuck answer forever.** On the direct path a transient failure is retried every minute with no
  end, logged as an error from `blockedAfter` on; the queue gives a piece up only once it is older
  than its maximum age (24 hours for `outbound-durable`), with `outbound.abandoned` and a receipt
  (`delivery.ts`, "Direct or queued"). Whether the direct path gives up too, and how either tells the
  user, is open.
