# pikit — Technical Specification

Status: **draft v0.1**. §4 (core) is implemented in `packages/core`; the rest describes
intent and contracts. `[open]` is undecided, `[decision]` is settled, `[planned]` is agreed
but not built, and `[upstream]` depends on experimental Pi APIs and must be isolated behind
the Pi adapter. Principles live in `MANIFESTO.md`; milestones and the standards they must
meet live in `ROADMAP.md`.

---

## 1. Goals and non-goals

### Goals

1. A **small, stable core** that defines how components communicate and nothing else.
2. **Source-owned components** installed into the user's project, editable and removable.
3. A **typed, event-driven app lifecycle** covering the full path from inbound message to
   delivered reply, modeled the way Pi models the agent loop.
4. **Two runtimes from the same project**: long-running server (Bun/Node) and serverless
   Cloudflare Workers + Durable Objects.
5. **Pi as the agent runtime**, consumed through its public, runtime-neutral packages.
6. A CLI that makes add / edit / remove / diff / upgrade practical.

### Non-goals

- Reimplementing anything Pi already does. Pi is the agent: loop, providers, compaction,
  retries, steering and follow-up queues, session serialization, resume, tool execution,
  skills. pikit is the kit around it (§6.2, "Pi first"). Before building an agent-facing
  feature, check Pi; if Pi does it, use it through the adapter.
- Dynamic plugin loading in production. Components are compiled in at build time.
- A hosted registry service. Registries are Git repos or static JSON + files.
- Matching feature-for-feature with OpenClaw or Hermes.
- Supporting agent runtimes other than Pi in v1 (the `AgentRuntime` boundary exists so it is
  *possible*, not so it is *done*).
- A hooks-style or directive-based programming model. No `'use agent'`, no `useX()` with
  implicit context, no compiler transform, no mandatory build plugin. Components register
  plain functions against an explicit `pikit` object; composition is a file you read.
  Dynamic behavior is `prepare(state)` (§6.2a), not re-executed agent functions.
- A workflow DSL. Multi-step processes are persisted state plus conditional tools.
- Owning the harness pieces in a runtime package. Router, session stores, outbox, scheduler,
  approvals, and channel ingress are components the user copies, not exports of `@pikit/core`.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Core** | `@pikit/core`. Events, pipelines, capabilities, lifecycle, config, diagnostics. |
| **App** | `[decision]` The composed, running service: `defineApp({ components, config }).create()`, then `start()`/`stop()`. One per process on the server target, one per Durable Object on Cloudflare. It hosts many conversations; it is not Pi's `AgentHarness`, which runs one conversation's agent loop. Named `App` rather than `Harness` for that reason. |
| **Component** | An installable unit of source: files + manifest + optional migrations, tests, config schema. Copied into the project. |
| **Extension** | Runtime behavior registered against the app lifecycle (`pikit.on`, `pikit.pipeline`, `pikit.provide`). Usually the entry point of a component; may also be a standalone project file. |
| **Capability** | A named, typed service that exactly one component provides and others consume (`sessions.store`, `execution.shell`). |
| **Event** | A typed notification. All listeners receive it; none can change its outcome. |
| **Pipeline** | A typed, ordered transformation chain. Each stage receives the previous stage's output. |
| **Registry** | A source of components: official, third-party, private, or local. |
| **Runtime target** | Where the app runs: `server` or `cloudflare`. |
| **Agent runtime** | The thing that runs the agent loop. In v1: Pi. |
| **Conversation key** | Stable identity of an external conversation (`tenant:channel:conversation`). |
| **Actor** | A conversation seen as a unit of execution: a stable identity, a durable state (its session) and a mailbox (Pi's inbox). pikit's only kind of actor is the conversation (§7). |
| **Worker** | Wherever an actor's steps run right now: a server process, a Durable Object instance. Holds nothing that cannot be rebuilt from the actor's records. Not to be confused with a Cloudflare Worker, which is pikit's ingress. |
| **Ingress** | The stateless part that receives from channels, authenticates, normalizes and routes to the actor. |
| **Conversation ownership** | Which worker has an actor's session open. Always at most one (§7.2). Not to be confused with source ownership (the user owns the code). |
| **Session** | A Pi session: transcript, inbox (steer / follow-up / next-run queues), operations, values. The actor's state. A conversation points to its active session. |
| **Workspace** | The filesystem an agent operates on. Distinct from the session. |

---

## 3. Layering

```
┌───────────────────────────────────────────────────────────┐
│  User project                                             │
│  ├── src/agents/           agent definitions              │
│  ├── src/extensions/       project-local behavior         │
│  ├── src/pikit/            installed components (owned)   │
│  ├── pikit.config.ts       composition root               │
│  └── config/               values (not behavior)          │
├───────────────────────────────────────────────────────────┤
│  Registry components (copied in, above)                   │
│  channels · router · sessions · outbox · scheduler ·      │
│  approvals · workspace · execution · deployment · admin   │
├───────────────────────────────────────────────────────────┤
│  @pikit/core        (npm dependency, versioned, small)    │
│  @pikit/pi-adapter  (npm dependency, isolates Pi churn)   │
├───────────────────────────────────────────────────────────┤
│  @earendil-works/pi-agent-core · pi-ai · pi-protocol ·    │
│  pi-client                                                │
└───────────────────────────────────────────────────────────┘
```

Rules:

- The core has **no** dependency on any component.
- Components depend on the core and on **capability contracts**, never on other components'
  files directly. (Exception: a component may declare a *component dependency* in its
  manifest; the CLI installs it. Code still talks through capabilities.)
- Nothing in `src/pikit/` imports Node, Bun, or Cloudflare APIs directly unless the component
  is explicitly runtime-specific (its manifest says so).

---

## 4. Core

### 4.1 Composition root

```ts
// pikit.config.ts
import { defineApp } from "@pikit/core";
import telegram from "./src/pikit/channels/telegram";
import router from "./src/pikit/router";
import sessions from "./src/pikit/sessions/sqlite";
import pi from "./src/pikit/runtime/pi";
import auditLog from "./src/extensions/audit-log";

export default defineApp({
  components: [telegram, router, sessions, pi, auditLog],   // registry and project-local alike
  config,                                 // a plain object; loading YAML is the target's job
});
```

The composition root is explicit. There is no auto-discovery of components in production.
(The CLI edits this file when running `add` / `remove`.)

`config` is always a value, never a path: the core is runtime-neutral and cannot read files
(§16). Config keys are namespaced by component name (`config["channel-http"]`), with core
keys (`capabilities`) at the same level.

### 4.2 Component definition

```ts
import { defineComponent } from "@pikit/core";

export default defineComponent({
  name: "durable-outbox",
  version: "1.2.0",

  config: OutboxConfigSchema,        // typebox; merged into the global config schema

  setup(pikit, config) {
    const sql = pikit.use("storage.sql");          // declares the dependency; a handle
    const queue = createQueue(config);
    pikit.provide("outbound.queue", queue);        // declares and installs
    pikit.on("outbound.requested", (message) => queue.enqueue(message));
    return {
      start: () => queue.open(sql.get()),          // resources are acquired here, not in setup
      stop: () => queue.close(),
    };
  },
});
```

`setup` runs once per app instance. On the server target that is once per process. On
Cloudflare it is once per Durable Object instantiation (which may happen many times; setup
must be cheap and idempotent). `[decision]` `setup` is **synchronous and only registers**:
it never opens sockets, files, connections or timers. A component that owns resources returns
`{ start, stop }` from `setup`; the closure carries setup-local state to both. The app
calls `start` in dependency order and `stop` in reverse (§4.6). Because setup acquires
nothing, a failed `create()` has nothing to clean up.

`[decision]` `setup` receives `pikit: Pikit`, which is **not** a context. It carries the
read-only `target`, `config`, `logger` and `clock`, the registration verbs (`on`, `pipeline`,
`provide`, `provideKeyed`, `use`, `useOptional`, `useKeyed`) and `halt`. It has no `emit`,
`run`, `derive`, `abortSignal` or `value`: emitting or running a pipeline during setup would
reach other components' handlers before the graph is validated. Work happens in `start`/`stop`
and in handlers, which receive a `AppContext` (§4.7).

**`setup` is the manifest.** `[decision]` A component does not declare `provides` or
`requires`. The app records every `pikit.provide(name, impl)` and `pikit.use(name)` and
derives the dependency graph from them, as Chord's plugin host does (§6.4). What the code
does and what the component claims cannot disagree, because there is only one of them.

- `use(name)` returns a `Handle<T>`. `handle.get()` returns the provider's implementation (the
  selected one, §4.5) and throws during `setup`, because the provider's setup may not have run
  yet. Call it in `start`, in a listener or in a pipeline stage. `[decision]` An explicit
  handle rather than Chord's proxies: pikit has no hot reload and no remote services, which
  are what proxies are for, and a visible `get()` shows where resolution happens.
- `use()`, `useOptional()` and `useKeyed()` are the only ways to reach a capability. There is
  no `ctx.require`, because a second path would be an undeclared dependency.
- Registration is **sealed** when a component's `setup` returns. `on`, `pipeline`, `provide`,
  `provideKeyed`, `use`, `useOptional` and `useKeyed` called later (from `start`, a listener or
  a timer) throw, because they would bypass the validated graph and the resolved pipeline
  chains.
  What `describe()` reports is everything that runs.

`defineApp(...)` checks component names, the shape of `config.capabilities` and the
config schema, synchronously. `await definition.create()` runs every `setup` in list order,
validates the recorded graph, and returns the app (`start()`, `stop()`, `describe()`,
`context()`). `pikit doctor` is `create()` + `describe()`; `describe()` reports each
component's derived `provides` and `requires`.

### 4.3 Events

Events are **notifications**. Every listener receives the event; return values are ignored.
Because a listener's failure is only logged, nothing that must succeed (starting a server,
opening a database) may live in an event listener; that is what `start`/`stop` are for.

```ts
pikit.on("outbound.delivered", async (event, ctx) => { ... });   // in setup
await ctx.emit("outbound.delivered", payload);                    // in start or a handler
```

`emit` awaits all listeners in registration order. A listener that throws is logged and does
not stop the others (mirrors Pi's extension error handling).

`[decision]` `on()` returns nothing: there is no unsubscribe. Listeners are registered in
`setup` and live as long as the app, so the graph `pikit doctor` prints is the one that
runs. A listener that should act once keeps its own flag.

Event names are namespaced. Core-owned namespaces:

```
runtime.*     starting · ready · stopping · stopped
inbound.*     received · authenticated · rejected · normalized
route.*       resolved · failed
conversation.* resolved · created · reset
session.*     opened · created · closed
agent.*       dispatched · started · settled · failed
outbound.*    requested · queued · delivered · failed
```

Component-owned and project-owned events use their own prefix (`scheduler.*`, `acme.*`).

Events are typed by declaration merging, like Pi's `CustomAgentMessages`:

```ts
declare module "@pikit/core" {
  interface AppEvents {
    "acme.customer.created": { customerId: string; plan: string };
  }
}
```

For events that cross a process or persistence boundary (queues, webhooks, restored state) a
runtime schema is also registered. `[planned]` — built with the first component that
persists an event (`durable-outbox`):

```ts
pikit.registerEvent({
  name: "acme.customer.created",
  version: 1,
  schema: Type.Object({ customerId: Type.String(), plan: Type.String() }),
});
```

### 4.4 Pipelines

Pipelines are **ordered transformations**. Each stage receives the output of the previous one
and returns the next value (or the same value unchanged).

```ts
pikit.pipeline("inbound.normalize", async (message, ctx) => ({
  ...message,
  text: message.text.trim(),
}), { priority: 100, id: "trim" });

const normalized = await ctx.run("inbound.normalize", raw);   // in start or a handler
```

Ordering is deterministic: by `priority` (descending), then registration order. Stages have
ids (default `stage-<n>`) so `pikit doctor` can print the resolved chain. `[decision]` There
are no `before`/`after` anchors: a stage that must run next to another reads that stage's
priority in `pikit doctor` and picks a neighbouring one. Registry code is copied into the
project, so a priority only changes when its owner changes it. Anchors can be added later as
an additive change; removing them once shipped could not be.

Every pipeline has **one value type**: stages are `Value → Value`. A pipeline that produces
something carries it as a field of the value, so later stages see both the input and what
earlier stages decided. `[decision]` — this is Pi's patch model and makes §6.2b trivial.

Core-owned pipelines (value types defined with the components that first run them):

```
inbound.authenticate   { channel, request: Request, verdict?: authenticated { actor } | rejected { reason } }
inbound.normalize      InboundMessage
route.resolve          { message: InboundMessage, decision?: RouteDecision }
conversation.resolve   { decision: RouteDecision, conversation?: ConversationRef }   [planned]
agent.prepare          AgentRequest                 (system prompt, tools, context)   [planned]
outbound.prepare       OutboundMessage                                               [planned] M2
```

The first three are typed in the core since M1 (`inbound.ts`), with the first channel that runs
them (`channel-http`). `inbound.authenticate` is shared by every channel: each channel adds its
own stage, which acts only on requests whose `channel` is its own. A request is authenticated
only when a stage returns the `authenticated` verdict; no verdict is a rejection, so a missing
stage fails closed.

A stage may short-circuit by returning `pikit.halt(reason)`; the pipeline stops, `run`
returns the `Halt` (with the stage id) and `pipeline.halted { pipeline, stage, reason }` is
emitted. A stage that throws rejects the run (a failed transformation has no valid output);
a stage that returns `undefined` is an error (a forgotten `return`), not "unchanged".

### 4.5 Capabilities

Capabilities are **named services with exactly one provider**.

```ts
pikit.provide("sessions.store", store);      // in a component's setup
const store = pikit.use("sessions.store");   // in a component's setup; store.get() later
```

- Two providers for the same capability is a startup error unless config selects one:
  ```yaml
  capabilities:
    sessions.store: postgres
  ```
- A `use` with no provider, an ambiguous provider and a selection that names a component
  which does not provide the capability all fail in `create()`: after every setup, before any
  `start`.
- **Optional dependencies.** `[decision]` `useOptional(name)` declares a dependency that may be
  absent: `get()` returns `undefined` when nothing provides it. It is a separate verb, not an
  option of `use`, so whether a dependency is optional is written in code and no config value
  can switch it (S3). `use` and `useOptional` of the same name in one setup is a required use.
  When it is installed, its provider starts first like any other dependency. Optional is not
  permissive: several providers still need a selection. `describe()` lists optional uses apart
  from required ones, so `component.json` does not require them at install time. There is no
  `ctx.has(name)`: asking whether a capability exists is `useOptional(name).get()`, a declared
  question.
- **Keyed capabilities.** `[decision]` Some capabilities have one implementation per key
  rather than one provider: `channel.transport` has one transport per channel. A provider
  calls `pikit.provideKeyed(name, key, impl)`, possibly for several keys; a consumer calls
  `pikit.useKeyed(name)` and gets a `KeyedHandle<T>`: `get(key)` returns that key's
  implementation (or `undefined`) and `keys()` lists them, both from `start` onward. A keyed
  consumer starts after every provider of that capability.
  - No provider is not an error: an empty set is a normal state, and a consumer already
    handles a missing key per call (a missing transport is an `outbound.failed`). A consumer
    that needs at least one key checks `keys()` in its `start`, visibly.
  - Two components providing the same key is an error.
  - One capability is either single or keyed. Mixing `provide` and `provideKeyed`, or
    `use`/`useOptional` and `useKeyed`, for one name is an error.
  - Selection does not apply to keyed capabilities.

  Same model as Chord's keyed services (§6.4), with keys fixed at setup instead of spawned at
  runtime. Keyed types are declared in `AppKeyedCapabilities`, single ones in
  `AppCapabilities`.
- Capability contracts are TypeScript interfaces exported from `@pikit/core`.

Core-defined capability contracts (interfaces only; no implementations in core):

| Capability | Contract | Notes |
|---|---|---|
| `storage.sql` | `SqlDatabase` | Minimal sync/async SQL surface. Backed by `bun:sqlite`, `node:sqlite`, Postgres driver, or DO `ctx.storage.sql`. |
| `storage.blob` | `BlobStore` | put/get/delete/list. Local dir, S3, R2. |
| `sessions.store` | Pi `SessionRepo` + `SessionStorage` | Re-exported from Pi; typed by `@pikit/pi-adapter`. See §7. |
| `conversations.registry` | `ConversationRegistry` | Conversation key → active session and agent: `resolve` (creates the session the first time), `get`, `reset` (§7.4, §7.6). Workspace ref and metadata `[planned]`. |
| `conversations.ownership` | `ConversationOwnership` | `[planned]` Lease per conversation so only one worker has its session open. Needed only with several server replicas (§7.2). |
| `workspace` | `WorkspaceProvider` | Resolves a `Workspace` for a conversation/agent. |
| `execution` | Pi `ExecutionEnv` | Filesystem for the agent's tools; `exec()` may return `shell_unavailable`. |
| `execution.shell` | Pi `ExecutionEnv` | Same contract, provided **only** when `exec()` really runs commands on a real filesystem. Shell tools require this one. |
| `http.route` (keyed by `"METHOD /path"`) | `HttpRoute` | One HTTP endpoint as a standard fetch handler, `(request: Request, ctx: AppContext) => Response \| Promise<Response>`, with no framework type, so it runs behind `Bun.serve` and a Cloudflare Worker alike. Channels and admin components provide routes; one server component serves them all (§9.1). |
| `network.fetch` | `Fetch` (`typeof fetch`) | Outbound HTTP. A separate capability so policy and tests can replace it. |
| `agent.runtime` | `AgentRuntime` | See §6. |
| `model.provider` (keyed by provider id) | pi-ai `Provider` | One per model provider (`anthropic`, `faux` in tests), each its own component importing its pi-ai provider by subpath. The runtime builds its models from all of them, and each agent names its own `provider/modelId`, so agents may use different providers side by side. Typed by `@pikit/pi-adapter` (§6.2). |
| `agent.definition` (keyed by agent name) | `AgentDefinition` | One per agent, provided by the project. The runtime resolves `ConversationRef.agent` through it, and the router can check that a name exists (§6.1). |
| `agent.state` | `AgentStateStore` | Per-conversation JSON state read by `prepare` and updated by tools. Provided by the Pi adapter over the session (§6.2a, §6.4); no separate store. |
| `channel.transport` (keyed by channel name) | `ChannelTransport` | Send/edit/delete messages for one channel. Each channel component provides its transport under its own key; delivery uses `transports.get(message.channel)`. A missing key is an `outbound.failed`, and `doctor` checks that every installed channel provides its own. |
| `inbound.dedup` | `InboundDedup` | Claim / commit / release of platform delivery ids. Optional; see "Inbound deduplication" in §5. |
| `outbound.queue` | `OutboundQueue` | Durable enqueue + worker. Optional; without it delivery is direct. |
| `scheduler` | `Scheduler` | Register/cancel timed jobs. |
| `approvals` | `ApprovalStore` | Decision lifecycle persistence. |
| `secrets` | `SecretStore` | `get(name)`: the value, or `undefined` when it is not set; an empty value is not set. The process environment (`secrets-env`, which never reads `.env` files itself), Worker bindings, an external vault. |
| `clock` | `Clock` | `now()`, `sleep()`. Injectable for tests and for DO alarms. M0: a `defineApp` option, not a capability (the app needs it before any component runs). |
| `logger` | `Logger` | Structured logging. M0: a `defineApp` option, same reason. |

### 4.6 Lifecycle

```
build time      pikit add/remove edit pikit.config.ts; bundler compiles what is listed
                 │
define          defineApp() → unique names, selection shape, config against merged schema
                 │
app create      every component.setup() in list order (sync, registration only; records
                 │  provide/use; returns start/stop) → derive and validate the graph
                 │
runtime.starting
start           component start() in dependency order; a failure stops the started ones in
                 reverse, emits runtime.stopping/stopped, and rejects start()
runtime.ready   every component is up
                 │
   ... handle inbound → route → agent → outbound ...
                 │
runtime.stopping
stop            component stop() in reverse order; every stop runs, failures are aggregated
runtime.stopped
```

**Deadlines.** `[decision]` `start(ctx?)` and `stop(ctx?)` take a `Context`; the core has no
timeout options. The deadline belongs to whoever runs the app (the `deployment-*`
component: systemd's stop timeout, a Durable Object's `blockConcurrencyWhile`), for example
`app.stop(withAbortSignal(AbortSignal.timeout(ms), BACKGROUND_CONTEXT))`.
- Every `start`/`stop` hook receives that cancellation as `ctx.abortSignal`.
- A `start` still running when it fires is abandoned: that start fails and rolls back.
- A `stop` still running when it fires is abandoned and reported in the `AggregateError`, and
  the remaining components still stop.
- `runtime.*` listeners share the deadline. A listener still running when it fires is
  abandoned like a hook; events still cannot fail the app.
- Past the deadline, each remaining step still runs and gets one turn of the event loop
  before it is abandoned, so quick cleanup after a slow step is not reported as a failure.
- JavaScript cannot kill a promise, so an abandoned hook keeps running. A hook must release
  what it acquired and return when it sees the abort; the app only stops waiting. The core
  cannot enforce this, so it is checked per component: `createLifecycleConformance` (§14).
- Abandoned work is visible: a `warn` when it is abandoned.
- The rollback of a failed start does not inherit the start's cancellation, which is usually
  why it runs. It is bounded only by a `stop()` that interrupts the start.

`stop()` during a `start()` in progress (a SIGTERM during boot) cancels the start, waits for
its rollback within the stop's deadline, and leaves the start's error to the caller of
`start()`. Concurrent `stop()` calls share the first call's shutdown and deadline, and
`start()` while stopping is rejected.

`[decision]` An app is **single-use**. Once `stop()` is called or `start()` fails, `start()`
throws; restarting is `create()` again. Every target already restarts that way (a fresh
process, a fresh Durable Object), and it means abandoned work, which keeps running in its
component's closure, never shares that closure with a new run. Conversations are unaffected:
their state is in records (§7), not in the app.

Every `runtime.starting` is closed by `runtime.stopped`, including a failed start. On
Cloudflare, `start` runs inside the Durable Object constructor's `blockConcurrencyWhile`.

The core never restarts on its own. After a failed start or a stop that abandoned work, the
process is in an unknown state, and recovery is a fresh process: each target's shutdown rule is
in §9.1 and §9.2.

`pikit doctor` performs everything up to and including *setup* without starting servers, and
prints the resolved component graph, capability providers, pipeline chains, and config.

### 4.7 Context object

Every handler, `start` and `stop` receives `ctx` (setup does not; it receives `Pikit`, §4.2):

```ts
// Same shape as Chord's `Context`, which Pi's APIs take as their last argument.
interface Context {
  readonly abortSignal: AbortSignal | undefined;
  value<T>(key: ContextKey<T>): T | undefined;
  toString(): string;
}

interface AppContext extends Context {
  target: "server" | "cloudflare";
  config: ResolvedConfig;
  emit(event, payload): Promise<void>;   // propagates this same ctx to listeners
  run(pipeline, input): Promise<Value | Halt>;
  derive(change: (context: Context) => Context): AppContext;
  logger: Logger;
  clock: Clock;
}
```

The invocation part of the context (cancellation and values such as tenant, actor or trace)
is a `Context`: immutable, passed explicitly, derived with `withAbortSignal`, `withCancel` and
`withContextValue` over typed keys from `createContextKey`, starting from
`BACKGROUND_CONTEXT`. `[decision]` Shape and helper semantics match Chord's (§6.4) without
importing it.

- `app.context(parent?)` gives an app context over any `Context`, including one that
  came from Pi: the request's cancellation and values reach every handler.
- `ctx.derive(change)` does the same from inside a handler:
  `ctx.derive((c) => withContextValue(TENANT, "acme", c)).emit(...)`.
- Do not keep the `ctx` of `start` for later work. It carries the start deadline, so a server
  that uses it for every request sees them all cancelled when that deadline fires. Derive one
  context per invocation instead, from that invocation's own cancellation:
  `ctx.derive(() => withAbortSignal(request.signal, BACKGROUND_CONTEXT))`. `derive` is how a
  component that is not the host leaves the start context.
- `emit`/`run` live on the context so everything downstream of a request shares its
  cancellation and values without threading them by hand.
- Cancelling a child never cancels its parent.

Conversation data is not a context value: it arrives in the payloads of the events and
pipelines that concern it.

---

## 5. App lifecycle (the main path)

```
Channel ingress (HTTP/webhook/WebSocket)
  │  emit inbound.received
  ▼
pipeline inbound.authenticate      (channel verifies signature / JWT / token)
  │  emit inbound.authenticated | inbound.rejected
  ▼
pipeline inbound.normalize         → InboundMessage
  ▼
pipeline route.resolve             → RouteDecision { agent, tenant, tags, access }
  │  emit route.resolved | route.failed
  ▼
pipeline conversation.resolve      → ConversationRef { key, sessionId, workspaceRef }
  │  emit conversation.resolved | conversation.created
  ▼
hand the message to the worker that owns the conversation (§7.2)
  ▼
capability agent.runtime.dispatch(AgentRequest) → Admission, once the message is durable (§6.1)
  │  idle → started:   a run starts
  │  busy → queued:    Pi's inbox, as `steer` by default (§7.3); the run in progress answers
  │  seen → duplicate: nothing runs
  │  emit agent.dispatched
  ▼
the run, in the worker (Pi lifecycle; the adapter re-emits selected Pi events as agent.*)
  │  emit agent.started
  │  emit agent.settled | agent.failed   (from Pi's run_end, also for a run resumed after a crash)
  ▼
pipeline outbound.prepare          → OutboundMessage
  │  emit outbound.requested
  ▼
  if outbound.queue provided → enqueue; worker delivers; emit outbound.queued/delivered/failed
  else                       → channel.transport[message.channel].send(); emit outbound.delivered/failed
```

Core types (abridged):

```ts
interface InboundMessage {
  id: string;                         // platform delivery id or client message id; the requestId
  channel: string;
  conversationId: string;
  actor: { id: string };
  text: string;
  raw: unknown;                       // channel-specific payload, never inspected by core
  receivedAt: number;
  // [planned], each optional, with the component that produces it:
  // tenant, threadId, actor.displayName / roles, attachments
}

interface RouteDecision {
  agent: string;
  access: "allow" | "deny";
  reason?: string;
  // [planned], optional: tenant, tags
}

interface ConversationRef {
  key: string;                        // tenant:channel:conversationId[:threadId]
  agent: string;
  sessionId: string;
  workspaceRef?: WorkspaceRef;        // [planned] with `workspace` (§8.2); not in the core yet
}

interface OutboundMessage {
  id: string;
  channel: string;
  conversationId: string;
  threadId?: string;
  text?: string;
  blocks?: unknown;                   // channel-specific rich content
  attachments?: Attachment[];
  correlation?: { requestId?: string; runId?: string; decisionId?: string };
  idempotencyKey: string;
}
```

Inbound deduplication is **not core**. `[decision]` Platforms redeliver (webhook retries,
polling restarts), and both what identifies a redelivery (Telegram `update_id`, Slack
`event_id`) and when the platform may be acknowledged are channel-specific. A core table with
an in-memory fallback would break absence (MANIFESTO, "If you don't need it, it doesn't exist"), silently stop working after
a restart or hibernation, and — recorded before dispatch — drop the retry of a message whose
first attempt crashed. So:

- The **channel** owns the key (`InboundMessage.id` is the platform's delivery id) and the ack
  rule: a webhook is acknowledged only once the message is durably accepted.
- **`inbound-dedup`** is a component providing `inbound.dedup`, and it covers **transport
  deduplication only**: the platform delivery id and the ack. It claims the id in the last
  `inbound.normalize` stage and halts duplicates (the ingress emits `inbound.rejected
  { reason: "duplicate" }`); it commits once the message is durably accepted by the
  conversation, and releases on failure before that point, so the platform's retry runs
  again. In-flight claims expire, so a crash does not block a conversation forever.
- **Logical deduplication belongs to Pi.** Once a message reaches the conversation, it is
  submitted with `requestId = InboundMessage.id`; Pi deduplicates submissions per
  conversation and tracks each one to its answer (§6.4). pikit does not track "was this
  message answered" itself. `[upstream]` — until Pi's durable runtime ships, the adapter
  hands the message to Pi with its `requestId` inside and finds duplicates in Pi's inbox and
  transcript (§6.1, §6.4). pikit keeps no record of its own.
- The guarantee is **at-least-once**: a crash between effect and commit can repeat a reply.
  Effectful tools stay safe through idempotency keys (§8.4).
- Without `inbound-dedup` there is no deduplication — no table, no LRU, no half-measure.

Prior art: OpenClaw's durable ingress (`docs/plugins/sdk-channel-plugins/durable-ingress.md`)
reached the same shape: ack after durable append, claim/commit, completion tombstones.

---

## 6. Agent runtime and the Pi adapter

### 6.1 `AgentRuntime` contract

```ts
interface AgentRuntime {
  /** Hand a message to its conversation. Resolves when Pi has accepted it, not when it is answered. */
  dispatch(request: AgentRequest, ctx: AppContext): Promise<Admission>;
  /** Stop the active run now (§7.3). */
  abort(conversation: ConversationRef, ctx: AppContext): Promise<void>;
  /** Wake a conversation with no new message; continue the runs a dead worker left open. */
  resume(conversation: ConversationRef, ctx: AppContext): Promise<void>;
}

interface AgentRequest {
  /** Logical identity of the message (`InboundMessage.id`); Pi's `operationId` for a run (§6.4). */
  requestId: string;
  /** Names the session and the agent (`conversation.agent`). */
  conversation: ConversationRef;
  prompt: string;
}

/** What happened to the message, known as soon as Pi has made it durable. */
type Admission =
  | { kind: "started"; requestId: string }     // idle: a run started; its operationId is requestId
  | { kind: "queued"; requestId: string }      // busy: Pi's inbox, `steer` by default (§7.3)
  | { kind: "duplicate"; requestId: string };  // this conversation already ran requestId

/** Payload of `agent.settled` and `agent.failed`: how one run ended. */
interface AgentResult {
  conversation: ConversationRef;
  /** The request that started the run. */
  requestId: string;
  /** Every request the run took: its starter, then each message queued into it. */
  requestIds: string[];
  kind: "completed" | "aborted" | "failed";
  text?: string;
  messages: AgentMessage[];
  usage?: Usage;
  error?: { code: string; message: string };
}

// Events (AppEvents), all emitted by the runtime:
"agent.dispatched": { conversation: ConversationRef; admission: Admission };  // every admission
"agent.started":    { conversation: ConversationRef; requestId: string; resumed: boolean };
"agent.settled":    AgentResult & { kind: "completed" | "aborted" };
"agent.failed":     AgentResult & { kind: "failed" };
```

`AgentRequest` starts minimal. Images, a quoted message and prompts made of messages are added
with the components that produce them: adding a field is compatible, removing one is not.

The shape comes from the adapter spike against `pi-agent-core` 0.87.1 (§6.4). It is the shape
of a submission in Pi's durable runtime, so moving to that runtime happens inside the adapter.
`[planned]`

- **Enqueue first, then start.** `dispatch` puts every message in Pi's inbox first (`steer`,
  or the agent's `whileRunning` mode, §7.3), and then calls `accept()` with no prompt of its
  own.
  - On an idle conversation, Pi starts a run and drains its inbox into it.
  - On a busy one, `accept()` fails with `LaneBusy`, and the run in progress takes the message
    at its next boundary. Pi re-reads its inbox inside the commit that ends a run, so a message
    enqueued before that commit is never left behind.

  Deciding "busy, so steer" first and enqueuing afterwards would race the end of the run
  (§6.4, gap 2). That is why the contract has no `steer()`: `dispatch` is the only way in. It
  is also the order of Pi's durable runtime, where an idle input first drains what is queued.
- **Answers are events, not return values.** Pi reports every run's end (`run_end`) whether
  anyone waits for it or not. That includes a run whose caller stopped waiting, and a run that
  a new worker resumed after a crash, which no `dispatch` call is waiting for. The adapter
  emits `agent.settled` / `agent.failed` from that event, and delivery (§5) follows the event.
  `dispatch` therefore returns only the admission.
- **The admission is the ack point.** `dispatch` resolves once Pi has committed the run or the
  queued message to the session. That is "durably accepted" in §5: a channel may acknowledge
  the platform, and `inbound-dedup` may commit its claim.
- **`ctx` bounds the call, not the run.** Pi keeps the caller's context values (tenant, actor
  and trace reach the tools) but drops its cancellation from the run (`withoutAbortSignal`).
  Cancelling `ctx` never stops a run; `abort()` does.
- **The `requestId` travels with the message.** Each inbound message is a Pi `custom` message
  (`customType: "pikit.inbound"`, `details: { requestId }`). It is committed together with the
  message, first in the inbox and then in the transcript, and Pi's default conversion gives it
  to the model as a user message.
  - A duplicate is found in Pi's inbox or transcript, also after a crash and after compaction
    (which keeps old entries).
  - Admissions of one conversation run one at a time in its worker, so two deliveries of one
    request cannot both pass the check.
  - A run takes the `requestId` of the message that started it as its `operationId`.

  pikit keeps no record of its own.
- **`abort()` is cooperative.** Pi signals the running tools and waits for them to return; the
  run then ends as `aborted`. A tool that ignores `context.abortSignal` holds `abort()` until it
  finishes.
- **`abort()` withdraws what was queued.** Messages queued in the aborted run are not answered:
  Pi takes them out of its inbox. They stay known, so a redelivery is a `duplicate` (§6.4,
  gap 4), as Pi's durable runtime records a withdrawn submission `unanswered`. They are not in
  the aborted run's `requestIds`; telling their channel they were dropped is the channel's
  choice.
- **A queued message is answered by the run it joined.** Its entry, with its `requestId`, sits
  in that run's transcript. Its answer is the first assistant message after it that calls no
  tools, the same answer as the run's prompt. That is how Pi's durable runtime settles every
  input placed in one turn. `AgentResult.requestIds` lists every request a run took, read from
  the run's own transcript entries, so a channel that replies per message (an HTTP request
  waiting for its answer) replies to each of them with the run's answer. It needs no new record.
- **The agent is found by name.** `conversation.agent` names an `AgentDefinition` that the
  project provides under the keyed capability `agent.definition`, keyed by its name
  (`pikit.provideKeyed("agent.definition", support.name, support)`). A run resumed after a crash
  has no request to carry a definition, and one name cannot disagree with itself. The router can
  check that a name exists and `pikit doctor` lists the agents.
- **Opening a conversation resumes it.** When the runtime opens a conversation's session, for a
  `dispatch` or a `resume`, it first continues the runs a dead worker left open, as Pi's `mini`
  does. Otherwise a message dispatched there would queue behind a run nobody drives. `resume()` is
  how a host wakes a conversation with no new message: at boot, or from a Durable Object alarm.
- **The runtime emits `agent.*`.** `agent.dispatched` for every admission, duplicates included,
  in the caller's context. `agent.started` when a run starts or a worker resumes one (Pi emits
  no `run_start` for a resumed run). `agent.settled` / `agent.failed` from the run's terminal
  record, the one Pi's `run_end` announces: the adapter drives every run of a conversation it has
  open, a started one with `drive()` and an interrupted one with `lane.resume()`, so every end
  reaches it. Run events carry the admitting call's values without its cancellation.
- **`resume()`** continues the operations `AgentHarness.create()` reports as `open`, with
  `lane.resume()`; their outcomes arrive as `agent.settled` like any other run. Tools declared
  `replay: "safe"` run again; for any other tool Pi records an "interrupted" error result and
  the model decides. The replay rules of §8.4 are Pi's.
- **No `suspended` result.** A run waiting for a retry or a deferred response has not ended: it
  is an open operation that `resume()` (or the host's alarm, §9.2) continues.

Who owns these types `[decision]`: the core owns the *shapes* (`defineAgent`,
`AgentDefinition`, `TurnConfig`, `AgentRequest`, `AgentResult`, `AgentRuntime`), because they
are the stable programming model (§12a). The Pi-specific payloads inside them
(`AgentMessage`, `ImageContent`, `Usage`, the tool type) are opaque in the core and made
precise by `@pikit/pi-adapter` through declaration merging — the same mechanism as
`AppEvents`. The core never imports Pi; a project with the adapter sees Pi's exact types.
Components that implement a Pi contract (`sessions.store`, `execution`) import those types
from `@pikit/pi-adapter`, which re-exports them, never from `@earendil-works/pi-*`.

Core exports (M1): `defineAgent`, `AgentDefinition`, `TurnConfig`, `AgentRequest`, `Admission`,
`AgentResult`, `AgentRuntime`, `ConversationRef`, and the opaque `AgentMessage`, `AgentTool` and
`Usage` with their merge target `AgentPayloads` (each `unknown` until the adapter fills it in).
For the inbound path (§5): `InboundMessage` and `RouteDecision`, with the pipelines
`inbound.authenticate`, `inbound.normalize` and `route.resolve` typed on `AppPipelines`. Contracts:
`SecretStore` (`secrets`), and `ConversationRegistry` with `ConversationReset` (`conversations.registry`
and the payload of `conversation.reset`), and `HttpRoute` (`http.route`).
`@pikit/pi-adapter` fills in `AgentPayloads` and types `sessions.store` (Pi's `SessionRepo`)
and `model.provider` (pi-ai's `Provider`) by importing it anywhere in the project.

### 6.2 Pi adapter (`@pikit/pi-adapter`)

The adapter is the **only** package that imports `@earendil-works/pi-*`. It exposes
`pikit`-shaped types and hides Pi's experimental surface. `[upstream]`

**Pi first.** `[decision]` Pi is the agent; pikit is the kit that lets Pi run as a robust,
multi-agent service in the cloud. Before designing any agent-facing feature, check whether
Pi already does it; if it does, the adapter exposes Pi's feature and pikit builds nothing.
If Pi does it partially, the adapter wraps it and the gap goes upstream. pikit builds only
what a single Pi process cannot provide for itself. Verified against `pi-agent-core`
0.87.1, the pinned version (§6.4):

| Pi already does it — use it | pikit adds it — Pi cannot, from inside one process |
|---|---|
| Agent loop, providers (`pi-ai`), compaction, retries (`RetryPolicy`) | Channels, ingress, authentication, deduplication |
| Steering, follow-up and next-run queues, persisted as the session inbox | Routing messages to agents (multi-agent) |
| Serialized writes per session; exclusive open of a session within a process | Ownership of a session **across** processes (§7.2) |
| Resume of the operations a dead worker left open; tool replay (`replay: "safe" \| "never"`) | Durable delivery (outbox), scheduling, approvals surfaces |
| Tool hooks, tool execution modes, turn preparation / finish hooks; `read` / `write` / `edit` / `bash` tools over `ExecutionEnv` | Tool components that give Pi's tools a capability and a `replay`; policy; sandboxes via `execution` |
| Session values, branches, forks, usage records | Conversation registry, reset, workspace references |
| Skills, prompt templates, system prompt assembly | Deployment, secrets, targets, `doctor` |

When a row moves (Pi ships something pikit built), pikit deletes its version.

Responsibilities:

- Build on Pi's durable `AgentHarness`, the harness Pi's own session-worker prototype uses,
  until Pi's durable runtime replaces it (§6.4). Reference: `mini` in the Pi repo
  (`packages/coding-agent/src/experimental/mini`). One worker per session holds the
  harness, storage and model runtime; a replacement worker resumes each open operation with
  `lane.resume(context)`. This is the actors-and-workers model of §7 inside one host.
- Build an `AgentHarness` per conversation from `AgentDefinition` + capabilities:
  - `session` from `sessions.store`.
  - `ExecutionEnv` from `execution`.
  - `tools` from the agent definition and installed tool components.
  - `models` from the `model.provider` components (`modelsFrom`), each importing its pi-ai
    provider **by subpath** (bundle size on Cloudflare).
- Translate Pi hooks/events → `agent.*` events and `agent.prepare` pipeline:
  - `before_run` → `agent.prepare` (system prompt, tools, context injection).
  - `before_tool` / `after_tool` → `agent.tool.call` / `agent.tool.result` (interceptable).
  - `after_response` → `agent.response` (provider errors, failover hooks).
  - `run_end` → `agent.settled` / `agent.failed`, whether or not anyone waits (§6.1). Built.
- Run in Pi's two steps: `accept()` makes the run durable (the admission of §6.1), and
  `drive()` executes it in this process.
  - `server`: `drive({ waitForRetry: true })`; the worker waits through retry backoff.
  - `cloudflare`: `drive({ waitForRetry: false })` returns `waiting { notBefore }`, and the
    Durable Object sets an alarm and drives again (§9.2). `[open]` — settled in M4.
- On `AgentHarness` creation, Pi reports the operations a dead worker left `open`, without
  starting their effects; `resume()` continues them with `lane.resume()`.
- Pass pikit's context into Pi through a one-line bridge:
  `chord.withAbortSignal(ctx.abortSignal, ctx)` when `abortSignal` is set, otherwise `ctx`.
  pikit derives from a parent's `abortSignal` property. Chord's `withContextValue` reads the
  signal through a private key, so without the bridge a pikit context that Pi derives would
  lose its cancellation (verified against chord 0.87.1). A Chord context passed into pikit
  needs no bridge.
- Deliver every message through Pi's own `steer()` first (or the agent's `whileRunning` mode,
  `[planned]`), then `accept()`: an idle conversation starts a run that drains it, a busy one
  answers `LaneBusy` and its run takes the message (§6.1). pikit keeps no queue of its own (§7.3).
- Keep a conversation's harness open only while it drives a run, and close it when idle (§7.1,
  invariant 5). Everything that touches one conversation runs in that conversation's line, one
  step at a time; runs execute outside it.
  - A busy conversation reuses its open harness: a message queued into its run opens nothing.
  - Reopening costs a session read, not the provider's prompt cache: Pi sends the same system
    prompt, tools and message prefix under the same cache key (`<sessionId>:<lane>`), so the
    provider still hits its cache. Both are tested (`adapter.test.ts`, "caches").
  - Keeping idle conversations open for a while (an `idleMs`) is added only if reopening is
    measured to be slow.
- Load Pi extensions for each conversation and bind them to its harness (§6.2b). `onHarness`
  also receives each harness as it opens, for tests. The `runtime-pi` component takes it as
  `createRuntimePi({ onHarness })`, a plain function in its own source; its default export is
  the component without options.

The split `[decision]`: `@pikit/pi-adapter` (npm, pinned with Pi) holds everything that talks to
Pi, including the bridges that read Pi's storage layout, because it changes when Pi changes.
`runtime-pi` (copied to `src/pikit/runtime/pi/`) is the wiring the user owns: which
capabilities it reads, what it refuses to start without (no agent, a model no provider has), and
its tests, which run the `agent.runtime` and lifecycle conformance suites through
`@pikit/pi-adapter/testing` without importing Pi (rule 13).
- Pass each tool component's `replay: "safe" | "never"` to Pi's `AgentHarnessTool.replay`; Pi
  applies it on resume (§8.4).

Agent definition (project file, convention-based under `src/agents/{name}/`):

```
src/agents/assistant/
├── agent.ts            defineAgent({ ... })
├── system-prompt.md
├── skills/             SKILL.md folders (Pi format)
└── context/            files copied into the workspace before a run
```

### 6.2b Running Pi extensions unchanged

A Pi extension is `export default function (pi: ExtensionAPI) { ... }`. pikit runs existing
extensions without modification, except for what needs a terminal UI. Built in M1
(`packages/pi-adapter/src/extensions/`), checked against pi-coding-agent 0.87.1.

Known facts (0.87.1):
- `AgentSession` still drives the legacy `Agent` class (`agent.beforeToolCall`), not
  `AgentHarness`. The compat layer translates Pi's *semantic* extension events onto the harness
  hooks, not Pi's classes, so Pi's own migration lands in the adapter only.
- Existing extensions import from `@earendil-works/pi-coding-agent`, and not only types:
  `defineTool` is a value.

Decisions `[decision]`:
- **A vendored subset.** The compat layer's `ExtensionAPI` is a subset of Pi's types in
  `@pikit/pi-adapter/extensions` (attributed in `NOTICE`; Pi is MIT), not a dependency on
  `pi-coding-agent`: 19 MB for types is out of proportion, and a subset states exactly what pikit
  supports. Pi's own example extensions, copied byte for byte, compile against it and run in
  `compat.test.ts`; a Pi bump copies them again.
- **No TUI.** The compat object reports `mode: "rpc"` and `hasUI: false`. `ui.select` / `ui.input`
  answer `undefined`, `ui.confirm` answers `false`, and every other `ui.*` call does nothing, so
  extensions that guard on `hasUI` take their non-interactive path, as Pi already asks them to.
- **Declared in the composition root.** `createRuntimePi({ extensions: [permissionGate, hello] })`
  in `pikit.config.ts`, imported statically; never discovered or loaded dynamically. They apply
  to every conversation of the runtime. Per agent (`defineAgent({ extensions })`) can be added
  later without breaking this.
- **Loaded per conversation, as Pi loads them per session.** When a conversation opens, each
  factory runs and registers handlers, tools and providers; then the host binds them to that
  conversation's harness and fires `session_start` (`reason: "resume"`). `session_shutdown`
  (`reason: "quit"`) fires when the conversation closes, idle or at stop. Every action
  (`pi.sendMessage()`, `pi.setActiveTools()`…) therefore acts on the conversation it was loaded
  for, with no ambient "current conversation"; calling one while loading throws, as in Pi. A
  single load for the whole runtime would need exactly that ambient context. The cost: a factory
  runs each time a conversation opens.
- **The import resolves by alias.** A project installs `@pikit/pi-extension-shim`, a one-file
  package that re-exports `@pikit/pi-adapter/extensions`, under the name
  `@earendil-works/pi-coding-agent` (`"npm:@pikit/pi-extension-shim@…"`). It is ordinary package
  resolution, so it works in Bun, Node and bundlers, and the coding agent is never installed.
  This repository does the same with `workspace:@pikit/pi-extension-shim@*`.

Support tiers (on 0.87.1):

| Tier | Surface | How |
|---|---|---|
| A — works | `on(...)`: `session_start`, `session_shutdown`, `before_agent_start`, `context`, `before_provider_request`, `after_provider_response`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start` / `_update` / `_end`, `tool_execution_start` / `_update` / `_end`, `tool_call`, `tool_result`. `registerTool`, `defineTool`, `isToolCallEventType`, `registerProvider`, `sendMessage`, `sendUserMessage`, `appendEntry`, `set/getSessionName`, `setLabel`, `set/getActiveTools`, `getAllTools`, `setModel`, `set/getThinkingLevel`, `events`. On `ctx`: `hasUI`, `mode`, `cwd`, `model`, `signal`, `isIdle`, `abort`, `hasPendingMessages`, `waitForIdle`, `getSystemPrompt`, `compact` | `tool_call` → `before_tool` (`block` blocks; mutating `event.input` in place patches the arguments). `tool_result` → `after_tool`. `before_agent_start` → `before_run` (an added message) and `transform_context` (the system prompt, for that run). `context` → `transform_context`. `before_provider_request` → `before_payload`. `after_provider_response` → `after_response`. Run, turn, message and tool notifications → the harness's events, in Pi's order. `ctx.abort()` → the conversation's `abort()`, which records withdrawn messages (§6.4, gap 4). Tools → harness tools, `replay: "never"` |
| B — later, with channels | `registerCommand` (slash commands from a channel), `ui.select` / `confirm` / `input` answered by a person (overlaps `approvals`) | Today they are tier C |
| C — no-op with a warning | Every other event (`input`, `user_bash`, `model_select`, `agent_before_settle`, `context_with_system`, `cache_warming_decision`, `session_before_*`, `resources_discover`, `project_trust`…), `registerShortcut`, `registerFlag` / `getFlag`, `register*Renderer`, `registerMarkdownTransformer`, TUI `ui.*`, `ctx.shutdown()`. Absent: `ctx.sessionManager`, `ctx.modelRegistry`, `newSession`, `fork`, `switchSession` | TUI-only, or owned by pikit (the process, the sessions). The warning is a log line when the extension loads; `pikit doctor` lists it once the CLI exists `[planned]`. `pi.exec()` rejects until extensions are given `execution.shell` |

Where pikit differs from Pi in a way an extension may notice:
- `sendMessage` / `sendUserMessage` on an idle conversation wait for its next run (`nextRun`):
  starting a run outside `dispatch` would bypass admission (§6.1).
- A lane created before an extension was installed gets that extension's tools activated when
  it opens.

**Taking a conversation up again with extensions loaded.** Loading per conversation means
extensions load again each time a conversation reopens. Tested in `compat.test.ts`:
- **Reopen after idle:** the extensions load again and `session_start` fires again; their tools
  stay active and their handlers act on the next message.
- **Resume after a crash** (a worker killed with SIGKILL, resumed in this process): the extensions
  are bound before the run continues and see `agent_start` (the adapter fires it, because Pi
  emits no `run_start` for a resumed run), the interrupted tool's end, and `agent_end`.
  - With `replay: "safe"` the tool runs again and `tool_result` can rewrite its result.
  - With `replay: "never"` it does not run; Pi records it interrupted, and only
    `tool_execution_end` reaches the extensions.
  - **The interrupted call is not put to `tool_call` again**, even when it is replayed: Pi
    records a call's intent after its `before_tool` check and replays that decision. The same
    extensions ran before the crash, so the call was checked then. An extension installed
    between the crash and the resume does not see it.
- **Prompt cache across a reopen:** with extensions installed (a tool, a policy and a system
  prompt change), the provider receives the same system prompt, the same tools in the same
  place and the same message prefix, and its cache hits.
- **Extension state:** what an extension keeps in its closure starts over on each reopen, as in
  Pi on each session load. What it appends with `pi.appendEntry` stays in the session. When a
  conversation closes, the adapter waits for the extensions' notifications and actions still in
  flight (an `agent_end` handler writing an entry) before `session_shutdown` and the harness
  closes. `[open]`: reading those entries back needs `ctx.sessionManager`, which pikit does not
  provide yet; decide a read-only subset when an extension needs it.

### 6.2a Dynamic agents without hooks

Static agent definitions break down for real work: which tools, instructions, model and
skills an agent has must depend on where the conversation is. pikit expresses this as an
explicit function from persisted state to turn configuration — the same power as a hooks
model, with an explicit input, an explicit output, and a documented moment of execution.

```ts
// src/agents/release/agent.ts
import { defineAgent } from "@pikit/core";
import { runTests, deploy, summarize } from "../../tools";

export default defineAgent({
  name: "release",
  model: "anthropic/claude-sonnet",           // static defaults
  tools: [runTests, summarize],
  systemPrompt: "./system-prompt.md",
  skills: "./skills",

  state: { phase: "testing", testsPassed: false },   // initial persisted state (JSON)

  prepare(state, ctx) {                       // runs before every turn
    return {
      model: state.phase === "summarize" ? "anthropic/claude-haiku" : undefined,
      tools: state.testsPassed ? [runTests, summarize, deploy] : undefined,
      systemPrompt: state.phase === "deploying" ? ctx.prompt("deploying.md") : undefined,
    };
  },
});
```

The core's `AgentDefinition` has `name`, `model`, `systemPrompt` (the text) and `tools` today;
`state`, `prepare` and `skills` are `[planned]` and are added to it without breaking it.

Rules:

- `prepare(state, ctx) → Partial<TurnConfig>` is pure with respect to its inputs. It does not
  register anything as a side effect; it returns a value. `undefined` fields keep the static
  default.
- `state` is the agent's persisted per-conversation state: a JSON document tools and
  extensions may read and update (`ctx.state.update(patch)`). `[decision]` It is stored **in
  the Pi session**, as a conversation-scoped document in Pi's durable runtime and, until
  that ships, as a session value. It commits atomically with the transcript, survives
  restarts and eviction, and starts fresh on `/reset` (a new session). pikit adds no store for
  it (§6.4).
- The adapter runs `prepare` in Pi's `before_run` hook and applies the result via
  `setModel` / `setActiveTools` / system prompt for that run. The resolved `TurnConfig` is
  appended to the session as a custom entry, so "what did the agent have on turn N" is
  answered by reading the transcript, not by re-deriving code paths.
- `prepare` is callable in tests as a plain function: `prepare({ testsPassed: true }, ctx)`.
- The `agent.prepare` pipeline (§4.4) runs *after* `prepare` and lets components and
  extensions patch the `TurnConfig` further (context injection, policy restrictions).

**Workflows are state, not graphs.** pikit has no workflow DSL. A multi-step process is a
`state.phase` the agent advances by calling tools, with `prepare` exposing the tools that
belong to each phase. Durability (§8.4) makes a step-graph engine unnecessary.

### 6.3 Tools

Tools are components too (`tool-*`). A tool component declares which capabilities it needs so
`pikit doctor` can refuse a deployment that cannot satisfy it:

```json
{ "name": "tool-shell", "requires": { "capabilities": ["execution.shell"] } }
{ "name": "tool-http-fetch", "requires": { "capabilities": ["network.fetch"] } }
```

`pi-agent-core` ships `createReadTool`, `createWriteTool`, `createEditTool` and
`createBashTool` (verified on 0.87.1). They are harness tools over Pi's `ExecutionEnv`, which
they receive as `toolContext.env`. They import nothing Node-only (`typebox`, `diff`), and Pi's
own session worker (`mini`) uses them. Following Pi first, `tool-read`, `tool-write`,
`tool-edit` and `tool-bash` wrap Pi's factories and do not reimplement them. `[decision]`

A wrapper adds only what the kit owns:
- the capability the tool requires (`execution`, or `execution.shell` for `bash`);
- its `replay`. Pi's tools declare none, so they default to `"never"`; a read-only wrapper
  declares `"safe"`.

pikit writes a tool as source only when Pi has none (for example `ls`, or `http-fetch`). The
tools run on any `execution` provider. Pi's `ExecutionEnv` includes `exec`, so a provider
without a shell implements it as an error; only `bash` reaches it. When Pi's durable runtime
redefines tools (pico-v5 §7.2), Pi migrates its own tools and the wrappers follow.

`pi-coding-agent` is never a dependency of a pikit project. Its only use is as an external
binary (`pi`) invoked by the CLI for `resolve with pi` (§10.6). `[decision]`

### 6.4 Pi version and alignment with Pi's durable runtime

**Pin:** `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` at exactly **0.87.1** in the
adapter's `package.json`; 0.87.x is the supported line. `[decision]` The harness is
experimental and changes weekly, and the adapter's bridges read Pi's storage records (see
below). A bump is therefore a deliberate change: run `pi-gaps.test.ts`, `pi-facts.test.ts` and the adapter's conformance tests, then check
this section again. Pi's own dependencies use caret ranges within 0.87 (`^0.87.1`); the
lockfile freezes them. `typebox` follows Pi's exact version (1.3.27), so the core and Pi share
one copy.

From 0.87, `pi-agent-core` depends on `@earendil-works/chord`, and the harness `Context` is
Chord's. Only the adapter sees either. The adapter spike ran against 0.87.1 (tag `v0.87.1`,
`f07218c4`). On Pi's `main` at `7fd564cb` (2026-09-23), the harness runtime is unchanged since
that tag.

**Pi's durable runtime** (`@earendil-works/pi-durable`, "Pico5") is Pi's next harness: one
session holding conversations, immutable entries, durable tasks, submissions and documents,
all committed atomically. `pi-durable` 0.87.1 publishes its storage (memory, SQLite; JSONL is on
`main`), not its runtime: `pico-v5-handoff.md` has the storage packages done and the runtime
packages pending.
Following Pi first, pikit **does not build** what it will provide, and shapes its own
contracts so the move happens inside the adapter. `[upstream]`

| pikit need | Pi durable runtime | Until it ships (verified by the spike on 0.87.1) |
|---|---|---|
| Message to a busy conversation | Submission with `whenBusy: "steer"` (pikit's default) | Enqueue first (`steer()`), then `accept()`. Pi drains its inbox into a new run, or the run in progress takes the message at a boundary. Bridges gap 2 |
| Logical deduplication, "was it answered?" | Submission `requestId`, awaitable until `done` / `unanswered` with its answer | The `requestId` travels inside the message (a Pi `custom` message) and is found in Pi's inbox or transcript. Bridges gaps 1 and 3 |
| `agent.state` | Conversation-scoped document | Session value `pikit` / `agent.state`. It is committed apart from the transcript, so a tool's state change and its result are two commits |
| Continue a killed run | Tasks resume from their records | `AgentHarness.create()` reports `open` operations; `lane.resume()` continues them; tool `replay` is Pi's |
| Multi-step work, waits, approvals that last days | Durable tasks: phases, effect sandwich (commit intent → effect → commit outcome), memos, `sleep(until)`, abort protocol | `state.phase` + tools; nothing more is built |
| Subagents | Owned child conversations inside the session | Deferred |
| `sessions-cloudflare-do` | Its SQLite core runs over a synchronous database facade that a Durable Object can implement | Pi's current `SessionRepo` |

**Gaps found by the adapter spike, and their bridges.** Pi's durable runtime lives in
its own package (`pi-durable`) and replaces `AgentHarness`, so these gaps will not be closed
in `pi-agent-core`. The adapter bridges each one with mechanisms Pi already has, reproducing
the durable runtime's submission semantics, and deletes the bridge when it moves to
`pi-durable`. `pi-gaps.test.ts` asserts Pi's own behaviour, called directly; the `agent.runtime`
conformance suite and `adapter.test.ts` prove each bridge. The bridges live in
`packages/pi-adapter/src/inbound.ts`.

| # | Gap in `pi-agent-core` 0.87.1 | Bridge in the adapter | Pi durable runtime |
|---|---|---|---|
| 1 | `accept()` does not reject a reused `operationId`: an idle lane runs the same request again | Duplicate check before admission, and one admission at a time per conversation in its worker. One worker owns a conversation (§7.2) | `requestId` deduplicates before any write |
| 2 | No atomic "run if idle, otherwise queue": a `steer()` that lands after the run's last boundary waits in the inbox for the next run | Enqueue first, then `accept()`. Pi re-reads its inbox in the commit that ends a run, and `accept()` drains it on an idle lane | Admission decides idle or busy in one transaction; an idle input first drains older queued items |
| 3 | `steer()`, `followUp()` and `nextRun()` take no request id | The message is a Pi `custom` message with `details: { requestId }`, committed with it | Queued submissions carry their `requestId` |
| 4 | `abort()` takes the queued steers and follow-ups out of the inbox and returns them only in memory: a redelivery looks new | After `abort()`, a `custom` entry `pikit.withdrawn { requestIds }`, which the duplicate check reads | `Conversation.abort()` withdraws queued submissions and records them `unanswered` |

Costs of the bridges:

- **Inbound messages have the role `custom`, not `user`.** Pi's conversion, compaction and
  events handle them, and Pi extensions already see `custom` messages from `sendMessage`.
  Two limits remain:
  - compaction detects a split turn by looking for `user`, so a cut inside a turn is not
    recognised as split (read from the code, not tested);
  - images go inside `content`, because `steer()`'s `images` parameter accepts only user
    messages.
- **The inbox is read through Pi's exported record addresses** (`laneState`, `pendingEntry`).
  They follow Pi's storage layout, which is one more reason to pin the exact version.
- **Deduplication scans the transcript,** so the adapter bounds it to a redelivery window: the
  last 1000 message entries of the branch. Compaction keeps old entries on the branch, so it
  does not hide a request.
- **The withdrawn record is a second write.** A crash between Pi's abort and the
  `pikit.withdrawn` entry loses the record, not a message: the message was already withdrawn.
- **Opening a session by id lists the store.** Pi's repos open from metadata; the conversation
  knows only its session id. A conversation registry that keeps the metadata can remove the scan.
- **One admission at a time holds only inside one worker.** Several replicas need
  `conversations.ownership` (§7.2).

Facts the adapter relies on (0.87.1):

- `AgentHarness.close()` closes the `Session` it was given. Evicting a conversation closes both;
  the next owner reopens the session from its repo.
- There is no `drive: "automatic" | "manual"` option and no `peekAction()`. Admission is
  `accept()` (durable); execution is `drive()` (process-local). `drive({ waitForRetry: false })`
  returns `waiting { notBefore }` for the host to schedule, which is the shape a Durable Object
  alarm needs (read from the types; the spike did not exercise it).
- The context bridge of §6.2 is needed: Pi derives telemetry contexts with Chord's
  `withContextValue`, and without the bridge they lose a pikit context's cancellation.
- A branch scan honours `start` and `stopAtId` only `newestFirst`, and includes the stop entry;
  `oldestFirst` walks from the root. A run's messages are read newest first and reversed.
- A run resumed after a crash emits no `run_start`, and `run_end` is also emitted for
  compactions and navigations. The adapter reports only the runs it accepted or resumed.
- Session values survive a new harness over the same stored session, and a new session starts
  without them: the basis of `agent.state` (§6.2a).

`pi-facts.test.ts` asserts each of these on Pi directly.

Mapping of vocabulary: **one pikit conversation (the actor) is one Pi session.** The session
is Pi's unit of single-writer ownership (§7.2); conversations inside it are Pi's transcript
scopes (the root one, forks, subagents). Pi's durable storage states that cross-process
locking is not supported, which confirms that conversation ownership stays pikit's job.

What stays pikit's: channels, ingress and transport deduplication (§5), routing between
agents, conversation ownership across processes, delivery, scheduling triggers, approval
surfaces, deployment.

---

## 7. Actors, workers and sessions

### 7.1 The model `[decision]`

A **conversation is an actor**: an identity (the conversation key), a durable state (its Pi
session) and a mailbox (the session's inbox, which is Pi's). A **worker** is wherever the
actor's steps run right now — a server process, a Durable Object instance. The actor is
permanent; the worker is disposable. Everything else follows from five invariants:

1. **The actor's state is records, not memory.** Registry pointer, Pi session (transcript,
   inbox, operations, values) and workspace ref are persisted through capabilities. What a
   worker holds in memory is a cache that can be rebuilt from those records.
2. **One owner at a time.** Any worker may run any actor's next step, but only one worker has
   an actor's session open at a time, on every target (§7.2).
3. **One mailbox, Pi's.** Messages that reach a busy actor go to Pi's inbox (§7.3); two runs
   of the same conversation never overlap.
4. **Workers are disposable.** Losing a worker loses no actor: the next owner opens the
   session, `resume()` continues the run, and the inbox is still there (replay rules in §8.4).
5. **Idle actors cost only storage.** No open session, timer or sandbox is kept for an idle
   conversation. Closing a session deactivates the actor; it never resets it.

An `AgentDefinition` is to an actor what a class is to an object: routing picks the agent,
`conversation.resolve` picks the actor. Everything with state that receives messages is a
conversation — a routine posts to a conversation, an approval answer arrives in one, a
subagent is a child conversation.

### 7.2 Conversation ownership

Pi serializes writes to a session and opens a session exclusively **within one process**, and
states its precondition: "a storage path has one owning process and one owning Session at a
time; a second process is unsupported." pikit's job is to guarantee that precondition when
there is more than one process. That is all ownership means.

| Target | How one owner is guaranteed | Component |
|---|---|---|
| Server, one replica | The process is the only worker; an in-memory map of open sessions is a cache | none |
| Server, several replicas | A lease per conversation in the database; the non-owner forwards or waits | `[planned]` `conversations.ownership` |
| Cloudflare | `idFromName(conversationKey)` routes every message for a key to one Durable Object | none (platform) |

`[open]` Several replicas need fenced writes: a worker that stalls past its lease must not
write over the next owner. Pi's `Storage.commit` has no expected-sequence check, so the
fencing belongs in the session store or the lease; decide when the component is built.

### 7.3 Messages that arrive during a run `[decision]`

They go to Pi's inbox; pikit keeps no queue. Pi's semantics, which pikit does not change:

| Pi call | When the message enters the run |
|---|---|
| `steer()` | After **all** tool calls of the current assistant turn finish (tools are not cancelled), before the next model call. Changes the agent's course. |
| `followUp()` | When the agent would otherwise stop; the same run continues with another turn. |
| `nextRun()` | At the next run; the current run is not extended. |

**The default is `steer`**, for every message that reaches a busy conversation: in a chat,
a new message usually means "change course". An agent may choose another mode
(`defineAgent({ whileRunning: "followUp" })`) `[planned]`. Stopping at once, without
waiting for tools, is `abort()`, not a queue mode. Pi's `steeringMode` / `followUpMode`
(`all` or `one-at-a-time`) keep Pi's defaults.

`agent.state` lives in the session (§6.2a), so a `/reset` starts it fresh. Anything that
must survive a reset belongs to the conversation registry's metadata, not to `agent.state`.

The adapter reports what happened to a message sent to a busy conversation as `queued`, and
the answer arrives through the same run. With Pi's durable runtime this becomes a
submission the adapter can await until it is answered (§6.4).

### 7.4 Two different records

| | Persists | Lives in |
|---|---|---|
| **Conversation registry** | conversation key → active Pi session id, workspace ref, agent, metadata | `conversations.registry` |
| **Pi session** | transcript entries, lanes, operation records, queues, usage | `sessions.store` |

A conversation can point to many sessions over time (`/reset` creates a new one and repoints;
old sessions remain).

The registry's contract, `ConversationRegistry` (core, M1) `[decision]`:
- `resolve(key, agent, ctx)` returns the conversation for a key. The first time, the registry
  creates its session in `sessions.store` and records the pointer. Concurrent first calls for one
  key create one session.
- A conversation **keeps the agent it was created with**. An actor does not change class (§7.1),
  and a session's transcript belongs to one agent. A route that names another agent for an
  existing key does not move it; a reset keeps the agent too. Moving a conversation to another
  agent is `[open]` until a component needs it.
- `get(key, ctx)` reads without creating. `reset(key, ctx)` is §7.6, and returns `undefined` for a
  key with no conversation.
- Keys are opaque strings. The channel builds them (`http:<conversationId>` for `channel-http`);
  the tenant enters the key when tenants are routed (§16). TTL/eviction of in-memory `AgentHarness` objects **never** deletes the
registry pointer. A conversation must be restorable long after its `AgentHarness` was
evicted; this is a hard rule.

### 7.5 `sessions.store`

The contract is Pi's `SessionRepo<TMetadata>` + `SessionStorage`. `[upstream]` The adapter
re-exports them; components implement them. Every implementation must pass
`createSessionRepoConformance()` and `createStorageConformance()` from
`@earendil-works/pi-agent-core/harness/session/testing` (plus the fork/lifecycle sub-suites
exported alongside them; verified against `pi-agent-core` 0.87.1).

A component does not import Pi (rule 1), so the adapter exposes what a store needs:
- `@pikit/pi-adapter/testing` re-exports both suites, with `storageOf(session)`, the `Storage` under
  a session Pi's repositories created, so a store's storage suite runs over the storage it writes.
- `@pikit/pi-adapter/node` (server only) has `createJsonlSessionStore({ root, cwd })`: Pi's
  `JsonlSessionRepo` with a default working directory for callers that do not know one.

Known gap (0.87.1): `JsonlSessionRepo` fails one case of `createSessionRepoConformance`, "publishes
create when it reserves a shared destination id first" (a `create` racing a `fork` for the same new
id). Pi's own JSONL test does not run its destination-reservation cases. pikit neither forks nor
chooses session ids, so it does not reach it. JSONL stores register the case as `test.failing`
(`JSONL_REPO_CONFORMANCE_GAPS`), so a Pi release that fixes it is noticed.

Planned implementations:

| Component | Backing | Target |
|---|---|---|
| `sessions-memory` | in-memory (Pi's `MemorySessionRepo`) | tests |
| `sessions-jsonl` | Pi's `JsonlSessionRepo` over local FS | server |
| `sessions-sqlite` | `@earendil-works/pi-session-backend-sqlite-node` or `bun:sqlite` | server |
| `sessions-postgres` | own implementation | server |
| `sessions-cloudflare-do` | DO `ctx.storage.sql` | cloudflare |

### 7.6 Reset semantics

```yaml
reset:
  session: new          # always
  workspace: preserve | recreate
```

Emits `conversation.reset { conversation, previousSessionId, newSessionId }`, where
`conversation` is the reset conversation on its new session, once the new pointer is durable. The
registry emits it, in the caller's context. The previous session is kept and nothing is deleted. A
run still going on the previous session finishes there, and its answer is still delivered. M1
resets the session only; `workspace` joins with §8.

---

## 8. Workspace and execution

### 8.1 Why they are separate from sessions

A session transcript records *that* a file was edited; it is not the file. Restoring a session
without restoring the workspace yields an agent that remembers changes that no longer exist.
pikit therefore treats workspace persistence as its own capability with its own reference
stored in the conversation registry.

```ts
interface WorkspaceRef {
  driver: "local" | "virtual" | "git" | "r2-snapshot" | "container" | string;
  path?: string;
  repository?: string;
  branch?: string;
  lastCommit?: string;
  snapshotKey?: string;
}
```

### 8.2 `workspace` capability

```ts
interface WorkspaceProvider {
  resolve(conversation: ConversationRef, agent: AgentDefinition): Promise<Workspace>;
}
interface Workspace {
  ref: WorkspaceRef;
  env: ExecutionEnv;                       // Pi contract: FileSystem + Shell
  checkpoint?(): Promise<WorkspaceRef>;    // snapshot / commit
  release(): Promise<void>;
}
```

Planned implementations:

| Component | Filesystem | Shell | Persistence | Target |
|---|---|---|---|---|
| `workspace-local` | real dir under `~/.pikit/workspaces/{agent}` | yes | disk | server |
| `workspace-virtual` | table in `storage.sql` | no (`shell_unavailable`) | SQL | both |
| `workspace-git` | clone/checkout per session | via `execution` | Git remote | both* |
| `workspace-r2-snapshot` | tar in `storage.blob` | via `execution` | R2/S3 | both* |
| `workspace-container` | Cloudflare Container FS | yes | ephemeral + checkpoint | cloudflare |

\* requires an `execution` provider that has a real filesystem.

### 8.3 `execution` capability

The contract is Pi's `ExecutionEnv`. Implementations:

| Component | `exec()` | Notes |
|---|---|---|
| `execution-local` | Pi `NodeExecutionEnv` | server |
| `execution-fetch` | returns `err(shell_unavailable)` | edge-pure; FS from `workspace-virtual` |
| `execution-cloudflare-container` | RPC to the DO's attached Container | cloudflare |
| `execution-remote` | HTTP/WebSocket to any host implementing the executor protocol | both |

Tools that need a shell declare `execution.shell`; `execution-fetch` does not provide it, so
`pikit doctor` fails early.

### 8.4 Effectful tools and replay

After a crash or DO eviction, a tool call can have its intent recorded and no result. Pi
handles this itself (verified by the adapter spike on 0.87.1). On `resume()`, a tool declared
`replay: "safe"` runs again. Any other tool (`"never"` is Pi's default) is not re-run: Pi
records an error result saying that the call was interrupted and its external outcome is
unknown, and the model decides. The adapter only passes each tool's declared `replay` to Pi.
Components that perform external writes must use `OutboundMessage.idempotencyKey` / their own
keys derived from `${sessionId}:${runId}:${toolCallId}`.

---

## 9. Runtime targets

### 9.1 Server

- Process: Bun ≥ 1.4 (preferred) or Node ≥ 22.
- HTTP: a thin `server-bun` component (Hono or `Bun.serve`) exposing `/health`, `/ready`,
  channel webhooks, and admin routes contributed by components.
- Routes are the keyed capability `http.route` (§4.5) `[decision]`: a standard fetch handler under
  the key `"METHOD /path"`. `METHOD` is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. A path segment
  is literal or a parameter (`:id`) matching exactly one segment, and handlers read parameters
  from `request.url`. What a server guarantees to every handler is the contract, and
  `createHttpRouteConformance` checks it:
  - the request as sent and the response unchanged;
  - a context of its own, never `start`'s, cancelled when the client goes away or the server
    stops, and a handler still answers after that cancellation;
  - concurrent handling;
  - a `500` that does not reveal a thrown error, and a `404` for no match;
  - a refusal to start with a key it cannot serve.
- Storage: `sessions-sqlite` + `storage-sqlite` by default; Postgres optional.
- Scheduler: `scheduler-cron` (in-process, `Bun.cron` or `croner`), jobs persisted in
  `storage.sql`.
- Deployment: `deployment-docker` generates `Dockerfile` + `compose.yaml`;
  `deployment-systemd` generates a unit file. `pikit up/down/logs/status` wrap them.
- Agent runtime is `pi-agent-core` here too; `pi-coding-agent` is not imported on any target
  (§6.3).
- Workers: one process is one worker and owns every conversation (§7.2). Several replicas
  need `conversations.ownership`; until it exists, the server target runs one replica.
- Start and shutdown `[decision]`: the entrypoint (owned by the `deployment-*` component, not
  the core) passes deadlines and never restarts an app in the same process; the supervisor
  (systemd, Docker) restarts the process.
  - `start(ctx)` with a deadline. If it rejects, exit non-zero.
  - On SIGTERM or SIGINT, `stop(ctx)` with a deadline shorter than the supervisor's kill
    timeout (systemd `TimeoutStopSec`, Docker's stop grace period), leaving room to exit.
    Exit 0 if it resolves, non-zero if it rejects (a stop that failed or was abandoned).
  - A second signal during the stop exits at once.

### 9.2 Cloudflare

Topology:

```
Worker (fetch)                     ← channel ingress, auth, routing (stateless)
   │  idFromName(conversationKey)
   ▼
Durable Object "Conversation"      ← one per conversation key
   ├── pikit app instance          (setup on construct; must be cheap)
   ├── sessions-cloudflare-do      (ctx.storage.sql)
   ├── conversations.registry      (ctx.storage.sql)
   ├── outbox table + alarm        (retries with at-least-once + backoff)
   ├── WebSocket hibernation       (streaming to clients)
   └── optional Container binding  (shell/workspace)
Cloudflare Workflows               ← approvals and anything that waits > 15 min
Cron Triggers                      ← scheduler ticks (fan out to DOs)
R2                                 ← blobs, workspace snapshots
```

Constraints the design must respect (from Cloudflare docs, verify on change):

- No `child_process`, no `node:sqlite`, no `eval`. Components are compiled in; nothing
  dynamic.
- 128 MB memory per isolate; 10 MB compressed bundle; 1 s startup. Import `pi-ai` providers by
  subpath only.
- DO alarm handlers ≤ 15 min; CPU ≤ 30 s default (configurable to 5 min). Waiting on a model
  response is wall-clock, not CPU.
- ~6 concurrent outbound connections per invocation → cap subagent fan-out.
- In-memory state is lost on hibernation; everything the app needs across actions must
  be in `ctx.storage`.
- `blockConcurrencyWhile` terminates and resets the object if its callback throws or runs
  longer than 30 s. `start(ctx)` runs inside it with a shorter deadline, so a slow start rolls
  back before the platform kills it, and its rejection is rethrown: the reset is the fresh
  process. There is no in-object restart.
- SQL row/blob ≤ 2 MB → large attachments and images go to R2 with a reference in the
  transcript.

Drive model: the adapter admits with `accept()` and executes with
`drive({ waitForRetry: false })`; Pi commits every step to the session. When the drive returns
`waiting { notBefore }` (a retry backoff), the DO sets an alarm and returns, and on the alarm it
drives again. If the object is evicted mid-drive, the next request or alarm calls `resume()`.
`[upstream]` `[open]` — read from the 0.87.1 types, not yet exercised; settled in M4.

Streaming: `agent.*` progress events are forwarded to hibernating WebSockets attached to the
DO; the authoritative state is always the session, never the stream.

Deployment: `deployment-cloudflare` generates `wrangler.toml` (DO bindings, R2, Workflows,
cron, optional Container), and `pikit deploy --profile cloudflare` wraps `wrangler deploy`.

### 9.3 What is shared

| Layer | Shared? |
|---|---|
| Core, contracts, events, pipelines | 100 % |
| Agent definitions, prompts, skills | 100 % |
| Router, approvals logic, decision lifecycle | 100 % |
| HTTP channels (webhook parse/verify/format) | ~90 % (ingress adapter differs) |
| API-only tools | 100 % |
| Shell tools | need `execution.shell` provider on the target |
| Sessions, storage, workspace, execution, scheduler, deployment | adapters differ |

---

## 10. Components and registries

### 10.1 Component package layout

```
channel-telegram/
├── component.json
├── files/
│   └── src/pikit/channels/telegram/
│       ├── index.ts          defineComponent(...)
│       ├── ingress.ts        webhook → InboundMessage
│       ├── transport.ts      ChannelTransport
│       ├── format.ts
│       └── telegram.test.ts
├── config/
│   └── schema.ts             typebox config schema
├── migrations/               optional, for storage.sql users
│   └── 001_telegram.sql
└── README.md
```

### 10.2 Manifest

```json
{
  "name": "channel-telegram",
  "version": "1.4.0",
  "description": "Telegram bot channel (webhook ingress + Bot API transport)",
  "license": "MIT",
  "targets": ["server", "cloudflare"],
  "requires": {
    "pikit": ">=0.1.0",
    "capabilities": ["network.fetch", "secrets"]
  },
  "optional": { "capabilities": [] },
  "provides": ["channel.transport"],
  "dependencies": {},
  "files": [{ "source": "files/src", "target": "src" }],
  "environment": [
    { "name": "TELEGRAM_BOT_TOKEN", "secret": true, "required": true },
    { "name": "TELEGRAM_WEBHOOK_SECRET", "secret": true, "required": true }
  ],
  "config": "config/schema.ts",
  "migrations": "migrations",
  "replay": { "tools": {} }
}
```

Rules:

- `dependencies` are real npm deps (SDKs, crypto). They are added to the project's
  `package.json`. Behavior is copied; protocols and crypto are depended on.
- No install scripts. Ever. `[decision]`
- `provides`, `requires.capabilities` and `optional.capabilities` exist because the CLI must
  read them before any code is copied. They are **generated** from the component's `setup`
  (`describe()`), never written by hand, and `pikit registry validate` and `pikit doctor` fail
  when they drift. `[decision]`
  - `requires.capabilities` are its `use()`s: the component cannot run without a provider.
  - `optional.capabilities` are its `useOptional()`s and `useKeyed()`s: it runs without a
    provider. The delivery component's `useKeyed("channel.transport")` lands here.
- A component depends on **capabilities, never on components** (rule 4). There is no
  `requires.components`: the manifest is generated from `setup`, and `setup` has no way to
  name another component. A capability no installed component provides is reported by
  `pikit add` and `pikit doctor`, not installed implicitly. `[decision]`
- `targets` gates `pikit add` against the project's configured targets.

### 10.3 Project manifest

```json
// pikit.json
{
  "version": 1,
  "targets": ["server"],
  "registries": {
    "official": "https://github.com/pikit-dev/registry",
    "acme": "git+ssh://git@github.com/acme/pikit-registry.git",
    "local": "../my-components"
  },
  "components": {
    "channel-telegram": {
      "registry": "official",
      "version": "1.4.0",
      "commit": "a83f92c",
      "files": {
        "src/pikit/channels/telegram/index.ts": { "hash": "sha256:...", "modified": false },
        "src/pikit/channels/telegram/format.ts": { "hash": "sha256:...", "modified": true }
      }
    }
  }
}
```

### 10.4 Registry format

A registry is a Git repository (or static HTTP root) with:

```
registry.json                index: name → { versions, description, targets, path }
components/<name>/           component packages as in §10.1
```

No server-side logic. Private registries use the user's existing Git credentials.

### 10.5 Install flow

```
pikit add acme/channel-whatsapp
  1. resolve registry + version (pinned commit)
  2. fetch component package
  3. check targets and pikit version; warn for each required capability nothing installed provides
  4. show: files to write, npm deps to add, env vars required, capabilities requested, source
  5. confirm
  6. write files; refuse to overwrite modified files without --force
  7. add npm deps; run package manager install
  8. edit pikit.config.ts (append import + entry)
  9. append config schema; scaffold config/ values; append .env.example
 10. record hashes in pikit.json
 11. run `pikit doctor`
```

`pikit remove` reverses it and refuses if that would leave a capability that another installed
component requires (`use`) without a provider. Losing the provider of an optional capability is
allowed; `doctor` reports it.

### 10.6 Upgrade flow

```
pikit outdated                 list newer versions, count modified files
pikit diff <component>         three-way: installed-original vs upstream vs local
pikit upgrade <component>      apply clean hunks; for conflicts:
                               [show diff | keep local | take upstream | resolve with pi]
```

`resolve with pi` hands the three versions to a Pi session with a merge prompt. This is the
mechanism that makes source-ownership survivable for fast-moving integrations.

---

## 11. CLI

```
pikit new <dir> [--preset <name>] [--target server|cloudflare]
pikit init                                   # in an existing project
pikit add <component>[@version] [--registry] [--force]
pikit remove <component>
pikit create <kind> <name>                   # extension | component | channel | tool | agent
pikit registry add|remove|list|init|validate
pikit outdated | diff | upgrade
pikit config check | configure [<component>]
pikit doctor
pikit dev                                    # local run with reload (server target)
pikit up | down | restart | logs | status    # server target via docker/systemd component
pikit deploy [--profile <name>]              # delegates to deployment-* component
pikit expose                                 # cloudflare tunnel / caddy helper (server)
```

Presets are lists of `add` calls, nothing more:

```yaml
# registry/presets/telegram.yaml
components:
  - runtime-pi
  - server-bun
  - channel-telegram
  - router-basic
  - storage-sqlite
  - sessions-sqlite
  - workspace-local
  - execution-local
  - deployment-docker
  - admin-basic
```

---

## 12. Configuration

- `config/pikit.yaml` — non-secret values. Schema is the merge of core schema + every
  installed component's schema; validated at `doctor`, `dev`, `up`, `deploy`.
- `.env` (server) / Worker secrets (cloudflare) — secrets, read through `secrets` capability.
- Profiles: `config/<profile>.yaml` overlays for `--profile`.
- YAML is parsed with a YAML 1.2 parser; `on/off/yes/no` are strings. `[decision]`
- The validated config is a deep-frozen copy. `ctx.config` is shared by every component, so a
  mutation would be a hidden coupling between them; frozen, it throws where it happens. The
  caller's objects are never defaulted or frozen in place. `[decision]`

---

## 12a. Stability policy

pikit is meant to be boring. The programming model a user learns for 1.0 is the model for
the whole 1.x line; there is no "pikit 2 rewrites how you define agents".

| Surface | Rule |
|---|---|
| `@pikit/core` public API (`defineApp`, `defineComponent`, `defineAgent`, `pikit.on/pipeline/provide/provideKeyed/use/useOptional/useKeyed`, `ctx.emit/run/derive`, event and pipeline names, capability contracts) | Semver. Within a major: additive changes only. Removals require a deprecation that ships in at least one minor with a runtime warning and a `pikit doctor` hint, then a major. Majors are rare and come with an automated migration where possible. |
| Contract interfaces (`SessionStore`, `SqlDatabase`, `ExecutionEnv`, `Workspace`, `ChannelTransport`, …) | Same as core. A contract change ships with its updated conformance suite in the same release. |
| `@pikit/pi-adapter` | May move faster to absorb Pi churn. Its *pikit-facing* surface follows the core rule; its Pi-facing internals are unstable by design. |
| `component.json`, `pikit.json`, registry format | Versioned schemas (`version` field). Readers accept all prior versions of the same major. |
| Components | Version independently. A component major never forces a core major. Installed components are the user's; upstream changes reach them only through `pikit upgrade`. |
| Pre-1.0 (M0–M5) | Anything may change. No compatibility promises. This is the period to be wrong quickly. |

Cadence: core minors as needed, never on a schedule that forces churn; component releases
are independent. Every core release note lists "what you must change" first — the target
is that the answer is "nothing" for every minor.

## 13. Security model

- Components execute in-process with full privileges of the app. Installing one is
  running code. The CLI shows provenance (registry, commit, files, deps, env, capabilities)
  and pins commits; it never runs install scripts.
- Inbound authentication is a pipeline stage every channel must implement; a channel with no
  `inbound.authenticate` stage fails `doctor`.
- Tool gating is a component (`policy-tools`): intercepts `agent.tool.call`, evaluates rules
  by agent role, blocks or allows. It is **policy mediation, not a sandbox**; documented as
  such. Real isolation is a property of the `execution` provider (container, micro-VM,
  remote sandbox).
- Secrets never appear in config files or session transcripts; the `secrets` capability is
  the only read path and logs redact by name.

---

## 14. Testing and conformance

- Core: unit tests for event ordering, pipeline priority/halt, capability resolution errors,
  config schema merge, lifecycle order.
- **Lifecycle conformance** (`createLifecycleConformance` in `@pikit/core/testing`): every
  component that owns resources passes it. It aborts the component's `start` and `stop` while
  they run and checks that each settles within `settleMs`, that nothing is left open (when
  the fixture provides `openResources()`), and that a fresh app over the same component can start again. Cases have
  Pi's runner-independent shape (`{ group, name, run() }`).
- **Agent runtime conformance** (`createAgentRuntimeConformance` in `@pikit/core/testing`):
  every `agent.runtime` passes it. It drives a scripted agent that the fixture provides (each
  turn answers `answer: <newest inbound message>`; `hold` blocks in a tool until released;
  `holdAtEnd()` pauses a run after its final answer) and observes only the capability and the
  `agent.*` events. It covers admission (`started` / `queued` / `duplicate`, concurrent
  deliveries included), a message answered by the run in progress even when it arrives as that run
  ends, `agent.settled` with nobody waiting, a cancelled caller that does not stop the run,
  `abort()` withdrawing queued messages that stay duplicates, and a run left open by a dead worker:
  resumed by `resume()` or by the next `dispatch`, answering the messages dispatched to it, its
  request still a duplicate. The fixture's `interrupted()` provides that dead worker; the Pi
  adapter kills a real process. An in-memory double in the suite's own tests proves the suite
  asks nothing Pi-specific (S12).
- **Secrets conformance** (`createSecretStoreConformance`): every `secrets` provider. The suite
  chooses the secrets and the fixture seeds its store with them. A secret reads back exactly
  (spaces, symbols, unicode, 4 KB), an unset or empty one reads `undefined`, and no value appears
  in `describe()` or in a log line. An in-memory double passes it.
- **Conversation registry conformance** (`createConversationRegistryConformance`): every
  `conversations.registry`. It covers create once (concurrently too), stable pointers, one session
  per key, `get` creating nothing, a conversation keeping its agent, opaque keys, reset (new
  session, old kept, one event) and pointers surviving a new worker. When the fixture lists its
  store's sessions, the suite also checks that pointers name real sessions and that nothing is
  deleted. An in-memory double passes it.
- **HTTP route conformance** (`createHttpRouteConformance`): every server of `http.route`
  (§9.1). The suite provides the routes and sends requests through the fixture. An in-memory
  double that routes a `Request` with no socket passes it.
- Contracts ship **conformance suites** (`@pikit/core/testing`): any `sessions.store`,
  `storage.sql`, `workspace`, `execution`, `channel.transport`, `outbound.queue`
  implementation must pass its suite. Pi's session conformance is reused for
  `sessions.store`.
- Components ship their own tests inside `files/` so they are copied into the user's project
  and keep running there.
- The registry CI runs every component's tests on both targets it declares (server: Bun;
  cloudflare: `wrangler dev` / Miniflare).

---

## 15. Acceptance scenarios (design validation)

The design is considered validated when all five pass without touching the core:

1. **Minimal**: `runtime-pi` + `server-bun` + `channel-http` → working agent over HTTP.
2. **Chat**: `+ channel-telegram + sessions-sqlite` → stateful Telegram bot.
3. **Reliability**: `+ durable-outbox` → delivery retried after simulated channel failure;
   channel component unchanged.
4. **Swap**: `remove sessions-sqlite`, `add sessions-postgres` → router/channel/agent
   untouched; conformance suite green.
5. **Custom**: `pikit create extension company-policy` → alters routing and blocks a tool
   without forking any component.

And the runtime proof:

6. **Edge**: same agents + `deployment-cloudflare + sessions-cloudflare-do + workspace-virtual
   + execution-fetch` → deploys, answers, survives DO eviction mid-run (`resume()` completes
   the run), and the DO session backend passes Pi's conformance suite.

7. **Pi compat**: an existing Pi extension that uses only tier A of §6.2b (e.g. a
   `tool_call` policy + one `registerTool`) is added to `runtime-pi` unmodified and its
   handlers fire during scenario 1. The extension half runs today: Pi's own `permission-gate`,
   `protected-paths` and `hello` examples, byte for byte (`compat.test.ts`). The HTTP half
   waits for scenario 1.

---

## 16. Open questions `[open]`

- Sync vs async `SqlDatabase` contract. DO SQL is sync; Postgres is async. Likely: async
  contract, sync implementations wrap. Pi's SQLite backend expects sync — needs an adapter.
- Where the conversation registry lives on Cloudflare when a *global* view is needed (list
  all conversations): D1 index vs per-DO only. Probably per-DO + optional D1 index component.
- Config format: YAML vs TypeScript-only. TS gives types for free; YAML is friendlier for
  `configure` wizards. Current lean: YAML for values, TS for composition.
- Whether `router` should be core or a component. Current lean: the `route.resolve`
  pipeline is core; every actual routing strategy is a component.
- Streaming to channels that support message editing (Telegram, Google Chat): a
  `channel.transport` optional `edit()` + a `stream-to-edit` component, or core support.
- Multi-tenant isolation guarantees: routing is not isolation. Document clearly; consider a
  `tenant-isolation` component that maps tenants to separate DO namespaces / DB files.
- Runtime availability and degradation: how a component that breaks after `start` (a stuck
  poller, a dead connection) becomes visible, and who decides between degrading and
  restarting. Today `/ready` reflects only the start, so a broken process looks healthy
  and no supervisor restarts it (§9.1). Chord has the consumer half (stable handles,
  `unavailable`/`replaced`, calls fail fast without queueing, `ready()`) but no
  self-report, no notion of essential, and no policy. Current lean: a `health` capability
  and a `health-registry` component, not core. Components report through
  `useOptional("health")`, so absence changes nothing. The registry owns the policy: degrade
  what can be tolerated, fail `/health` for what is essential so that the supervisor
  restarts the process. It follows Chord's availability semantics so that §6.4 does not end
  up with two models. It is decided with M2's real components, not before. To settle: grace
  periods against flapping, where "essential" is declared (per deployment, so config), and a
  conformance suite that proves a component reports its failures.

Resolved `[decision]`:

- `defineApp({ config })` takes an object; the core never reads files (rule: runtime
  neutrality). The CLI/target loads YAML and passes the value.
- Config is namespaced by component name (`config[component.name]`); core keys live at the
  same level. Merge is mechanical; no `configKey` in the manifest until a collision exists.
- `setup` is the manifest: the graph is derived from `provide`/`use` calls (§4.2). Missing,
  ambiguous and badly selected providers and cycles fail in `create()`, before any `start`.
- `use()` returns an explicit `Handle` whose `get()` works after validation; no proxies, no
  `ctx.require`.
- Registration is sealed when `setup` returns; `stop()` cancels an in-flight `start()`
  (§4.2, §4.6).
- `start(ctx)`/`stop(ctx)` take their deadline from the caller as a context; hooks that
  outlive it are abandoned, not awaited (§4.6). The host knows the deadline; the core stays
  free of timers and timeout options.
- An extension is a component and is listed in `components` like any other. There is no
  `extensions: [...]` option: one list, one way to install. One `define*` fewer to keep stable.
- Events are typed by declaration merging on `AppEvents` (as Pi's `CustomAgentMessages`);
  no runtime registration for typing. Pipelines likewise on `AppPipelines`.
- Pipelines are `Value → Value` (§4.4). Stage errors propagate; `undefined` from a stage is an
  error, not "unchanged".
- `setup` registers, `start`/`stop` own resources (§4.2, §4.6). Resource acquisition in an
  event listener would turn a failed start into a log line and a healthy-looking process.
- A consumer is ordered after the provider `get()` will return (the selected one), not after
  every installed provider; an unselected provider cannot create a false cycle.
- `capabilities` is a reserved component name (it is the core's config key).
- Inbound deduplication is the `inbound-dedup` component, not core (§5).
- Keyed capabilities (`provideKeyed` / `useKeyed`) replace `channel.transport:<name>` and its
  "never in `use`" rule (§4.5). A transport is found by key per message, and the outbox
  depends on every transport.
- Optional dependencies are `useOptional(name)`, a verb rather than a boolean option: absent
  means `undefined`, present means ordered first. `useKeyed` accepts no providers, so it needs
  no optional form.
- `ctx.has(name)` is removed: `useOptional(name).get()` answers the same question as a declared
  dependency, and a second, undeclared path would contradict §4.2.
- Capability names: `execution` (filesystem, maybe no shell), `execution.shell` (real shell),
  `network.fetch` (outbound HTTP). `workspace.posix` is dropped: a real shell implies it.
- `component.json`'s `provides`/`requires`/`optional` are generated from `setup` (§10.2).
  Components depend on capabilities only; there is no `requires.components`.
- `defineAgent` and the agent shapes are core; Pi payload types are opaque in core and made
  precise by the adapter (§6.1).
- **Pi first** (§6.2): an agent-facing feature is built in pikit only after checking that Pi
  does not already provide it. pikit is the kit around Pi, never a second agent.
- Conversations are actors and processes are workers (§7.1). The actor's mailbox is Pi's
  inbox; pikit keeps no message queue of its own.
- The invocation context has Chord's `Context` shape and helper semantics, with no Chord
  dependency (§4.7). Crossing into Pi needs a one-line bridge in the adapter (§6.2).
- Pi is pinned to 0.87.x (§6.4). Pi's durable runtime is the target: pikit builds no
  logical deduplication, task engine or state store of its own.
- `agent.state` lives in the Pi session and resets with it (§6.2a).
- `inbound-dedup` is transport deduplication only; logical deduplication is Pi's submission
  `requestId` (§5, §6.4).
- Messages reaching a busy conversation are `steer`ed by default (§7.3), matching what a chat
  user means by a new message; an agent may choose `followUp` or `nextRun`.
- "Conversation ownership", not "placement": one worker has a session open at a time. A
  single-process server and Cloudflare need no component for it; several replicas do (§7.2).
- `AgentRuntime.dispatch` returns an admission, and a run's answer is the `agent.settled` event
  the adapter emits from Pi's `run_end` (§6.1). A run resumed after a crash has nobody waiting
  for it, so a return value cannot carry its answer. The contract has no `steer()`: Pi decides
  idle or busy atomically, and a caller deciding first would race the end of the run.
- Pi will not add submissions to `pi-agent-core`: its durable runtime is a separate package.
  Until the adapter moves to it, the adapter bridges Pi 0.87.1's gaps with Pi's own mechanisms,
  reproducing the durable runtime's semantics:
  - it enqueues first and then calls `accept()`;
  - the `requestId` travels inside a Pi `custom` message.

  pikit builds no submission store, and the bridge is deleted on the move (§6.4).
- The runtime resolves the agent from `conversation.agent` through the keyed capability
  `agent.definition`; `AgentRequest` carries no definition (§6.1). A resumed run has no request,
  so the name is the only truth.
- `AgentRequest` starts as `{ requestId, conversation, prompt: string }`; other inputs arrive with
  the components that produce them, because adding a field is compatible and removing one is not.
- Opening a conversation resumes the runs a dead worker left open; `resume()` wakes a
  conversation without a message (§6.1).
- `abort()` withdraws the messages queued in the run; they stay duplicates (§6.1, §6.4 gap 4),
  as in Pi's durable runtime.
- Pi extensions run through a vendored subset of `ExtensionAPI` in the adapter, with no TUI
  (`hasUI: false`, `ui.*` no-ops) (§6.2b). Extensibility through Pi's ecosystem is a goal, and a
  19 MB types-only dependency is not.
- Pi extensions are declared in `createRuntimePi({ extensions })`, loaded per conversation as Pi
  loads them per session (so their actions need no ambient context), and imported from
  `@earendil-works/pi-coding-agent` through an alias to `@pikit/pi-extension-shim` (§6.2b).
- `AgentResult.requestIds` lists every request a run took (§6.1). Without it, a request queued
  into a running run would never learn it was answered, and a channel that replies per message
  (HTTP) would wait forever. The list is read from the transcript; no record is added.
- Model providers are components: each provides the keyed capability `model.provider` under its
  id, and the runtime builds its models from all of them (§4.5). Adding a provider is adding a
  component, and a missing one is visible in `doctor`, not a config flag.

---

## 17. Roadmap

Milestones, what each one proves, and the standards every milestone must meet live in
`ROADMAP.md`. This spec defines the contracts; the roadmap defines when they are real.

---

## 18. Higher-level components (post-M2)

Components that encode operational patterns beyond plain message-in/reply-out, in order of
value. Each one is built contracts-first against the core in §4–§5 and must remain removable:

| Component | What it encodes |
|---|---|
| `approvals` | Deterministic decision lifecycle: proposed → approved/rejected → executed → verified, with retries, reminders, stalled escalation, TTL/abandonment, and **delivery-time binding** of a decision to the message/thread where a human can answer it (a decision created by a scheduled job cannot know its answer surface until the result is sent). |
| `inbound-dedup` | Transport deduplication (§5): claim / commit / release of platform delivery ids, duplicates halted, retries of crashed attempts allowed, stale claims expired. At-least-once by contract. Logical deduplication is Pi's. |
| `durable-outbox` | Outbound intents persisted before send, retried with backoff, dead-lettered, and recorded so later replies can quote or thread against them. |
| `conversations.registry` | Conversation key → active session + workspace ref, with TTL eviction of memory that never drops the pointer, and explicit `/reset` semantics. |
| `routines` | File-defined scheduled prompts (`src/agents/{name}/routines/*.yaml`) synced into `scheduler`, with target fan-out by route tags and previous-run context injection. |
| `policy-tools` | Role-based interception of `agent.tool.call`: shell command and path rules, allow/deny lists, hot-reloadable. Policy mediation, not a sandbox. |
| `channel-google-chat` | Google Chat app: JWT-verified webhook ingress, REST transport with message create/patch, cards, threads, media. |
