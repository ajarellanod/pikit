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

## How big a component is (decided)
A component is the smallest unit whose removal takes away something an agent's own `tools` or
`model` list does not already control: an import or registration, an npm dependency, a secret or
variable, a config block, a table or timer, a target constraint, or a risk class (replay safe or
unsafe, needs a shell, reaches the network).
- **Merge** only parts identical on all of these that must share one resource (one alarm:
  `platform-cloudflare`).
- **Split** when a target, a risk class or a heavy dependency differs: `tool-read` (safe) apart from
  `tool-write` and `tool-edit` (unsafe), and `tool-bash` (a shell); one `provider-*` per model
  provider, since targets and variables differ and the manifest must say so.
- **Build on a capability, never copy its provider**: `workspace-local` uses `execution`.
- **Decisions live in the component's source** (a tool's `replay`, a policy, a default); the kit holds
  only what changes when Pi changes and must be the same in every project (SPEC §3.3).
- **Components never depend on components.** A bundle is a preset.

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
   Nothing in the CLI or `@pikit/contracts` changes; redeclaring one of the kit's is refused. A
   component of another name that uses the capability carries an identical copy of the contract's
   file (it never imports another component's files; `tsc` refuses two copies that differ).
   [Memory](memory.md) is the worked example.
2. **Copy a reference component of the same kind.** `router-basic` (a pipeline stage),
   `channel-telegram` (a channel), `storage-sqlite` (a `storage.sql` provider), `tool-fetch` (a tool),
   `deployment-docker` (a deployment), `extension-house-rules` (agent behaviour: a section and a
   `beforeTool` hook, provided as `agent.extension`; runtime-pi's `extensions.test.ts` adds a
   document and a tool), `provider-openrouter` (a model provider: about ten lines, since every
   pi-ai provider is a subpath of the adapter, `@pikit/pi-adapter/providers/<id>`, and an unknown
   endpoint is `createProvider` from `@pikit/pi-adapter/provider` with an API from
   `@pikit/pi-adapter/api/<name>`, as `provider-openai-compatible` does). A component is a folder in a registry:
   `component.json` (name, description, targets, requires, provides, dependencies, files) and
   `files/src/pikit/<name>/index.ts` exporting `defineComponent({ name, config, setup })`. What the
   component decides (a tool's `replay`, a policy, a default) is written in that source, never in the
   kit: `tool-read` spreads Pi's `createReadTool()` and sets `replay: "safe"`. A tool that works on
   `api.env` uses `execution` (`execution.shell` for a shell), which `registry validate` checks.
3. **Durability comes with the contracts.** Keep state in `storage.sql` / `storage.kv` or a
   pi-durable document, wake with `wakeups`, read what must not be missed from a feed with a cursor
   (SPEC K3), deliver a channel's answers through `startAnswerDelivery` (which uses `outbound.queue`
   when installed). A component that does this never has to think about
   crashes, evictions or deploys. Each kind has its ready-made path:
   - a **channel** calls `admitInbound` for each message and `startAnswerDelivery` in its `start`
     (`@pikit/contracts`): answers from the `answers` feed with a cursor of its own, one lane per
     conversation, retries and idempotency keys, on both runtime models;
   - **agent behaviour** is an `agent.extension` (skill `pikit-extension`, reference
     `extension-house-rules`): its per-conversation state is a document committed with the
     transcript, and a tool with an effect is `replay: "unsafe"` or idempotent by its call id;
   - **state shared across conversations** (a person's memory, a team's settings) has one owner, an
     actor key of the component's, read and written with `ActorMailbox.call` and answered by its
     `ActorInbox.answer` handler: the App itself on a server, its own Durable Object on Cloudflare.
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
   ([open registries](open-registries.md)). A component's view is a shadcn registry item, which
   `pikit add` installs into `src/dashboard/` when the project has a UI (SPEC §5).

## What is missing (to make this the easy path)
- **More skills for AI agents** (`.agents/skills/`). `pikit-component` (the steps above) and
  `pikit-extension` (agent behaviour) ship with every project; "add a dashboard view" comes with
  the dashboard (`src/dashboard/`, SPEC §5), and a focused "write a channel" when the next channel
  shows what the general skill leaves out.
- **A helper to run an extension in a Harness turn** without runtime-pi (as `runToolCalls` does for a
  tool): today a component's own tests check its extension's parts, and the real App test is the
  project's own, because it imports `src/pikit/runtime-pi/`.
- **A dev loop for a project's own registry**: an edit in `registry/` reaches `src/pikit/` by
  `pikit upgrade`, and the registry's copy is kept out of `tsc` (two copies of a contract file must
  be identical).
- **A suite for every contract.** Missing today: `execution`/`ExecutionEnv` is in the adapter
  (`@pikit/pi-adapter/execution/testing`), not in contracts; the agent tool shape has none; future
  contracts (memory) get theirs when written.
- **Design notes as build guides.** Each ⭐ note in `features/` states: the contract (and suite),
  the Pi pieces it relies on, what it must guarantee, the tests that prove it. [Memory](memory.md)
  is the first one written so.
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
- **`agent.submissions`: now runs on its real provider.** Its suite (`createSubmissionsConformance`)
  runs on the in-memory double and on runtime-pi's runtime over pi-durable: on storage-sqlite
  (`packages/pi-adapter/src/submissions-conformance.test.ts`) and on storage-do in the workerd lane
  (`runtime-answers.workerd.ts`). runtime-pi records only from pi-durable's commits, so its fixture
  (`createPiSubmissionsFixture`, `@pikit/pi-adapter/testing/neutral`) makes the runtime record each of
  the suite's `SubmissionsRecorder` writes through messages, runs and `abandon`; the suite settles
  runs as a runtime groups them. Only `prunes` is left out: past the log's retention, runtime-pi's
  `get` reads pi-durable. The log's pruning runs under the feed suite (`answers.test.ts`), and crash
  recovery has its own tests (`recovery.test.ts`, `submissions.test.ts`).
- **`model.provider`.** pi-ai's `Provider`: no suite; provider-anthropic, provider-openrouter,
  provider-openai-compatible and provider-faux each test their own.
- **`agent.conversations`.** Only exercised through the `agent.runtime` and `conversations.registry`
  suites (a fixture creates conversations with it), never on its own.
- **`route.resolve` as a router's stage.** The channel suite checks that a channel honours a stage's
  halt; nothing checks a router (router-basic, router-rules) against a shared list of cases.
- **`agent.definition`.** Data the project provides (`defineAgent` validates it); runtime-pi refuses
  to start on an agent it cannot run.
- **`agent.extension`.** pi-durable's `Extension`: runtime-pi refuses a missing, misnamed or reserved
  (`pikit.`) one, and each extension proves its behaviour with its own tests (`extension-house-rules`'
  `app.test.ts`, runtime-pi's `extensions.test.ts`).

## Skills: how they reach a project (decided)
The skills for AI agents live in the kit repository, `.agents/skills/<skill>/SKILL.md`, and
`pikit new` copies them into every project's `.agents/skills/` (`skillFiles` in
`packages/cli/src/commands/starter.ts`). Not a component: a skill provides no capability and runs
nothing, and every project needs it from the first minute. A project made by an older CLI copies a
newer skill by hand. There are two: `pikit-component` (the steps above, executable by an agent) and
`pikit-extension` (agent behaviour as an `agent.extension`); "add a dashboard view" comes with
the dashboard (SPEC §5).
