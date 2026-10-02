# Building components

**Public appeal:** —

**Specified:** partly (MANIFESTO principles 4, 6 and 13; SPEC P1, P3; the component schema
`registry/schema/component.schema.json`; the conformance suites in `@pikit/contracts/testing`)

**Needed by:** the promise itself. pikit gives the bases and the user builds their assistant on
them, so building a component, by hand or with an AI agent, must be easy and must come out right.

## What it gives
A user who wants memory, routines, approvals or WhatsApp asks their AI agent to build it for their
project, and gets a component that composes, passes its contract's suite, survives crashes and can
be shared, without learning pikit's internals first.

## How a component is made (today)
1. **Pick the contract.** A component provides capabilities (`provides`) and uses others
   (`requires`, `optional`), all named in `@pikit/contracts` (or in `@pikit/pi-adapter` for Pi's
   own shapes). `pikit registry capabilities` lists them with their stability. A feature's design
   note in `features/` names the contract it needs; if none fits, the contract is written first,
   in `@pikit/contracts`, with its suite.
2. **Copy a reference component of the same kind.** `router-basic` (a pipeline stage),
   `channel-http` (a channel), `storage-sqlite` (a `storage.sql` provider), `tool-fetch` (a tool),
   `deployment-docker` (a deployment). A component is a folder in a registry:
   `component.json` (name, description, targets, requires, provides, dependencies, files) and
   `files/src/pikit/<name>/index.ts` exporting `defineComponent({ name, config, setup })`.
3. **Durability comes with the contracts.** Keep state in `storage.sql` / `storage.kv` or a
   pi-durable document, wake with `wakeups`, read what must not be missed from a feed with a cursor
   (SPEC K3), deliver through `outbound.queue`. A component that does this never has to think about
   crashes, evictions or deploys.
4. **Prove it with the suite.** Every provider runs its contract's conformance suite from
   `@pikit/contracts/testing` (`createChannelConformance`, `createSqlDatabaseConformance`,
   `createConversationRegistryConformance`, `createFeedConformance`, `createHttpRouteConformance`,
   `createOutboundQueueConformance`, wakeups, mailbox, secrets, storage.kv, agent.runtime…), plus
   its own tests. Durable-target components also run in the workerd lane.
5. **Check it composes.** `bun run registry validate` (the manifest, its files, its imports per
   target), then `pikit add <name> --registry <path>` in a project and `pikit doctor`.
6. **Share it.** A registry is a folder with `registry.json`; anyone can `pikit add` from it
   (`--registry <path>`). Git registries (`github:someone/registry`) are planned
   ([open registries](open-registries.md)); the shadcn registry format is the distribution
   candidate for UI pieces.

## What is missing (to make this the easy path)
- **Skills for AI agents** (`.agents/skills/`): "write a channel", "write a tool", "write a store",
  "add a dashboard view", "write a feature from its design note": the steps above, executable by
  an agent in the user's project. Shipped with the starter so they are in every project.
- **A suite for every contract.** Missing today: `execution`/`ExecutionEnv` is in the adapter
  (`@pikit/pi-adapter/execution/testing`), not in contracts; the agent tool shape has none; future
  contracts (`dashboard.view`, memory) get theirs when written.
- **Design notes as build guides.** Each ⭐ note in `features/` states: the contract (and suite),
  the Pi pieces it relies on, what it must guarantee, the tests that prove it.
- **`pikit new component <kind> <name>`** (maybe): scaffolds a component from its kind's reference.
  Only if copying a reference proves too slow for agents.
- **Git registries**, so what one user builds another installs.

## Pi first
Pi's extensions (pi-durable's `defineExtension`: tools, system prompt sections, hooks, tasks) are
how agent behaviour is built; a pikit component that adds agent behaviour wraps one. What Pi
cannot give itself (channels, delivery, deployment, the dashboard) is a pikit component.

## Open questions
- Whether a `dashboard.view` contract (a view and its admin API routes, shown when installed) is
  part of `admin-dashboard`'s first version or comes with the first component that needs a view.
- Whether skills live in the kit repository (copied by `pikit new`) or are a component
  (`agent-skills`) like any other.

## Contracts without a suite (today)
MANIFESTO principle 13 promises a conformance suite for every contract. These do not have one in
`@pikit/contracts/testing` yet; a provider of one proves itself with its own tests:
- **`agent.tool`, the tool shape.** A tool is pi-durable's `ToolRegistration`; `runToolCalls`
  (`@pikit/pi-adapter/execution/testing`) runs it in a real Harness turn, but nothing checks every
  tool the same way (a description, a `replay`, errors the model can read, cancellation honoured).
- **`execution` and `execution.shell`.** Their suite exists but lives in the adapter
  (`createDurableExecutionConformance`, `@pikit/pi-adapter/execution/testing`), since the contract is
  pi-durable's `ExecutionEnv`. Likewise `workspace` (`createWorkspaceConformance`) and
  `model.credentials` (`createCredentialStoreConformance`), in `@pikit/pi-adapter/testing/neutral`.
- **`model.provider`.** pi-ai's `Provider`: no suite; provider-anthropic, provider-openrouter and
  provider-faux each test their own.
- **`agent.conversations`.** Only exercised through the `agent.runtime` and `conversations.registry`
  suites (a fixture creates conversations with it), never on its own.
- **`route.resolve` as a router's stage.** The channel suite checks that a channel honours a stage's
  halt; nothing checks a router (router-basic, router-rules) against a shared list of cases.
- **`agent.definition`.** Data the project provides (`defineAgent` validates it); runtime-pi refuses
  to start on an agent it cannot run.
