# One message, end to end

A Telegram message on a server (`channel-telegram`, long polling), the same on Cloudflare
(`channel-telegram-webhook`), and the HTTP channel's variant. Paths are under `registry/components/`
unless they start with `packages/`.

## The shape of it

```
platform → channel ─ admitInbound ─────────────────────────────→ agent.runtime.dispatch
                     inbound.normalize → route.resolve → conversations.registry.resolve
                                                                         │ durable: ack the platform
runtime runs the agent (pi-durable) ── run ends ─→ answers feed row, then agent.settled / agent.failed
                                                                         │ the event wakes
channel's startAnswerDelivery ── reads the feed from its cursor ─→ transport.send  (or outbound.queue)
```

Two rules hold at every step: the platform is acknowledged only once the message is durable in its
conversation, and an answer is read from a feed with a cursor, never only from an event.

## On a server (`channel-telegram`)

One App, one process. A typical project has `storage-sqlite`, `storage-kv-sql`, `conversations-kv`,
`router-basic`, `runtime-pi`, a provider, and `outbound-durable` with `wakeups-timers` (offered with
the channel).

1. **Receive.** `channel-telegram/files/src/pikit/channel-telegram/poller.ts` long-polls
   `getUpdates` for each bot and hands each update to `handleUpdate` (`inbound.ts`). The poll's offset
   moves past an update only once it was handled: a crash means Telegram delivers it again. An update
   whose admission keeps failing is retried (0.5 s doubling, up to a minute apart) and given up after
   15 minutes, its sender told.
2. **Channel checks.** `inbound.ts`: private chats only; the sender must be in
   `TELEGRAM_ALLOWED_USERS` (a stranger is told their id once); `/start`, `/help`, `/new` are answered
   by the channel (`/new` is `conversations.registry.reset`; a redelivered command runs once, its
   message id kept in `storage.kv`).
3. **Admit.** `admitInbound` ([packages/contracts/src/inbound.ts](../packages/contracts/src/inbound.ts))
   with an `InboundMessage` whose `id` is `<instance>:<chat id>:<message id>` and the key
   `<instance>:<chat id>` (`telegram:123`, or `telegram:ops:123` for a second bot):
   - `inbound.normalize` (no stage in the registry), then `route.resolve` (router-rules at 1,
     router-basic at 0): an agent, or `halted` / `denied` / `no_route`, which the chat is told.
   - `conversations.resolve(key, agent)` (`conversations-kv/.../index.ts`): the key's pointer in
     `storage.kv`, or on the first message a new conversation from `agent.conversations` (runtime-pi)
     and the pointer written with `setIfAbsent`.
   - `runtime.dispatch({ requestId, conversation, prompt })`.
4. **Dispatch.** runtime-pi (`runtime-pi/files/src/pikit/runtime-pi/index.ts`) calls the adapter
   (`packages/pi-adapter/src/runtime.ts`), which hands the message to pi-durable. It resolves when the
   message is committed: `started` (idle), `queued` (a run is going; the next run takes it with the
   others), or `duplicate` (the same request id is already in the conversation: Telegram delivered it
   twice). This is the inbound deduplication. `agent.dispatched` is emitted, and `agent.started` for a
   new run (channel-telegram shows "typing…").
5. **Ack.** `handleUpdate` resolves, and the poller moves its offset.
6. **Run.** pi-durable runs the agent: the definition's `prepare(state)`, its model
   (`model.provider`), its tools (`agent.tool`) on `execution` or `workspace`, its extensions. Every
   step is checkpointed in `storage.sql` (pi-durable's tables). With a `wakeups` provider installed,
   runtime-pi drives runs inside the wakeup `runtime-pi.drive`; without, runs are promises of the
   process.
7. **Settle.** When the run ends, the adapter appends one row to the answers log
   (`runtime_pi_answers`, [packages/pi-adapter/src/answers.ts](../packages/pi-adapter/src/answers.ts)),
   then emits `agent.settled` or `agent.failed`. The row is `agent.submissions.answers`' next fact.
8. **Wake.** channel-telegram's listener stops "typing…" and calls `answers.wake(ctx)`.
9. **Deliver.** `startAnswerDelivery`
   ([packages/contracts/src/delivery.ts](../packages/contracts/src/delivery.ts)), started in the
   channel's `start`, runs a pass (driven by a timer in the process: channel-telegram passes no
   `wakeups`):
   - reads up to `window` (200) answers after its cursor (`answers-cursor` in the channel's `storage.kv`
     namespace);
   - skips a run every request of which is the dashboard's, another channel's conversation, or one with
     nothing to say (`replyText` in `index.ts`: the answer, a failure note, or nothing for an aborted run);
   - groups by conversation: each conversation is a lane, in feed order; lanes run at the same time;
   - **with `outbound.queue`** (outbound-durable): `enqueue({ idempotencyKey: answerKey(...), channel,
     conversationKey, text })`, then the mark `answer:<key>`. outbound-durable
     (`outbound-durable/files/src/pikit/outbound-durable/queue.ts`, `store.ts`) splits it into pieces in
     one transaction, wakes its `outbound-durable` wakeup, sends each conversation's pieces in order
     through the transport the channel attached, retries (5 s, 30 s, 2 min, then every 10 min), gives up
     on a permanent error or after 24 h, and writes a receipt per settled piece;
   - **without**: for each piece, mark `piece:<key>#<i>` = `sending`, `transport.send` with key
     `<key>#<i>`, mark `sent`; then `answer:<key>`. A failure retries the lane after `retryMs` (1 s, 5 s,
     30 s, then 60 s) and holds that conversation's later answers; a `permanent` refusal is logged and
     given up;
   - moves the cursor past the answers delivered in a row from it, then deletes their marks.
10. **Platform.** `transport.ts` sends a piece with `sendMessage`, Markdown converted, split at 4096
    characters. A piece resent after a cut send starts with `↻ `.

### channel-http instead

`channel-http/files/src/pikit/channel-http/index.ts`. `POST /v1/messages` runs `http.authenticate`,
builds the `InboundMessage` (`id` = the client's `messageId` or a new UUID, key `http:<conversationId>`),
calls `admitInbound` with `beforeDispatch` registering a waiter, then waits up to `replyTimeoutMs`
(120 s) for `agent.settled` / `agent.failed` naming its request id: `200 { requestId, text }`, or
`202` if not in time. The answer is in the HTTP response; there is no transport and no feed reader. A
repeated `messageId` answers from `agent.submissions.get`, and `GET
/v1/conversations/:id/messages/:messageId` reads it later. server-bun
(`server-bun/files/src/pikit/server-bun/index.ts`) serves the routes.

## On Cloudflare (`channel-telegram-webhook`)

Two Apps (C1). The Worker's App has `secrets-cloudflare`, `platform-cloudflare` and
`channel-telegram-webhook-worker`; each conversation's Durable Object runs the rest
(`storage-do`, `storage-kv-sql`, `conversations-kv`, `router-basic`, `runtime-pi`,
`channel-telegram-webhook`, `execution-do`, tools, and outbound-durable if offered).

1. **Receive (Worker).** Telegram posts to `POST /telegram`. deployment-cloudflare's Worker host
   (`deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts`) starts the Worker's App on
   the isolate's first request and picks the route. `channel-telegram-webhook/.../worker.ts` checks the
   `X-Telegram-Bot-Api-Secret-Token` header (`401` otherwise), keeps private text messages, checks the
   allowed users (a stranger is told, or sent as `telegram.stranger` when the bot takes logins).
2. **Hand to the actor.** `actor.mailbox.send("telegram:<chat>", "telegram.update", update, ctx)`.
   platform-cloudflare (`platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts`) makes it
   an RPC: `env.CONVERSATION.get(env.CONVERSATION.idFromName(key)).deliver(type, key, message)`.
3. **The object starts.** The `Conversation` class (`deployment-cloudflare/.../entrypoint.ts`, logic in
   `host.ts`) composes `pikit.config.ts`'s default export on its first event, inside
   `blockConcurrencyWhile` (20 s start deadline), with `WORKERS_HOST.object` on the start context. Its
   `deliver` calls the handler platform-cloudflare registered with `onDeliver`, which calls the
   `actor.inbox` handler for `telegram.update`.
4. **Admit (object).** channel-telegram-webhook's handler (`index.ts`, `inbox.ts`) checks the update
   is for this chat, answers `/start`, `/help`, `/new`, `/login` itself, and otherwise calls
   `admitInbound` exactly as on a server (same request id and key, so a redelivery is `duplicate`).
   `conversations-kv` keeps its pointer in `storage-kv-sql` over `storage-do` (the object's SQLite).
5. **Dispatch.** runtime-pi, with `wakeups` from platform-cloudflare, asks for the wakeup
   `runtime-pi.drive` before `dispatch` resolves, so a run is never left without something to drive it.
   The handler then kicks "typing…" (`channel-telegram-webhook.typing`) and wakes delivery.
6. **Ack.** The handler resolves, the RPC resolves, the Worker answers Telegram `200`. If anything
   rejected, the Worker answers `500` and Telegram delivers again.
7. **Run, in slices.** The object's alarm fires. platform-cloudflare runs one slice (`sliceMs`, 60 s):
   every due wakeup starts, one run per name. `runtime-pi.drive` opens pi-durable if this instance has
   not (after an eviction), resumes what is pending, and waits for the run until it ends or the slice
   deadline cancels its context; then it asks again. A wait for a time only (a model retry) suspends
   pi-durable so the object can be evicted until then. Each model call or fetch is a subrequest.
8. **Settle.** As on a server: the answers row in the object's SQL, then `agent.settled`.
9. **Deliver.** channel-telegram-webhook's listener calls `delivery.wake`, which asks for the wakeup
   `channel-telegram-webhook.answers` now; platform-cloudflare starts it in the same slice.
   `startAnswerDelivery` (given `wakeups`) runs the same pass as on a server, at most `piecesPerRun`
   (20) sends per run, stopping at the slice deadline and asking again. The cursor and marks live in
   the object's `storage.kv`: each object delivers its own conversation.
10. **Platform.** The transport sends to Telegram (a subrequest per piece).

What survives an eviction at any point: the message (committed in step 5), the run (checkpointed), the
wakeup rows (`platform_cloudflare_wakeups`), the answers row, the cursor and marks. The next alarm or
message starts a new App and continues.

## What a crash costs

| Cut between | What happens next |
|---|---|
| receiving and `dispatch` committing | the platform was not acknowledged: it delivers again |
| `dispatch` committing and the ack | the platform delivers again; `dispatch` returns `duplicate`, nothing runs twice |
| a run's steps | the run resumes from its checkpoints; an interrupted `safe` tool call runs again, an `unsafe` one gives the model an interrupted result |
| the run's end and its answers row | the next reconciliation (start, a redelivery, a resume) logs and announces it |
| the answers row and `agent.settled` | the event is lost; delivery reads the row at its next pass (start, a wake, a retry) |
| a send leaving and its `sent` mark | the piece goes again once, as a possible duplicate, under the same key |
| `answer:<key>` and the cursor | the answer is skipped by its mark; marks are cleaned later |
| enqueue and `answer:<key>` (queued) | enqueued again under the same key: stored once |

Messages nothing can answer (their agent was removed, or still pending after
`abandonPendingAfterHours`, 72 h) are abandoned: settled `failed` with code `abandoned`, and the chat
asks the user to send again.

The guarantee is at-least-once delivery of every admitted message's answer. The header of
[delivery.ts](../packages/contracts/src/delivery.ts) states the direct and queued paths precisely.
