# tool-notify

The `notify` tool, for the agents that name it: an agent sends a message to a chat you named in the
config (the `developer` announces its pull request in the Telegram "ops" group, a routine posts its
daily summary to a Google Chat space). It only sends: the agent never reads that chat, never enters
it, and gets no reply from it.

- **Provides:** `agent.tool`, under `notify` (replay `safe`).
- **Uses:** `outbound.queue` (outbound-durable), `actor.mailbox` and `actor.inbox` (mailbox-local,
  actors-do), `storage.kv` (the rate limit's count); optionally `agent.definition`, to check at start
  that the agents a `from` names exist.
- **Targets:** `server` and `durable` (Cloudflare, celld). On a server every key's actor is the App, so
  the message lands in the App's one outbox. On `durable` the call is an RPC to the destination's
  object (`idFromName(<its key>)`, one subrequest), whose own outbox and alarm send it.
- **Installs to:** `src/pikit/tool-notify/` (`index.ts`, `callers.ts`, `tool-notify.test.ts`).

## Use it

```sh
pikit add tool-notify
```

Name each chat in `pikit.config.ts`: the channel instance whose transport sends it, and the chat as
that channel keys it, both written out (tool-notify never parses a key):

```ts
export const config = {
  "tool-notify": {
    destinations: {
      ops: {
        channel: "telegram:ops",                 // the channel instance that sends it
        conversation: "telegram:ops:-100123",    // the chat, as that channel keys it
        description: "The operations group: deploys, pull requests, incidents.",
        from: ["developer", "orchestrator"],     // optional: who may send here
      },
      team: {
        channel: "googlechat",
        conversation: "googlechat:spaces/AAAA1234",
        description: "The team's space: daily summaries.",
        maxPerHour: 4,                           // this chat's limit
        attribution: false,                      // only what the model wrote
      },
    },
    maxPerHour: 30,                              // per chat, unless it says otherwise (default 30)
  },
};
```

and name the tool in the agents that send (`src/agents/<agent>/agent.ts`):

```ts
defineAgent({ name: "developer", model: "…", tools: ["notify"] })
```

The model calls `notify({ to, text })`: `to` is one of the names (the tool's description lists each
with its `description` and `(only from: …)`), `text` is Markdown, at most 4,000 characters. It returns
`Queued for "ops".` once the message is stored for delivery; it never waits for the delivery.

**Which chats work:** those whose transport sends to a key alone, without a run behind it. Telegram
(channel-telegram and channel-telegram-webhook): any chat of the instance's bot, a group's negative id
included; the bot must be a member of the group, and a reply there goes nowhere (the channel admits
private chats only). Google Chat: a space's key sends to its top level, a thread's key to the thread.
Not channel-web (its transport writes a run's answer) nor channel-http (it answers request by request).

**What a message looks like:** the sending agent's name first, in bold, on its own line, then the text:

```
**developer:**
Opened #42: fix the login redirect.
```

Telegram shows **developer:** in bold, Google Chat *developer:*. `attribution: false` on a destination
sends only the text. The chat a delegated agent's task came from is never written in the message (a
person's private chat does not go to a group); it is logged with each message
(`tool-notify: queued for ops`, with the origin's key and the delegation chain).

**Approval:** none of its own. To have a person approve each post, list `notify` in
`extension-approvals`' `tools` (it approves the exact call: destination and text).

## What it guarantees

- **A name, never an address.** `to` is a union of the configured names; an unknown one is refused,
  and nothing is stored. A destination the config does not name does not exist for the model.
- **`from`, tool-delegate's rule.** A destination with `from` takes a message only when the calling
  conversation's agent **and every agent above it** in its delegation are in `from`: an allowed
  `orchestrator` does not launder a `support` agent's task into the ops group. The chain is read with
  tool-delegate's `callersOf` (`callers.ts`, the same file in both, kept identical by the registry's
  `twins.test.ts`), from the `delegate:` keys only tool-delegate writes, its first agent checked against
  the origin the runtime fixed. A chain that cannot be trusted reaches no destination with `from`; a
  destination without `from` takes any agent that names `notify`. A `from` naming no agent, or a config
  with no destination, stops the App at start.
- **Enqueued by the destination's actor.** The tool calls `tool-notify.enqueue` on the actor that owns
  the destination's key; this component's handler there checks the call is for its own key, applies
  the rate limit, and calls `outbound.queue.enqueue`: one outbox per chat, so one lane per chat (the
  queue orders a chat's pieces), its `pending`, receipts and health in one place.
- **Replay `safe`.** The idempotency key is `answerKey(conversation, "tool-notify:" + callId)`: a call
  made again after a crash stores nothing twice (the queue keeps one per key) and is not counted twice.
  In the dashboard's Delivery a notification opens the conversation that sent it.
- **No transport attached for the channel**: the queue refuses, the call fails with why, nothing is
  stored and nothing is counted.
- **A rate limit per chat** (`maxPerHour`), counted in the handler's `storage.kv` namespace, by
  idempotency key, over the last hour. Over it the call is refused (`rate_limited`), saying in how many
  minutes the next one fits. Another chat is not affected. A platform's own limits are the queue's
  waits, not refusals.
- **Send-only.** The destination's conversation is never touched: no message admitted, no run, nothing
  in its transcript or in `agent.submissions`; the notification exists only as outbox pieces. The
  tool's result holds nothing of the destination's.
- **Delivery is outbound-durable's**: retries, rate limits, abandonment after a permanent refusal or 24
  hours, at-least-once (Telegram marks a possible duplicate with `↻ `, Google Chat drops it).

## Tests

- `tool-notify.test.ts` (copied into your project): what `setup` declares, a start refused (a `from`
  naming no agent, no destination), the description and the schema's names, an unknown name refused
  (`constructor` included) with nothing stored, the message stored under the call's key and attributed
  (and not with `attribution: false`), a text over 4,000 characters refused, `from` (an allowed caller,
  a refused one with nothing stored, laundering through an allowed orchestrator refused, a chain wholly
  in it allowed, untrusted chains refused for a destination with `from` and allowed for one without),
  replay (stored and counted once), the rate limit (refused with when, a replay of a counted call not,
  another chat unaffected, one fits again an hour later), no transport (refused, nothing stored, nothing
  counted), and the handler refusing a call for another key or malformed. In an App with the in-memory
  mailbox and `storage.kv`, and a stand-in queue.
- `app.test.ts` (beside `files/`, in the registry only): with runtime-pi on a SQLite file and the
  scripted model, mailbox-local, a real outbound-durable and storage-kv-sql: send-only (the message is
  sent to the chat; the destination's key has no conversation in the registry, no submission, no run),
  replay stored and counted once against outbound-durable, no transport (nothing stored), and two
  conversations notifying one chat in one lane, in the order stored.
- `twins.test.ts` (registry only): `callers.ts` is the same in tool-delegate and tool-notify.
- `tests/workerd/test/tool-notify.workerd.ts`: from conversation A's object, the notify lands in the
  destination's object's outbox (not A's), and that object's alarm delivers it to a fake Telegram after
  an eviction, once.
- Each negative case was checked to fail on a broken tool (the `from` check removed, the key built from
  a fresh id, names read through the prototype, a replay counted, no limit, one count for every chat,
  counted before the enqueue, the handler's key check removed, the attribution switch ignored, the
  start check removed, the length check removed; in workerd, enqueued in the caller's own object).
- Not covered: a real Telegram group or Google Chat space (check by hand once); a replay more than an
  hour after its first call is counted again (the queue still stores it once).

Design note: [features/completed/tool-notify.md](https://github.com/ajarellanod/pikit/blob/main/features/completed/tool-notify.md).
