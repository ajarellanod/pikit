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
| `agent.runtime` | single | runtime-pi | admin-api, channel-http, channel-telegram, channel-telegram-webhook, channel-web | `createAgentRuntimeConformance` |
| `agent.conversations` | single | runtime-pi | conversations-file, conversations-kv | none of its own |
| `agent.submissions` | single | runtime-pi | channel-telegram, channel-telegram-webhook, channel-web, channel-http? | `createSubmissionsConformance`, `createFeedConformance` |
| `agent.observe` | single | runtime-pi | admin-api, channel-web | `createAgentObserveConformance` |
| `agent.definition` | keyed | the project | admin-api?, agents-live?, extension-pikit-self?, router-basic?, router-rules?, runtime-pi?, tool-delegate? | none (`defineAgent` validates) |
| `agent.directory` | single | agents-live | admin-api?, router-rules?, runtime-pi? | `createAgentDirectoryConformance` |
| `agent.tool` | keyed | tool-bash, tool-delegate, tool-edit, tool-fetch, tool-mcp, tool-read, tool-websearch-brave, tool-write | agents-live?, runtime-pi? | none |
| `agent.skill` | keyed | the project | agents-live?, runtime-pi? | none (`defineSkill` validates; runtime-pi checks each key is its skill's name) |
| `agent.extension` | keyed | extension-house-rules, extension-pikit-self | agents-live?, runtime-pi? | none |
| `agent.command` | keyed | admin-api, runtime-pi | admin-api? | `createAgentCommandConformance` |
| `conversations.registry` | single | conversations-file, conversations-kv | admin-api, channel-http, channel-telegram, channel-telegram-webhook, channel-web | `createConversationRegistryConformance` |
| `outbound.queue` | single | outbound-durable | admin-api?, channel-telegram-webhook?, channel-telegram?, channel-web? | `createOutboundQueueConformance` |
| `storage.sql` | single | storage-do, storage-sqlite | admin-api, channel-web, outbound-durable, repo-github-app, runtime-pi, settings-store, storage-kv-sql | `createSqlDatabaseConformance` |
| `storage.kv` | single | storage-kv-sql | channel-telegram, channel-telegram-webhook, channel-web, conversations-kv, health-registry?, tool-mcp? | `createKeyValueConformance` |
| `actor.mailbox` | single | mailbox-local, actors-do | admin-api, channel-telegram-webhook, channel-web, repo-github-app, settings-store | `createMailboxConformance` |
| `actor.inbox` | single | mailbox-local, actors-do | channel-telegram-webhook, repo-github-app, admin-api?, channel-web?, settings-store? | `createMailboxConformance` |
| `wakeups` | single | actors-do, wakeups-timers | channel-telegram-webhook, outbound-durable, channel-web?, runtime-pi? | `createWakeupsConformance` |
| `http.route` | keyed | admin-api, admin-proposals, channel-http, channel-telegram-webhook, channel-web, repo-github-app, health-registry, settings-store | server-bun? | `createHttpRouteConformance` (run by servers) |
| `admin.auth` | single | admin-auth-token | admin-api, admin-proposals?, channel-web?, health-registry?, repo-github-app?, settings-store? | `createAdminAuthConformance` |
| `secrets` | single | secrets-workers, secrets-env | admin-auth-token, channel-http, channel-telegram, channel-telegram-webhook, channel-web, email-resend, email-ses, repo-github-app, repo-github-token, tool-websearch-brave, provider-failover?, runtime-pi?, tool-mcp? | `createSecretStoreConformance` |
| `settings` | single | settings-store | agents-live, channel-web?, repo-github-token?, router-basic?, router-rules?, runtime-pi? | `createSettingsConformance` |
| `repo.github` | single | repo-github-app, repo-github-token | proposals-github | `createGitHubConformance` |
| `proposals` | single | proposals-github, proposals-local | admin-proposals, execution-do?, extension-pikit-self? | `createProposalsConformance` |
| `health` | single | health-registry | channel-telegram?, provider-failover?, server-bun? | `createHealthConformance` |
| `email.send` | single | email-resend, email-ses | channel-web? | `createEmailSenderConformance` |
| `model.complete` | single | runtime-pi | admin-api? | `createModelCompleteConformance` |
| `model.provider` | keyed | provider-anthropic, provider-failover, provider-faux, provider-openai, provider-openai-compatible, provider-openrouter | agents-live?, provider-failover?, runtime-pi? | none |
| `model.credentials` | single | credentials-file | provider-failover?, runtime-pi? | `createCredentialStoreConformance` (`@pikit/pi-adapter/testing/neutral`) |
| `execution` | single | execution-do, execution-local | tool-edit, tool-read, tool-write, workspace-local, runtime-pi? | `createDurableExecutionConformance` (`@pikit/pi-adapter/execution/testing`) |
| `execution.shell` | single | execution-do, execution-local | tool-bash | same |
| `workspace` | single | workspace-local | runtime-pi?, tool-bash?, tool-edit?, tool-read?, tool-write? | `createWorkspaceConformance` (`@pikit/pi-adapter/testing/neutral`) |

Two more suites check behaviour rather than one capability: `createChannelConformance` (what every
channel does with a message and its answer: channel-http, channel-telegram, channel-telegram-webhook, channel-web)
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

- `AgentRequest` is `{ requestId, conversation, prompt, images?, whenBusy?, sender? }`. `ConversationRef` is
  `{ key, agent, conversationId, channel? }`: the channel's key, the agent's name, the runtime's
  conversation, and the channel the conversation belongs to for good (`telegram`, `http`, `dashboard`,
  `delegate`). `conversations.registry` records the channel with the key's first resolve; the runtime
  records it with the conversation, so a run sees it (`CONVERSATION`, `PrepareContext`, its `workspace`)
  even when the ref that reached it has none (an operator's action). It is for treating a channel's
  conversations apart (a directory, a prompt), never for finding where an answer goes. Settlements
  (`AgentResult`, `agent.submissions`) do not carry it.
- `sender` (`Sender`, `{ channel, id }`) is who sent the message, as its producer established it:
  `admitInbound` gives the message's actor (`{ channel, id: actor.id }`), admin-api the operator
  (`{ channel: "dashboard", id }`), tool-delegate's tasks the delegating agent (`{ channel: "delegate",
  id }`). The runtime keeps it with the message, durably, and gives it to the run that takes the
  message (`RUN_REQUESTS`, below); it is not in the result nor in `agent.submissions`.
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

Provider: runtime-pi (on pi-durable, through `@pikit/pi-adapter`'s `createDurableRuntime`), the only
one for good: Pi is the only agent runtime (SPEC §3.3), as for every runtime contract below.
Suite: `createAgentRuntimeConformance`, run by runtime-pi with and without `wakeups`, by the adapter,
and in workerd; it also checks a runtime refuses to start with two stewards (`stewardProblem`).

### `agent.conversations`

`create(ctx): Promise<string>`: a new, empty conversation in the runtime's storage. Only
`conversations.registry` uses it, on a key's first message and on a reset. Provider: runtime-pi (in a
Durable Object, the object's root conversation first).

### `agent.definition` (keyed, provided by the project)

One `AgentDefinition` per agent name: `{ name, model: "provider/modelId", steward?, systemPrompt?,
tools?, extensions?, skills?, state?, prepare?(state, ctx) }`, checked by `defineAgent`. `steward: true` marks
the project's main agent, the one its operators may ask to change it (SPEC §6): at most one per App
(the runtime refuses to start with two: `stewardProblem`, which the `agent.runtime` suite checks),
and only it may name `pikit-self` (extension-pikit-self
refuses to start otherwise). `tools` names `agent.tool`
keys or holds tool objects; `extensions` names `agent.extension` keys; `skills` names `agent.skill`
keys (the project's catalog) or holds skills of the agent's own. An agent gets only what it
names. A skill is an `AgentSkill` (`defineSkill` over a `SKILL.md`, [skill.ts](../packages/contracts/src/skill.ts):
the Agent Skills format Pi's coding agent reads): the runtime lists each one's name, description and
location in a system prompt section and gives the agent the tool `skill` (`SKILL_TOOL`), which loads
one's instructions; an agent with skills may not have a tool of its own named `skill`
(`skillsProblem`). `prepare` is pure and synchronous: from the conversation's state it returns the
fields that change for this run (`skills` among them). The project provides agents (`src/extensions/agents.ts`); runtime-pi refuses to
start when an agent names a model, tool, extension or skill nothing provides.

### `agent.directory` ([agent-directory.ts](../packages/contracts/src/agent-directory.ts), optional)

Agents that are data: names no component provided at setup (an operator's, made in the dashboard).
`list(ctx)` (by name) and `get(name, ctx)` of `DirectoryAgent`s, JSON: `{ name, description?, model,
systemPrompt?, tools?, extensions?, skills? }`, each one `defineAgent` accepts. Never an `agent.definition`
key, never the steward (no `steward` field, no `pikit-self`); answers are copies; a change applies to
the next read. runtime-pi resolves a name from `agent.definition` first, then here, and checks a live
agent when used (a model, installed tools, extensions and skills), failing that admission otherwise;
router-rules checks a rule's agent here when a message matches it; admin-api lists them (`live:
true`). Provider: agents-live (its settings). Suite: `createAgentDirectoryConformance` (agents-live,
and in workerd over settings-store on storage-do).

### `agent.state`, `CONVERSATION` and `RUN_REQUESTS` (context keys, not capabilities)

The runtime puts all three in the context of everything that runs for a conversation: its tools, and
the system prompt sections and hooks (generation, tool, compaction) of its agent's extensions.

- `AGENT_STATE` ([agent-state.ts](../packages/contracts/src/agent-state.ts)): the conversation's JSON
  state. `get(ctx)`, `update(patch, ctx)` (a shallow merge, committed, one at a time per conversation;
  a non-JSON patch is refused). It lives in the runtime's conversation and restarts from `state` after
  a reset. A tool reads it with `context.value(AGENT_STATE)`. Suite: `createAgentStateConformance`
  (run in the adapter's `prepare.test.ts`).
- `CONVERSATION` ([conversation-context.ts](../packages/contracts/src/conversation-context.ts)): the
  run's `ConversationRef`, for a tool that needs to know whose run it is in.
- `RUN_REQUESTS` ([run-requests.ts](../packages/contracts/src/run-requests.ts)): `list(ctx)`, the
  requests the run in progress takes (its starter, the follow-ups queued with it, the steers that
  joined it), each with its `sender`, read when asked; empty with no run going. Whose memory, which
  rules: code decides with it, never with the model (extension-house-rules' `senderTools`). Suite: the
  `agent.runtime` suite's sender cases (a request's sender, queued requests, a steer joining).

### `agent.skill` (keyed, provided by the project)

The project's skills, its catalog: one `AgentSkill` per name, keyed by `AgentSkill.name`
(`defineSkill(text, { name: <its folder> })`). Agents name the ones they know in `skills`
(`skills: ["review"]`); a skill installed and named by no agent is no agent's, as with tools. runtime-pi
refuses to start when an agent names a skill nothing provides, or when a key is not its skill's name;
a live agent (`agent.directory`) names skills too, checked when used, and agents-live offers the
installed ones. runtime-pi's overrides turn off, live, skills an agent's definition names. Adding or
changing a skill is a change to the project (SPEC §6); choosing which installed skills an agent has is
configuration, as its tools are.

```ts
// a project component, as src/extensions/agents.ts provides the agents:
import review from "../skills/review/SKILL.md" with { type: "text" };
const skill = defineSkill(review, { name: "review" });
pikit.provideKeyed("agent.skill", skill.name, skill);
```

### `agent.tool` (keyed)

One tool per name the model calls it by: pi-durable's `ToolRegistration` (`defineTool` from
`@pikit/pi-adapter/tools`), with its `replay` (`safe`: an interrupted call runs again on recovery;
`unsafe`: the model gets an interrupted result). `component.json`'s `replay.tools` records it. A tool
that works on `api.env` must use `execution` or `execution.shell`. Registry tools: `read` (safe),
`write`, `edit`, `bash`, `fetch` (unsafe), `websearch` (safe), `delegate` (safe), and tool-mcp's
`<server>_<tool>`.

A tool cannot use `agent.runtime` or `conversations.registry` (the runtime uses every tool: a cycle).
What a tool may need of the runtime is in its context, from the runtime's `scope`: besides the keys
above, `AGENT_DELEGATION` (`@pikit/pi-adapter/tools`, Pi-shaped: it takes the call's `api`), the
runtime's delegation on pi-durable's subagents: `run(api, { agent, key, channel, task, sender })`, a child
conversation of another agent owned by the call (stopping the run stops it; a rerun finds it), or
`start(…)`, one that outlives the run, whose answer is admitted to the parent through `dispatch`
(request id `delegate-result:<task id>`). Used by tool-delegate. Tested by the adapter's
`delegation.test.ts` and the workerd lane.

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
  resolve(key, agent, channel, ctx): Promise<ConversationRef>; // creates on first call, then returns the record
  get(key, ctx): Promise<ConversationRef | undefined>;  // creates nothing
  reset(key, agent, ctx): Promise<ConversationReset | undefined>; // agent: undefined keeps the key's
}
```

- The pointer is a record, never memory. Concurrent first resolves of one key make one conversation.
- A conversation keeps the agent and the channel it was created with: a later resolve's change nothing,
  a reset keeps the channel. `admitInbound` resolves with the message's channel, admin-api with
  `dashboard`. Every ref the registry gives has its channel.
- `reset` points the key to a new conversation, keeps the old one, and emits `conversation.reset`
  once the pointer is durable. No pointer is ever deleted. `reset(key, agent, ctx)` with an `agent` gives
  the new conversation another agent (`undefined` keeps the key's): what `admitInbound` does when the key's agent is gone (below).

Providers: conversations-kv (on `storage.kv`, both targets), conversations-file (a JSON file, server).
Both use `agent.conversations`, so the runtime starts first.

### The inbound path ([inbound.ts](../packages/contracts/src/inbound.ts))

Not a capability: a function and two pipelines every channel shares. `admitInbound(ctx, message,
{ conversations, runtime, key, beforeDispatch? })` runs `inbound.normalize`, then `route.resolve`,
then `conversations.resolve(key, agent)`, then `runtime.dispatch`, and returns an `InboundOutcome`:
`admitted`, `duplicate`, `halted` (a stage halted), `denied` (the router said deny) or `no_route` (no
stage decided). It throws when a stage changed the message's `id`, `channel` or `conversationId`, or
when a capability fails. A dispatch rejected with `AgentUnavailableError` (the conversation's agent
is gone for good: removed, a live agent deleted) is not thrown: the key moves to a new conversation of
the agent routed now and the message goes there, or, when routing names the gone agent, it is
`denied`. The `InboundMessage` is `{ id, channel, conversationId, actor: { id }, text, images? }` (a
field is added, optional, with the component that reads it); its `id` becomes the request id, its
actor the request's sender, its `images` (channel-web's attachments, bounded by the channel) the
request's `images`. A normalize stage keeps the images unless it means to change them. See [pipelines.md](pipelines.md).

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
  pending(page): Promise<Page<PendingPiece>>;         // what is not settled yet, never its text
}
```

- The same `idempotencyKey` enqueued twice is stored once. Each conversation's pieces go in order.
- At-least-once: a piece whose send may have reached the platform goes again with
  `possibleDuplicate`.
- A piece is abandoned at the provider's maximum age whatever the reason, also when its channel
  never attaches a transport again (the channel was removed): nothing stays open for good.
- Events `outbound.delivered` and `outbound.abandoned` are notices (log-events logs them);
  `receipts` is the record.
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
(`-` as `_`; `registry validate` checks the names its shipped files create) and creates them in
`start`. The dialect is the subset SQLite and Postgres share (pi-durable's own
tables and runtime-pi's answers log use SQLite's, and are unprefixed: one runtime per database).
Providers: storage-sqlite (a file, server), storage-do (the Durable Object's SQLite). Suite:
`createSqlDatabaseConformance`.

### `storage.kv`

`namespace(name)` returns a `KeyValueStore`: `get`, `set`, `setIfAbsent` (exactly one concurrent
writer wins), `delete`. Values are JSON and copied; each call is atomic on its own, with no
transaction across calls. A component opens the namespace named after it (`registry validate` checks it). Provider: storage-kv-sql
(on `storage.sql`). Suite: `createKeyValueConformance`; double: `createMemoryKeyValueStorage`.

---

## Actors and time

### `actor.mailbox` and `actor.inbox` ([actor.ts](../packages/contracts/src/actor.ts), C2)

How a component reaches the actor that owns a key without knowing where it runs.

```ts
interface ActorMailbox {
  send(key, type, message: JsonValue, ctx): Promise<void>;        // resolves once the actor holds it durably
  call(key, type, message: JsonValue, ctx): Promise<JsonValue>;   // asks for an answer
  stream(key, type, message: JsonValue, ctx): Promise<AsyncIterable<JsonValue>>; // asks for answers as they come
}
interface ActorInbox {
  readonly scope: "all" | "one";                                  // whose actor this App is: every key's, or one key's
  handle(type, (key, message, ctx) => Promise<void>): void;       // in start; one handler per type
  answer(type, (key, message, ctx) => Promise<JsonValue>): void;
  answerStream(type, (key, message, ctx) => Promise<AsyncIterable<JsonValue>>): void;
}
```

- `send` rejects when no handler is registered for the type, the key is empty, the message is not
  JSON, the handler rejects, the actor is unreachable, or `ctx` is cancelled. A channel that gets a
  rejection does not acknowledge its platform. Delivery is at-least-once; handlers recognise repeats.
- `call` is neither retried nor deduplicated. It rejects with `ActorCallError` whose `code` is
  `invalid`, `no_handler`, `cancelled`, `unreachable`, `failed`, or the handler's own.
- `stream` is refused as `call` is, before its first value. Then it yields a JSON copy of each value
  in order, read only as the caller reads, and ends with the handler's stream, or throws an
  `ActorCallError`: the stream's own code (`failed` for any other error or a value that is not JSON),
  `unreachable` (the actor's App stopped, its object was evicted), `cancelled`. Closing it, or
  cancelling `ctx`, closes the handler's stream and cancels its context. On Cloudflare an open stream
  keeps its object in memory: callers close the ones nobody reads.
- Handlers are registered by method, not provided as a keyed capability: otherwise the mailbox would
  depend on every handler's component, a cycle through the runtime and `wakeups`.
- `scope` is what a component whose state every key shares reads instead of the target (K1): with
  `"one"` that state is another actor's, reached through `actor.mailbox` (settings-store's settings
  object, admin-api's index). The suite checks it against where the messages were handled.
- `answerCall` and `callResult` carry a call's outcome across an RPC, for providers; `answerStream`
  and `streamResult` a stream's (a byte stream of JSON frames, one per line, with beats while the
  actor waits when its provider asks for them: an RPC stream notices a caller gone only when it writes).

Providers: mailbox-local (server: the App itself is every key's actor, `scope` `"all"`), actors-do
(an RPC to the Durable Object `idFromName(key)`; the object's own key is a local call; `scope` `"one"`). Types in use:
`telegram.update`, `telegram.stranger` (channel-telegram-webhook), and admin-api's `admin-api.*`
messages, calls and its one stream (`admin-api.live`). Suite: `createMailboxConformance`; double: `createMemoryMailbox`.

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
component asks again at start), actors-do (rows in the object's SQL over its one alarm,
run in slices of `sliceMs`, 60 s by default). Names in use: `runtime-pi.drive`, `outbound-durable`,
`channel-telegram-webhook.answers`, `channel-telegram-webhook.typing`. Suite:
`createWakeupsConformance`; double: `createMemoryWakeups`.

### `WORKERS_HOST` ([cloudflare.ts](../packages/contracts/src/cloudflare.ts), C5)

A context key in `@pikit/contracts/cloudflare`, not a capability. deployment-cloudflare's entrypoints
put `{ env, origin?, object? }` on each App's start context; `object` has `id`, `storage`,
`onAlarm(handler)`, `onDeliver(handler)`, `onCall(handler)` and `onStream(handler)`. Only Cloudflare components read it
(storage-do, secrets-workers, actors-do, runtime-pi, channel-telegram-webhook's Worker
half). Its types are structural: no `cloudflare:*` import. Its test helper, `withWorkersHost` (a
component gets the host in its start context, as from the entrypoint), is in
`@pikit/contracts/cloudflare/testing`, apart from the neutral suites.

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
health-registry (`GET /admin/api/health-registry`), and the dashboard routes of admin-proposals,
repo-github-app and settings-store. Suite: `createHttpRouteConformance`, run by
server-bun and deployment-cloudflare.

### `admin.auth` ([admin.ts](../packages/contracts/src/admin.ts))

`verify(request, ctx): Promise<Operator | undefined>`, and optional `sessions` (`open(request, ctx)`
returning `{ operator, cookie }`, `close(request)`). Closed by default; a provider that could verify
nobody fails the start; the credential never leaks; `verify` never consumes the body. A request
authenticated by a session cookie must carry `x-pikit-admin` (`ADMIN_CLIENT_HEADER`) to change
anything. Provider: admin-auth-token (a bearer `PIKIT_ADMIN_TOKEN` from `secrets`, signed 12 h
cookies). Suite: `createAdminAuthConformance`.

### `agent.observe` ([observe.ts](../packages/contracts/src/observe.ts))

Read-only, for a reader the consumer authorized for that conversation: an operator (`admin.auth`,
admin-api), or a channel's user for their own conversation (channel-web, by its key); a consumer
that shows it to someone who is not an operator projects what that person may see (channel-web's
live view: the answer's text and the tools' names, nothing else). `conversations(page)`,
`conversation(id)`, `transcript(id, page)` (newest
first), `watch(id)` (an async iterable: a `snapshot`, then changes; a consumer that falls behind gets a
new snapshot), `usage(id)`. It runs in the App that runs the runtime: on Cloudflare it sees only that
object's conversations. Pages are `Page<T>` (`{ items, next? }`) asked for with a `PageRequest`
(`{ limit?, cursor? }`), both in [page.ts](../packages/contracts/src/page.ts): a view of now, not a
feed (`outbound.queue`'s `pending` pages the same way). Provider: runtime-pi (`createObserver` in the
adapter). Suite:
`createAgentObserveConformance` (in the adapter's tests and workerd).

---

## Models

- **`model.provider`** (keyed, `@pikit/pi-adapter`): one pi-ai `Provider` per id; agents name models
  as `provider/modelId`. Every pi-ai provider is a subpath `@pikit/pi-adapter/providers/<id>`.
  Providers: provider-anthropic, provider-openai, provider-openrouter, provider-openai-compatible, provider-faux
  (scripted models for tests), and provider-failover (`failover/<chain>`: a chain of the other
  providers' models, a request moving to the next model when one fails before it answers). `modelProviders` in
  `component.json` lists their keys.
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
workspace-local (server: one directory per agent, or per channel of each agent from `ConversationRef.channel`,
inside `execution`). Suites:
`createDurableExecutionConformance` (`@pikit/pi-adapter/execution/testing`),
`createWorkspaceConformance` (`@pikit/pi-adapter/testing/neutral`), and for a shell with `git`,
`createWorkspaceGitConformance` (`@pikit/pi-adapter/execution/testing`): the steward's steps
(`clone`, `checkout -b`, `status`, `diff`, `add`, `commit -m`, `log`, `push origin <branch>`) through
the shell against a remote, with real git's meaning, and given the remote's credential, that it
appears nowhere the agent can read (every durable provider's rule, SPEC C7).

## Platform

### `secrets` ([secrets.ts](../packages/contracts/src/secrets.ts))

`get(name): Promise<string | undefined>`; an empty value is not set. A secret never appears in config,
`describe()`, a log line or a transcript. Providers: secrets-env (the process environment), secrets-
cloudflare (the Worker's `env`). Suite: `createSecretStoreConformance`.

### `settings` ([settings.ts](../packages/contracts/src/settings.ts))

Values an operator changes live from the dashboard, read when used (SPEC §6, "What changes live is
data"; [features/settings.md](../features/settings.md)). The contract is what a component sees:

```ts
interface Settings {
  declare(component, schema, defaults): void;        // in start, once per App
  get<T>(component, ctx): Promise<T>;                 // the stored value over the defaults, valid
}
```

- Config or setting, never both: config is deployed and read at start, a setting is changed by an
  operator and read when used (its default may come from config).
- A setting is never a secret, only a secret's name (`tokenSecret: "GITHUB_TOKEN"`). A provider holds
  every component to it with two shared checks: `declare` refuses a schema whose secret-named string
  (`apiKey`, `token`, `password`...) is free (`secretSettingProblem`: it must have
  `pattern: SECRET_NAME_PATTERN`) and defaults holding a credential; an operator's change holding one
  (a known shape, whole or as a word: `sk-...`, `ghp_...`, a bot token, a JWT) is refused
  (`credentialSettingProblem`). Neither refusal, nor any log line, echoes the value; the suite checks
  both.
- `declare` takes a JSON Schema of an object (TypeBox's `Type.Object`) and defaults it must accept;
  it throws otherwise, and on a second declaration.
- `get` answers a copy: each top-level key the operator stored over its default; a stored key the
  schema no longer accepts is left out, its default used, and logged. An undeclared component is
  `SettingsError` (`unknown_component`); any other rejection is the store's, and a consumer keeps
  what it read last, or its config.
- An operator's change applies to the next `get` of every App within the provider's bound (a second
  on Cloudflare), and outlives a restart.
- How an operator changes them is the provider's own surface, not the contract's: settings-store's
  dashboard routes and Settings section (`SettingsStore`: `set`, `sections`, `invalid_value`).

Provider: settings-store (on `storage.sql`; on Cloudflare the values are one object's,
`settings-store:settings`, which every App reaches through `actor.mailbox`). Users: agents-live (its agents), router-basic, router-rules, runtime-pi (an agent's
overrides), repo-github-token (the repository). Suite: `createSettingsConformance`, whose fixture changes
values as an operator would (`operate`).

### `repo.github` ([github.ts](../packages/contracts/src/github.ts))

The project's own repository on GitHub and a token for it: what self-improvement needs (SPEC §6).

```ts
interface GitHubAccess {
  repository(ctx): Promise<string | undefined>;   // "owner/name", the connected one
  token(ctx): Promise<string>;                     // for it; GitHubNotConnectedError while none is
}
```

- `repository` is read when asked: connecting, choosing another or disconnecting applies to the next
  call of every App (within the provider's bound, a second).
- `token` lasts at least `GITHUB_TOKEN_MIN_LIFE_MS` (5 minutes) when it resolves, and GitHub accepts it
  for that repository; it may be answered again while it lasts. While nothing is connected it rejects
  with `GitHubNotConnectedError` (`code: "not_connected"`, `isGitHubNotConnected`), saying how to
  connect. A token is never logged, stored or put in an error.

Providers, interchangeable: repo-github-app (Cloudflare: a GitHub App the operator creates and installs
from the dashboard; installation tokens minted with the App's JWT, its key sealed with a key derived
from the admin token) and repo-github-token (both targets: a `GITHUB_TOKEN` secret and the repository, a
setting). User, which never branches on the provider: proposals-github (its pull requests: read,
opened, merged, closed, and the credential of its `remote()`). The steward's workspace never reads
`repo.github`: execution-do pushes to `proposals.remote()`. Without a provider nothing is connected. Suite: `createGitHubConformance` (repo-github-app in
Bun and in workerd, repo-github-token).

### `proposals` ([proposals.ts](../packages/contracts/src/proposals.ts))

The agent's changes to itself, waiting for an operator (SPEC §6). The steward proposes the same way
whatever the provider: it clones `remote()`, commits on `pikit/self/<topic>` and pushes it; the
pushed branch is the proposal (its head commit's first line the title, the rest the description).

```ts
interface Proposals {
  status(ctx): Promise<ProposalsStatus>;   // ready or not, part by part; the deploys when known
  list(ctx): Promise<ProposalList>;        // where they live, checks before or after approval, open then closed
  get(id, ctx): Promise<ProposalDetail>;   // description, files with patches, checks, deploy
  approve(id, { head?, override?, operator }, ctx): Promise<ApproveOutcome>;
  reject(id, { comment?, operator }, ctx): Promise<RejectOutcome>;
  remote(ctx): Promise<ProposalsRemote | undefined>; // a path, or an https URL with authorization() for trusted code
}
```

- An id is the branch's topic. Only branches under the prefix of the project's own repository are
  proposals: anything else is `not_found`.
- An action is refused as an outcome, before anything is written: `not_found`, `not_open`, `moved`
  (the head is not the one the operator read), `checks_failing` (unless `override`), `wrong_base`,
  `not_mergeable`. A failure to reach where proposals live is `ProposalsError` with a code
  (`not_connected` while not set up, `rate_limited` with `retryAfter`…); the HTTP status is the
  route's (admin-proposals maps each code to one).
- What only some providers have is optional and in plain words: `ref` (`#42`, how the place proposals
  live names one), `draft`, `mergeDetail` (why it does or does not merge), `previewUrl`.
- An https remote's `authorization()` is read when git needs it, and rejects, saying why, when the
  credential cannot be had now; trusted code sends it to that remote alone.
- Providers, interchangeable: proposals-local (server: branches of a bare repository in the state
  volume, approvals for deployment-docker's deployer, which merges, checks, deploys and rolls back)
  and proposals-github (Cloudflare: pull requests opened for pushed branches, merged through GitHub's
  API, GitHub through `repo.github`). Users: admin-proposals (the dashboard's routes, view and section),
  extension-pikit-self (`remote()`, for the steward's steps), execution-do (`remote()`: the only
  remote its `git` pushes to, under its `branchPrefix`). Suite: `createProposalsConformance`
  (both providers).

### `health` ([health.ts](../packages/contracts/src/health.ts))

`reporter(component)` returns `{ up(), degraded(reason), down(reason) }`; `snapshot()` returns
`{ status, components }`. A component's state is its last report; one that never reported is not
listed. Overall: all up is `up`; any degraded or a non-essential down is `degraded`; an essential one
down past the grace period is `down`. Reporting never throws or waits. Components report through
`useOptional("health")`. Provider: health-registry (also `GET /admin/api/health-registry` and a
dashboard view). Users: channel-telegram (each bot), server-bun (`/health` answers its status). Suite:
`createHealthConformance`.

### `email.send` ([email.ts](../packages/contracts/src/email.ts))

One email to one person, for a component that must reach someone by email (a verification, a
password reset, a sign-in link, an invitation).

```ts
interface EmailSender {
  send({ to, subject, text, html? }, ctx): Promise<{ id: string }>;   // the provider's id, once it accepted it
}
```

- One recipient per call, a plain address; `subject` and `text` not empty, the subject on one line.
  Anything else is `invalid` before a request is made (`emailMessageProblem`, which every provider
  runs first).
- The sender is the provider's (its `EMAIL_FROM` variable): a component never picks one.
- Every rejection is an `EmailError` with a `code`: `invalid` (the address or the message: never
  retry), `rejected` (the provider refused: an unverified sender, a suppressed address, a suspended
  account, its credentials) or `unavailable` (the network, a timeout, a cancelled `ctx`, 429, 5xx:
  retry later; one after the request left may have been sent). The provider retries nothing and
  stores nothing.
- No error message or log line holds the subject, the text, the html or a link (a link is a sign-in):
  what the provider's API says is cleaned by `emailErrorDetail` first.
- `ctx` bounds it (a cancelled one sends nothing, or stops waiting), and so does the provider's own
  timeout.

Providers, variables only (a `fetch` to an HTTP API, both targets): email-resend (Resend's
`POST /emails`, `RESEND_API_KEY`) and email-ses (Amazon SES v2 `SendEmail`, signed with SigV4 over Web
Crypto, `AWS_SES_*`). Consumer: channel-web's accounts (being built). Suite:
`createEmailSenderConformance`, against a fake of each provider's HTTP API (both providers).

## A registry's own contracts

A registry adds a capability without changing the CLI: the defining component declares it in
`component.json` (`declares.capabilities`, and `declares.kinds` for a new prefix), keeps its type in a
file of its own (declaration merging on `AppCapabilities`), and ships a suite. Another component that
uses it carries an identical copy of that file. Redeclaring a kit capability is refused. No component
in this registry declares one today; [features/memory.md](../features/memory.md) is the worked example.
