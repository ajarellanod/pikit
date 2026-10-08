# Contracts

A contract is a capability's interface, its guarantees, and a conformance suite every provider runs.
The kit's contracts are in [packages/contracts/src](../packages/contracts/src) (`@pikit/contracts`);
those whose types are Pi's are in [packages/pi-adapter/src/types.ts](../packages/pi-adapter/src/types.ts)
(`@pikit/pi-adapter`). The kernel defines none. Each source file's header is the full statement of
its contract; this page summarises it.

The catalogue ([capabilities.ts](../packages/cli/src/registry/capabilities.ts)) gives each capability
its mode, one line, and a stability. Every one is `experimental` except `agent.definition` (`stable`
by decision). `pikit registry capabilities` prints the catalogue with the providers and users read
from every `component.json`; the tables below come from it.

Suites are in `@pikit/contracts/testing` ([testing/index.ts](../packages/contracts/src/testing/index.ts))
unless said otherwise. Each returns `ConformanceCase[]` for any test runner:

```ts
for (const c of createChannelConformance(() => myFixture())) test(`${c.group}: ${c.name}`, () => c.run());
```

## Overview

| Capability | Mode | Provided by | Used by (`?` = optional) | Suite |
|---|---|---|---|---|
| `agent.runtime` | single | runtime-pi | admin-api, channel-http, channel-telegram, channel-telegram-webhook | `createAgentRuntimeConformance` |
| `agent.conversations` | single | runtime-pi | conversations-file, conversations-kv | none of its own |
| `agent.submissions` | single | runtime-pi | channel-http?, channel-telegram, channel-telegram-webhook | `createSubmissionsConformance`, `createFeedConformance` |
| `agent.observe` | single | runtime-pi | admin-api | `createAgentObserveConformance` |
| `agent.definition` | keyed | the project | admin-api?, router-basic?, router-rules?, runtime-pi? | none (`defineAgent` validates) |
| `agent.tool` | keyed | tool-bash, tool-edit, tool-fetch, tool-mcp, tool-read, tool-websearch-brave, tool-write | runtime-pi? | none |
| `agent.extension` | keyed | extension-house-rules | runtime-pi? | none |
| `agent.command` | keyed | admin-api, runtime-pi | admin-api? | `createAgentCommandConformance` |
| `conversations.registry` | single | conversations-file, conversations-kv | admin-api, channel-http, channel-telegram, channel-telegram-webhook | `createConversationRegistryConformance` |
| `outbound.queue` | single | outbound-durable | admin-api?, channel-telegram?, channel-telegram-webhook? | `createOutboundQueueConformance` |
| `storage.sql` | single | storage-do, storage-sqlite | admin-api, outbound-durable, runtime-pi, storage-kv-sql | `createSqlDatabaseConformance` |
| `storage.kv` | single | storage-kv-sql | channel-telegram, channel-telegram-webhook, conversations-kv, health-registry?, tool-mcp? | `createKeyValueConformance` |
| `actor.mailbox` | single | mailbox-local, platform-cloudflare | admin-api, channel-telegram-webhook | `createMailboxConformance` |
| `actor.inbox` | single | mailbox-local, platform-cloudflare | admin-api?, channel-telegram-webhook | `createMailboxConformance` |
| `wakeups` | single | platform-cloudflare, wakeups-timers | channel-telegram-webhook, outbound-durable, runtime-pi? | `createWakeupsConformance` |
| `http.route` | keyed | admin-api, channel-http, channel-telegram-webhook, health-registry | server-bun? | `createHttpRouteConformance` (run by servers) |
| `admin.auth` | single | admin-auth-token | admin-api, health-registry? | `createAdminAuthConformance` |
| `secrets` | single | secrets-cloudflare, secrets-env | admin-auth-token, channel-http, channel-telegram, channel-telegram-webhook, tool-websearch-brave, execution-do?, runtime-pi?, tool-mcp? | `createSecretStoreConformance` |
| `health` | single | health-registry | channel-telegram?, server-bun? | `createHealthConformance` |
| `model.complete` | single | runtime-pi | admin-api? | `createModelCompleteConformance` |
| `model.provider` | keyed | provider-anthropic, provider-faux, provider-openai-compatible, provider-openrouter | runtime-pi? | none |
| `model.credentials` | single | credentials-file | runtime-pi? | `createCredentialStoreConformance` (`@pikit/pi-adapter/testing/neutral`) |
| `execution` | single | execution-do, execution-local | tool-edit, tool-read, tool-write, workspace-local, runtime-pi? | `createDurableExecutionConformance` (`@pikit/pi-adapter/execution/testing`) |
| `execution.shell` | single | execution-do, execution-local | tool-bash | same |
| `workspace` | single | workspace-local | runtime-pi?, tool-bash?, tool-edit?, tool-read?, tool-write? | `createWorkspaceConformance` (`@pikit/pi-adapter/testing/neutral`) |

Two more suites check behaviour rather than one capability: `createChannelConformance` (what every
channel does with a message and its answer: channel-http, channel-telegram, channel-telegram-webhook)
and `createConvergenceConformance` (kill the process after each commit, restart, check it converges:
outbound-durable, and answer delivery over storage-kv-sql in this repository). `@pikit/core/testing`
has `createLifecycleConformance`, which almost every component runs.

---

## Agent

### `agent.runtime` ([agent.ts](../packages/contracts/src/agent.ts))

Runs the agents. One per App.

```ts
interface AgentRuntime {
  dispatch(request: AgentRequest, ctx): Promise<Admission>;   // { kind: "started" | "queued" | "duplicate", requestId }
  abort(conversation: ConversationRef, ctx): Promise<void>;
  resume(conversation: ConversationRef, ctx): Promise<void>;
}
```

- `AgentRequest` is `{ requestId, conversation, prompt, images?, whenBusy? }`. `ConversationRef` is
  `{ key, agent, conversationId }`: the channel's key, the agent's name, the runtime's conversation.
- `dispatch` resolves once the message is durable in the runtime (a channel's acknowledgement point),
  not when it is answered. Cancelling `ctx` never stops a run.
- The same `requestId` in one conversation is `duplicate`: nothing runs. This is pikit's inbound
  deduplication (pi-durable's).
- A message to a busy conversation is `queued` by default (`whenBusy: "followUp"`): every follow-up
  queued during a run is taken together by the next run. `whenBusy: "steer"` joins the run in progress
  at its next tool round.
- The answer is not returned. A run's end is the event `agent.settled` (completed or aborted) or
  `agent.failed`, with an `AgentResult` (`requestId` that started it, every `requestIds` it answered,
  `text`, `messages`, `usage`, `error`), and is recorded in `agent.submissions.answers`. A run resumed
  after a crash has no caller, which is why.
- Events `agent.dispatched` (every admission) and `agent.started` (with `resumed`) are emitted too.

Provider: runtime-pi (on pi-durable, through `@pikit/pi-adapter`'s `createDurableRuntime`).
Suite: `createAgentRuntimeConformance`, run by runtime-pi with and without `wakeups`, by the adapter,
and in workerd.

### `agent.conversations`

`create(ctx): Promise<string>`: a new, empty conversation in the runtime's storage. Only
`conversations.registry` uses it, on a key's first message and on a reset. Provider: runtime-pi (in a
Durable Object, the object's root conversation first).

### `agent.definition` (keyed, provided by the project)

One `AgentDefinition` per agent name: `{ name, model: "provider/modelId", systemPrompt?, tools?,
extensions?, state?, prepare?(state, ctx) }`, checked by `defineAgent`. `tools` names `agent.tool`
keys or holds tool objects; `extensions` names `agent.extension` keys. An agent gets only what it
names. `prepare` is pure and synchronous: from the conversation's state it returns the fields that
change for this run. The project provides agents (`src/extensions/agents.ts`); runtime-pi refuses to
start when an agent names a model, tool or extension nothing provides.

### `agent.state` and `CONVERSATION` (context keys, not capabilities)

- `AGENT_STATE` ([agent-state.ts](../packages/contracts/src/agent-state.ts)): the conversation's JSON
  state. `get(ctx)`, `update(patch, ctx)` (a shallow merge, committed, one at a time per conversation;
  a non-JSON patch is refused). It lives in the runtime's conversation and restarts from `state` after
  a reset. A tool reads it with `context.value(AGENT_STATE)`. Suite: `createAgentStateConformance`
  (run in the adapter's `prepare.test.ts`).
- `CONVERSATION` ([conversation-context.ts](../packages/contracts/src/conversation-context.ts)): the
  run's `ConversationRef`, for a tool that needs to know whose run it is in.

### `agent.tool` (keyed)

One tool per name the model calls it by: pi-durable's `ToolRegistration` (`defineTool` from
`@pikit/pi-adapter/tools`), with its `replay` (`safe`: an interrupted call runs again on recovery;
`unsafe`: the model gets an interrupted result). `component.json`'s `replay.tools` records it. A tool
that works on `api.env` must use `execution` or `execution.shell`. Registry tools: `read` (safe),
`write`, `edit`, `bash`, `fetch` (unsafe), `websearch` (safe), and tool-mcp's `<server>_<tool>`.
No suite (see [building-components.md](../features/building-components.md), "Contracts without a
suite").

### `agent.extension` (keyed, `@pikit/pi-adapter`)

One pi-durable `Extension` per name (`defineExtension` from `@pikit/pi-adapter/extensions`): system
prompt sections, hooks on model requests, tool calls and compaction, tool wrappers, durable tasks,
tools. An agent runs with the ones it names, in order, after its own tools. Names starting with
`pikit.` are the runtime's. Provider in the registry: extension-house-rules.

### `agent.command` (keyed, [command.ts](../packages/contracts/src/command.ts))

One slash command per name (`COMMAND_NAME`: lowercase letters, digits, `-`, `:`):
`{ description, argumentHint?, run(conversation, args, ctx) }`. It runs in the App that holds the
conversation and acts only through contracts. `run` resolves with `{ text? }`, a note for whoever ran
it; a thrown `Error` is the reason it failed. `listAgentCommands` and `runAgentCommand` are the
helpers a runner uses (`runAgentCommand` never throws). Providers: admin-api (`new`, `name`),
runtime-pi (`compact`). Runner: admin-api.

---

## Conversations and inbound

### `conversations.registry` ([conversations.ts](../packages/contracts/src/conversations.ts))

Which runtime conversation a conversation key is in now.

```ts
interface ConversationRegistry {
  resolve(key, agent, ctx): Promise<ConversationRef>;   // creates on first call, then returns the record
  get(key, ctx): Promise<ConversationRef | undefined>;  // creates nothing
  reset(key, ctx): Promise<ConversationReset | undefined>;
}
```

- The pointer is a record, never memory. Concurrent first resolves of one key make one conversation.
- A conversation keeps the agent it was created with.
- `reset` points the key to a new conversation, keeps the old one, and emits `conversation.reset`
  once the pointer is durable. No pointer is ever deleted.

Providers: conversations-kv (on `storage.kv`, both targets), conversations-file (a JSON file, server).
Both use `agent.conversations`, so the runtime starts first.

### The inbound path ([inbound.ts](../packages/contracts/src/inbound.ts))

Not a capability: a function and two pipelines every channel shares. `admitInbound(ctx, message,
{ conversations, runtime, key, beforeDispatch? })` runs `inbound.normalize`, then `route.resolve`,
then `conversations.resolve(key, agent)`, then `runtime.dispatch`, and returns an `InboundOutcome`:
`admitted`, `duplicate`, `halted` (a stage halted), `denied` (the router said deny) or `no_route` (no
stage decided). It throws when a stage changed the message's `id`, `channel` or `conversationId`, or
when a capability fails. The `InboundMessage` is `{ id, channel, conversationId, actor: { id }, text,
raw, receivedAt }`; its `id` becomes the request id. See [pipelines.md](pipelines.md).

Authentication is not here: each channel proves its senders its own way.

---

## Delivery

### `agent.submissions` ([submissions.ts](../packages/contracts/src/submissions.ts))

What became of each admitted message, read from the runtime, which is its only writer.

```ts
interface AgentSubmissions {
  pending(ctx): Promise<PendingConversation[]>;                 // conversations holding unanswered requests
  get(conversation, requestId, ctx): Promise<SubmissionStatus | undefined>;
  readonly answers: Feed<RunSettlement>;                         // every run's end, in commit order
}
```

`RunSettlement` is an `AgentResult` without `messages` and `usage`. A message the runtime gives up on
is settled `failed` with `error.code: "abandoned"`. runtime-pi keeps `answers` in `runtime_pi_answers`
(`packages/pi-adapter/src/answers.ts`), appended once per run before `agent.settled`/`agent.failed`,
kept `keepSettledDays` (7). Suites: `createSubmissionsConformance` (on the memory double and on
runtime-pi over storage-sqlite and storage-do), `createFeedConformance` for `answers`.

### `Feed<T>` ([feed.ts](../packages/contracts/src/feed.ts))

`read(after, limit)` returns `{ items: [{ cursor, fact }], gap }`. Facts in commit order; reading
changes nothing; a reader that saved a cursor misses nothing after it. `gap` says facts after the
cursor were pruned. Suite: `createFeedConformance`.

### `outbound.queue` ([outbound.ts](../packages/contracts/src/outbound.ts))

Stores an answer before sending it, and delivers it.

```ts
interface OutboundQueue {
  enqueue(message: OutboundMessage): Promise<void>;    // { idempotencyKey, channel, conversationKey, text }
  attach(channel, transport: ChannelTransport): void;  // a channel hands its transport while it runs
  detach(channel, signal?): Promise<void>;
  readonly receipts: Feed<DeliveryReceipt>;           // every piece that settled
  pending(page): Promise<ObservedPage<PendingPiece>>; // what is not settled yet, never its text
}
```

- The same `idempotencyKey` enqueued twice is stored once. Each conversation's pieces go in order.
- At-least-once: a piece whose send may have reached the platform goes again with
  `possibleDuplicate`.
- Events `outbound.delivered` and `outbound.abandoned` are notices; `receipts` is the record.
- Transports attach rather than being a keyed capability, which would be a cycle (the queue would use
  the channels, the channels the queue).

A **`ChannelTransport`** is the channel's: `{ idempotent, split(text), send(piece, signal) }`. A failed
send throws `DeliveryError(kind)`: `transient`, `rate_limited` (with `retryAfterMs`, not counted as a
failure) or `permanent`, with `maybeSent`. `answerKey(conversation, requestId)` is
`${conversationId}:${requestId}`, and piece keys are `${key}#${index}`.

Provider: outbound-durable (on `storage.sql` and `wakeups`; gives up on `permanent` or after 24 h).
Suite: `createOutboundQueueConformance`, and the convergence suite.

### `startAnswerDelivery` ([delivery.ts](../packages/contracts/src/delivery.ts))

Not a capability: the outbound protocol every chat channel calls in `start`. The channel passes
`name`, `answers` (the feed), `store` (its `storage.kv` namespace), `transports`, `route(key)`, `text
(answer)`, `queue?`, `wakeups?` and a `DeliveryPolicy` (`retryMs`, `blockedAfter`, `window`,
`piecesPerRun`, `sendTimeoutMs`). It returns `{ wake(ctx), stop(signal) }`. What it guarantees: a
cursor (`answers-cursor`) per channel, one lane per conversation, retries, idempotency keys, and a
dashboard-only run never sent to a chat. Its header states the direct and queued guarantees and what
survives a crash at each step. See [message-flow.md](message-flow.md). The dashboard's request ids
start with `DASHBOARD_REQUEST_PREFIX` (`dashboard:`).

---

## Storage

### `storage.sql` ([storage.ts](../packages/contracts/src/storage.ts))

```ts
interface SqlDatabase {
  query(sql, params?): Promise<SqlRow[]>;
  run(sql, params?): Promise<{ changes: number }>;
  transaction<T>(work: (tx) => Promise<T>): Promise<T>;   // statements only: no network, no timer
}
```

Async, bound `?` parameters, one database per App, each component owns tables prefixed with its name
and creates them in `start`. The dialect is the subset SQLite and Postgres share (pi-durable's own
tables and runtime-pi's answers log use SQLite's, and are unprefixed: one runtime per database).
Providers: storage-sqlite (a file, server), storage-do (the Durable Object's SQLite). Suite:
`createSqlDatabaseConformance`.

### `storage.kv`

`namespace(name)` returns a `KeyValueStore`: `get`, `set`, `setIfAbsent` (exactly one concurrent
writer wins), `delete`. Values are JSON and copied; each call is atomic on its own, with no
transaction across calls. A component opens the namespace named after it. Provider: storage-kv-sql
(on `storage.sql`). Suite: `createKeyValueConformance`; double: `createMemoryKeyValueStorage`.

---

## Actors and time

### `actor.mailbox` and `actor.inbox` ([actor.ts](../packages/contracts/src/actor.ts), C2)

How a component reaches the actor that owns a key without knowing where it runs.

```ts
interface ActorMailbox {
  send(key, type, message: JsonValue, ctx): Promise<void>;        // resolves once the actor holds it durably
  call(key, type, message: JsonValue, ctx): Promise<JsonValue>;   // asks for an answer
}
interface ActorInbox {
  handle(type, (key, message, ctx) => Promise<void>): void;       // in start; one handler per type
  answer(type, (key, message, ctx) => Promise<JsonValue>): void;
}
```

- `send` rejects when no handler is registered for the type, the key is empty, the message is not
  JSON, the handler rejects, the actor is unreachable, or `ctx` is cancelled. A channel that gets a
  rejection does not acknowledge its platform. Delivery is at-least-once; handlers recognise repeats.
- `call` is neither retried nor deduplicated. It rejects with `ActorCallError` whose `code` is
  `invalid`, `no_handler`, `cancelled`, `unreachable`, `failed`, or the handler's own.
- Handlers are registered by method, not provided as a keyed capability: otherwise the mailbox would
  depend on every handler's component, a cycle through the runtime and `wakeups`.
- `answerCall` and `callResult` carry a call's outcome across an RPC, for providers.

Providers: mailbox-local (server: the App itself is every key's actor), platform-cloudflare (an RPC to
the Durable Object `idFromName(key)`; the object's own key is a local call). Types in use:
`telegram.update`, `telegram.stranger` (channel-telegram-webhook), and admin-api's `admin-api.*`
messages and calls. Suite: `createMailboxConformance`; double: `createMemoryMailbox`.

### `wakeups` ([wakeups.ts](../packages/contracts/src/wakeups.ts), C3, C4)

```ts
interface Wakeups {
  handle(name, handler: (ctx) => Promise<void>): void;   // in start; one owner per name
  at(name, time, ctx): Promise<void>;                     // replaces the name's request
  cancel(name, ctx): Promise<void>;
}
```

A request carries only a time; the handler reads what to do from its own state. Never early, maybe
late, at least once, one run per name at a time, a request made during a run stands after it, a
rejected handler runs again with backoff and never gives up. A request may come before its handler.
The handler's `ctx` is cancelled at the provider's slice deadline or when the App stops: it stops at a
consistent point, asks again, and resolves.

Providers: wakeups-timers (in-process timers, server; requests do not survive a restart, so a
component asks again at start), platform-cloudflare (rows in the object's SQL over its one alarm,
run in slices of `sliceMs`, 60 s by default). Names in use: `runtime-pi.drive`, `outbound-durable`,
`channel-telegram-webhook.answers`, `channel-telegram-webhook.typing`. Suite:
`createWakeupsConformance`; double: `createMemoryWakeups`.

### `WORKERS_HOST` ([cloudflare.ts](../packages/contracts/src/cloudflare.ts), C5)

A context key in `@pikit/contracts/cloudflare`, not a capability. deployment-cloudflare's entrypoints
put `{ env, origin?, object? }` on each App's start context; `object` has `id`, `storage`,
`onAlarm(handler)`, `onDeliver(handler)` and `onCall(handler)`. Only Cloudflare components read it
(storage-do, secrets-cloudflare, platform-cloudflare, runtime-pi, channel-telegram-webhook's Worker
half). Its types are structural: no `cloudflare:*` import.

---

## HTTP and admin

### `http.route` (keyed, [http.ts](../packages/contracts/src/http.ts))

One fetch handler `(request, ctx) => Response` per key `"METHOD /path"`. Segments are literal or
`:param`; a last `*` makes a prefix (`GET /admin/*`). The most specific key wins: literal, then with
parameters, then the longest prefix. A server guarantees: the request as sent, the response unchanged,
a context per request (cancelled when the client goes or the server stops), a thrown handler as a
`500` that reveals nothing, `404` for no match, and refuses to start on a key it cannot serve. Its own
routes (`/health`) come first. `parseHttpRouteKey`, `matchesHttpRoute` and `compareHttpRoutes` are
the shared grammar.

Servers (users): server-bun on a server, deployment-cloudflare's Worker host on Cloudflare. Routes:
channel-http (`POST /v1/messages`, `GET /v1/conversations/:id/messages/:messageId`, `POST
/v1/conversations/:id/reset`), channel-telegram-webhook's Worker half (`POST /telegram`, `POST
/telegram/<name>`, `GET /telegram/setup`), admin-api (`/admin/api/*`, `GET /admin/*`),
health-registry (`GET /admin/api/health-registry`). Suite: `createHttpRouteConformance`, run by
server-bun and deployment-cloudflare.

### `admin.auth` ([admin.ts](../packages/contracts/src/admin.ts))

`verify(request, ctx): Promise<Operator | undefined>`, and optional `sessions` (`open(request, ctx)`
returning `{ operator, cookie }`, `close(request)`). Closed by default; a provider that could verify
nobody fails the start; the credential never leaks; `verify` never consumes the body. A request
authenticated by a session cookie must carry `x-pikit-admin` (`ADMIN_CLIENT_HEADER`) to change
anything. Provider: admin-auth-token (a bearer `PIKIT_ADMIN_TOKEN` from `secrets`, signed 12 h
cookies). Suite: `createAdminAuthConformance`.

### `agent.observe` ([observe.ts](../packages/contracts/src/observe.ts))

Read-only, for operators: `conversations(page)`, `conversation(id)`, `transcript(id, page)` (newest
first), `watch(id)` (an async iterable: a `snapshot`, then changes; a consumer that falls behind gets a
new snapshot), `usage(id)`. It runs in the App that runs the runtime: on Cloudflare it sees only that
object's conversations. Provider: runtime-pi (`createObserver` in the adapter). Suite:
`createAgentObserveConformance` (in the adapter's tests and workerd).

---

## Models

- **`model.provider`** (keyed, `@pikit/pi-adapter`): one pi-ai `Provider` per id; agents name models
  as `provider/modelId`. Every pi-ai provider is a subpath `@pikit/pi-adapter/providers/<id>`.
  Providers: provider-anthropic, provider-openrouter, provider-openai-compatible, provider-faux
  (scripted models for tests). `modelProviders` in `component.json` lists their keys.
- **`model.credentials`** (`@pikit/pi-adapter`): pi-ai's `CredentialStore`, per provider id; pi-ai
  writes refreshed OAuth tokens back. Without it, providers read their environment variables (through
  `secrets` first, if installed). Provider: credentials-file (server only).
- **`model.complete`** ([model.ts](../packages/contracts/src/model.ts)): `complete({ model, system?,
  prompt, maxTokens? }, ctx): Promise<string>`. One text from one of the App's models: no
  conversation, no tools, not counted in any conversation's usage. Refuses a model none of the
  providers has. Provider: runtime-pi. User: admin-api (titles).

## Execution

All three are pi-durable's `ExecutionEnv` (files and a shell), in `@pikit/pi-adapter`.

- **`execution`**: the filesystem the agent's file tools work on. Its `exec` may answer
  `shell_unavailable`.
- **`execution.shell`**: the same, provided only when `exec` really runs commands. `tool-bash`
  requires it.
- **`workspace`**: `resolve(conversation, ctx): Promise<{ env }>`, each conversation's environment,
  resolved per tool call. Without it, tools work on `execution`.

Providers: execution-local (server: the machine's filesystem and shell), execution-do (Cloudflare:
files in the object's SQL, a simulated shell with `git`, `curl`, `node` as host commands, C7),
workspace-local (server: one directory per agent, inside `execution`). Suites:
`createDurableExecutionConformance` (`@pikit/pi-adapter/execution/testing`),
`createWorkspaceConformance` (`@pikit/pi-adapter/testing/neutral`).

## Platform

### `secrets` ([secrets.ts](../packages/contracts/src/secrets.ts))

`get(name): Promise<string | undefined>`; an empty value is not set. A secret never appears in config,
`describe()`, a log line or a transcript. Providers: secrets-env (the process environment), secrets-
cloudflare (the Worker's `env`). Suite: `createSecretStoreConformance`.

### `health` ([health.ts](../packages/contracts/src/health.ts))

`reporter(component)` returns `{ up(), degraded(reason), down(reason) }`; `snapshot()` returns
`{ status, components }`. A component's state is its last report; one that never reported is not
listed. Overall: all up is `up`; any degraded or a non-essential down is `degraded`; an essential one
down past the grace period is `down`. Reporting never throws or waits. Components report through
`useOptional("health")`. Provider: health-registry (also `GET /admin/api/health-registry` and a
dashboard view). Users: channel-telegram (each bot), server-bun (`/health` answers its status). Suite:
`createHealthConformance`.

## A registry's own contracts

A registry adds a capability without changing the CLI: the defining component declares it in
`component.json` (`declares.capabilities`, and `declares.kinds` for a new prefix), keeps its type in a
file of its own (declaration merging on `AppCapabilities`), and ships a suite. Another component that
uses it carries an identical copy of that file. Redeclaring a kit capability is refused. No component
in this registry declares one today; [features/memory.md](../features/memory.md) is the worked example.
