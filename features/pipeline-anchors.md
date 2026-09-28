# Pipeline anchors: the planned pipelines, and `agent.state` outside a run

**Public appeal:** —

**Specified:** partly (SPEC §4.4 table, `[planned]`; moved from SPEC §6.2a; SPEC §4.5, `agent.state` row)

**Needed by:** nothing required. They arrive with their first consumer: [policy tools](policy-tools.md)
and [memory](memory.md) (`agent.prepare`), [multi-tenant isolation](multi-tenant-isolation.md)
(`conversation.resolve`), the first outbound transformation (`outbound.prepare`), a
[scheduler](scheduler.md) or an admin route (`agent.state` outside a run).

## What it gives
The points on the main path where a component can change what happens without forking another:
which conversation a message goes to, what a run is configured with, what an answer looks like.

## How it fits pikit
- `conversation.resolve` (`{ decision, conversation? }`) lands in `admitInbound` when a component
  needs to change which conversation a message goes to (SPEC §5, M1 decision).
- `agent.prepare` runs after the agent's `prepare` in Pi's `before_run` and patches its `TurnConfig`.
- `outbound.prepare` transforms an `OutboundMessage` before it is enqueued.
- Each is a contract in `@pikit/contracts` (SPEC §4.9): its value type is decided with two real
  parties, never as a `[planned]` line alone.
- `agent.state` for components outside a run (an admin route, a scheduler): a capability, added with
  the first one that needs it (SPEC §4.5).
- Not to confuse with before/after anchors between stages, which SPEC §4.4 decided against (they
  could be added later, additively).

## Pi first
Pi already patches a run: `before_run` and `transform_context`, and a Pi extension's
`before_agent_start` (tier A) can inject context today without `agent.prepare`. Once `agent.state`
is a Pi document (SPEC §6.4), reading it outside a run is Pi's document API through the adapter,
not a pikit store.

## Open questions
- Does a Pi extension per agent make `agent.prepare` unnecessary for context injection?

## Moved from SPEC
SPEC §6.2a:

- `[planned]` The `agent.prepare` pipeline (§4.4) runs *after* `prepare` and lets components and
  extensions patch the `TurnConfig` further (context injection, policy restrictions). Deferred
  until the first component needs it (`policy-tools`, context injection): its value type is a core
  export to decide with a real consumer, and adding the pipeline later changes nothing for agents
  or for `prepare`.
