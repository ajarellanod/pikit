# Changelog

What changed for someone who uses pikit, newest first. Components version on their own; each
line names its area.

## Unreleased

pikit is unreleased: this is what the first release holds, by area, not the history of how it got
there.

### Kernel (`@pikit/core`)
- `defineComponent` / `defineApp`: synchronous `setup` that only registers (`provide`,
  `provideKeyed`, `use`, `useOptional`, `useKeyed`, `on`, `pipeline`); the dependency graph is derived
  from it and validated in `create()`; `start`/`stop` in dependency order with deadlines and rollback
  (K2, K6). Typed events, ordered pipelines with priorities and halts, keyed capabilities with
  selection, per-component TypeBox config merged, validated and frozen (K4, K11).
- `Context` is pikit's own, Chord's shape (K5). `Target` is the runtime model, `server` or `durable`
  (K1). `describe()` and `APP_DESCRIPTION`, a frozen, versioned description on every context the App
  creates (K13). Exports held by `exports.test.ts`; `@pikit/core/testing` has the lifecycle suite and a
  manual clock.

### Contracts (`@pikit/contracts`, each with its suite in `@pikit/contracts/testing`)
- Agents: `defineAgent` (with `extensions` by name), `agent.runtime` (dispatch, abort, resume, and
  steer with `whenBusy: "steer"`; `agent.*` events), `agent.conversations`, `agent.submissions`
  (read-only: `pending`, `get` and the `answers` feed), `agent.state`,
  `agent.observe` (conversations with agent, busy state and cost; a transcript; a live event stream;
  usage), `agent.tool`, `agent.definition`.
- Inbound and outbound: `admitInbound` (`inbound.normalize`, `route.resolve`), `conversations.registry`
  (a key's runtime conversation, resolve and reset), `outbound.queue` with `ChannelTransport` and
  `DeliveryError`, `Feed` (what must not be missed, read with a cursor, K3).
- Platform: `http.route` (fetch handlers by `"METHOD /path"`, parameters and prefix keys such as
  `GET /admin/*`), `admin.auth` (whether a request is an operator's), `secrets`, `storage.sql`,
  `storage.kv`, `actor.mailbox` / `actor.inbox` (C2), `wakeups` (C3), and `WORKERS_HOST` in
  `@pikit/contracts/cloudflare` (C5).
- The channel suite checks any channel end to end; the convergence suite checks crash recovery.
  Contracts still without a suite are listed in `features/building-components.md`.

### Pi adapter (`@pikit/pi-adapter`, the only package that imports Pi)
- On `@earendil-works/pi-durable` 1.0 (with `chord`, `pi-ai` and `pi-mcp` 1.0, exact pins):
  `createDurableRuntime` runs `agent.runtime`, `agent.conversations` and `agent.submissions` on one
  pi-durable `Harness` per storage, over `storage.sql` (`openDurableStorage`; pi-durable's storage
  conformance passes on SQLite and on a Durable Object). Messages queued while a run goes are answered
  together by the next run, steers join the run going; settlements are grouped exactly by their
  inputs' commit and logged once in `runtime_pi_answers`.
- `agent.extension` (keyed): a component adds agent behaviour as a pi-durable extension (system
  prompt sections, hooks, tool wraps, tasks), from `@pikit/pi-adapter/extensions`; agents select
  them by name.
- `createObserver` (`agent.observe` from pi-durable's records), `driveSlice` / `nextWakeAt` for hosts
  that run in slices, `harnessEnv` (each tool call's `workspace` or `execution`), `modelsFrom`,
  `loginInteraction`.
- Subpaths: `./tools` (`defineTool`, `codingTool`), `./mcp`, `./execution`, `./node` (server only),
  `./providers/anthropic|openrouter|faux`, `./credentials`, `./wakeups`, and their `testing` suites.

### Components (`registry/`, copied into projects as source)
- Runtime and models: `runtime-pi` (resumes what is pending at start; with `wakeups`, drives runs in
  slices), `provider-anthropic` (server), `provider-openrouter` (`apiBase`), `provider-faux` (a fake
  model for tests only), `credentials-file`.
- Channels: `channel-http` (server), `channel-telegram` (long polling, server),
  `channel-telegram-webhook` (Cloudflare: a Worker half and an object half, bot password and `/login`,
  self-registering webhook). Routing: `router-basic`, `router-rules`. Delivery: `outbound-durable`.
- Conversations and storage: `conversations-file`, `conversations-kv`, `storage-sqlite`, `storage-do`,
  `storage-kv-sql`, `secrets-env`, `secrets-cloudflare`, `mailbox-local`, `wakeups-timers`,
  `platform-cloudflare` (mailbox, inbox and wakeups over one alarm).
- Tools and execution: `tool-read`, `tool-write`, `tool-edit`, `tool-bash` (Pi's own), `tool-fetch`
  and `tool-websearch-brave` (their source in the component: the references for writing a tool),
  `tool-mcp` (remote MCP servers, with a deploy-time seed), `execution-local`, `workspace-local`,
  `execution-do` (files in the object's SQL, a shell without processes, `git`, `node` in QuickJS).
- Serving and operating: `server-bun` (`/health`, `/ready`), `admin-auth-token` (operators by a bearer
  token from `secrets`), `log-events`.
- Deployment: `deployment-docker` (`up`, `down`, `restart`, `status`, `logs`) and
  `deployment-cloudflare` (the Worker and one Durable Object per conversation running the project's
  two Apps; `up` waits for the new version on `/health`, then runs `afterDeploy` hooks, C8).

### Presets
- `http` and `telegram` (Docker on a server), `telegram-cloudflare` and `cloudflare-minimal`
  (`--target durable`). A preset is a list of `pikit add`s; its `choose` questions pick a channel. The
  starter agent's prompt says where it is reached, and its model is one the preset installs.

### CLI (`pikit`)
- `new` (guided in a terminal: target, preset, channel), `add`, `remove`, `upgrade` (three-way merge
  of your edits from `pikit-bases/`), `configure` (secrets, generated tokens, model logins), `doctor`,
  `dev`, `up | down | restart | status | logs` (delegated to the installed `deployment-*`),
  `registry validate | generate | capabilities`. A registry's components may declare their own
  kinds and capabilities (`declares` in `component.json`); the kit's catalogue is the default.
- `pikit.json` records what each install wrote (files and hashes, npm packages, hooks, offers);
  every change rolls back on failure and leaves a marker when interrupted. Offers install the one
  provider a component needs (`outbound.queue`, `storage.kv`). Components may declare
  `configure.ts` and `doctor`, `beforeDeploy` and `afterDeploy` hooks, which run on the machine that
  configures or deploys, never in the app.
- `pikit new` copies the skills for AI agents (`.agents/skills/`) into every project.

### Installer and templates
- `installer/install.sh`: from an empty server to a running agent (Docker), or `--durable` for
  Cloudflare. `scripts/template.ts` makes the "Deploy to Cloudflare" Telegram template from
  `pikit new` itself.

### Docs and verification
- `MANIFESTO.md`, `SPEC.md` (what must hold), `IDEA.md`, one design note per feature in `features/`,
  and the upstream proposals to Pi in `docs/upstream/`.
- `.agents/skills/pikit-component`: how an AI agent writes a component (contract, reference, durability
  through contracts, suite, `registry validate`, `pikit add`).
- `bun test` (every package and component), the workerd lane (`bun run test:workerd`: the Cloudflare
  components in real Durable Objects, eviction mid-run included), and `PIKIT_E2E=1` end-to-end tests:
  a project made by `pikit new` answers a message, on a server and in workerd.
