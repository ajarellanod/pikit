# Pipeline anchors: the planned pipelines, and `agent.state` outside a run

**Public appeal:** —

**Specified:** partly (the former SPEC §4.4 table, `[planned]`; moved from its §6.2a; its §4.5,
`agent.state` row)

**Needed by:** nothing required. They arrive with their first consumer: the first outbound
transformation (`outbound.prepare`), a [scheduler](scheduler.md) or an admin route (`agent.state`
outside a run).

## What it gives
The points on the main path where a component can change what happens without forking another:
what an answer looks like as it leaves, and an agent's state read or changed from outside a run.

## How it fits pikit
- `outbound.prepare` transforms an `OutboundMessage` as it leaves its channel: enqueued, sent
  directly, or returned in an HTTP response. Where it runs: [answer delivery](completed/outbound-delivery.md).
- `agent.state` for components outside a run (an admin route, a scheduler): a capability, added with
  the first one that needs it.
- Each is a contract in `@pikit/contracts` (SPEC §3): its value type is decided with two real
  parties, never as a `[planned]` line alone.
- **Not planned any more:**
  - `agent.prepare`, a pipeline after the agent's `prepare` that patched its `TurnConfig` (context
    injection, tools taken away by policy). An agent extension does both, per agent and per request:
    a section injects context, a `beforeTool` hook refuses a call, `beforeRequest` changes one
    request ([building components](building-components.md), skill `pikit-extension`, reference
    `extension-house-rules`). The agent's own `prepare(state)` stays for switching model, prompt,
    tools or extensions with its state.
  - `conversation.resolve` (`{ decision, conversation? }`), planned by the former SPEC §5 (M1) to
    change which conversation a message goes to: a conversation is one chat of one channel and its
    key is the channel's, never rewritten ([conversation routing](conversation-routing.md)).
    Reviving it means changing that decision first.
- Not to confuse with before/after anchors between stages, which the former SPEC §4.4 decided
  against (they could be added later, additively).

## Pi first
Pi patches a run itself: pi-durable's hooks (`beforeRequest`, `beforeTool`, `afterTool`,
`beforeCompact`) and sections, reached through `agent.extension`. `agent.state` is a Pi document
(`AgentStateDoc` in the adapter), so reading it outside a run is Pi's document API through the
adapter, not a pikit store.

## Moved from the former SPEC
The former SPEC §6.2a, kept as written; superseded by `agent.extension` (above):

- `[planned]` The `agent.prepare` pipeline (§4.4) runs *after* `prepare` and lets components and
  extensions patch the `TurnConfig` further (context injection, policy restrictions). Deferred
  until the first component needs it (`policy-tools`, context injection): its value type is a core
  export to decide with a real consumer, and adding the pipeline later changes nothing for agents
  or for `prepare`.
