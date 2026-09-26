# router-rules

Each conversation goes to the agent of the first rule in config it matches.

- **Provides:** nothing. It adds the stage `router-rules` (priority 1) to the `route.resolve`
  pipeline.
- **Uses:** `agent.definition`, to check at start that every agent a rule names exists.
- **Targets:** `server` and `cloudflare`.
- **Installs to:** `src/pikit/router-rules/`.
- **npm dependencies:** `typebox`.

## What it does

The rules are an ordered list; the first one that matches the message decides. A rule matches on
any of these fields, and every field it gives must match:

| Field | Matches | Example |
|---|---|---|
| `channel` | the channel instance, or a kind for every account of it | `"telegram:support"`, `"telegram"` |
| `conversation` | `InboundMessage.conversationId`: a chat, an HTTP client's conversation | `"12345"` |
| `actor` | `InboundMessage.actor.id`: who sent it | `"987654"` |

A rule with none of them matches every message. Each rule gives exactly one of `agent: "<name>"`
(that agent answers) or `deny: true` with an optional `reason` (nobody answers; the channel refuses
the message: `403 denied` over HTTP, "Sorry, I can't answer that here." on Telegram). A rule with
both, neither, or a field it does not know is invalid config, so a typo is never a catch-all.

A message no rule matches is left undecided, for the next stage: `router-basic`'s `defaultAgent`,
or `no_route` when nothing else routes it. The stage runs at priority 1, right before
`router-basic` (0); a project stage with a higher priority (10) still routes around both. A
decision already there is left alone.

It refuses to start when a rule names an agent that is not an `agent.definition`.

A conversation keeps the agent it was created with: a changed rule applies to new conversations,
and to an existing one after a reset (`/new`).

Rules are values. Choosing the agent another way (from the chat itself, by content) is a different
router component, not a config key here.

**Planned:** a `thread` field, once channels set `InboundMessage.threadId`. Until then a rule with
`thread` is invalid config.

## Config

Three agents: the support bot's account goes to `support`, one sales chat to `sales`, a blocked
user is denied, and everything else falls through to `router-basic`:

```ts
"router-rules": {
  rules: [ // required, at least one
    { actor: "666", deny: true, reason: "blocked" },
    { channel: "telegram:support", agent: "support" },
    { channel: "telegram", conversation: "12345", agent: "sales" },
    { channel: "http", agent: "assistant" },
  ],
},
"router-basic": {
  defaultAgent: "assistant",
}
```

A denied decision carries `agent: ""`: `RouteDecision.agent` is required, and a denied message
has no agent. Nothing reads it for a deny.

## Removing it

Remove it and every message goes back to `router-basic`'s `defaultAgent`, with nothing else
changed. Existing conversations keep the agent they were created with.

## Tests

`router-rules.test.ts` is copied with the component and runs in your project. It covers the
lifecycle conformance suite, first match, channel kinds and instances, conversation and actor,
the catch-all, deny, falling through to `router-basic`, an earlier decision left alone, the start
failure, and invalid rules.

`component.json` is generated from `setup` by the CLI and is not written by hand. The test "what
setup declares" pins it.
