# tool-notify: an agent sends a message to a chat the operator named

**Public appeal:** — (a team of agents that speaks up where the team is: the `developer` announces
its pull request in the Telegram "ops" group, a routine posts its daily summary to a Google Chat or
Slack space, a scheduled job that went wrong tells the team chat)

**Specified:** yes (design), not built (owner's decision, 2026-10-20).

**Needed by:** nothing required. It fills [team agents](team-agents.md)' row "An agent writes to
another chat". Builds on `outbound.queue` (`outbound-durable`) and `actor.mailbox` / `actor.inbox`;
runs on `server` and `durable` (celld, Cloudflare).

## What it gives
Today an agent answers only in its own conversation: its run's answer goes back through the channel
that owns its key (`startAnswerDelivery`, `packages/contracts/src/delivery.ts`). `tool-notify` adds
one tool, `notify({ to, text })`, that **sends** a message to a chat the operator configured, by
name:

```ts
"tool-notify": {
  destinations: {
    ops: {
      channel: "telegram:ops",                 // the channel instance whose transport sends it
      conversation: "telegram:ops:-100123",    // the chat, as that channel keys it
      description: "The operations group: deploys, pull requests, incidents.",
      from: ["developer", "orchestrator"],     // optional: who may send here (tool-delegate's rule)
    },
    team: {
      channel: "googlechat",
      conversation: "googlechat:spaces/AAAA1234",
      description: "The team's space: daily summaries.",
      maxPerHour: 4,
    },
  },
  maxPerHour: 30,                              // per destination, unless it says otherwise
}
```

and the agents that may use it name the tool (`defineAgent({ ..., tools: ["notify"] })`).

It is **send-only**. The sending agent never reads the destination's conversation, never enters it,
and never gets a reply from it: the tool returns once the message is stored for delivery, and
nothing comes back. Nothing here lets one session read another.

## Decisions
1. **A name, never an address.** `to` is a union of the configured names (as `delegate`'s `agent`
   is, `registry/components/tool-delegate/files/src/pikit/tool-delegate/index.ts`), and the tool's
   description lists each destination with its `description` and `(only from: ...)`. The model cannot
   write a chat id, a key or a channel: a destination the config does not name does not exist.
2. **A destination is a channel instance and a conversation key, both written out.** An
   `OutboundMessage` needs both (`channel`, `conversationKey`, `packages/contracts/src/outbound.ts`),
   and a key is read back only by the channel that made it ("only the channel that made the key reads
   it", same file): tool-notify never parses a key to find its channel. The pair is checked when a
   message is enqueued: `enqueue` rejects when no transport is attached for the channel
   (`registry/components/outbound-durable/files/src/pikit/outbound-durable/queue.ts`, `enqueue`), and
   the model reads why; nothing is stored. A check at start would need channels to list their
   instances, which no contract does (open below).
3. **Who may send: `from`, tool-delegate's rule.** A destination with `from` takes a message only when
   the calling conversation's agent **and every agent above it** in its delegation, up to the
   conversation a person or a channel started, are in `from`: an allowed `orchestrator` does not
   launder a `support` agent's task into the ops group. The chain is never the model's: it is
   tool-delegate's `callersOf` (`index.ts`), read from the `delegate:` key only tool-delegate writes,
   its first agent checked against the origin the runtime fixed (`originOf`). A chain that cannot be
   trusted reaches no destination with `from` (fail closed); a destination without `from` takes any
   agent that names `notify`. Components never import each other (SPEC P4, C6), so the chain's
   reading becomes one file (`callers.ts`: `chainOf`, `depthOf`, `callersOf`) that is the same in
   tool-delegate and tool-notify, kept identical by a repository twins test, as
   `registry/components/channel-telegram-webhook/twins.test.ts` keeps channel-telegram's
   `transport.ts`. tool-delegate's README ("nothing else parses them") then names its twin.
4. **The idempotency key is the call's:** `answerKey(conversation, "tool-notify:" + api.callId)`, so
   `<calling conversation id>:tool-notify:<call id>` (`api.callId` is stable across a replay, as
   tool-schedule's job ids use it). Replay is `safe`: a call run again after a crash enqueues the same
   key, and the queue stores it once ("The same `idempotencyKey` again changes nothing",
   `OutboundQueue.enqueue`). The shape is an answer key's on purpose: the dashboard's Delivery reads
   the conversation before the first `:` (`conversationOfAnswer`,
   `registry/components/admin-api/files/src/pikit/admin-api/routes.ts`), so a notification stuck or
   given up opens the conversation that sent it; and an idempotent transport derives the platform's
   ids from the piece's key (Google Chat's `requestId` and `messageId`,
   `registry/components/channel-google-chat/files/src/pikit/channel-google-chat/ids.ts`).
5. **Enqueued by the destination's actor, not the caller's.** The tool asks the actor that owns the
   destination's key: `actor.mailbox.call(conversation, "tool-notify.enqueue", { idempotencyKey,
   channel, text, from })`, answered by tool-notify's own `actor.inbox` handler (`answer`), which checks
   the rate limit and calls `outbound.queue.enqueue` in the App that owns that key. Why: SPEC C1 keeps
   "events, feeds and the outbox ... local to the object that owns the conversation". One outbox per
   chat keeps one lane per chat (the queue orders a conversation's pieces, and a retry holds the ones
   behind it, `outbound-durable` README), its `pending`, `receipts` and `health` in one place, and the
   rate limit counted by one owner. Enqueuing in the caller's own object would also work on Cloudflare
   (every object runs the channel's object half, which attaches every bot's transport to its queue:
   `channel-telegram-webhook/files/.../index.ts`, `startAnswerDelivery`), but would scatter one chat's
   outbox over every sender's object. This is how [memory](memory.md) reaches `memory:<person>`.
6. **Text only, bounded.** `text` is Markdown, at most 4,000 characters; the channel's transport
   splits it. No parts in v1: a `question` part would ask in a chat whose answer lands in a
   conversation that never asked it ([approvals](approvals.md)), and files wait for
   [rich content](rich-content.md).
7. **Stored, not delivered, is the tool's result.** It returns `Queued for "ops".` once the queue holds
   it; it never waits for delivery, which may take up to a day, and never reads receipts. What becomes
   of it is outbound-durable's: retries, rate limits, abandonment after a permanent refusal or 24
   hours, `outbound.abandoned`, `health`, the dashboard's Delivery.
8. **`outbound.queue` is required.** There is no direct mode: a tool cannot reach a channel's
   transport (transports are attached to the queue, never provided: "a keyed capability for transports
   would be a cycle", `outbound.ts`). So `requires`: `outbound.queue`, `actor.mailbox`, `actor.inbox`,
   `storage.kv` (the rate limit's count); `optional`: `agent.definition` (a `from` naming no agent
   stops the App at start, as tool-delegate's does).
9. **A rate limit per destination,** `maxPerHour` (the component's, overridden per destination),
   counted by the destination's handler in its `storage.kv` namespace, by idempotency key, so a replayed
   call is not counted twice. Over it, the call is refused (`ActorCallError` with code `rate_limited`)
   and the model reads when it may send again. The platform's own limits (Telegram's per-group rate)
   are the queue's `rate_limited` waits, not refusals.
10. **The destination's conversation is never touched.** No message is admitted to it, no run starts,
    nothing is in its transcript or in `agent.submissions`: the notification exists only as outbox
    pieces. On Cloudflare the destination's object may exist only for its outbox (Durable Objects
    exist by name, `admin-api` README).

## How it fits pikit
- **A tool component**, `agent.tool` under `notify` (`replay: "safe"`), with `defineTool` from
  `@pikit/pi-adapter/tools`, like `tool-delegate` and `tool-schedule`; it reads the calling
  conversation from `CONVERSATION`.
- **Composition only: no new contract, capability or SPEC change.** Each piece exists:
  `OutboundQueue.enqueue` takes any `channel` and `conversationKey`, not only a run's answer (its
  `idempotencyKey` is "`answerKey(...)` for a run's answer", so others are allowed); `actor.mailbox`'s
  `call` reaches whichever actor owns a key, which "need not be a conversation's" (SPEC C2), and works
  in an object to another key (`actors-do` README, "`actor.mailbox` in the object"); a component
  registers its own message types on `actor.inbox`, as memory-sql does. `tool-notify.enqueue` is
  spoken between two halves of one component, not a contract. Nothing changes in
  `@pikit/contracts`, `@pikit/pi-adapter`, or the capability catalogue
  (`packages/cli/src/registry/capabilities.ts`). The one change elsewhere is tool-delegate's
  `callers.ts` twin (decision 3).
- **Server** (`mailbox-local`): every key's actor is the App, so the call is local and the message
  lands in the App's one queue (`outbound-durable` on `storage-sqlite`), sent through the transport the
  channel attached (`channel-telegram` for `telegram:ops`, its bot `TELEGRAM_OPS_BOT_TOKEN`).
- **Durable** (`actors-do`, on Cloudflare or celld): an RPC from the caller's object to
  `idFromName("telegram:ops:-100123")`, whose App has its own outbound-durable (on `storage-do`) and
  the channel's object half with every bot's transport attached; its alarm (`wakeups`) sends and
  retries, also with the object evicted. Cost: one subrequest per call (C4), as memory's calls.
- **Which channels can be destinations**: those whose transport sends to a key alone, without a run
  behind it. Telegram (both twins): `chatIn` accepts any chat id of the bot's instance, a group's
  negative id included (`channel-telegram/files/.../account.ts`, `transport.ts`), though the channel
  admits private chats only (`inbound.ts`): the bot must be a member of the group, and a reply there
  goes nowhere. Google Chat: a space's key sends to its top level, a thread's key to the thread
  (`createAnswerTargets`, `key.ts`). Not `channel-web` (its transport writes a run's answer it did
  not hear, `delivery.ts`) nor `channel-http` (it answers request by request). Slack once
  [channel-slack](channel-slack.md) has a transport.
- **Not `deliver_to`**: [scheduler](scheduler.md) keeps "an answer delivered elsewhere than its
  conversation" out of scope. A routine whose result belongs elsewhere names `notify` and sends it;
  its answer still goes to its own conversation.

### With the other pieces
- **Origin.** A delegated agent's call runs in a `delegate:` conversation whose origin is the chat a
  person talks in (`originOf`). The handler logs the origin's key, the chain and the destination with
  each message (`tool-notify: queued for ops`), so an operator can trace which chat led to a post; the
  origin is never written into the message (a person's private key does not go to a group).
- **House rules per sender.** `extension-house-rules`' `senderTools: [{ tool: "notify", senders: [...] }]`
  limits which people's runs may send, on the agent a person talks to; `from` limits the agents below
  it. A delegated run's sender is the delegating agent (`{ channel: "delegate" }`), so per-person rules
  belong at the top of the tree.
- **Approvals.** v1 adds no approval of its own: an operator who wants a person to approve each post
  lists `notify` in `extension-approvals`' `tools`, which approves the exact call (destination and
  text), on a server. Approval per destination is open.
- **Duplicates.** At-least-once, as every answer: a send cut by a crash goes again with
  `possibleDuplicate`; Google Chat drops the copy (idempotent), Telegram shows it with `↻ `
  (`POSSIBLE_DUPLICATE_MARK`). `call` is neither retried nor deduplicated (SPEC C2), so the handler is
  idempotent: the same key twice is stored and counted once.
- **A failed routine.** A run that fails before its model calls `notify` sends nothing: alerting on
  `agent.failed` or `outbound.abandoned` without the model is another component, which would enqueue
  the same way (open).

## Pi first
Pi has no message from one session to another chat. Its `ctx.ui.notify` is a notice to the session's
own user (the former SPEC's `Interaction.notify`, kept in [approvals](approvals.md)), and pi-durable's
subagents are child conversations whose answers come back ([subagents](subagents.md)): the opposite of
send-only. Delivery to a chat platform is pikit's (P1, `delivery.ts`'s "Pi first"), so this is a pikit
component on pikit's queue.

## Guarantees and tests
Each guarantee is enforced in one place (the tool for names and `from`, the handler for the rate limit
and the enqueue) and tested there; per contract rule 7, each negative case is checked to fail on a
broken tool (the `from` check removed, the key built from a fresh id).

- **Names only**: an unknown `to` is refused; the parameter schema lists only configured names.
- **`from`**: an allowed caller sends; a refused one sends nothing; a `support` task delegated to an
  allowed `orchestrator` is refused (laundering); an untrusted chain is refused for a destination with
  `from` and allowed for one without; a `from` naming no agent stops the App at start.
- **Replay**: the same call run twice (a crash after the enqueue, before the result) stores one
  message and counts once, against a real `outbound-durable`.
- **No transport attached**: the call fails, the model reads why, nothing is stored.
- **Rate limit**: the limit's next call is refused with when to try again; a replay of a counted call
  is not; another destination is not affected.
- **Send-only**: after a notify, the destination's key has no conversation in the registry, no
  submission and no run; the tool's result holds nothing of the destination's.
- **One outbox per chat**: two conversations notifying one destination fill one queue's lane, in the
  order the handler stored them.
- **Twins**: `callers.ts` is the same in tool-delegate and tool-notify (repository test).
- **workerd lane**: from conversation A's object, a notify lands in the destination's object (its
  `pending`, not A's), and is delivered by that object's alarm after an eviction, with no new message.
- Not covered by tests: a real Telegram group or Google Chat space (checked by hand once).

## Open questions
- **Approval per destination** (`approval: true` on `ops`): `extension-approvals` matching a tool by
  its arguments, or tool-notify asking for approval itself through `approvals`. Both are component
  changes, not contracts; approvals run on a server only today.
- **Per person** (only when the tree started in some chats or for some senders): `from` is agents;
  a destination's `origins` would read `originOf`.
- **Checking destinations at start**: channels do not say which instances they run, and transports
  attach once channels start. A channel could declare whether its transport takes messages that answer
  no run (`channel-web`'s does not): a `ChannelTransport` field in `@pikit/contracts` (contract rules
  1 and 9), only once a channel needs to refuse.
- **The `tool-notify:` request id prefix**: a channel's request id that starts with it would share a
  key namespace with a notification. `admitInbound` reserves only `dashboard:`; reserving this one too
  is a kit change, or the key could leave the answer-key shape (and the Delivery link with it).
- **Attribution**: whether the message says which agent sent it (a prefix per destination), or only
  what the model wrote.
- **Telling the sender of an abandoned message**: reading the destination's receipts and messaging the
  sender back would be the first reply path, against send-only; today the operator sees it.
- **The chain as runtime data**: if a third component needs the delegation chain (house rules by
  chain, approvals), the runtime could record it beside the origin (`ConversationRef`), a contract
  change in the adapter's layer, instead of more twins of `callers.ts`.
- **Reply context**: a person who answers the notification in a chat the channel admits starts a
  conversation that does not know it ([team agents](team-agents.md), "Reply context").
