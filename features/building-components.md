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
   (`requires`, `optional`). The kit's shared vocabulary is in `@pikit/contracts` (and in
   `@pikit/pi-adapter` for Pi's own shapes: `agent.tool`, `agent.extension`, `execution`…);
   `pikit registry capabilities` lists them with their stability. A feature's design note in
   `features/` names the contract it needs. If none fits, the contract is yours: its type lives in
   the component that defines it (declaration merging on `AppCapabilities`, as the kit's do), with a
   suite next to it, and that component declares it in its `component.json`, with a new name prefix
   when the feature is a new kind:
   `"declares": { "kinds": ["memory"], "capabilities": { "memory": { "mode": "single", "stability": "experimental", "summary": "…" } } }`.
   Nothing in the CLI or `@pikit/contracts` changes; redeclaring one of the kit's is refused.
2. **Copy a reference component of the same kind.** `router-basic` (a pipeline stage),
   `channel-http` (a channel), `storage-sqlite` (a `storage.sql` provider), `tool-fetch` (a tool),
   `deployment-docker` (a deployment); for agent behaviour, runtime-pi's `extensions.test.ts` (an
   extension with a section, hooks and a tool, provided as `agent.extension`). A component is a
   folder in a registry:
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
5. **Check it composes.** `pikit registry validate <registry>` (the manifest, its files, its imports
   per target, and its kind and capabilities against the kit's catalogue plus what the registry's
   components declare), then `pikit add <name> --registry <path>` in a project and `pikit doctor`
   (which also checks that every tool and extension an agent names is installed).
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
Agent behaviour is a Pi extension (pi-durable's `defineExtension`, from
`@pikit/pi-adapter/extensions`): async system prompt sections that read the conversation's documents,
hooks on model requests (`beforeRequest`, `afterResponse`, `onYield`, `afterTools`), tool calls
(`beforeTool`, `afterTool`) and compaction (`beforeCompact`), tool wrappers, durable tasks, tools, and
its own state as a document (`defineDoc`) or in `storage.sql`. A component provides it under its name
(`pikit.provideKeyed("agent.extension", "memory", extension)`), and an agent runs with it only by
naming it (`defineAgent({ …, extensions: ["memory"] })`), as with tools. An agent's `prepare(state)`
stays for the simple case (switch model, prompt, tools or extensions with the state); anything async,
or that must see each request or tool call, is an extension. What Pi cannot give itself (channels,
delivery, deployment, the dashboard) is a pikit component.

## Open questions
- Whether a `dashboard.view` contract (a view and its admin API routes, shown when installed) is
  part of `admin-dashboard`'s first version or comes with the first component that needs a view.
- Whether skills live in the kit repository (copied by `pikit new`) or are a component
  (`agent-skills`) like any other.
