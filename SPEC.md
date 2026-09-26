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
import telegram from "./src/pikit/channel-telegram";
import router from "./src/pikit/router-basic";
import sessions from "./src/pikit/sessions-sqlite";
import pi from "./src/pikit/runtime-pi";
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
  name: "outbound-durable",
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
persists an event (`outbound-durable`):

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
| `storage.sql` | `SqlDatabase` | Async `query` / `run` / `transaction` (§16: decided async). One database per app; each component owns its own tables, prefixed with its name. Backed by `node:sqlite` (`storage-sqlite`, M2), a Postgres driver, or DO `ctx.storage.sql`. |
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
| `model.credentials` | pi-ai `CredentialStore` | Credentials of the model providers, one per provider id (API key or OAuth tokens). pi-ai refreshes OAuth tokens inside the store's `modify` and writes them back, and reads the environment (`ANTHROPIC_API_KEY`) only when nothing is stored. Optional: without it, providers read their environment variables only. Typed by `@pikit/pi-adapter`; its conformance suite is in `@pikit/pi-adapter/testing` (§14), because the contract is pi-ai's. |
| `agent.definition` (keyed by agent name) | `AgentDefinition` | One per agent, provided by the project. The runtime resolves `ConversationRef.agent` through it, and the router can check that a name exists (§6.1). |
| `agent.tool` (keyed by tool name) | `AgentTool` | One per tool, provided by `tool-*` components. An agent names the tools it uses in `AgentDefinition.tools`; the runtime resolves the names (§6.3). |
| `agent.extension` (keyed by extension name) | Pi `ExtensionFactory` | `[planned]` (M1.5) One per Pi extension, provided by a component. An agent names the extensions it uses in `AgentDefinition.extensions`, as it names tools; the runtime loads them per conversation (§6.2b). Typed by `@pikit/pi-adapter`, so the core sees only names. |
| `agent.state` | `AgentState` | Per-conversation JSON state read by `prepare` and updated by tools. Not a capability today: the runtime puts the conversation's `AgentState` in the context of each run (`AGENT_STATE`), stored in the Pi session (§6.2a, §6.4); no separate store. A capability for components that act outside a run (an admin route, a scheduler) is `[planned]`, with the first one that needs it. |
| (no capability) | `ChannelTransport` | How a channel sends to its platform: `idempotent`, `split`, `send` (§5, "Outbound delivery"). Not in the registry: a channel attaches its transport to `outbound.queue` while it runs, since a keyed `channel.transport` used by the queue, and a queue used by the channel, would be a dependency cycle. Without a queue, the channel sends through its own transport. |
| `inbound.dedup` | `InboundDedup` | Claim / commit / release of platform delivery ids. Optional; see "Inbound deduplication" in §5. |
| `outbound.queue` | `OutboundQueue` | `enqueue`, `attach`, `detach` (§5, "Outbound delivery"). Optional: without it a channel sends directly, best effort, as in M1. `outbound-durable` (M2) provides it on `storage.sql`. |
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

**M1: the HTTP channel.** `[decision]` for M1, with `channel-http`:
- **No `conversation.resolve` pipeline yet.** The channel calls
  `conversations.registry.resolve(key, decision.agent)` directly. The pipeline is added, which is
  compatible, when a component needs to change which conversation a message goes to.
- **The answer is the HTTP response.** Delivery does not go through `outbound.prepare` and
  `channel.transport`. `channel-http` listens to `agent.settled` / `agent.failed` itself and
  answers every POST waiting for one of the run's `requestIds`, so a message admitted as `queued`
  gets the answer of the run it joined. The map of waiting POSTs is a cache: the answer is in the
  session whether or not a POST waits, and a POST that waited longer than `replyTimeoutMs` gets
  `202 { requestId }`. Reason: a client waiting on its own request has nothing to retry and no
  transport that can fail. `outbound.prepare`, `channel.transport` and the outbox arrive in M2 with
  `outbound-durable` and the first channel that sends to a platform. No `outbound-direct` component
  is built, because M2 would replace it.
- **Duplicates.** A POST whose `messageId` is already in the conversation gets
  `409 { requestId, error: "duplicate" }` and does not run. Its answer went to the first POST and
  is in the session. pikit keeps no copy of answers to return again; Pi's durable runtime will make
  a submission awaitable until its answer (§6.4).

**The inbound path in code.** `[decision]` The steps after authentication are one function in
`@pikit/core`, `admitInbound(ctx, message, { conversations, runtime, key, beforeDispatch? })`, the
same for every producer of messages (a channel, a scheduler). It runs `inbound.normalize`, checks
that no stage changed which message or conversation it is (`id`, `channel`, `conversationId`;
changing one throws), runs `route.resolve`, resolves the conversation `key` and dispatches, and
returns what happened:

| Outcome | When | `channel-telegram` | `channel-http` |
|---|---|---|---|
| `admitted` | durable in its conversation (`started` or `queued`) | "typing…", then the answer | waits for the answer (`200` / `202`) |
| `duplicate` | the conversation already has the message | nothing | `409 duplicate` |
| `halted` | a stage of `inbound.normalize` or `route.resolve` stopped it | "I can't take that message." | `422` (normalize) / `403` (route) |
| `denied` | the router decided no agent answers | "Sorry, I can't answer that here." | `403 denied` |
| `no_route` | no stage of `route.resolve` decided (logged as an error) | "This bot is not set up to answer yet." | `500 no_route` |

- It is the protocol, not a strategy (rule 2): what varies is a pipeline stage (normalizing,
  routing, dedup), and what is a platform's stays in the channel: authentication, the conversation
  key, commands, replies, "typing…", HTTP's wait for the answer. It registers nothing, keeps no
  state and is no capability; a channel may still run the path itself.
- `beforeDispatch(conversation)` is called after the conversation resolves and right before
  `dispatch`: the last moment to start waiting for the run's events, which may arrive before
  `dispatch` returns. `channel-http` registers its reply waiter there.
- The `conversation.resolve` pipeline and the `inbound.*` / `route.*` events of the diagram above
  land in this function when a component needs them, with no channel changed.
- `createChannelConformance` (§14) holds every channel to it, whether it calls `admitInbound` or not.

**Telegram, before M2.** `[decision]` `channel-telegram`, the first chat channel:
- **Long polling, not a webhook.** The bot asks Telegram for updates (`getUpdates`), so it needs no
  public URL, certificate or open port, and runs the same on a laptop and on a VPS without a
  domain. Flue and Eve take webhooks; NanoClaw polls. A webhook, which Cloudflare needs, would be
  another component.
- **Acknowledged after admission.** The offset moves past an update only once `dispatch` admitted
  its message. A redelivery after a crash is the same request (`telegram:<chat>:<message>`), which
  the conversation recognises as a duplicate (§6.4). Logical deduplication is enough here:
  `inbound-dedup` is for platforms whose retries a crashed attempt must not lose (§5).
- **Senders are authorized, not requests authenticated.** Updates come from Telegram's own API, over
  TLS, with the bot's token, so there is no request to authenticate (§13). Anyone can find a bot,
  and an agent with tools must not answer strangers. Only the user ids in `TELEGRAM_ALLOWED_USERS`
  reach the agent; a stranger is told their id once, for the owner to add. The list is read through
  `secrets`, like the token, because it lives in `.env` next to it and `pikit configure` fills it.
- **Private chats only**, one conversation each (`telegram:<chat id>`). Groups need the bot's privacy
  mode and mention rules; later.
- **Replies as for HTTP.** The channel listens to `agent.settled` / `agent.failed` and sends the run's
  answer to the chat once per run, with "typing…" while it runs. It converts Markdown to Telegram's
  HTML (plain text when Telegram refuses it) and splits answers at 4096 characters. It retries in
  the process: after `retry_after` on a 429, with backoff on network errors and 5xx.
  - This is the platform-sending case M2's `outbound-durable` is for. When the outbox exists, the
    sending moves behind `channel.transport`, and ingress does not change.
  - Until then, a reply lost to a crash while sending is not sent again; the answer is in the
    session.

**Channels, accounts and keys.** `[decision]` (M1.5)
- A channel component may serve several accounts of its platform: two Telegram bots, two Google
  Chat apps. Each account is a **channel instance**, named `<kind>` for the default account
  (`telegram`) and `<kind>:<account>` for a named one (`telegram:support`).
  `InboundMessage.channel`, `OutboundMessage.channel` and the key a transport is attached under are
  the instance name.
- A conversation key is `<instance>:<conversation id>[:<thread id>]`: `telegram:12345`,
  `telegram:support:12345`, `googlechat:spaces/AAA:threads/BBB`. Only the channel that made a key
  reads it back. Routers, the outbox and tools read `InboundMessage` fields and never parse keys; the
  registry's conformance already treats keys as opaque.
- The default account keeps the keys channels use today, so existing conversations keep their
  sessions.
- Whether a thread is a conversation of its own is a value in the channel's config.

**Routing to many agents.** `[decision]` (M1.5)
- `router-rules` adds a `route.resolve` stage that runs before `router-basic`'s. Its config is a list
  of rules; the first that matches wins. A rule matches on any of `channel` (an instance, or a kind to
  match all its accounts), `conversation`, `thread` and `actor`, and gives `agent: "<name>"` or
  `deny`. A message no rule matches is left to the next stage: `router-basic`'s `defaultAgent`, or
  `route.failed` when nothing else routes it.
- Rules are values; a different strategy is a different component (S7). Choosing the agent from the
  chat itself (`/agent support`) is such a component, built when someone needs it.
- It refuses to start when a rule names an agent that is not an `agent.definition`, as
  `router-basic` does.
- A conversation keeps the agent it was created with (§7.1). A changed rule applies to new
  conversations, and to an existing one after a reset (`/new`).

**Outbound delivery.** `[decision]` (M2) The shape `outbound-durable` implements. It follows Hermes'
delivery ledger, with what NanoClaw and OpenClaw lack: backoff, per-conversation order, per-piece
progress, and one send path.

```ts
interface OutboundMessage {
  idempotencyKey: string;      // one per answer: `${sessionId}:${runId}`
  channel: string;             // the channel instance
  conversationKey: string;
  text: string;
}

interface ChannelTransport {
  /** The platform drops a repeated send with the same key (Google Chat `requestId`). */
  readonly idempotent: boolean;
  /** `text` in pieces the platform accepts, in order. */
  split(text: string): string[];
  send(piece: OutboundPiece, signal: AbortSignal): Promise<{ platformMessageId: string }>;
}

interface OutboundPiece {
  key: string;                 // `${idempotencyKey}#${index}`: the platform's key when idempotent
  conversationKey: string;
  text: string;
  possibleDuplicate: boolean;  // it may have been sent before: a non-idempotent transport marks it
}

/** What a transport throws; anything else counts as transient. */
class DeliveryError extends Error {
  kind: "transient" | "rate_limited" | "permanent";
  retryAfterMs?: number;       // rate_limited: what the platform asked for
  maybeSent?: boolean;         // the platform may have received it (a timeout)
}

interface OutboundQueue {
  /** Resolves once the message is stored; the same idempotencyKey again changes nothing. */
  enqueue(message: OutboundMessage): Promise<void>;
  /** A channel hands its transport while it runs, and takes it back when it stops. */
  attach(channel: string, transport: ChannelTransport): void;
  detach(channel: string): Promise<void>;
}
```

- **Stored before sent.** `enqueue` splits the text with the channel's transport and stores one row
  per piece, keyed `${idempotencyKey}#${index}`, in one transaction. Storing a key again changes
  nothing.
- **States:** `pending` → `sending` → `delivered` | `abandoned`. `sending` is written before the
  platform call, and `delivered` stores the platform's message id (what an edit or a delete needs).
  On start, a `sending` row goes back to `pending` as a possible duplicate: the process died during
  its send.
- **Order.** One conversation's pieces go out one at a time, in order. A piece waiting to be retried
  holds the ones behind it; other conversations do not wait for it (bounded concurrency).
- **Errors.** The transport classifies, the queue acts:
  - `transient` (and any error that is not a `DeliveryError`): retried after 5 s, 30 s, 2 min and
    10 min, then abandoned after the fifth attempt;
  - `rate_limited`: retried after `retryAfterMs`, not counted as an attempt. The queue waits, never
    the transport: a long flood wait inside a send froze every platform in Hermes;
  - `permanent` (a chat that blocked the bot, a bad request): abandoned at once;
  - `maybeSent`: the retry is a possible duplicate;
  - any piece older than 24 hours is abandoned.
- **Possible duplicates** (option (a)): an idempotent transport sends again with the same key and
  the platform drops the copy; a non-idempotent one (Telegram) sends again with a visible marker it
  chooses (`↻`). Losing an answer is worse than receiving it twice.
- Abandoned pieces stay readable for status and `doctor`; delivered rows are pruned after 7 days.
- "Typing…" and previews never go through the queue: losing one costs nothing.
- **Why `attach`.** A keyed `channel.transport` capability used by the queue, and the queue used by
  the channel, would be a cycle. With `attach`, the queue starts before the channels and stops after
  them, so a send in flight ends, or is aborted by the stop deadline, before its transport goes.
- **Known gap** `[upstream]`: between the run's answer being recorded in Pi's session and `enqueue`
  storing it there is a window (an `agent.settled` listener, milliseconds). A crash in it loses that
  delivery; the answer stays in the session. Pi's durable runtime has the same gap, with no commit
  hook at turn completion (§6.4); closed when it gains one.
- Each transport states its semantics (rule 7): Telegram is at-least-once with the marker; a
  platform with idempotent sends is effectively once.

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

interface OutboundMessage {        // M2, "Outbound delivery" above
  idempotencyKey: string;
  channel: string;
  conversationKey: string;
  text: string;
  // [planned], each optional, with the component that needs it:
  // threadId, blocks (channel-specific rich content), attachments, correlation
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
  /** What the run cost, in Pi's numbers (tokens and cost). The Pi adapter always sets it. */
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
- **`usage` is what Pi recorded for the run.** Every result, settled or failed, carries pi-ai's
  `Usage` (tokens and cost) summed over the run's own entries: each model response (failed attempts
  before a retry included), each tool result that reports usage, and a compaction made inside the
  run. These are the rows of Pi's usage ledger that point to an entry, so the runs of a session add
  up to the session's `getStats()` totals. Costs are pi-ai's prices; the adapter only adds them up.
  Pi 0.87.1 ties no other ledger row to an operation (a hook's own model request, an extension's
  `recordUsage` with no entry), so no run claims them. Pi's durable runtime keeps a completed
  attempt's usage on its entry, so the reading survives the move (§6.4). A run that called no model
  reports zero. The field stays optional in the core: another runtime may not know its cost.

Who owns these types `[decision]`: the core owns the *shapes* (`defineAgent`,
`AgentDefinition`, `TurnConfig`, `AgentRequest`, `AgentResult`, `AgentRuntime`), because they
are the stable programming model (§12a). The Pi-specific payloads inside them
(`AgentMessage`, `ImageContent`, `Usage`, the tool type) are opaque in the core and made
precise by `@pikit/pi-adapter` through declaration merging — the same mechanism as
`AppEvents`. The core never imports Pi; a project with the adapter sees Pi's exact types.
Components that implement a Pi contract (`sessions.store`, `execution`) import those types
from `@pikit/pi-adapter`, which re-exports them, never from `@earendil-works/pi-*`.

Core exports (M1): `defineAgent`, `AgentDefinition`, `TurnConfig`, `AgentRequest`, `Admission`,
`AgentResult`, `AgentRuntime`, `ConversationRef`, `PrepareContext`, and the opaque `AgentMessage`, `AgentTool` and
`Usage` with their merge target `AgentPayloads` (each `unknown` until the adapter fills it in).
For the inbound path (§5): `InboundMessage` and `RouteDecision`, with the pipelines
`inbound.authenticate`, `inbound.normalize` and `route.resolve` typed on `AppPipelines`. Contracts:
`SecretStore` (`secrets`), and `ConversationRegistry` with `ConversationReset` (`conversations.registry`
and the payload of `conversation.reset`), and `HttpRoute` (`http.route`). For agent state (§6.2a): `AgentState` and the context key `AGENT_STATE`;
`@pikit/core/testing` has its suite, `createAgentStateConformance`.
`@pikit/pi-adapter` fills in `AgentPayloads` and types `sessions.store` (Pi's `SessionRepo`),
`model.provider` (pi-ai's `Provider`) and `model.credentials` (pi-ai's `CredentialStore`) by
importing it anywhere in the project.

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
| Credentials per provider (`CredentialStore`), API-key and OAuth login flows, OAuth refresh under the store's lock, environment fallback | Where credentials are stored (`model.credentials`: a file on a server) |

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
  - credentials from `model.credentials` when it is installed (`modelsFrom(providers,
    { credentials })`); pi-ai resolves, refreshes and writes them back.
  - `models` from the `model.provider` components (`modelsFrom`), each importing its pi-ai
    provider **by subpath** (bundle size on Cloudflare). A component does not import pi-ai, so
    the adapter has one subpath per provider it exposes (`@pikit/pi-adapter/providers/anthropic`),
    each re-exporting pi-ai's subpath and nothing else.
- Translate Pi hooks/events → `agent.*` events and `agent.prepare` pipeline:
  - `before_run` → the agent's `prepare(state)` (§6.2a). Built. The `agent.prepare` pipeline after
    it (context injection, policy) is `[planned]`.
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
`runtime-pi` (copied to `src/pikit/runtime-pi/`) is the wiring the user owns: which
capabilities it reads, what it refuses to start without (no agent, a model no provider has, a
provider with no credentials at all, checked with pi-ai's `checkAuth`, which makes no network call
and refreshes nothing), and
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
  to every conversation of the runtime.
- **Per agent** `[decision]` (M1.5). An agent names the extensions it uses, as it names its tools:
  `defineAgent({ extensions: ["permission-gate"] })`. A component installs an extension by providing
  it under the keyed capability `agent.extension` (its name → the factory), typed by the adapter, so
  the core only sees names. A conversation loads the runtime's extensions and its agent's, once each;
  a name nothing provides fails as an unknown tool does.
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
import { deploy, summarize } from "../../tools";
import { DEPLOYING, RELEASE } from "./prompts";

export default defineAgent({
  name: "release",
  model: "anthropic/claude-sonnet",           // static defaults
  systemPrompt: RELEASE,
  tools: ["bash", summarize],

  state: { phase: "testing", testsPassed: false },   // initial state of each conversation (JSON)

  prepare(state, ctx) {                       // runs before every run of the conversation
    return {
      model: state.phase === "summarize" ? "anthropic/claude-haiku" : undefined,
      tools: state.testsPassed ? ["bash", summarize, deploy] : undefined,
      systemPrompt: state.phase === "deploying" ? DEPLOYING : undefined,
    };
  },
});

// A tool of that agent moves it on, in the conversation it runs in:
async execute(toolCallId, params, onUpdate, toolContext, invocation, context) {
  await context.value(AGENT_STATE)?.update({ phase: "deploying" }, context);
  ...
}
```

The core's `AgentDefinition` has `name`, `model`, `systemPrompt` (the text), `tools` (tool names
and tool objects, §6.3), `state` and `prepare` (M1). `defineAgent` infers the state's type from
`state`, so `prepare` sees `state.phase` typed, and rejects a `state` that is not a JSON object.
`prepare`'s `ctx` is a `PrepareContext`, `{ conversation }`; fields are added with the features
that need them. `skills` and a `ctx.prompt(file)` helper are `[planned]` with skills, and are added
without breaking it.

Rules:

- `prepare(state, ctx) → Partial<TurnConfig>` is pure with respect to its inputs. It does not
  register anything as a side effect; it returns a value. `undefined` fields keep the static
  default. Every run starts from the static fields plus what `prepare` returns for that run:
  nothing carries over from the previous run's result.
- `state` is the agent's persisted per-conversation state: a JSON document its tools read and
  update through their context (below). `[decision]` It is stored **in the Pi session**, as a
  conversation-scoped document in Pi's durable runtime and, until that ships, as a session
  value. It survives restarts and eviction, and starts fresh on `/reset` (a new session). pikit
  adds no store for it (§6.4). Today an update is a session commit of its own, apart from the
  tool result that follows it: a crash between the two leaves the state moved on and the call
  without a result, which then follows its tool's `replay` (§6.4, §8.4).
- **How a tool reaches it.** `[decision]` Through its context, not a global and not a capability:
  the runtime puts the conversation's `AgentState` in the context of every run under the core's
  key `AGENT_STATE`, and Pi passes that context to each tool call (Chord's values cross into Pi
  unchanged, §6.2). `context.value(AGENT_STATE)?.update({ phase: "deploying" }, context)`.
  - A tool has no `ConversationRef` of its own, and a project's tool objects are not components,
    so a capability would still need the conversation from the context. The context value is
    scoped to one run of one conversation: a tool cannot reach another conversation's state.
  - `AgentState` is `get(ctx)` (a copy of the initial state with every update merged over it) and
    `update(patch, ctx)`: a shallow merge, committed before it resolves, applied one at a time per
    conversation so parallel tools never lose each other's keys. A patch that is not JSON is
    rejected. Its suite is `createAgentStateConformance` (`@pikit/core/testing`), passed by an
    in-memory double and by the adapter's session-backed state.
  - A patch replaces whole keys, and it is computed before it is queued. A value built from
    the previous one (appending to a list, a counter) read with `get()` can lose a parallel
    tool's write to the same key. Keep such values in keys only one tool writes, or run the
    tools one at a time. A functional `update(fn)`, applied in the queue, is additive and waits
    for the first agent that needs it.
- The adapter runs `prepare` in Pi's `before_run` hook, once per run, before the run's first
  model call, with the conversation's state as it is then (`packages/pi-adapter/src/turns.ts`).
  Everything it applies is Pi's own mechanism:
  - the model and the active tools are Pi's lane configuration (`setModel`, `setActiveTools`),
    which Pi persists;
  - the tool objects are the harness's (`setTools`): the agent's tools for this run next to the
    tools of Pi extensions, which stay as the extensions left them;
  - the system prompt is the harness's `systemPrompt` function, which returns the prompt chosen
    for the run. A Pi extension's `before_agent_start` sees that prompt, and may still replace it.
- The resolved `TurnConfig` is appended to the session as a custom entry, `pikit.turn`
  (`{ model, systemPrompt?, tools }`, tools by name), one per run. "What did the agent have on
  run N" is answered by reading the transcript, not by re-deriving code paths. Custom entries
  never reach the model.
- An agent without `prepare` is unchanged: its static fields, as the harness was created.
- If `prepare` throws, or returns a model or a tool name nothing provides, the run gets the static
  definition and the error is logged. The static fields are the agent's baseline, so the idiom
  (static fields restrictive, `prepare` unlocking) fails closed. `runtime-pi` checks the static
  fields at start; what `prepare` returns can only be checked when it runs.
- **A resumed run is prepared again.** Pi runs `before_run` only when a run starts, and persists
  neither the system prompt nor the tool objects. When a new worker resumes a run a dead worker
  left open, the adapter calls `prepare` with the state as it is then, before continuing the run.
  The run's own tools may have moved the state on before the crash; preparing again keeps the
  harness and Pi's lane configuration consistent. The interrupted tool call follows Pi's replay
  rules (§8.4); a `safe` tool that the new configuration no longer has is recorded interrupted,
  like a `never` one.
- `prepare` is callable in tests as a plain function: `prepare({ testsPassed: true }, ctx)`.
- `[planned]` The `agent.prepare` pipeline (§4.4) runs *after* `prepare` and lets components and
  extensions patch the `TurnConfig` further (context injection, policy restrictions). Deferred
  until the first component needs it (`policy-tools`, context injection): its value type is a core
  export to decide with a real consumer, and adding the pipeline later changes nothing for agents
  or for `prepare`.
- Pi extensions do not reach `agent.state` yet: their tools and handlers receive an
  `ExtensionContext`, not the run's context. `[planned]` with the first extension that needs it.
  Once the state is a Pi document (§6.4), an extension reads it through Pi's own document API,
  so pikit adds nothing to the vendored `ExtensionAPI` for it.

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
`tool-edit` and `tool-bash` wrap Pi's factories and do not reimplement them. `[decision]` Built in M1.

A wrapper adds only what the kit owns:
- the capability the tool requires (`execution`, or `execution.shell` for `bash`);
- its `replay`. Pi's tools declare none, so they default to `"never"`; a read-only wrapper
  declares `"safe"`.

`@pikit/pi-adapter/tools` re-exports Pi's four factories and `bindTool(tool, { env, replay })`.
Pi's tools read their environment from the harness's `toolContext.env`, as Pi's own `mini` wires
them. A bound tool uses the environment of the capability its component declared instead, read
when it runs. The runtime then passes no tool context, and each tool works on exactly what it
declared: `read` on `execution`, `bash` on `execution.shell`. `[decision]`

**How an agent gets a tool.** `[decision]`
- A tool component provides its tool under the keyed capability `agent.tool`, keyed by the name
  the model calls it by.
- An agent names the tools it wants in `AgentDefinition.tools`, next to tool objects of its own:
  `defineAgent({ tools: ["read", "bash", lookupTicket] })`. It gets those and nothing else.
- Installing `tool-bash` gives no agent a shell until one names `bash`. What an agent can do is
  written where the agent is defined, and a project with a support agent and an ops agent gives
  `bash` to one of them only.
- The runtime resolves the names when a conversation opens. `runtime-pi` refuses to start when a
  name has no provider.
- `defineAgent` rejects a name that is not a tool name, and a name listed twice.
- Rejected: every installed tool for every agent. Pi's coding agent does that for one person in a
  terminal; a multi-agent service behind a channel should not. Adding names later would also
  silently change what an agent without a list can do.

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
| `agent.state` | Conversation-scoped document (a JSON object with an `initial()`). It can declare `history: "rewindable"` and `fork: "asOf"`, so the state follows a fork or a rewind of the transcript (`pico-v5.md` §3, checked at `cbe7cf00`) | Session value `pikit` / `agent.state` (`state.ts`), holding the updated keys; `get()` merges them over the agent's initial state. It is committed apart from the transcript, so a tool's state change and its result are two commits. A session value belongs to the whole session, not to a branch: correct while pikit never forks or rewinds a conversation. Passes `createAgentStateConformance` on memory and JSONL sessions |
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
  the tenant enters the key when tenants are routed (§16).

Implementations: `conversations-file` (M1, server) keeps the pointers in one JSON file. Every change
is written to a temporary file, flushed and renamed, and a pointer is used only once it is on disk.
A crash between creating a session and writing its pointer leaves an unused session, never a
pointer to a missing one. A registry on `storage.sql` waits for the synchronous or asynchronous
`SqlDatabase` question (§16); on Cloudflare the Durable Object holds its own pointer (§9.2). TTL/eviction of in-memory `AgentHarness` objects **never** deletes the
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

`[decision]` **Opening a session by id.** Pi's repos open a session from its metadata, which only a
listing gives, and a JSONL file's name holds a timestamp besides the id. So `SessionStore` (typed by
`@pikit/pi-adapter`) adds an optional `find(id, ctx)`, and the runtime opens every conversation with
it, falling back to listing a store without it. The JSONL store keeps an index, filled by its own
`create` and `fork` and by one listing the first time an id is missing after a restart; one process
owns the root (§7.2), so nothing changes the files behind it. A SQL store answers `find` with one
query. Without it, every message to an idle conversation read the first line of every session file
ever written (about 350 ms at 5,000 sessions); with it, 0.02 ms.

Planned implementations:

| Component | Backing | Target |
|---|---|---|
| `sessions-memory` | in-memory (Pi's `MemorySessionRepo`) | tests |
| `sessions-jsonl` | Pi's `JsonlSessionRepo` over local FS. Built (M1) | server |
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

**One workspace per agent** `[planned]` (M1.5). Each agent's tools work in a directory of their own
(`workspace-local`: `<root>/<agent>/`); without a `workspace` provider every agent shares
`execution`, as today. How a run's tools get their agent's `ExecutionEnv` is settled with the
component. A directory per agent is order, not isolation: a tool with `bash` runs as the same user
as pikit and can leave it, and read the model credentials in `.pikit/`. Isolation needs each agent's
tools in a separate sandbox (`execution-docker`, planned after M2).

### 8.3 `execution` capability

The contract is Pi's `ExecutionEnv`. Implementations:

| Component | `exec()` | Notes |
|---|---|---|
| `execution-local` | Pi `NodeExecutionEnv`, commands from an allowlist of variables | server. Built (M1). Not a sandbox |
| `execution-fetch` | returns `err(shell_unavailable)` | edge-pure; FS from `workspace-virtual` |
| `execution-cloudflare-container` | RPC to the DO's attached Container | cloudflare |
| `execution-remote` | HTTP/WebSocket to any host implementing the executor protocol | both |

Tools that need a shell declare `execution.shell`; `execution-fetch` does not provide it, so
`pikit doctor` fails early.

**Commands do not inherit the server's environment.** `[decision]` Pi's `NodeExecutionEnv` merges
the whole `process.env` into every command, so a `bash` tool could print the server's secrets
(`PIKIT_HTTP_TOKEN`, `ANTHROPIC_API_KEY`) with `env`. Pi's contract lets an environment define its
default variables (`ShellExecOptions.inheritEnv`). `createLocalExecution({ cwd, env })` in
`@pikit/pi-adapter/node` is `NodeExecutionEnv` whose defaults are only the variables it is given.
`execution-local` gives it an allowlist from its config.

This is not a sandbox, and the docs say so. Commands run as the server's OS user and can read
what that user can, including the credentials file. Paths are not confined to the working
directory either: with a shell, that would be false security. Isolation is the job of another
`execution-*` component that runs commands elsewhere (a container, a VM, a remote host), with the
same contract (§13).

`@pikit/pi-adapter` types both capabilities as Pi's `ExecutionEnv`. Pi ships no conformance suite
for it, so `createExecutionConformance` lives in `@pikit/pi-adapter/testing` (§14), and Pi's own
`NodeExecutionEnv` is its double.

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
- `server-bun` (M1) serves them with Hono 4.13.9 on `Bun.serve` `[decision]`:
  - `GET /health` answers `200` while the process can answer.
  - `GET /ready` answers `200` from `runtime.ready` until `runtime.stopping`, and `503` before and
    after. Today it reflects the start only (runtime availability is §16).
  - Stopping cancels every request in flight through its context, so a handler that waits answers
    at once. Past the stop deadline, the remaining connections are closed.
  - Bun closes a connection idle for about twice `idleTimeout`, even while its handler works, so
    `idleTimeoutSeconds` defaults to Bun's maximum, 255, above a channel's reply timeout.
  - Its port, host and limits are values in its config.
- Operational logs are a component, `log-events` (M1), on both targets `[decision]`: one line per
  `agent.*`, `conversation.reset`, `pipeline.halted` and `runtime.*` event, through the app's
  `Logger`. A line carries identifiers, the admission and run kinds, the run's `durationMs`, its
  tokens and cost (`AgentResult.usage`, §6.1) and an error's code. The format is the logger's (the
  container's JSON lines come from `deployment-docker`). Without the component there are no such
  lines, and there is no switch. The start times behind `durationMs` are a cache: a run that ends
  in another process logs no duration.
- Storage: `sessions-sqlite` + `storage-sqlite` by default; Postgres optional.
- Scheduler: `scheduler-cron` (in-process, `Bun.cron` or `croner`), jobs persisted in
  `storage.sql`.
- Deployment: a `deployment-*` component owns everything that runs the app on a machine: the
  process entrypoint, its logger, the supervisor's files and the commands `pikit up | down | restart
  | logs | status` delegate to (§11). It is not an app component: it runs the app rather than running
  inside it, so it is not listed in `pikit.config.ts`, and it provides and requires nothing.
  - `deployment-docker` (M1) installs `Dockerfile`, `compose.yaml` and `.dockerignore` at the
    project's root: `oven/bun:1.4-slim`, a production install from `bun.lock`, a non-root user,
    `.pikit/` on a volume, secrets from `.env` at run time (never in the image), a healthcheck on
    `GET /health`, and `restart: unless-stopped`. Its commands run `docker compose …` without a shell,
    and `status` adds what `/health` and `/ready` answer.
  - `deployment-systemd` `[planned]` generates a unit file.
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
  - A signal during the start cancels it (§4.6) and is a stop like any other.
  - `deployment-docker`'s deadlines are 30 s to start and 10 s to stop, under a 20 s
    `stop_grace_period`; a test in the component keeps the grace period above the stop deadline.
- Logs `[decision]`: the entrypoint recomposes the definition `pikit.config.ts` exports
  (`defineApp({ components, config, target: "server", logger })`) with the deployment's `Logger`.
  How a process logs belongs to where it runs, like its deadlines. `deployment-docker` writes JSON
  lines (`time`, `level`, `msg`, then the fields; `warn`/`error` on stderr), redacts fields by name
  (§13), and never throws on a field it cannot serialize. A `logger` or `clock` set in
  `pikit.config.ts` is not visible from its `AppDefinition` and does not reach the process; the
  entrypoint takes them as options.

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
│   └── src/pikit/channel-telegram/
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

A component installs to `src/pikit/<name>/`, under its exact name (`src/pikit/channel-telegram/`,
`src/pikit/runtime-pi/`). `[decision]` One name is used for the component, its directory, its
config key and its entry in `pikit.json`, so there is no mapping from name to path to remember or
to get wrong. Each directory belongs to exactly one component, which is what `pikit remove` and
the hashes in `pikit.json` rely on. `files/` mirrors the project: `files/src/pikit/<name>/` is
copied to `src/pikit/<name>/`, and a file a component installs at the project's root (a
`deployment-*` component's `Dockerfile`) sits at the root of `files/`. Because the layout is the
same, a component's tests reach the root files by the same relative path in the registry and in the
project.

### 10.2 Manifest

```json
{
  "$schema": "../../schema/component.schema.json",
  "name": "channel-telegram",
  "version": "1.4.0",
  "title": "Telegram: chat with your agent from the Telegram app",
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
  "migrations": "migrations"
}
```

Rules:

- `[decision]` **The shape is one schema.** `ManifestSchema` (typebox, in
  `packages/cli/src/registry/manifest.ts`) is the only definition of the fields: the CLI's `Manifest`
  type is derived from it; `validate` checks every `component.json` against it before any other rule;
  `pikit add` and `pikit new` check a component against it before installing it, whatever registry it
  comes from; and `generate` writes it as JSON Schema to the registry's `schema/component.schema.json`,
  which every `component.json` names in `$schema` (a generated field), so an editor completes and
  checks it. A field the schema does not know is an error, not silence: `generate` keeps it (nothing
  written by hand is lost) and `validate` names it.
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
- `files` maps paths under the component to paths under the project. `[decision]` `src` is mapped
  as a directory (`{ "source": "files/src", "target": "src" }`), and every file outside `src/` is
  named one by one, with a target relative to the project's root:
  ```json
  "files": [
    { "source": "files/src", "target": "src" },
    { "source": "files/Dockerfile", "target": "Dockerfile" },
    { "source": "files/compose.yaml", "target": "compose.yaml" },
    { "source": "files/.dockerignore", "target": ".dockerignore" }
  ]
  ```
  A component never maps a directory onto the project's root, so it owns exactly the root files it
  names: `pikit remove` deletes those and nothing else, `pikit.json` hashes each of them, and two
  components naming the same target is an install error. A root file already present is not
  overwritten without `--force`, as in step 6 of §10.5. A target never leaves the project (no `..`,
  no absolute path).
- `replay.tools` is generated too, and only for a component that provides `agent.tool`: each tool's
  name → its `replay` (`"safe"` or `"never"`, §8.4), read from the tool it provides. A component with
  no tool has no `replay`. `[decision]`
- Every other field is written by hand, and the generator never changes it:
  - `name` is the directory's name; `version` is semver.
  - `title` is what `pikit new` shows when the component answers a preset's question (§11):
    `"Name: what it is"`, the part after the colon being the hint. Optional, and required for every
    component of a kind some preset lets people choose (`validate` checks it).
  - `requires.pikit` must accept the `@pikit/core` of the registry's own commit.
  - `targets` is `server`, `cloudflare` or both.
  - `dependencies` lists exactly the npm packages the component's files import, tests included
    (they are copied and run in the project), except `@pikit/core`, which `requires.pikit` covers.
    Versions are pinned as the repository pins them (`typebox` follows Pi exactly).
  - `files` maps `files/src` onto `src`, and names each file outside `src/` on its own (see
    `files` above). `validate` rejects any other directory mapping.
  - `environment` lists every variable the component, or the Pi code it wraps, reads. A fallback
    that pi-ai reads only when nothing is stored (`ANTHROPIC_API_KEY`) is `required: false`.
  - `license`, `config` and `migrations` are optional. A component whose schema is its
    definition's `config` (every component so far) has no `config` path, so the schema is
    written once. `migrations` exists only for a component that ships some.
- Commands, from the repository root:
  - `bun run registry generate` rewrites the generated fields of every `component.json` in a stable
    key order and rebuilds `registry.json`. A component without `component.json` gets a skeleton
    (name, README summary, imported dependencies) with no `targets`: `validate` rejects it until
    someone writes them.
  - A component with no default export in `src/pikit/<name>/index.ts` is not an app component
  (a `deployment-*`, which runs the app, §9.1): it has no `setup`, so its generated fields are
  empty. A default export that is not a component is an error. `[decision]`
- `bun run registry validate` checks every component, every preset (§11) and that the JSON
    Schemas under `schema/` are what `generate` would write, and exits non-zero with one line per
    problem (§14).
- `bun run registry capabilities` prints the capability catalogue: each capability's mode (single or
  keyed), the package whose declaration merging defines its contract, one line on what it is, and the
  components that provide and use it. The line lives in `packages/cli/src/registry/capabilities.ts`,
  typed over `AppCapabilities` / `AppKeyedCapabilities`: a capability defined without an entry, or with
  the wrong mode, fails `tsc`, and `validate` rejects a component that names one with no entry.
- The fields are derived without starting anything:
  1. a recording `Pikit` runs `setup` to learn its single uses and its tools;
  2. an app of the component plus a stub provider per single use is created, and its
     `describe()` gives `provides`, `requires` and `optional`, as in `pikit doctor`.

  A config with required fields gets typebox's minimal valid value, only for describing.

### 10.3 Project manifest

`pikit.json` is the install record: what `pikit add` installed, from where, and what it wrote.
`pikit remove`, `pikit doctor` and `pikit configure` read it without the registry at hand.

```json
// pikit.json
{
  "version": 1,
  "targets": ["server"],
  "registries": {
    "default": "/home/me/.pikit/pikit/registry"
  },
  "components": {
    "channel-http": {
      "registry": "default",
      "version": "0.0.0",
      "commit": "ffc1a8f…",
      "files": {
        "src/pikit/channel-http/auth.ts": { "hash": "sha256:…" },
        "src/pikit/channel-http/index.ts": { "hash": "sha256:…" }
      },
      "dependencies": { "typebox": "1.3.27" },
      "environment": [{ "name": "PIKIT_HTTP_TOKEN", "secret": true, "required": true, "description": "…" }]
    }
  }
}
```

- `version` is the schema version (§12a). Components and files are sorted, so the file's diff shows
  only what changed.
- `registries` maps a name to a location. `[decision]` M1 reads local paths only: by default the
  registry of the pikit checkout the CLI runs from, or `--registry <path>`. Git and HTTP registries
  (`"official": "https://github.com/…"`, `"acme": "git+ssh://…"`) come with M3's `upgrade`, which is
  when a pinned commit starts to be fetched again.
- `commit` is the registry's Git commit when the component was installed, ending in `-dirty` when the
  registry had uncommitted changes; absent when the registry is not in Git.
- `files` holds each installed file's hash. `[decision]` Whether a file is modified is computed by
  comparing hashes and never stored: a stored flag goes stale as soon as someone edits the file.
  `doctor` lists modified files as information, `remove` refuses to delete them without `--force`,
  and M3's three-way `upgrade` takes the hash as its base.
- `dependencies` and `environment` are the manifest's fields at install time: `remove` deletes the
  npm packages nothing else needs, and `doctor` and `configure` know the variables, from this file
  alone.

### 10.4 Registry format

A registry is a Git repository (or static HTTP root) with:

```
registry.json                index: name → { version, description, targets, path }
components/<name>/           component packages as in §10.1
presets/<name>.yaml          presets (§11)
schema/                      component.schema.json and preset.schema.json, generated (§10.2)
```

```json
{
  "version": 1,
  "components": {
    "channel-http": {
      "version": "0.0.0",
      "description": "Talk to an agent over HTTP: send a message, get the answer in the response.",
      "targets": ["server", "cloudflare"],
      "path": "components/channel-http"
    }
  }
}
```

- The top-level `version` is the schema version of `registry.json` (§12a).
- `registry.json` is generated from the manifests by `bun run registry generate`, sorted by name,
  and `validate` fails when it differs.
- An entry has one `version`, not a list. `[decision]` A Git registry at one commit holds one
  version of each component. The other versions are earlier commits, and `pikit.json` pins the
  commit (§10.3).

No server-side logic. Private registries use the user's existing Git credentials.

### 10.5 Install flow

```
pikit add channel-http [--registry <path>] [--force] [--yes]
  1. resolve the registry and the component's version (and the registry's commit)
  2. read the component package
  3. check targets and requires.pikit; warn for each required capability nothing installed provides
  4. show: files to write, npm deps to add, env vars, capabilities provided and required, source
  5. confirm (--yes when there is no terminal)
  6. write files; refuse to overwrite a file that differs without --force
  7. add npm deps (kit packages to their vendored tarballs); run `bun install`
  8. edit pikit.config.ts: append the import and the `components` entry
     (a component with no default export, a `deployment-*`, is not listed)
  9. append its variables to .env.example, one block per component
 10. record registry, version, commit, file hashes, dependencies and environment in pikit.json
 11. run `pikit doctor`
```

`[decision]` The CLI edits `pikit.config.ts` as text, on one shape: one import line per component
(`import channelHttp from "./src/pikit/channel-http/index.ts";`), one entry per line in
`components`, one key per component in `const config = { … }`. When the file does not have that
shape, the CLI stops and says what to change; it never guesses. `add` scaffolds no config value: a
component whose config has required fields makes `doctor` fail with the core's config error until
they are set in `config` (M1 keeps values in `pikit.config.ts`, §12).

`pikit remove` reverses it and refuses if that would leave a capability that another installed
component requires (`use`) without a provider. Losing the provider of an optional capability is
allowed; `doctor` reports it. `[decision]` The answer comes from the app's own `describe()` (every
setup, no start), not from manifests, so project components count too and `remove` cannot disagree
with `doctor`. `remove` also:
- refuses to delete a file whose hash differs from `pikit.json` without `--force`;
- removes the component's import, its `components` entry and its `config` key, its `.env.example`
  block, and the npm dependencies no remaining component declares and no project file imports.

Adding and then removing a component leaves `git status` clean (S3). The CLI's end-to-end test checks
it on a generated project.

`pikit new <dir> [--preset <name> [--with <component>]...]` resolves the preset (§11) and checks every
component against the new project's targets and core before it writes anything, so a component that
cannot be installed never leaves half a project. Then it writes the project's own files: an agent (`assistant`,
`src/agents/assistant/agent.ts`, naming the tools the preset installs), `src/extensions/agents.ts`,
Pi's `permission-gate` example unmodified, `package.json`, `tsconfig.json`, `.gitignore` and a
README. Then it runs steps 1–10 for each component of the preset, and `bun install` and `doctor`
once. Two lines depend on what gets installed, never on the preset's name: `runtime-pi` is listed as
`createRuntimePi({ extensions: [permissionGate] })`, and `router-basic` gets
`defaultAgent: "assistant"`.

#### Vendored kit packages (M1 interim) `[decision]`

`@pikit/core`, `@pikit/pi-adapter` and `@pikit/pi-extension-shim` are not published yet. Until they
are, `pikit new` packs them from the CLI's checkout (`bun pm pack`) into the project's `vendor/`, and
the project depends on the tarballs:

```json
"dependencies": {
  "@earendil-works/pi-coding-agent": "file:vendor/pikit-pi-extension-shim-0.0.0.tgz",
  "@pikit/core": "file:vendor/pikit-core-0.0.0.tgz",
  "@pikit/pi-adapter": "file:vendor/pikit-pi-adapter-0.0.0.tgz"
},
"overrides": {
  "@pikit/core": "file:vendor/pikit-core-0.0.0.tgz",
  "@pikit/pi-adapter": "file:vendor/pikit-pi-adapter-0.0.0.tgz",
  "@pikit/pi-extension-shim": "file:vendor/pikit-pi-extension-shim-0.0.0.tgz"
}
```

- A packed package names its kit dependencies by version (`"@pikit/core": "0.0.0"`), which npm does
  not have. `overrides` points each one at its tarball, which also keeps exactly one copy of
  `@pikit/core` in `node_modules` (two copies would be two sets of contracts). The CLI's end-to-end
  test checks that there is one.
- Everything resolves inside the project, so `bun install --frozen-lockfile` works in
  `deployment-docker`'s image build, which copies `vendor/` before the install.
- A tarball already in `vendor/` is never repacked: `bun.lock` records its integrity.
- `vendor/` is committed with the project. When the packages are on npm, each `file:vendor/…`
  becomes a version, and `overrides` and `vendor/` go.

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
pikit new <dir> [--preset <name> [--with <component>]...] [--target server|cloudflare]
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

`pikit up | down | restart | logs | status` only delegate `[decision]`: they call the functions
of the same names that the installed `deployment-*` component exports from
`src/pikit/<name>/index.ts`. `deployment-docker`'s run `docker compose` in the project's directory;
`down` keeps the `.pikit/` volume, and `status` returns the containers' state plus what `GET /health`
and `GET /ready` answer. The CLI holds no Docker or systemd knowledge, so changing how a project is
deployed is editing or swapping that component.

M1 has these commands; the others print "not yet" and name the milestone that brings them.

| Command | M1 |
|---|---|
| `new`, `add`, `remove` | §10.5. `pikit new` with no directory, in a terminal, is the guided path (below). |
| `doctor` | Creates the app (every setup, no start) and prints the component graph, capability providers, pipelines and config (§4.6). Fails when the app does not compose, when a variable a component marks required is set neither in the environment nor in `.env` (names only, never values), or when a file breaks the Pi import rule (S1: a component imports no `@earendil-works/*`, project code only `@earendil-works/pi-coding-agent`, the Pi extensions' alias). Lists modified and deleted installed files as information. |
| `configure` | First runs the components' own steps (below). Then writes the other variables of the installed components to `.env` (mode 0600): a secret is asked without echo, and a required `*_TOKEN` can be generated. Then, for each `model.provider` without credentials, it runs pi-ai's login through `@pikit/pi-adapter` into the project's own `model.credentials` component, or stores the provider's API key in `.env`. Without a terminal (or with `--yes`), values come from the environment and `--generate <NAME>`, and `--login <provider>` runs a login. It never prints a value and never touches `~/.pi/agent/auth.json` (§13). A login runs where the app will run (below). |
| `dev` | After `doctor`, `bun --watch src/pikit/<deployment>/main.ts` (the installed `deployment-*` component's entrypoint) with `.env` loaded. |
| `up`, `down`, `restart`, `logs`, `status` | Delegate, as above. `up` runs `doctor` first, then checks the model credentials where the app runs (through the deployment's `exec`), and refuses to start an agent that has none. |
| `registry validate`, `registry generate`, `registry capabilities` | §10.2, §14. `bun run registry` in this repository calls the same code. |

`[decision]` **A component can own its setup.** A component that needs more than a value typed in
ships `src/pikit/<name>/configure.ts`, exporting `configure(io)`: checking a token against its API,
discovering an id. `pikit configure` runs these steps first, in a child process in the project.
- `io` gives the step its config from `pikit.config.ts`, `.env` to read and write (mode 0600;
  what the environment exports wins, as everywhere in `configure`), the terminal to ask with
  (`ask`, `askSecret`, and `choose` / `confirm` for a menu and a yes/no), and whether a person is
  there at all. A step declares `choose` and `confirm` optional and falls back to `ask`, so it also
  runs under a CLI that predates them.
- The step returns what is still missing.
- The variables of a component with a step are not asked again one by one: the step owns them. A
  bot token is not a value to generate.

The CLI knows nothing about what a step does, as with `deployment-*`. `channel-telegram`'s step
checks the bot token with `getMe`, and allows whoever sends the bot a message.

`[decision]` **The guided path.** Its prompts are `@clack/prompts` (menus with the arrow keys,
yes/no, text with a default, spinners), except secrets: a pasted token must stay one answer even over
several lines, which clack's password prompt does not keep, so pikit reads secrets itself, masked, and
draws them the same way. Without a terminal nothing is drawn and nothing changes. **The flow.** `pikit new` with no directory, in a terminal, asks the agent's name
(its folder), the preset to start from (only when the registry has several base presets, by their
`title`), and each of that preset's questions (`choose`, below): where to talk to it is "which
`channel-*` component", answered by every one in the registry that runs on the new project's targets,
shown by its `title`. It prints the `pikit new … --preset … --with …` command that makes the same
project without a terminal. Then it runs the same functions as the commands: `new`, `configure` (each component's own step, then
the model's login) and `up` (the default) or `dev`. It knows no channel: the choices come from the
registry and the questions from the components. Ctrl-C stops it at any question (exit 130); `pikit
new` again with the same name continues with the project already written, since `configure` asks
only for what is missing. The installer runs it when it finishes, so pasting the install line is the
only command a person types. Without a terminal, `pikit new` needs a directory, as before.

`[decision]` **A login lives where the app runs; nothing is copied.** A deployment component may
export `exec({ command, share, interactive })`: it runs a command where the app runs and resolves
with its exit code. `deployment-docker`'s is `docker compose run --rm --build --no-deps app …`: the
app's image, `.env` and `.pikit/` volume, no ports, with the directories in `share` mounted at the
same path. When `exec` exists, `configure`'s model step runs `credentials.ts` through it, so an OAuth
login lands in the volume `pikit up`'s app reads; `--login <provider> --local` (or choice 3) logs in
on this machine for `pikit dev` instead. The login prints pi-ai's URL and takes the redirect address
pasted back, which works on a VPS without a browser. An API key in `.env` serves both. Rationale:
mounting the host's `.pikit/` clashes over users and lets `dev` and `up` open one session at once,
and copying the login leaves a stale copy once a refresh rotates the token.

`[decision]` The CLI runs a project's code only in child `bun` processes in the project's directory
(`doctor`'s app, `configure`'s login and the components' steps), or where the app runs through the deployment's `exec` (the login for `pikit up`), so the project's own `@pikit/core` and components load, never
the CLI's, and every run sees the files as they are now. The exception is the deployment component's
commands, which are plain functions the CLI calls.

`[decision]` The CLI is installed by `installer/install.sh` (`curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh`, M1; the repository is `github.com/ajarellanod/pikit` for now): it
ensures git and Bun >= 1.4, clones pikit into `~/.pikit/pikit` at a ref, and writes the shim
`~/.pikit/bin/pikit`. It prints the `PATH` line instead of editing shell files, asks before any
`apt-get` or `sudo`, and installs Docker only with explicit consent (`--install-docker` or a "y";
on macOS it points to Docker Desktop). With the Docker it installed, and the same consent, it adds the
user to the `docker` group. Then, on a terminal, it runs `pikit new`, the guided path, with that group
already active (`sg docker`), and ends with the lines this shell still needs (the `PATH` line, and
`newgrp docker`). `PIKIT_NO_WIZARD=1` skips the guided path.

`[decision]` **Presets.** A preset is the list of `add` calls `pikit new` makes, and nothing reads
which preset a project came from. Its shape is `PresetSchema` (in
`packages/cli/src/project/registry-source.ts`), written by `generate` to `schema/preset.schema.json`,
which each preset names in a `yaml-language-server` comment; an unknown key is an error. A preset is
either:

- **a base**: `components`, in install order, and optionally `choose`, one question per component
  kind. Every registry component of that kind answers it (`title` in its `component.json` is the
  label), and the one the base lists is the default. So a new `channel-*` component is an answer as
  soon as it is in the registry, with no preset edited, and presets do not multiply per channel.
- **an alias**: `extends` a base and answers some of its questions with `with`. An alias of an alias
  is refused.

```yaml
# yaml-language-server: $schema=../schema/preset.schema.json
# registry/presets/http.yaml
title: "An agent, run in Docker"
components:
  - secrets-env
  - sessions-jsonl
  - conversations-file
  - credentials-file
  - provider-anthropic
  - execution-local
  - tool-read
  - tool-write
  - tool-edit
  - tool-bash
  - runtime-pi
  - router-basic
  - channel-http
  - server-bun
  - log-events
  - deployment-docker
choose:
  - kind: channel
    question: "Where do you want to talk to your agent?"
```

```yaml
# yaml-language-server: $schema=../schema/preset.schema.json
# registry/presets/telegram.yaml
title: "Telegram: chat with your agent from the Telegram app"
extends: http
with:
  - channel-telegram
```

- `--with <component>` answers a question without a terminal: it replaces the preset's component of
  the same kind, in place, so install order is kept. On an alias it answers again (the command line
  wins). A component of a kind the preset does not `choose` is refused (`pikit add` it after), as are
  two of one kind and `--with` without `--preset`.
- A base's `choose` kind must have exactly one component of that kind in `components` (the default),
  and each kind is asked once.
- `validate` resolves every preset, and every answer to every question, and requires a `title` of
  each component that answers one.
- A question has one answer per component, not per combination: combinations that need more than
  one component per answer, or rules between answers, are added when a real case needs them.

`registry/presets/http.yaml` (M1) is `samples/http`'s composition, plus `log-events` and
`deployment-docker`; a test in the sample keeps the two together. `registry/presets/telegram.yaml`
is an alias: `pikit new my-bot --preset telegram` is `pikit new my-bot --preset http --with
channel-telegram`. `server-bun` stays, for `/health` and `/ready`, which the container's healthcheck
and `pikit status` use. The project's own agents (`src/extensions/`) are not registry components
and are not in a preset.

---

## 12. Configuration

- `config/pikit.yaml` — non-secret values. Schema is the merge of core schema + every
  installed component's schema; validated at `doctor`, `dev`, `up`, `deploy`.
- `.env` (server) / Worker secrets (cloudflare) — secrets, read through `secrets` capability.
  With `deployment-docker`, compose passes `.env` to the container when it starts (`env_file`);
  `.dockerignore` keeps it out of the build context, so no image ever contains a secret.
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
- Inbound authentication is a pipeline stage every channel that receives requests must implement
  (an HTTP API, a webhook). A channel with no `inbound.authenticate` stage fails `doctor`.
  - A channel that pulls from a platform's API (Telegram long polling) has no request to
    authenticate: it reached the platform over TLS with its own token.
  - Such a channel still authorizes senders: `channel-telegram` lets only the Telegram users in its
    allowlist reach the agent (§5).
- Tool gating is a component (`policy-tools`): intercepts `agent.tool.call`, evaluates rules
  by agent role, blocks or allows. It is **policy mediation, not a sandbox**; documented as
  such. Real isolation is a property of the `execution` provider (container, micro-VM,
  remote sandbox).
- Secrets never appear in config files or session transcripts; the `secrets` capability is
  the only read path and logs redact by name.
- Operational logs (`log-events`, §9.1) never carry a message's text, a prompt, an answer or a
  run's error message: a log line names what happened, the session holds what was said. Each field
  is picked by name, so a field added to an event is not logged until it is chosen.
- Diagnostic logs are not operational logs. `[decision]` When the adapter logs a failure it
  swallows (a run no longer driven, a failing `prepare`, a Pi extension's handler or action), the
  line carries the error's message, because the operator has nothing else to diagnose it with.
  That message comes from Pi, from `prepare` or from an extension's own code, and may quote what
  that code put in it; it never comes from `log-events`, whose lines stay without messages.
- Model credentials (API keys, OAuth tokens) are not secrets read by name: pi-ai reads, refreshes
  and writes them through `model.credentials`. On a server, `credentials-file` keeps them in a
  file with mode `0600`. It never logs a value, and never quotes the file in an error. It never
  shares Pi's own `~/.pi/agent/auth.json`: a refresh would rotate the token the Pi CLI holds.

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
- **Channel conformance** (`createChannelConformance`): every channel (§5, "The inbound path in
  code"). The suite provides the runtime and the conversation registry (fakes that record what
  reaches them and answer every run), a router, and stages that halt, deny or move a message; the
  fixture delivers messages as the platform does and reports what each sender was told. A message
  reaches the routed agent in its own conversation and its sender gets the answer; a message
  delivered twice runs once; a message halted by a stage, denied, or sent with no router installed
  is not dispatched and its sender is told (the missing router is logged); a stage that moves a
  message to another conversation gets nothing dispatched. `channel-http` and `channel-telegram`
  pass it.
- **HTTP route conformance** (`createHttpRouteConformance`): every server of `http.route`
  (§9.1). The suite provides the routes and sends requests through the fixture. An in-memory
  double that routes a `Request` with no socket passes it.
- **Credential store conformance** (`createCredentialStoreConformance` in
  `@pikit/pi-adapter/testing`, because the contract is pi-ai's): every `model.credentials`. It
  covers read, list without secrets, `modify` serialized per provider and returning the stored
  credential when its function returns nothing, failed `modify`, `delete` and persistence. It also
  checks what pikit relies on: an OAuth refresh and a login by pi-ai are written back through the
  store. pi-ai's `InMemoryCredentialStore` is the double.
- **SQL database conformance** (`createSqlDatabaseConformance`): every `storage.sql`. Values of each
  type read back as written, parameters bound (never interpolated), `run`'s change counts,
  transactions that commit or roll back whole and reject with the work's own error, concurrent
  transactions that lose no update, statements outside a transaction that never see half of one, and
  data that survives a new app. A `node:sqlite` in-memory double in the suite's own test passes it.
- **Outbound queue conformance** (`createOutboundQueueConformance`): every `outbound.queue`. The suite
  owns the clock (`createManualClock`, also exported for components that wait) and a scripted
  transport, and checks §5 "Outbound delivery" to the millisecond: order per conversation, one
  conversation waiting behind a retry while others move, the backoff and the abandonment at the fifth
  transient failure, rate limits not counted, the 24-hour limit, possible duplicates (`maybeSent`, a
  send in flight when the process stopped, a send aborted by `detach`), and records that survive a
  restart. It has no in-memory double: one would be a second outbox. `outbound-durable` is its first
  implementation, and also runs a SIGKILL-during-a-send test in a real process.
- **Execution conformance** (`createExecutionConformance` in `@pikit/pi-adapter/testing`): every
  `execution` and `execution.shell`. It checks what Pi's tools rely on:
  - paths relative to `cwd`, and reading, writing, appending, listing, renaming and removing;
  - failures returned as results, never thrown;
  - with a shell: exit code and output, `cwd` and `env` options, `inheritEnv: false`, timeout and
    cancellation;
  - without a shell: `shell_unavailable`.

  Pi's `NodeExecutionEnv` is the double, with and without a shell.
- Contracts ship **conformance suites** (`@pikit/core/testing`): any `sessions.store`,
  `storage.sql`, `workspace`, `execution`, `channel.transport`, `outbound.queue`
  implementation must pass its suite. Pi's session conformance is reused for
  `sessions.store`.
- Components ship their own tests inside `files/` so they are copied into the user's project
  and keep running there.
- The registry CI runs every component's tests on both targets it declares (server: Bun;
  cloudflare: `wrangler dev` / Miniflare).
- **Registry validation** (`pikit registry validate`, and `bun run registry validate`, which calls
  the same code in `packages/cli/src/registry/`). For every directory under `registry/components/` it
  checks:
  - **drift** (S14): the generated fields equal what `setup` declares (§10.2), the manifest is in
    generated form, and `registry.json` matches the manifests;
  - **tools** (S10): every `agent.tool` has `replay` `"safe"` or `"never"`;
  - **naming**: the name equals the directory, is kebab-case, and has a known kind prefix. The
    kinds are AGENTS.md's naming table plus the kinds in use; a new kind is added on purpose;
  - **manifest**: the hand-written fields are well-formed, there is no `requires.components`, and
    `files` maps no directory but `files/src` → `src`;
  - **layout** (S13): `README.md`, `files/src/pikit/<name>/index.ts` and at least one `*.test.ts`
    exist, and no `package.json` in the component has `scripts`;
  - **imports** (S1, S4, S5), comments ignored and type-only imports included:
    - no import of `@earendil-works/*`;
    - no relative import into another component's `src/pikit/<other>/` or outside `files/`;
    - `node:*` and `bun:*` only when `targets` is exactly `["server"]`, `cloudflare:*` only
      when it is exactly `["cloudflare"]`, and Node builtins only with their `node:` scheme;
      `*.test.ts` files are exempt, because they run under Bun's test runner, never in a bundle;
  - **dependencies**: `dependencies` names exactly the npm packages the files import.

  `scripts/registry.test.ts` runs it on the real registry and proves each check fails on a
  fixture component.

---

## 15. Acceptance scenarios (design validation)

The design is considered validated when all five pass without touching the core:

1. **Minimal**: `runtime-pi` + `server-bun` + `channel-http` → working agent over HTTP. Runs
   (M1) in `samples/http`, with `secrets-env`, `sessions-jsonl`, `conversations-file`,
   `credentials-file`, `provider-anthropic` and `router-basic`. Its end-to-end test uses Pi's faux
   model over real HTTP, and a live test against Anthropic runs when a credential exists. The
   one-command path runs too: `pikit new --preset http` → `configure` → `dev` answers, and
   `pikit up` / `status` / `down` run it in Docker (`packages/cli/src/e2e.test.ts`,
   `PIKIT_E2E=1 PIKIT_E2E_DOCKER=1`, about 19 s on a warm cache).
2. **Chat**: `+ channel-telegram + sessions-sqlite` → stateful Telegram bot. `channel-telegram`
   exists (long polling, allowlist, its own `configure` step), with `sessions-jsonl` for now.
   `packages/cli/src/e2e-telegram.test.ts` runs `new --preset telegram` → `configure` → `dev` → an
   answer in the chat, against a fake Bot API.
3. **Reliability**: `+ outbound-durable` → delivery retried after simulated channel failure;
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
   `protected-paths` and `hello` examples, byte for byte (`compat.test.ts`). The HTTP half runs
   too: `permission-gate`, loaded with `createRuntimePi({ extensions })`, stops Pi's real `bash`
   (`tool-bash` on `execution-local`) from running `rm -rf` asked for over HTTP
   (`samples/http/test/scenario-7.test.ts`).
8. **Many agents** (M1.5): two agents with different system prompts, tools, Pi extensions and
   workspaces. `router-rules` sends two conversations (two Telegram chats, or two accounts) to one
   agent each; each answers with only its own tools and extensions, in its own directory. Removing
   `router-rules` routes everything to `router-basic`'s default agent, with nothing else changed (S3).

---

## 16. Open questions `[open]`

- `[decision]` `SqlDatabase` is async (M2). Postgres cannot be sync; SQLite (`node:sqlite`) and
  Durable Object SQL wrap in promises at no cost. A transaction runs statements only, never other
  I/O, so a sync store can run it as one step.
- Where the conversation registry lives on Cloudflare when a *global* view is needed (list
  all conversations): D1 index vs per-DO only. Probably per-DO + optional D1 index component.
- Config format: YAML vs TypeScript-only. TS gives types for free; YAML is friendlier for
  `configure` wizards. Current lean: YAML for values, TS for composition.
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
- A component installs to `src/pikit/<name>/`, under its exact name (§10.1). There is no
  kind-based path such as `channels/telegram`: one name, no mapping, one directory per component.
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
- M1's HTTP channel answers in the response (§5): `channel-http` listens to `agent.settled` /
  `agent.failed` and answers every waiting POST among the run's `requestIds`. There is no
  `outbound-direct`, `outbound.prepare` or `channel.transport` until M2's `outbound-durable`: a
  synchronous reply has nothing to retry, and a direct outbound path built now would be replaced
  in M2. A duplicate `messageId` is a `409`, with no stored answer to replay.
- A component can own its `pikit configure` step (`src/pikit/<name>/configure.ts`, §11): the setup
  of a platform belongs with the component that talks to it, and the CLI only calls it.
- `channel-telegram` receives by long polling, acknowledges after admission, relies on the request
  id for duplicates, and lets only allowlisted users reach the agent (§5, §13). No public URL is
  needed, so a bot runs where the project runs; the allowlist is what keeps an agent with tools
  from answering strangers.
- An agent names its tools (§6.3): `AgentDefinition.tools` takes names of installed tools, which
  `tool-*` components provide under the keyed capability `agent.tool`, next to tool objects. An
  installed tool reaches no agent that does not name it, so what an agent can do is written where
  it is defined.
- The router is a component (M1). The `route.resolve` pipeline and `RouteDecision` are core; every
  routing strategy is a component that adds a stage. `router-basic` fills in `defaultAgent` when no
  earlier stage decided, so a project stage with a higher priority routes around it without forking
  it.
- Model providers are components: each provides the keyed capability `model.provider` under its
  id, and the runtime builds its models from all of them (§4.5). Adding a provider is adding a
  component, and a missing one is visible in `doctor`, not a config flag.
- `AgentResult.usage` is the sum of the usage Pi recorded on the run's own entries (§6.1), not a
  pikit count and not a scan of the session ledger by position: Pi 0.87.1 ties ledger rows to
  entries, not to operations, and its durable runtime keeps usage on entries too.
- Operational logs are the `log-events` component, not core behaviour (§9.1): installing it is
  enabling it. Its lines carry no text of a conversation and log an error's code, not its message
  (§13), because a provider's error message may quote the request.
- A `deployment-*` component is not an app component: it owns the entrypoint, the logger and the
  supervisor's files, and exports the functions `pikit up | down | restart | logs | status` call
  (§9.1, §11). The app runs the same with or without it, and the CLI holds no Docker or systemd
  knowledge.
- The entrypoint recomposes `pikit.config.ts`'s components and config with the deployment's logger
  (§9.1): the log format belongs to where a process runs, and `AppDefinition` does not expose the
  logger to reuse it. No core change was needed.
- A component's files outside `src/` are named one by one in `files` (§10.2), so a component owns
  exactly the root files it lists, and removing it cannot touch a file it did not install.
- A tool reaches `agent.state` through its context (`context.value(AGENT_STATE)`), not through a
  capability (§6.2a). A tool has no `ConversationRef`, a project's tool objects are not components,
  and a value scoped to one run of one conversation cannot reach another conversation. A capability
  for components outside a run waits for one that needs it.
- `AgentState.update(patch)` is a shallow merge, applied one at a time per conversation (§6.2a).
  It is the smallest operation that lets parallel tools write different keys; the stored value holds
  only the updated keys, so a key added to an agent's initial state reaches existing conversations.
- `prepare` runs once per run, in Pi's `before_run`, and every run starts from the static fields
  (§6.2a). A run is the unit Pi configures and records; nothing carries over, so a run's
  configuration is a function of the state alone.
- A resumed run is prepared again with the current state (§6.2a). Pi does not persist the system
  prompt or the tool objects, and the state may have moved before the crash; reading back the
  crashed run's `pikit.turn` entry could name tool objects no longer given by `prepare`.
- A failing `prepare` gives the run the static definition, logged (§6.2a). A run cannot be refused
  from `before_run`, and the static fields are the agent's declared baseline.
- `component.json`'s generated fields come from the app's own `describe()`, over the component
  and a stub per single use, not from a second reading of `setup` (§10.2). `pikit doctor` and the
  manifest then cannot disagree on what `use`, `useOptional` and `useKeyed` mean.
- `replay.tools` is generated from the tools a component provides and exists only for tool
  providers (§10.2). It is a fact of the code, like `provides`, and S10's tool manifest validation
  reads it.
- `dependencies` lists exactly the packages the component's files import, tests included,
  minus `@pikit/core` (§10.2). Validation compares the two, so the list cannot go stale.
- The runtime-neutrality import scan (S5) covers the files that ship. `*.test.ts` runs under Bun's
  test runner, which every component test already imports as `bun:test` (§14).
- `registry.json` gives each component one `version`: a Git registry at a commit holds one
  version, and `pikit.json` pins the commit (§10.4).
- The CLI's M1 registries are local paths, the CLI checkout's registry by default (§10.3). Fetching
  Git registries matters once a pinned commit must be fetched again, which is M3's `upgrade`.
- Until `@pikit/*` are published, `pikit new` vendors them as tarballs in `vendor/`, with `overrides`
  (§10.5): the project installs from its own directory, in a Docker build too, with one `@pikit/core`.
- `pikit.json` stores each file's hash, not a `modified` flag (§10.3): a flag goes stale when the
  file is edited, a hash cannot.
- `pikit.json` keeps each component's `dependencies` and `environment` as installed (§10.3), so
  `remove`, `doctor` and `configure` need no registry.
- The CLI edits `pikit.config.ts` as text on one recognised shape and refuses any other (§10.5): the
  user's file stays explicit and reviewable, and an unexpected shape is an error, not a guess.
- `pikit remove` asks the app's `describe()` what depends on a component (§10.5), so project
  components count and `remove` agrees with `doctor`.
- A required variable that is not set fails `pikit doctor`, reported apart from composition
  problems; `pikit new` expects it, because `pikit configure` comes next (§11).
- The CLI runs project code in child processes, in the project's directory (§11): the project's own
  `@pikit/core` loads, and nothing is cached from an earlier version of the file.

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
| `outbound-durable` | Outbound intents persisted before send, retried with backoff, dead-lettered, and recorded so later replies can quote or thread against them. |
| `conversations.registry` | Conversation key → active session + workspace ref, with TTL eviction of memory that never drops the pointer, and explicit `/reset` semantics. |
| `routines` | File-defined scheduled prompts (`src/agents/{name}/routines/*.yaml`) synced into `scheduler`, with target fan-out by route tags and previous-run context injection. |
| `policy-tools` | Role-based interception of `agent.tool.call`: shell command and path rules, allow/deny lists, hot-reloadable. Policy mediation, not a sandbox. |
| `channel-google-chat` | Google Chat app: JWT-verified webhook ingress, REST transport with message create/patch, cards, threads, media. |
