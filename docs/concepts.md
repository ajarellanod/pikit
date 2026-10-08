# Concepts

The kernel is `@pikit/core` ([packages/core/src](../packages/core/src)). Its only runtime dependency
is `typebox`, and it knows nothing about agents, channels or storage: those words live in
`@pikit/contracts`. Its public surface is [index.ts](../packages/core/src/index.ts), held by
`exports.test.ts`.

```
pikit.config.ts
  defineApp({ components, config })           checks names and config (sync)
    .create()   every setup runs, in list order: provide / use / on / pipeline
                graph derived and validated (missing, ambiguous, cycles)
    .start()    runtime.starting → start() in dependency order → runtime.ready
    .stop()     runtime.stopping → stop() in reverse order   → runtime.stopped
    .describe() what was composed (APP_DESCRIPTION)
```

## App

`defineApp({ components, config, target?, logger?, clock? })` ([app.ts](../packages/core/src/app.ts))
checks that component names are unique, reads `config.capabilities` (selections), merges every
component's config schema and validates the config. It throws at once on a problem.

`create()` runs every component's `setup`, records what each provides and uses, then validates the
graph: a required capability with no provider, an ambiguous one, a selection that names a component
that does not provide it, a capability used in the wrong mode, or a cycle all fail `create()`, before
anything starts. It returns an `App`:

- `start(parent?)` runs each component's `start` in dependency order (providers first, list order as
  the tiebreaker). If one throws, the components already started are stopped in reverse order and
  `start` rejects naming the component ([lifecycle.ts](../packages/core/src/lifecycle.ts)).
- `stop(parent?)` runs each `stop` in reverse order; every `stop` runs even if one throws. During a
  `start`, it cancels the start and waits for its rollback.
- The kernel keeps no timeouts (K2). Deadlines come from the `parent` context of `start` and `stop`,
  given by whoever runs the App (a deployment's entrypoint). A hook still running at its deadline is
  abandoned and logged.
- An App is single-use: after `stop()` or a failed `start()`, `create()` a new one.
- `stop()` may never run (`kill -9`, eviction). Nothing correct may depend on it (K6).
- `context(parent?)` gives an `AppContext` for work outside a hook (a request, a test).

A project may define several Apps (K7). On Cloudflare it defines two (below).

## Component

```ts
export default defineComponent({
  name: "router-basic",                       // kebab-case, prefixed by its kind
  config: Type.Object({ defaultAgent: Type.String({ minLength: 1 }) }),
  setup(pikit, config) {                      // sync, registers only
    const agents = pikit.useKeyed("agent.definition");
    pikit.pipeline("route.resolve", (value) => /* … */ value, { id: "router-basic" });
    return { start() { /* check agents.get(config.defaultAgent) */ } };
  },
});
```

- **`setup(pikit, config)`** is synchronous and only registers: `provide`, `provideKeyed`, `use`,
  `useOptional`, `useKeyed`, `on` (events), `pipeline` (stages). A promise returned from it is an
  error. Registering after `setup` returned (from `start`, a listener, a timer) throws: the
  registration is sealed. `config` is the component's own part of the config, defaulted and frozen;
  a component never sees another's config (K4).
- **What it returns** is optional `{ start?(ctx), stop?(ctx) }`. Resources are acquired in `start` and
  released in `stop`, both honouring `ctx.abortSignal`. Variables of `setup` are shared through the
  closure.
- **`start`'s context carries the start deadline.** Work that outlives `start` (a poller, a server)
  uses `ctx.derive(() => BACKGROUND_CONTEXT)` or a context per request, never `start`'s own.
- `setup` is the manifest: `component.json`'s `provides`, `requires` and `optional` are generated from
  what `setup` does ([components.md](components.md)).

The kernel reserves the config key `capabilities`; no component may be named so.

## Capability

A capability is a named service. The kernel registers them
([capabilities.ts](../packages/core/src/capabilities.ts)); their types come from the contracts by
declaration merging on `AppCapabilities` and `AppKeyedCapabilities`.

| Kind | Provided with | Used with | Rule |
|---|---|---|---|
| single | `provide(name, impl)` | `use(name)` | exactly one provider is used; none is an error |
| single, optional | `provide(name, impl)` | `useOptional(name)` | `get()` returns `undefined` when nothing provides it |
| keyed | `provideKeyed(name, key, impl)` | `useKeyed(name)` | every provider's keys are visible; none is fine |

- The mode is fixed by how a name is first provided. Providing one name both ways is an error, as is
  providing the same key twice or a single capability twice from one component.
- `use`, `useOptional` and `useKeyed` return a handle. `handle.get()` (keyed: `get(key)`, `keys()`)
  throws during `setup`: call it in `start` or later.
- **Start order.** A user depends on the provider `get()` will return. A keyed use depends on every
  provider of that name; an optional use on its provider when one is installed. A component may use
  what it provides itself.
- **Selection.** When several installed components provide a single capability, `create()` fails
  unless `config.capabilities[name]` names one: `{ capabilities: { "storage.sql": "storage-sqlite" } }`.
  Selecting a keyed capability is an error.
- Optional is a verb, not a flag, so whether a dependency is optional is written in code, not config.

## Contract

A contract is a capability's TypeScript interface plus its written guarantees and a conformance suite.
The kit's live in [packages/contracts/src](../packages/contracts/src), and Pi-shaped ones in
[packages/pi-adapter/src/types.ts](../packages/pi-adapter/src/types.ts). A registry may declare its
own (`declares` in `component.json`). Contracts are the only coupling between components: a component
never imports another component's files (P4). See [contracts.md](contracts.md).

Besides interfaces, the contracts hold two protocol functions that every channel must get right:
`admitInbound` (a message in) and `startAnswerDelivery` (answers out). The policy (route, texts,
retry waits) is passed in by the calling component (SPEC §3.3).

## Pipeline

A pipeline is an ordered chain of stages over one value type. Stages run by `priority` (higher
first), then registration order. A stage returns the next value, or `halt(reason)` to stop the chain
(the kernel then emits `pipeline.halted`). Throwing, or returning `undefined`, fails the run.
`ctx.run(name, value)` runs one. See [pipelines.md](pipelines.md).

## Event

`pikit.on(name, listener)` registers a listener in `setup`; `ctx.emit(name, payload)` awaits every
listener in registration order ([events.ts](../packages/core/src/events.ts)). A listener that throws
is logged and does not stop the others. There is no unsubscribe. Events are notifications: never
persisted, and may be missed (K3).

## Feed

What must not be missed is a feed, not an event: `Feed<T>.read(after, limit)` returns facts committed
after a cursor ([feed.ts](../packages/contracts/src/feed.ts)). A reader keeps its own cursor, applies
facts idempotently, and moves the cursor only past facts whose effect is committed. Events only wake
it. A feed is a type inside a contract, not a capability: `agent.submissions.answers` and
`outbound.queue.receipts` are the two that exist.

## Context

`Context` is `{ abortSignal, value(key), toString() }` ([context.ts](../packages/core/src/context.ts),
K5), the same shape as Chord's. It is immutable; `withAbortSignal`, `withCancel` and
`withContextValue` derive new ones. Every handler gets an `AppContext`, which adds `target`, `logger`,
`clock`, `emit`, `run` and `derive`.

Values that are not capabilities travel as context keys:

| Key | Defined in | Set by | Holds |
|---|---|---|---|
| `APP_DESCRIPTION` | `@pikit/core` | the kernel, on every context an App creates | the frozen `describe()` |
| `AGENT_STATE` | `@pikit/contracts` (`agent-state.ts`) | the runtime, on each run | the conversation's `AgentState` |
| `CONVERSATION` | `@pikit/contracts` (`conversation-context.ts`) | the runtime, on each run | the run's `ConversationRef` |
| `WORKERS_HOST` | `@pikit/contracts/cloudflare` | deployment-cloudflare's entrypoints, on the start context | `env`, `origin` (Worker), `object` (Durable Object) |

## Target

`Target` is `"server" | "durable"` (K1): a runtime model, not a provider. `server` is a long-lived
process with a persistent disk; `durable` is one actor (a Durable Object) per conversation, evicted
between events. `pikit.target` and `ctx.target` say which, but no component branches on it in
`setup`: a difference between targets is a different component, or a capability. A component's
`component.json` lists its `targets`; a project's `pikit.json` records its own. See
[targets.md](targets.md).

## The two Apps on Cloudflare

A Cloudflare project's `pikit.config.ts` has two Apps (C1):

```ts
export default defineApp({ components: [...], config });                 // each conversation's Durable Object
export const worker = defineApp({ components: [...], config: workerConfig }); // the Worker
```

- The **Worker's App** receives every request: the ingress half of each channel, the mailbox, secrets,
  the admin API's routes. It checks and routes.
- The **object's App** runs in the Durable Object named after the conversation key: the runtime,
  storage, the registry, the router, the channel's other half, delivery.
- A component with a half for each App declares `"apps": { "worker": "<export>" }` in
  `component.json`. The default export goes in the object's App; the named export (a component named
  `<name>-worker`, configured under that key in `workerConfig`) goes in the Worker's. `"worker":
  "default"` puts the same component in both (`platform-cloudflare`, `secrets-cloudflare`,
  `admin-auth-token`). `pikit add` and `pikit remove` edit both Apps.
- The halves talk only through `actor.mailbox` (Worker → object) and `actor.inbox` (object).

On a server, a project has one App, and only default exports are listed.

## Config and secrets

- **Config** is plain values in `pikit.config.ts`, one key per component, validated against each
  component's TypeBox schema with its defaults applied, then deep-frozen. It is committed and shown
  (`pikit doctor`, the dashboard). Config holds values, never strategies: two strategies are two
  components.
- **Secrets** are read only through the `secrets` capability (`secrets-env` on a server,
  `secrets-cloudflare` on Cloudflare). They live in `.env` (mode 0600, written by `pikit configure`,
  never committed) and are declared in a component's `environment`. Config may name a secret
  (`tokenSecret: "GITHUB_TOKEN"`), never hold one. `secretLikePaths` and `redactSecrets`
  ([secrets.ts](../packages/contracts/src/secrets.ts)) catch a secret put in config by mistake:
  `doctor` warns, the dashboard redacts.

## describe() and APP_DESCRIPTION

`app.describe()` returns an `AppDescription` (version 1): the target, the components in start order
with what each provides, requires and uses optionally, each capability's providers (and the selected
one, or the keys of a keyed one), each pipeline's stages in order, and the config. The same object,
frozen, is on every context the App creates as `ctx.value(APP_DESCRIPTION)` (K13). It is for
observers only: `pikit doctor` prints it, and `registry validate` refuses any component whose shipped
files name `APP_DESCRIPTION` unless its name starts with `admin-` (`checkDescriptionReaders` in
[checks.ts](../packages/cli/src/registry/checks.ts)). A component that adapts to what is installed
uses `useOptional`.
