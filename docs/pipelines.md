# Pipelines and events

Both are kernel mechanisms ([pipeline.ts](../packages/core/src/pipeline.ts),
[events.ts](../packages/core/src/events.ts)). A pipeline transforms one value through ordered stages
and can stop it; an event notifies every listener and can be missed. Neither is persisted. What must
not be missed is a feed ([contracts.md](contracts.md#delivery)).

## How a pipeline runs

```ts
pikit.pipeline("route.resolve", stage, { id: "router-rules", priority: 1 });   // in setup
const result = await ctx.run("route.resolve", { message });                    // anywhere with a ctx
if (result instanceof Halt) { /* result.reason, result.stage */ }
```

- **Type.** A pipeline has one value type, declared by merging into `AppPipelines`. Stages are
  `(value, ctx) => value | Halt | Promise<…>`. A pipeline that "produces" something carries it as a
  field of the value (`route.resolve`'s `decision`).
- **Order.** `priority` descending (default 0), then registration order, which is the order of
  `components` in `pikit.config.ts`. There are no anchors: a stage that must run next to another picks
  a neighbouring priority. `pikit doctor` prints every chain as `id (priority) → …`, and
  `describe().pipelines` holds it.
- **Ids.** Unique within a pipeline (a duplicate throws in `setup`). Default `stage-<n>`.
- **Halt.** A stage returns `pikit.halt(reason)` (or `halt` from `@pikit/core`): the chain stops,
  the kernel awaits `pipeline.halted` `{ pipeline, stage, reason }`, and `run` returns a `Halt` with
  the stage's id.
- **Throw.** A stage that throws aborts the run: `run` rejects. Returning `undefined` is an error too
  (`stage "<id>" returned undefined`), to catch a forgotten `return`.
- **No stage.** A pipeline with no stage returns its input unchanged.
- Stages are registered only in `setup`.

## The pipelines that exist

Three, found by every `pikit.pipeline(` and `ctx.run(` in the kernel, contracts and registry.

### `inbound.normalize`

| | |
|---|---|
| Declared in | [packages/contracts/src/inbound.ts](../packages/contracts/src/inbound.ts) |
| Value | `InboundMessage` (`{ id, channel, conversationId, actor, text, raw, receivedAt }`) |
| Run by | `admitInbound`, first, for every message of every channel |
| Stages in the registry | none |
| Rules | a stage may rewrite the text or enrich the message, never `id`, `channel` or `conversationId` (`admitInbound` throws) |
| Halt | `admitInbound` returns `{ kind: "halted", pipeline: "inbound.normalize" }`: channel-http answers `422`, the Telegram channels "I can't take that message." |

It is the place for a project's policy stage (a filter, a rewrite).

### `route.resolve`

| | |
|---|---|
| Declared in | [packages/contracts/src/inbound.ts](../packages/contracts/src/inbound.ts) |
| Value | `{ message: InboundMessage; decision?: RouteDecision }`, `RouteDecision` = `{ agent, access: "allow" \| "deny", reason? }` |
| Run by | `admitInbound`, after `inbound.normalize` |
| Rule | a stage that finds a `decision` leaves it; the first stage to set one decides |
| No decision at the end | `no_route`, logged as an error ("install a router"); channel-http answers `500 no_route` |
| `deny` | `denied`: channel-http `403`, the Telegram channels "Sorry, I can't answer that here." |
| Halt | `halted`: channel-http `403` |

Stages in the registry, in the order they run:

| Stage id | Priority | Component | What it does |
|---|---|---|---|
| (a project's) | 10 and up, by convention | the project | routes some messages, or denies them (router-basic's README shows one at 10) |
| `router-rules` | 1 | [router-rules](../registry/components/router-rules/files/src/pikit/router-rules/index.ts) | the first rule matching `channel` (an instance like `telegram:ops`, or a kind like `telegram`), `conversation`, `actor` decides an agent or a deny; no match leaves it undecided |
| `router-basic` | 0 | [router-basic](../registry/components/router-basic/files/src/pikit/router-basic/index.ts) | `defaultAgent` for everything still undecided |

Both routers refuse to start when they name an agent that is not an `agent.definition`. `pikit doctor`
fails when a channel is installed and `route.resolve` has no stage (`serving.ts`).

The decision's agent is used only for a key's first message: `conversations.registry.resolve` keeps
the agent a conversation was created with.

### `http.authenticate` (channel-http's own)

| | |
|---|---|
| Declared in | [channel-http/index.ts](../registry/components/channel-http/files/src/pikit/channel-http/index.ts) (a component may declare a pipeline) |
| Value | `{ channel; request: Request; verdict?: { kind: "authenticated"; actor } \| { kind: "rejected"; reason } }` |
| Run by | each of channel-http's routes, before anything else |
| Stage | `channel-http-bearer`, priority 100: compares the bearer token with `PIKIT_HTTP_TOKEN` (constant time) |
| Rules | a stage acts only on its own `channel` and leaves a rejection alone; no verdict, a halt, or `rejected` is a `401` |

A project adds a stage to it as to any pipeline (another way to authenticate).

## Events

Events are typed by merging into `AppEvents`. `ctx.emit` awaits each listener in registration order;
a listener's error is logged (`event listener failed`) and the next one runs. Emit never throws
because of a listener.

| Event | Payload | Emitted by | Listened to by |
|---|---|---|---|
| `runtime.starting`, `runtime.ready`, `runtime.stopping`, `runtime.stopped` | `{}` | the kernel's lifecycle; `stopped` also closes a failed start | server-bun (`/ready` is 200 between `ready` and `stopping`), log-events |
| `pipeline.halted` | `{ pipeline, stage, reason }` | the kernel, when a stage halts | log-events |
| `agent.dispatched` | `{ conversation, admission }` | runtime-pi, for every admission (duplicates too), in the caller's context | admin-api (index activity), log-events |
| `agent.started` | `{ conversation, requestId, resumed }` | runtime-pi, when a run starts or a new worker resumes one | channel-telegram ("typing…"), admin-api, log-events |
| `agent.settled` | `AgentResult` with `kind: "completed" \| "aborted"` | runtime-pi, after the run is logged in `answers` | channel-http (answers the waiting POST), channel-telegram, channel-telegram-webhook (wake delivery), admin-api (index, titles), log-events |
| `agent.failed` | `AgentResult` with `kind: "failed"` | runtime-pi (also for an abandoned message, code `abandoned`) | the same as `agent.settled` |
| `conversation.reset` | `{ conversation, previousConversationId, newConversationId }` | conversations-kv, conversations-file, once the new pointer is stored | admin-api, log-events |
| `outbound.delivered` | `{ channel, conversationKey, key, attempts, possibleDuplicate }` | outbound-durable | no registry component (a reader of `receipts` would use it to wake) |
| `outbound.abandoned` | `{ channel, conversationKey, key, attempts, reason }` | outbound-durable | no registry component |

Declared in: [lifecycle.ts](../packages/core/src/lifecycle.ts) and [app.ts](../packages/core/src/app.ts)
(the kernel's), [agent.ts](../packages/contracts/src/agent.ts),
[conversations.ts](../packages/contracts/src/conversations.ts),
[outbound.ts](../packages/contracts/src/outbound.ts).

`runtime.*` listeners share the lifecycle's deadline and cannot fail the App. log-events writes one
line per event with no message text ([its README](../registry/components/log-events/README.md)).

### Events wake, feeds decide

The channels show the pattern: `agent.settled` / `agent.failed` only call `delivery.wake(ctx)`. What
is delivered is read from `agent.submissions.answers` with a stored cursor, so an event lost to a
crash, or one that fired while the channel was stopped, delays an answer and never loses it. The
exception is channel-http, which answers a POST that is waiting in memory from the event; the answer
is still in the conversation, readable with `GET /v1/conversations/:id/messages/:messageId`.
