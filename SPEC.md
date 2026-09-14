# pikit — Technical Specification

Status: **draft v0.1** — this document describes intent and contracts, not shipped code.
Anything marked `[open]` is undecided. Anything marked `[upstream]` depends on experimental
Pi APIs and must be isolated behind the Pi adapter.

---

## 1. Goals and non-goals

### Goals

1. A **small, stable core** that defines how components communicate and nothing else.
2. **Source-owned components** installed into the user's project, editable and removable.
3. A **typed, event-driven harness lifecycle** covering the full path from inbound message to
   delivered reply, modeled the way Pi models the agent loop.
4. **Two runtimes from the same project**: long-running server (Bun/Node) and serverless
   Cloudflare Workers + Durable Objects.
5. **Pi as the agent runtime**, consumed through its public, runtime-neutral packages.
6. A CLI that makes add / edit / remove / diff / upgrade practical.

### Non-goals

- Reimplementing an agent loop, model providers, or compaction. Pi owns these.
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
| **Component** | An installable unit of source: files + manifest + optional migrations, tests, config schema. Copied into the project. |
| **Extension** | Runtime behavior registered against the harness lifecycle (`pikit.on`, `pikit.pipeline`, `pikit.provide`). Usually the entry point of a component; may also be a standalone project file. |
| **Capability** | A named, typed service that exactly one component provides and others consume (`sessions.store`, `execution.shell`). |
| **Event** | A typed notification. All listeners receive it; none can change its outcome. |
| **Pipeline** | A typed, ordered transformation chain. Each stage receives the previous stage's output. |
| **Registry** | A source of components: official, third-party, private, or local. |
| **Runtime target** | Where the harness runs: `server` or `cloudflare`. |
| **Agent runtime** | The thing that runs the agent loop. In v1: Pi. |
| **Conversation key** | Stable identity of an external conversation (`tenant:channel:conversation`). |
| **Session** | A Pi session (transcript, lanes, records). A conversation points to its active session. |
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
import { defineHarness } from "@pikit/core";
import telegram from "./src/pikit/channels/telegram";
import router from "./src/pikit/router";
import sessions from "./src/pikit/sessions/sqlite";
import pi from "./src/pikit/runtime/pi";
import auditLog from "./src/extensions/audit-log";

export default defineHarness({
  components: [telegram, router, sessions, pi],
  extensions: [auditLog],                 // sugar: components without `provides`
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

  provides: ["outbound.queue"],
  requires: ["storage.sql", "channel.transport"],

  config: OutboxConfigSchema,        // typebox; merged into the global config schema

  setup(pikit, config) {
    const sql = pikit.require("storage.sql");
    pikit.provide("outbound.queue", createQueue(sql, config));
    pikit.on("outbound.requested", enqueue);
    pikit.on("runtime.ready", startWorker);
    pikit.on("runtime.stopping", stopWorker);
  },
});
```

`setup` runs once per harness instance. On the server target that is once per process. On
Cloudflare it is once per Durable Object instantiation (which may happen many times; setup
must be cheap and idempotent).

### 4.3 Events

Events are **notifications**. Every listener receives the event; return values are ignored.

```ts
pikit.on("outbound.delivered", async (event, ctx) => { ... });
await pikit.emit("outbound.delivered", payload);
```

`emit` awaits all listeners in registration order. A listener that throws is logged and does
not stop the others (mirrors Pi's extension error handling).

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
  interface HarnessEvents {
    "acme.customer.created": { customerId: string; plan: string };
  }
}
```

For events that cross a process or persistence boundary (queues, webhooks, restored state) a
runtime schema is also registered:

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

const normalized = await pikit.run("inbound.normalize", raw);
```

Ordering is deterministic: by `priority` (descending), then registration order. Stages have
ids so `pikit doctor` can print the resolved chain and so a project extension can insert
`before: "trim"` / `after: "mentions"`.

Core-owned pipelines:

```
inbound.authenticate   raw request     → authenticated | rejected
inbound.normalize      raw message     → InboundMessage
route.resolve          InboundMessage  → RouteDecision
conversation.resolve   RouteDecision   → ConversationRef
agent.prepare          AgentRequest    → AgentRequest   (system prompt, tools, context)
outbound.prepare       OutboundMessage → OutboundMessage
```

A stage may short-circuit by returning `pikit.halt(reason)`; the pipeline stops and
`pipeline.halted` is emitted.

### 4.5 Capabilities

Capabilities are **named services with exactly one provider**.

```ts
pikit.provide("sessions.store", store);      // in a component's setup
const store = pikit.require("sessions.store"); // anywhere
```

- Two providers for the same capability is a startup error unless config selects one:
  ```yaml
  capabilities:
    sessions.store: postgres
  ```
- `require` of a missing capability is a startup error listing components that provide it.
- Capability contracts are TypeScript interfaces exported from `@pikit/core/contracts`.

Core-defined capability contracts (interfaces only; no implementations in core):

| Capability | Contract | Notes |
|---|---|---|
| `storage.sql` | `SqlDatabase` | Minimal sync/async SQL surface. Backed by `bun:sqlite`, `node:sqlite`, Postgres driver, or DO `ctx.storage.sql`. |
| `storage.blob` | `BlobStore` | put/get/delete/list. Local dir, S3, R2. |
| `sessions.store` | Pi `SessionRepo` + `SessionStorage` | Re-exported from Pi; see §7. |
| `conversations.registry` | `ConversationRegistry` | conversation key → active session id, workspace ref, metadata. |
| `workspace` | `WorkspaceProvider` | Resolves a `Workspace` for a conversation/agent. |
| `execution` | Pi `ExecutionEnv` | Filesystem + shell for the agent's tools. |
| `agent.runtime` | `AgentRuntime` | See §6. |
| `agent.state` | `AgentStateStore` | Per-conversation JSON state read by `prepare` and updated by tools. See §6.2a. |
| `channel.transport:<name>` | `ChannelTransport` | Send/edit/delete messages for one channel. |
| `outbound.queue` | `OutboundQueue` | Durable enqueue + worker. Optional; without it delivery is direct. |
| `scheduler` | `Scheduler` | Register/cancel timed jobs. |
| `approvals` | `ApprovalStore` | Decision lifecycle persistence. |
| `secrets` | `SecretStore` | Read secrets by name. `.env`, Worker bindings, external vault. |
| `clock` | `Clock` | `now()`, `sleep()`. Injectable for tests and for DO alarms. |
| `logger` | `Logger` | Structured logging. |

### 4.6 Lifecycle

```
build time      pikit add/remove edit pikit.config.ts; bundler compiles what is listed
                 │
harness create  defineHarness() → resolve components → validate requires/provides
                 │                                     → validate config against merged schema
setup           component.setup() in dependency order
                 │
runtime.starting
runtime.ready   listeners/servers/alarms may start
                 │
   ... handle inbound → route → agent → outbound ...
                 │
runtime.stopping
runtime.stopped
```

`pikit doctor` performs everything up to and including *setup* without starting servers, and
prints the resolved component graph, capability providers, pipeline chains, and config.

### 4.7 Context object

Every handler receives `ctx`:

```ts
interface HarnessContext {
  target: "server" | "cloudflare";
  config: ResolvedConfig;
  require<K extends CapabilityName>(name: K): Capability<K>;
  logger: Logger;
  clock: Clock;
  signal?: AbortSignal;              // present during an agent run
  conversation?: ConversationRef;    // present once resolved
}
```

---

## 5. Harness lifecycle (the main path)

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
capability agent.runtime.dispatch(AgentRequest)
  │  emit agent.dispatched · agent.started
  │  (Pi lifecycle runs inside; adapter re-emits selected Pi events as agent.* )
  │  emit agent.settled | agent.failed
  ▼
pipeline outbound.prepare          → OutboundMessage
  │  emit outbound.requested
  ▼
  if outbound.queue provided → enqueue; worker delivers; emit outbound.queued/delivered/failed
  else                       → channel.transport:<name>.send(); emit outbound.delivered/failed
```

Core types (abridged):

```ts
interface InboundMessage {
  id: string;
  channel: string;
  tenant?: string;
  conversationId: string;
  threadId?: string;
  actor: { id: string; displayName?: string; roles?: string[] };
  text: string;
  attachments: Attachment[];
  raw: unknown;                       // channel-specific payload, never inspected by core
  receivedAt: number;
}

interface RouteDecision {
  agent: string;
  tenant?: string;
  tags: string[];
  access: "allow" | "deny";
  reason?: string;
}

interface ConversationRef {
  key: string;                        // tenant:channel:conversationId[:threadId]
  agent: string;
  sessionId: string;
  workspaceRef?: WorkspaceRef;
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

Idempotency: `InboundMessage.id` is recorded by the core before dispatch; a duplicate id
within a retention window is dropped and `inbound.rejected { reason: "duplicate" }` is
emitted. Storage for this uses `storage.sql` if present, otherwise an in-memory LRU (documented
as best-effort).

---

## 6. Agent runtime and the Pi adapter

### 6.1 `AgentRuntime` contract

```ts
interface AgentRuntime {
  dispatch(request: AgentRequest, ctx: HarnessContext): Promise<AgentResult>;
  steer(conversation: ConversationRef, message: string): Promise<void>;
  abort(conversation: ConversationRef): Promise<void>;
  resume(conversation: ConversationRef): Promise<AgentResult | undefined>;   // after crash/hibernation
}

interface AgentRequest {
  conversation: ConversationRef;
  agent: AgentDefinition;
  prompt: string | AgentMessage[];
  images?: ImageContent[];
  context?: { prefix?: string; quoted?: InboundMessage };
}

interface AgentResult {
  kind: "completed" | "aborted" | "failed" | "suspended";
  text?: string;
  messages: AgentMessage[];
  usage?: Usage;
  error?: { code: string; message: string };
}
```

### 6.2 Pi adapter (`@pikit/pi-adapter`)

The adapter is the **only** package that imports `@earendil-works/pi-*`. It exposes
`pikit`-shaped types and hides Pi's experimental surface. `[upstream]`

Responsibilities:

- Build an `AgentHarness` per conversation from `AgentDefinition` + capabilities:
  - `session` from `sessions.store`.
  - `ExecutionEnv` from `execution`.
  - `tools` from the agent definition and installed tool components.
  - `models` from `pi-ai` with providers imported **by subpath** (bundle size on Cloudflare).
- Translate Pi hooks/events → `agent.*` events and `agent.prepare` pipeline:
  - `before_run` → `agent.prepare` (system prompt, tools, context injection).
  - `before_tool` / `after_tool` → `agent.tool.call` / `agent.tool.result` (interceptable).
  - `after_response` → `agent.response` (provider errors, failover hooks).
  - run finish → `agent.settled` / `agent.failed`.
- Choose drive mode by target:
  - `server`: `drive: "automatic"` (`prompt()` and await).
  - `cloudflare`: `drive: "manual"` (`peekAction()` / `executeAction()` loop with persistence
    between actions; see §9).
- On harness create, inspect `suspended` operations and expose them through `resume()`.
- Classify tools with `replay: "safe" | "never"` from the tool component manifest.

Agent definition (project file, convention-based under `src/agents/{name}/`):

```
src/agents/assistant/
├── agent.ts            defineAgent({ ... })
├── system-prompt.md
├── skills/             SKILL.md folders (Pi format)
└── context/            files copied into the workspace before a run
```

### 6.2b Running Pi extensions unchanged `[planned]`

A Pi extension is `export default function (pi: ExtensionAPI) { ... }`. The adapter exposes a
compat object implementing the non-UI subset of `ExtensionAPI` over `AgentHarness` and pikit
capabilities, so existing extensions run without modification. They are imported statically
(`runtime-pi` config `extensions: [...]`), never discovered or loaded dynamically. The compat
layer reports `mode: "rpc"`, `hasUI: false` — the case Pi already documents and requires
extensions to guard for.

Support tiers (`pikit doctor` lists what an extension uses and at which tier):

| Tier | Surface | Mapping |
|---|---|---|
| A — works as-is | `on(tool_call \| tool_result \| before_agent_start \| context \| before_provider_request \| after_provider_response \| agent_* \| turn_* \| message_* \| tool_execution_* \| session_start \| session_shutdown)`, `registerTool`, `registerProvider`, `set/getModel`, `set/getActiveTools`, `sendMessage`, `sendUserMessage`, `appendEntry`, `abort`, `isIdle`, `waitForIdle`, `exec`, `getSystemPrompt`, `getContextUsage`, `compact` | The §6.2 hook table read in reverse: Pi handlers return a patch (`undefined` = no change); a pikit stage returns the next value. Wrapper: `v => ({ ...v, ...(await handler(v)) })`. `tool_call { block }` = `halt`. |
| B — later, chat-meaningful | `registerCommand` (slash commands from a channel), `ui.notify/select/confirm/input` (routed to the channel, awaiting a reply — overlaps with `approvals`) | Component-level; not in the first adapter cut. |
| C — no-op with a `doctor` warning | `registerShortcut`, `register*Renderer`, `registerMarkdownTransformer`, `addAutocompleteProvider`, `ui.setWidget/setStatus/setTitle/setFooter/setHeader/theme/editor*`, `navigateTree`, `switchSession`, `fork` | TUI-only or session-tree UI. |

Known facts (pi-coding-agent 0.85.1): `AgentSession` still drives the legacy `Agent` class
(`agent.beforeToolCall`), not `AgentHarness`; the compat layer translates Pi's *semantic*
extension events, not its classes, so Pi's migration lands in the adapter only. Typing the
compat object against Pi's own `ExtensionAPI` would make `pi-coding-agent` a types-only
devDependency (19 MB); the alternative is vendoring the subset (~200 lines, attributed in
`NOTICE`). `[open]` — decide in the adapter step.

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

Rules:

- `prepare(state, ctx) → Partial<TurnConfig>` is pure with respect to its inputs. It does not
  register anything as a side effect; it returns a value. `undefined` fields keep the static
  default.
- `state` is the agent's persisted per-conversation state (capability `agent.state`, §4.5):
  a JSON document tools and extensions may read and update (`ctx.state.update(patch)`),
  stored in `storage.sql` or as Pi custom entries. It survives restarts and DO eviction.
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
{ "name": "tool-shell", "requires": { "capabilities": ["execution.shell", "workspace.posix"] } }
{ "name": "tool-http-fetch", "requires": { "capabilities": ["network.fetch"] } }
```

`pi-agent-core` ships **no** built-in tools: `AgentHarness` receives `tools: AgentHarnessTool[]`
and nothing else. The `read`/`write`/`edit`/`bash`/`ls` factories live in `pi-coding-agent`,
take `cwd` plus a per-tool `operations` interface (not `ExecutionEnv`), and pull in a 19 MB
Node-only package. pikit therefore ships its own small tools as source in `tool-*` components,
written against Pi's `ExecutionEnv` contract, so they run on any `execution` provider
(including `workspace-virtual` on Cloudflare). `[decision]`

`pi-coding-agent` is never a dependency of a pikit project. Its only use is as an external
binary (`pi`) invoked by the CLI for `resolve with pi` (§10.6). `[decision]`

---

## 7. Sessions and conversations

### 7.1 Two different things

| | Persists | Lives in |
|---|---|---|
| **Conversation registry** | conversation key → active Pi session id, workspace ref, agent, metadata | `conversations.registry` |
| **Pi session** | transcript entries, lanes, operation records, queues, usage | `sessions.store` |

A conversation can point to many sessions over time (`/reset` creates a new one and repoints;
old sessions remain). TTL/eviction of in-memory harness objects **never** deletes the
registry pointer. A conversation must be restorable long after its harness object was
evicted; this is a hard rule.

### 7.2 `sessions.store`

The contract is Pi's `SessionRepo<TMetadata>` + `SessionStorage`. `[upstream]` The adapter
re-exports them; components implement them. Every implementation must pass
`createSessionRepoConformance()` and `createStorageConformance()` from
`@earendil-works/pi-agent-core/harness/session/testing` (plus the fork/lifecycle sub-suites
exported alongside them; verified against `pi-agent-core` 0.85.1).

Planned implementations:

| Component | Backing | Target |
|---|---|---|
| `sessions-memory` | in-memory (Pi's `MemorySessionRepo`) | tests |
| `sessions-jsonl` | Pi's `JsonlSessionRepo` over local FS | server |
| `sessions-sqlite` | `@earendil-works/pi-session-backend-sqlite-node` or `bun:sqlite` | server |
| `sessions-postgres` | own implementation | server |
| `sessions-cloudflare-do` | DO `ctx.storage.sql` | cloudflare |

### 7.3 Reset semantics

```yaml
reset:
  session: new          # always
  workspace: preserve | recreate
```

Emits `conversation.reset { previousSessionId, newSessionId }`.

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

After a crash or DO eviction, Pi may find a `tool_started` record without a result. Tools
marked `replay: "safe"` are re-run. Tools marked `replay: "never"` are not; the adapter
returns a tool error explaining the uncertainty and the agent decides. Components that
perform external writes must use `OutboundMessage.idempotencyKey` / their own keys derived
from `${sessionId}:${runId}:${toolCallId}`.

---

## 9. Runtime targets

### 9.1 Server

- Process: Bun (preferred) or Node ≥ 22.
- HTTP: a thin `server-bun` component (Hono or `Bun.serve`) exposing `/health`, `/ready`,
  channel webhooks, and admin routes contributed by components.
- Storage: `sessions-sqlite` + `storage-sqlite` by default; Postgres optional.
- Scheduler: `scheduler-cron` (in-process, `Bun.cron` or `croner`), jobs persisted in
  `storage.sql`.
- Deployment: `deployment-docker` generates `Dockerfile` + `compose.yaml`;
  `deployment-systemd` generates a unit file. `pikit up/down/logs/status` wrap them.
- Agent runtime is `pi-agent-core` here too; `pi-coding-agent` is not imported on any target
  (§6.3).

### 9.2 Cloudflare

Topology:

```
Worker (fetch)                     ← channel ingress, auth, routing (stateless)
   │  idFromName(conversationKey)
   ▼
Durable Object "Conversation"      ← one per conversation key
   ├── pikit harness instance (setup on construct; must be cheap)
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
- In-memory state is lost on hibernation; everything the harness needs across actions must
  be in `ctx.storage`.
- SQL row/blob ≤ 2 MB → large attachments and images go to R2 with a reference in the
  transcript.

Drive model: the adapter runs Pi in `drive: "manual"`. Each `executeAction()` result is
persisted by Pi's own records; the DO loops until `peekAction()` returns `undefined` or the
request budget is near exhaustion, in which case it sets an alarm and returns. On alarm (or
next request) the DO calls `resume()` and continues. `[upstream]` — depends on the current
`AgentHarness` API; the adapter owns this.

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
    "components": ["channel-core"],
    "capabilities": ["network.fetch", "secrets"]
  },
  "provides": ["channel.transport:telegram"],
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
  3. check targets, pikit version, capability availability (warn), component deps (install)
  4. show: files to write, npm deps to add, env vars required, capabilities requested, source
  5. confirm
  6. write files; refuse to overwrite modified files without --force
  7. add npm deps; run package manager install
  8. edit pikit.config.ts (append import + entry)
  9. append config schema; scaffold config/ values; append .env.example
 10. record hashes in pikit.json
 11. run `pikit doctor`
```

`pikit remove` reverses it and refuses if another installed component `requires` it.

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

---

## 12a. Stability policy

pikit is meant to be boring. The programming model a user learns for 1.0 is the model for
the whole 1.x line; there is no "pikit 2 rewrites how you define agents".

| Surface | Rule |
|---|---|
| `@pikit/core` public API (`defineHarness`, `defineComponent`, `defineAgent`, `pikit.on/pipeline/provide/require/emit/run`, event and pipeline names, capability contracts) | Semver. Within a major: additive changes only. Removals require a deprecation that ships in at least one minor with a runtime warning and a `pikit doctor` hint, then a major. Majors are rare and come with an automated migration where possible. |
| Contract interfaces (`SessionStore`, `SqlDatabase`, `ExecutionEnv`, `Workspace`, `ChannelTransport`, …) | Same as core. A contract change ships with its updated conformance suite in the same release. |
| `@pikit/pi-adapter` | May move faster to absorb Pi churn. Its *pikit-facing* surface follows the core rule; its Pi-facing internals are unstable by design. |
| `component.json`, `pikit.json`, registry format | Versioned schemas (`version` field). Readers accept all prior versions of the same major. |
| Components | Version independently. A component major never forces a core major. Installed components are the user's; upstream changes reach them only through `pikit upgrade`. |
| Pre-1.0 (M0–M5) | Anything may change. No compatibility promises. This is the period to be wrong quickly. |

Cadence: core minors as needed, never on a schedule that forces churn; component releases
are independent. Every core release note lists "what you must change" first — the target
is that the answer is "nothing" for every minor.

## 13. Security model

- Components execute in-process with full privileges of the harness. Installing one is
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
   handlers fire during scenario 1.

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

Resolved while building M0 `[decision]`:

- `defineHarness({ config })` takes an object; the core never reads files (rule: runtime
  neutrality). The CLI/target loads YAML and passes the value.
- Config is namespaced by component name (`config[component.name]`); core keys live at the
  same level. Merge is mechanical; no `configKey` in the manifest until a collision exists.
- `setup` order is topological over `provides`/`requires`; cycles and unsatisfied `requires`
  fail in `defineHarness`, not at runtime, so `require` inside `setup` is always safe.
- An extension is a component without `provides`; `extensions: [...]` is sugar concatenated
  to `components`. One `define*` fewer to keep stable.
- Events are typed by declaration merging on `HarnessEvents` (as Pi's `CustomAgentMessages`);
  no runtime registration for typing.

---

## 17. Roadmap

### M0 — Core (implemented, tested, no Pi)
- `@pikit/core` implemented with unit tests: events, pipelines, capabilities, lifecycle,
  config merge/validation, diagnostics (§4). Only the contracts `HarnessContext` needs
  (`Clock`, `Logger`); every other contract is written when the first component requires it,
  interface + conformance suite before implementation. `[decision]` — a types-only
  milestone has no runnable check; contracts are validated by running them.
- This spec reviewed; open questions resolved or deferred explicitly.

### M1 — Five minutes to a running agent
Definition of done: on a clean VPS, `curl … | sh && pikit new my-agent --preset http && cd
my-agent && pikit configure && pikit up` yields a responding agent with `/health`, logs, and
status — and `src/pikit/` contains every behavior as readable source.
- `@pikit/core` implementation; `@pikit/pi-adapter` (automatic drive); `defineAgent` with
  `prepare(state)` and `agent.state`.
- Components: `runtime-pi`, `server-bun`, `channel-http`, `router-basic`, `storage-sqlite`,
  `sessions-sqlite`, `workspace-local`, `execution-local`, `tool-shell` (Pi built-ins),
  `deployment-docker`, `admin-basic`.
- CLI: installer script, `new`, `add`, `remove`, `doctor`, `dev`, `configure`, `up/down/
  logs/status/restart`.
- Scenario 1 green.

### M2 — Chat + reliability
- `channel-telegram`, `durable-outbox`, `scheduler-cron`, `preset telegram`.
- CLI: `expose` (Cloudflare tunnel / Caddy), `config check`.
- Scenarios 2–3 green.

### M3 — Ownership tooling
- `pikit.json` hashes, `outdated`, `diff`, `upgrade` (incl. resolve-with-pi).
- `create extension|component`, `registry init|validate`.
- `sessions-postgres`. Scenarios 4–5 green.

### M4 — Cloudflare PoC
- `sessions-cloudflare-do` passing Pi conformance.
- Pi adapter manual-drive mode + resume.
- `deployment-cloudflare`, `workspace-virtual`, `execution-fetch`, `scheduler-cloudflare`.
- Bundle ≤ 10 MB gz, startup ≤ 1 s measured. Scenario 6 green.

### M5 — Cloudflare full
- `execution-cloudflare-container`, `workspace-container`, `workspace-r2-snapshot`.
- Approvals via Workflows.
- `channel-google-chat`, `approvals` (deterministic decision lifecycle, see §18).

### Later
- `execution-remote` executor protocol.
- Second agent runtime behind `AgentRuntime` (only if demanded).
- Registry gallery site (static).

---

## 18. Higher-level components (post-M2)

Components that encode operational patterns beyond plain message-in/reply-out, in order of
value. Each one is built contracts-first against the core in §4–§5 and must remain removable:

| Component | What it encodes |
|---|---|
| `approvals` | Deterministic decision lifecycle: proposed → approved/rejected → executed → verified, with retries, reminders, stalled escalation, TTL/abandonment, and **delivery-time binding** of a decision to the message/thread where a human can answer it (a decision created by a scheduled job cannot know its answer surface until the result is sent). |
| `durable-outbox` | Outbound intents persisted before send, retried with backoff, dead-lettered, and recorded so later replies can quote or thread against them. |
| `conversations.registry` | Conversation key → active session + workspace ref, with TTL eviction of memory that never drops the pointer, and explicit `/reset` semantics. |
| `routines` | File-defined scheduled prompts (`src/agents/{name}/routines/*.yaml`) synced into `scheduler`, with target fan-out by route tags and previous-run context injection. |
| `policy-tools` | Role-based interception of `agent.tool.call`: shell command and path rules, allow/deny lists, hot-reloadable. Policy mediation, not a sandbox. |
| `channel-google-chat` | Google Chat app: JWT-verified webhook ingress, REST transport with message create/patch, cards, threads, media. |
