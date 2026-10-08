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
- Agents: `defineAgent` (with `extensions` by name, and `steward: true` for the project's one steward,
  SPEC §6), `agent.runtime` (dispatch, abort, resume, and
  steer with `whenBusy: "steer"`; `agent.*` events), `agent.conversations`, `agent.submissions`
  (read-only: `pending`, `get` and the `answers` feed), `agent.state`,
  `agent.observe` (conversations with agent, busy state and cost; a transcript; a live event stream;
  usage), `agent.tool`, `agent.definition`.
- Inbound and outbound: `admitInbound` (`inbound.normalize`, `route.resolve`) and its outbound
  counterpart `startAnswerDelivery` (a channel's answers from the `answers` feed and its own cursor,
  one ordered lane per conversation, retries with the channel's own waits, idempotency keys, a crash
  resends at most the piece in flight, marked; on `wakeups` in slices or a timer in the process; its
  header says once what direct and queued delivery each guarantee),
  `conversations.registry` (a key's runtime conversation, resolve and reset), `outbound.queue` with
  `ChannelTransport` and `DeliveryError`, `Feed` (what must not be missed, read with a cursor, K3).
- Platform: `http.route` (fetch handlers by `"METHOD /path"`, parameters and prefix keys such as
  `GET /admin/*`), `admin.auth` (whether a request is an operator's), `secrets`, `storage.sql`,
  `storage.kv`, `actor.mailbox` / `actor.inbox` (C2: `send`, and `call` answered by `answer`, failing
  with a coded `ActorCallError`), `wakeups` (C3), and `WORKERS_HOST` in
  `@pikit/contracts/cloudflare` (C5).
- `health` (`reporter(name)`: `up`, `degraded`, `down`; `snapshot()`), with its suite
  `createHealthConformance`: a component reports through `useOptional("health")`, so without a
  provider nothing changes. `outbound.queue`'s `pending(page)`: the pieces not settled yet (`queued`,
  `sending`, `retrying`), with their attempts, next try, last error (short) and whether they may repeat,
  never their text; its suite checks the states, settling into `receipts`, restarts and paging.
  `agent.observe` lists conversations in the runtime's order (creation order for runtime-pi).
- The channel suite checks any channel end to end, durability included (an answer settled while the
  channel was stopped, a lost event, retries in order, a cut send resent at most once, independent
  lanes, a transient admission failure never dropped, a redelivered reset command run once); the
  convergence suite checks crash recovery, of the outbox and of direct delivery over storage-kv-sql.
  The `agent.submissions` suite runs on runtime-pi, on SQLite and in a Durable Object.
  Contracts still without a suite are listed in `features/building-components.md`.
- `github`: the project's own repository on GitHub, as connected (`repository`, `owner/name` or
  none), and a short-lived token for it (`token`, at least five minutes left;
  `GitHubNotConnectedError` while none is), never logged; suite `createGitHubConformance`.

### Pi adapter (`@pikit/pi-adapter`, the only package that imports Pi)
- On `@earendil-works/pi-durable` 1.1.0 (with `chord`, `pi-ai` and `pi-mcp` 1.1.0, exact pins):
  `createDurableRuntime` runs `agent.runtime`, `agent.conversations` and `agent.submissions` on one
  pi-durable `Harness` per storage, over `storage.sql` (`openDurableStorage`; pi-durable's storage
  conformance passes on SQLite and on a Durable Object). Messages queued while a run goes are answered
  together by the next run, steers join the run going; settlements are grouped exactly by their
  inputs' commit and logged once in `runtime_pi_answers`. Each conversation sends the provider its own
  session id, the same on every turn, so prompt caches keyed on it hit. On Cloudflare Workers an idle
  conversation's context is not kept in memory (`contextRetentionMs: 0`), so no timer keeps a Durable
  Object alive after a run.
- `createDurableExecutionConformance` runs pi-durable's `ExecutionEnv` suite (readers, `watch`, argv
  `exec`, output streams) and then pikit's cases it lacks; `watch: false` and `shell: false` leave out
  what an environment does not have.
- `agent.extension` (keyed): a component adds agent behaviour as a pi-durable extension (system
  prompt sections, hooks, tool wraps, tasks), from `@pikit/pi-adapter/extensions`; agents select
  them by name.
- `createObserver` (`agent.observe` from pi-durable's records), `driveSlice` / `nextWakeAt` for hosts
  that run in slices, `harnessEnv` (each tool call's `workspace` or `execution`), `modelsFrom`,
  `loginInteraction`.
- Subpaths: `./tools` (`defineTool` and Pi's own tools, with no replay: a component sets it), `./mcp`,
  `./execution`, `./node` (server only), `./providers/<id>` for every pi-ai built-in provider and
  `./api/<name>` for every lazy API (generated by `scripts/pi-providers.ts` at each Pi bump, checked
  against pi-ai; no barrel; Bedrock and Vertex server only), `./provider` (`createProvider`,
  `envApiKeyAuth`: a provider written in a project), `./credentials`, `./wakeups`, and their `testing`
  suites.

### Components (`registry/`, copied into projects as source)
- Runtime and models: `runtime-pi` (resumes what is pending at start; with `wakeups`, drives runs in
  slices; model keys read through `secrets`; refuses to start an agent that names a coding tool with
  no environment, naming what to install), `provider-anthropic` (API keys on both targets, its login
  on a server), `provider-openrouter` (`apiBase`), `provider-openai-compatible` (any endpoint that
  speaks OpenAI's API: `id`, `baseUrl`, the key's name, `models`), `provider-faux` (fake
  models for tests and trials: `faux/echo`, and `faux/scripted`, which calls a tool on
  `call: <tool> <json>` and shows the system prompt on `echo-system`), `credentials-file`.
- Channels: `channel-http` (server), `channel-telegram` (long polling, server),
  `channel-telegram-webhook` (Cloudflare: a Worker half and an object half, bot password and `/login`,
  self-registering webhook); both deliver through `startAnswerDelivery`, run a redelivered command
  once, and share their identical files (held by a test). The poller tries a failing update for 15
  minutes, never skipping past it, then tells its sender. Routing: `router-basic`, `router-rules`.
  Delivery: `outbound-durable` (on `wakeups` on both targets: a retry is a timer on a server and the
  object's alarm on Cloudflare; transient failures never abandon, only an age of 24 hours does).
- Conversations and storage: `conversations-file`, `conversations-kv`, `storage-sqlite`, `storage-do`,
  `storage-kv-sql`, `secrets-env`, `secrets-cloudflare`, `mailbox-local`, `wakeups-timers`,
  `platform-cloudflare` (mailbox, inbox and wakeups over one alarm).
- Tools and execution: `tool-read`, `tool-write`, `tool-edit`, `tool-bash` (Pi's own), `tool-fetch`
  and `tool-websearch-brave` (their source in the component: the references for writing a tool),
  `tool-mcp` (remote MCP servers, with a deploy-time seed); each tool's `replay` is in its own source
  and a tool on `api.env` uses `execution` (checked by `registry validate`). `execution-local`,
  `workspace-local` (a directory per agent under `execution`'s, with its variables and shell),
  `execution-do` (files in the object's SQL, a shell without processes, `git`, `node` in QuickJS;
  pi-durable 1.0.3's environment: positional and directory readers, argv `exec`, no `watch`).
- Health: `health-registry` (server and durable): a degraded component, or a non-essential one down,
  makes the App `degraded`; an essential one (`essential` in config) down for `graceMs` (30 s) makes it
  `down`; a down verdict a restart did not fix doubles the grace (up to `maxGraceMs`, kept in
  `storage.kv`), which starts over after a calm period. Mark essential only what a restart can fix. It brings the dashboard's Health view (`view/`, the reference component with a view) and its
  route. `channel-telegram`'s bots report their polling: `degraded` after a failed `getUpdates`,
  `down` after 5 in a row.
- Self-improvement's gate: `admin-proposals` (server and durable; on Cloudflare in both Apps): the
  agent's pull requests from `pikit/self/*` of the project's repository in the dashboard's Proposals
  view (state, checks, preview URL; a page per proposal with its description, diff and checks),
  approved (squash-merged at the head the operator read, into the default branch) or rejected
  (commented and closed) with `PIKIT_MERGE_TOKEN`, which only those routes read; reads with
  `GITHUB_TOKEN`; failing, pending or missing checks refuse Approve unless overridden. It installs
  the project's CI, `.github/workflows/pikit-checks.yml` (typecheck, `bun test`, the Worker's
  dry-run bundle). `pikit doctor` no longer calls a component whose only use is its routes unused on
  Cloudflare, where the Worker's host serves them.
- GitHub on Cloudflare: `github-app` (durable; both Apps, its connection in one object): the
  dashboard's Settings → GitHub creates a GitHub App in the operator's account from a manifest
  (private, no webhook; contents and pull requests write, checks and statuses read) and installs it on
  the bot's repository, two clicks, no token pasted anywhere. The callback's `state` is single-use,
  expires in 15 minutes and is bound to the operator and the browser that started it; the App's
  private key and secrets are sealed (AES-GCM, a key derived from `PIKIT_ADMIN_TOKEN` by HKDF:
  changing that token means connecting again); installation tokens for the repository alone are
  minted with an RS256 JWT (Web Crypto, GitHub's PKCS#1 key wrapped as PKCS#8) and kept until shortly
  before they expire. It provides `github`: execution-do's `git` pushes the connected repository with
  its token (and sends it for no other), extension-pikit-self tells the steward its repository.
  Without a provider both fall back to the `GITHUB_TOKEN` secret.
- `outbound-durable` implements `pending` (50 per page, at most 500); a piece cut by a crash records
  why it is sent again.
- Serving and operating: `server-bun` (`/health` answers `{ status }`, 503 when `health` says `down`; `/ready`), `admin-auth-token` (operators by a bearer
  token from `secrets`, and browser sessions: a signed, expiring HttpOnly SameSite=Strict cookie,
  `x-pikit-admin` required on unsafe methods), `admin-api` (the operator's HTTP API under
  `/admin/api/*`: the composition, config values that look like secrets redacted; conversations from
  its conversation index, newest activity first, paged, on both hosts; a transcript, live events as
  server-sent events; conversations of the dashboard's own (`dashboard:<uuid>`) and the operator's
  follow-ups to another channel's, marked for the agent and never delivered to that channel; abort and
  reset; with an `outbound.queue`, what is not delivered yet and what settled; it serves the
  dashboard's built files at `/admin/` under a Content-Security-Policy, `index.html` for any page
  path), `log-events`.
- Delivery: `startAnswerDelivery` passes over a run every request of which is the dashboard's
  (`DASHBOARD_REQUEST_PREFIX`); a run that also took a user's message is delivered.
- Agent behaviour: `extension-house-rules` (rules from config as a system prompt section, listed tools
  refused by a `beforeTool` hook; the reference agent extension), of the kind `extension-`.
  `extension-pikit-self` (SPEC §6's self-knowledge, `pikit-self`): a section with a short guide to
  pikit and how each part of the agent is changed, the kit's docs linked at the project's
  `kit.commit`, and what runs now, read in-process from `APP_DESCRIPTION` (K13, which exempts it) and
  `agent.definition`, config secrets redacted; no tool. Only the steward may name it: the App does not
  start with another agent that does, nor (runtime-pi) with two stewards.
- Deployment: `deployment-docker` (`up`, `down`, `restart`, `status`, `logs`) and
  `deployment-cloudflare` (the Worker and one Durable Object per conversation running the project's
  two Apps; `up` waits for the new version on `/health`, then runs `afterDeploy` hooks, C8; while an
  object's App cannot start, a guard alarm wakes it again, from 30 s doubling up to 1 h, past
  Cloudflare's 6 retries). Its `wrangler.jsonc`'s `build.command` builds a project's dashboard before
  every bundle, whoever runs wrangler: a failed build stops the deploy.

### Dashboard (`registry/dashboard/`)
- A project's choice, not a component (SPEC §5): `src/dashboard/`, a shadcn/ui project of its own
  (Vite, React, Tailwind v4, pinned packages) over `admin-api`: sign-in with the operator's token once
  (a session cookie; the token is kept nowhere), the conversations newest first, one of them live (its
  transcript, the answer being written, the tools running), abort, reset, its cost, and the
  composition. It is a channel of its own: "New conversation" with one of the App's agents, and, in
  another channel's conversation, a follow-up whose answer stays in the dashboard. Polling and live
  streams pause while the tab is hidden or the operator is away, slower on Cloudflare. A view is a folder of
  `src/views/`, shown when the capabilities it declares are installed; Delivery is one (with an
  `outbound.queue`). A component brings its own view (`view` in `component.json`): `pikit add` copies it
  to `src/dashboard/src/views/<name>/` when the project has a UI, recorded as the component's. Its
  pieces, views and the components' views are shadcn items too (`@pikit`, `registry/ui/r/`, generated by
  `scripts/ui-registry.ts`): `shadcn add @pikit/<item>`. The skill `pikit-view` teaches an AI agent to add
  a view and its routes, and to prefer a new view to editing a base one.
- `/admin/?settings=<id>` opens the Settings dialog at a component's section (github-app's setup
  comes back there). The CSP lets a form post to `https://github.com` (github-app's Connect).

### Presets
- `http` and `telegram` (Docker on a server; conversations on `conversations-kv` over
  `storage-kv-sql`), `telegram-cloudflare` and `cloudflare-minimal` (`--target durable`). A preset is a
  list of `pikit add`s; its `choose` questions pick a channel (`multiple`: several at once), and its
  `features` are the components `pikit new` offers to add. The starter agent's prompt says where
  it is reached, and its model is one the preset installs; on a server it does not name `bash`.
  Every preset that runs an agent installs `extension-pikit-self`, and the starter agent, the
  project's steward (`steward: true`), names it.

### CLI (`pikit`)
- `new` (guided in a terminal: target, preset, channels, several at once, then what it can do: the
  dashboard and the preset's features; `--with` answers both in a script), `add` (one or several names, one
  transaction), `remove`, `upgrade` (three-way merge
  of your edits from `pikit-bases/`; a kit behind the CLI is a plan of its own, shown in `--dry-run`,
  and `doctor` notes it), `configure` (secrets, generated tokens, model logins), `doctor`,
  `dev`, `up | down | restart | status | logs` (delegated to the installed `deployment-*`),
  `registry validate | generate | capabilities`. A registry's components may declare their own
  kinds and capabilities (`declares` in `component.json`); the kit's catalogue is the default.
  `validate` holds imports per file kind: what shipped files import is a `dependency` (with a
  `requires` range for a kit package), what only tests import a `devDependency`. It refuses a
  component other than `admin-*` whose shipped files name `APP_DESCRIPTION` (K13), and `setup` that
  declares differently on two of its targets (K1). Outside the kit repository its messages say
  `pikit registry generate <dir>`.
- `pikit.json` records what each install wrote (files and hashes, npm packages, hooks, offers), read
  through a schema whose errors name the file and the field; `add` and `upgrade` share one
  transaction, so every change rolls back on failure and leaves a marker when interrupted. Offers install the one
  provider a component needs (`outbound.queue`, `storage.kv`, `wakeups`); it goes with that component
  unless another requires it. `remove` and `doctor` refuse a project that would answer nobody (a
  channel without a router, routes without a server), and print doctor's notes. Components may declare
  `configure.ts` and `doctor`, `beforeDeploy` and `afterDeploy` hooks, which run on the machine that
  configures or deploys, never in the app. `pikit add` installs a component's README beside its
  code (`src/pikit/<name>/README.md`).
- `doctor` warns when a config value looks like a secret (pointing to `secrets`), and prints the
  config redacted.
- `configure` and `up` check credentials only for the model providers the agents name, and reach
  the deployment (Docker) only when one is missing here; `dev` checks this machine's. A provider's key
  name comes from its component's manifest, and a login is offered only where pi-ai has one.
- `pikit new` copies the skills for AI agents (`.agents/skills/`) into every project, with where the
  kit is written in (this machine's checkout, and GitHub at the project's kit commit; the project's
  README says so too), and leaves a
  registry of the project's own (`registry/`) and the dashboard (`src/dashboard/`) out of `tsc` and
  `bun test` (`bunfig.toml`); `lib` is ES2023. Its `.gitattributes` marks the dashboard's built
  module generated (collapsed, `-diff`).
- `pikit new --ui` (and the guided path's features step) and `pikit ui on | off`: the dashboard and what it
  needs (`admin-auth-token`, `admin-api`), or neither; `off` refuses to lose your edits or your own
  views without `--force`. `pikit.json`'s `dashboard` records its files and `pikit-bases/` keeps them,
  so `pikit upgrade` (without names) merges its new version with your edits. `deployment-docker`'s
  image builds it in a stage of its own.

### Installer and templates
- `installer/install.sh`: from an empty server to a running agent (Docker), or `--durable` for
  Cloudflare. `scripts/template.ts` makes the "Deploy to Cloudflare" Telegram template from
  `pikit new` itself, with self-improvement dormant (`admin-proposals` and `github-app`): GitHub is
  connected after deploying from the dashboard's Settings → GitHub, never in the button's form.

### Docs and verification
- `MANIFESTO.md`, `SPEC.md` (what must hold), `IDEA.md`, one design note per feature in `features/`,
  and the upstream proposals to Pi in `docs/upstream/`.
- `.agents/skills/pikit-component`: how an AI agent writes a component (contract, or one of its own
  with `declares`; reference; durability through contracts, `startAnswerDelivery`, actor calls; suite;
  `registry validate`, `pikit add`). `.agents/skills/pikit-extension`: agent behaviour as an
  `agent.extension` (sections, hooks, documents, tools, testing with the scripted faux model).
- `features/memory.md` is a build guide: per-person memory as a store with an actor per person
  (`ActorMailbox.call`) and an extension (a stable section, an idempotent `remember`).
- `bun test` (every package and component), the workerd lane (`bun run test:workerd`: the Cloudflare
  components in real Durable Objects, eviction mid-run included), and `PIKIT_E2E=1` end-to-end tests:
  a project made by `pikit new` answers a message, on a server and in workerd.
