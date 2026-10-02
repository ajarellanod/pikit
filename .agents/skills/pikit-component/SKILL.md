---
name: pikit-component
description: Write a pikit component (a channel, a tool, a store, a router stage, a model provider, an admin route, a deployment) for a pikit project or registry. Use when the user asks to add behaviour to their pikit assistant, build a feature from a design note in features/, or make a component that others can `pikit add`.
---

# Write a pikit component

pikit is a kit for Pi: the kernel (`@pikit/core`) composes components, the contracts
(`@pikit/contracts`) are the only words they share, and Pi (through `@pikit/pi-adapter`, the only
door to Pi) runs the agents. Everything else is a component: source copied into the project, which
the user owns. A component that follows the steps below composes, survives crashes and evictions, and
can be shared.

## 0. Know the project before you write

```sh
pikit doctor                    # the components in start order, who provides what, what is missing
pikit registry capabilities     # every capability: what it is for, its stability, who provides it
```

Read `pikit.config.ts` (everything that runs is listed there) and `pikit.json` (what was installed,
and the target: `server` is a long-lived process, `durable` an actor per conversation on Cloudflare).
Installed components are in `src/pikit/<name>/`, each with a README; the project's own are in
`src/extensions/`. If the feature has a design note (`features/<feature>.md` in the pikit
repository), read it first: it names the contract and what must be guaranteed.

## 1. Pick the contract

A component **provides** capabilities and **uses** others, all named in `@pikit/contracts` (or in
`@pikit/pi-adapter` for Pi's own shapes: `execution`, `workspace`, `model.provider`,
`model.credentials`). Find the one your behaviour fits: a channel admits messages with
`admitInbound` and delivers through `outbound.queue`; a tool is an `agent.tool`; a store provides
`storage.sql` or `storage.kv`; routing is a stage of the `route.resolve` pipeline; an HTTP endpoint is
an `http.route` (`"POST /v1/x"`, `"GET /items/:id"`, `"GET /admin/*"`); an admin route asks
`admin.auth`; reading the runtime is `agent.observe`.

If no contract fits, the contract comes first, in `@pikit/contracts`, with its conformance suite in
`@pikit/contracts/testing`. Do not invent a private coupling between two components: what one needs
from another is a capability.

## 2. Copy the reference of its kind

| Kind | Reference | What it teaches |
|---|---|---|
| Tool | `tool-fetch` | `defineTool` from `@pikit/pi-adapter/tools`, `replay`, limits, tests from `execute` to a Harness turn |
| Tool with a secret | `tool-websearch-brave` | a key through `secrets` at each call, `configure.ts`, `environment` in `component.json` |
| Channel | `channel-http` (server), `channel-telegram` / `channel-telegram-webhook` | `admitInbound`, answers from `agent.submissions`, delivery through `outbound.queue` |
| Pipeline stage | `router-basic` | `pikit.pipeline("route.resolve", …)`, refusing to start on bad config |
| Store | `storage-sqlite`, `storage-kv-sql`, `conversations-kv` | providing a storage contract; state in `storage.kv` with `setIfAbsent` |
| Admin route / auth | `admin-auth-token` | `admin.auth`, a secret read at start, constant-time compare |
| Model provider | `provider-openrouter`, `provider-faux` | a pi-ai provider as `model.provider`, `modelProviders` |
| Deployment | `deployment-docker` | `up`, `down`, `status`, `logs`; a stop deadline (K2) |

Installed ones are in `src/pikit/`; the rest are in the registry the CLI uses
(`registry/components/` of the pikit checkout), or `pikit add <name>` to read one in place.

A component is a folder:

```
component.json                         name, description, targets, requires, optional, provides,
                                       dependencies, files, environment, hooks (most are generated)
README.md                              what it does, what it needs, its guarantees
files/src/pikit/<name>/index.ts        export default defineComponent({ name, config?, setup })
files/src/pikit/<name>/<name>.test.ts  its tests, copied with it into the project
```

A component only the project needs can be a single file in `src/extensions/` listed in
`pikit.config.ts`, like `src/extensions/agents.ts`; make it a registry component when it should be
shared, upgraded or removed with `pikit remove`.

## 3. Write it by the rules

- **`setup` is synchronous and only registers**: `provide`, `provideKeyed`, `use`, `useOptional`,
  `useKeyed`, `on`, `pipeline`. Call `handle.get()` in `start` or later, never in `setup`.
- **Resources in `start`, released in `stop`**, both honouring `ctx.abortSignal`. Never keep
  `start`'s context for later work: `ctx.derive(() => BACKGROUND_CONTEXT)`.
- **Config holds values, never secrets or strategies**: a TypeBox schema with defaults. A secret is
  read through `secrets` (`secrets.get().get("NAME")`) and declared in `component.json`'s
  `environment`. Two strategies are two components, not a config switch.
- **Imports**: `@pikit/core`, `@pikit/contracts`, `@pikit/pi-adapter` (never `@earendil-works/*`),
  `typebox`, and npm packages the component declares. A component for both targets imports no
  `node:*`, `bun:*` or `cloudflare:*`; one that does says `"targets": ["server"]`.
- **Fail loudly**: a component that cannot work refuses to start, with a message naming the
  component and what to fix, never a secret's value.
- **No magic**: nothing happens on import; everything is in `setup`.

## 4. Durability comes with the contracts

Never hold what must survive in memory, and never rely on `stop()`: a `kill -9` or an eviction skips
it (K6). Instead:
- keep state in `storage.sql` (tables prefixed with the component's name, created in `start`) or
  `storage.kv` (a namespace named after the component);
- wake later with `wakeups` (`handle(name, handler)` in `start`, `at(name, time)`), at least once,
  maybe late: make the handler idempotent;
- read what must not be missed from a feed with a stored cursor (`agent.submissions`' `answers`),
  never from events alone (events may be missed, K3);
- deliver through `outbound.queue`, which stores before it sends and retries;
- a tool with an effect is `replay: "unsafe"`, or derives an idempotency key from its call.

## 5. Prove it with its suite

Run the contract's conformance suite from `@pikit/contracts/testing` in the component's test
(`createHttpRouteConformance`, `createChannelConformance`, `createSqlDatabaseConformance`,
`createKeyValueConformance`, `createConversationRegistryConformance`, `createAdminAuthConformance`,
`createAgentObserveConformance`, `createWakeupsConformance`, `createSecretStoreConformance`…),
`createLifecycleConformance` from `@pikit/core/testing` when it owns resources, and a test named
"what setup declares" that pins `app.describe().components` for it. No network in tests: a local
`Bun.serve` stands in for any API, and `provider-faux` for a model. A `durable` component also
runs in the workerd lane of the pikit repository (`tests/workerd`).

## 6. Check it composes

In a registry (the pikit repository or your own):

```sh
bun run registry generate    # writes provides / requires / optional of component.json from setup
bun run registry validate    # manifest, files, imports per target, presets
```

In the project:

```sh
pikit add <name> --registry <path-to-registry>   # copies it, lists it in pikit.config.ts, installs npm deps
pikit doctor                                     # green: everything provided and configured
bun test && bun run typecheck
pikit dev                                        # and try it
```

Done means: its suite and tests pass, `registry validate` is clean, `pikit add` then `pikit doctor`
is green, `pikit remove <name>` leaves the project as it was, and its README says what it provides,
needs, guarantees and how it is tested.
