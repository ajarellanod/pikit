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
  usage), `agent.tool`, `agent.skill` (the project's skills, its catalog: an agent names the ones it
  knows in `skills`, as it names tools; live agents and overrides too), `agent.definition`.
- Inbound and outbound: `admitInbound` (`inbound.normalize`, `route.resolve`; it refuses a message
  whose id starts with `dashboard:`, the operator's, which channel-http answers `400`) and its outbound
  counterpart `startAnswerDelivery` (a channel's answers from the `answers` feed and its own cursor,
  one ordered lane per conversation, retries with the channel's own waits, idempotency keys, a crash
  resends at most the piece in flight, marked; on `wakeups` in slices or a timer in the process; its
  header says once what direct and queued delivery each guarantee),
  `conversations.registry` (a key's runtime conversation, resolve and reset, and the channel the
  conversation belongs to for good: `ConversationRef.channel`, which every run sees), `outbound.queue` with
  `ChannelTransport` and `DeliveryError`, `Feed` (what must not be missed, read with a cursor, K3).
- Rich content: `InboundMessage.images` (a message's photos, dispatched as `AgentRequest.images`; an
  `inbound.normalize` stage may drop them); parts (`AppMessageParts` by declaration merging,
  `MessagePart` with its `fallback`, `OutboundMessage.parts`, `ChannelTransport.draws`), folded in one
  place, `messagePieces`, by both delivery paths and outbound-durable: a part a transport does not draw
  is its fallback text, a drawn one goes with the last piece, and an answer of parts and no text is
  still delivered (`AgentResult.parts`, `RunSettlement.parts`); the `question` part (`question.ts`:
  `questionProblem`, `questionPart`, `answerProblem`, `answerText`), vocabulary between the tool that
  asks and the channels that draw it; `AdmitOptions.beforeDispatch` may return a promise, awaited
  before dispatch; the `agent.partial` event (the answer as it is written, a notice for previews).
- Platform: `http.route` (fetch handlers by `"METHOD /path"`, parameters and prefix keys such as
  `GET /admin/*`), `admin.auth` (whether a request is an operator's), `secrets`, `storage.sql`,
  `storage.kv`, `actor.mailbox` / `actor.inbox` (C2: `send`, `call` answered by `answer`, and `stream`
  answered by `answerStream`, each value a JSON copy read as the caller reads, closed with its caller,
  failing with a coded `ActorCallError`; the inbox's `scope` says whether the App is every key's actor or one
  key's, what a component reads instead of the target), `wakeups` (C3), and `WORKERS_HOST` in
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
- `repo.github`: the project's own repository on GitHub, as connected (`repository`, `owner/name` or
  none), and a short-lived token for it (`token`, at least five minutes left;
  `GitHubNotConnectedError` while none is), never logged; suite `createGitHubConformance`.
- `proposals`: the agent's changes to itself waiting for an operator (`status`, `list`, `get`,
  `approve`, `reject` with typed refusals, `remote()`: where the steward clones from and pushes
  `pikit/self/<topic>` to); an id is the branch's topic, and providers are interchangeable; suite
  `createProposalsConformance` (the id as the provider lists it, no id reaching a branch outside the
  prefix, `checks_failing` held unless `override` where checks run before an approval, through the
  fixture's `failChecks`).
- `email.send`: one email to one person (`EmailSender.send({ to, subject, text, html? }, ctx)` gives
  `{ id }`), from the provider's `EMAIL_FROM` (a component never picks a sender); `EmailError`'s
  `invalid`, `rejected` and `unavailable`, checked first by every provider (`emailMessageProblem`);
  never a subject, body or link in an error or a log. Suite `createEmailSenderConformance`, against a
  fake of each provider's HTTP API.
- `http.route`: a handler reads the client's address the server saw in `x-pikit-client-address`
  (`CLIENT_ADDRESS_HEADER`): server-bun's socket peer, the Worker's `cf-connecting-ip`; a client's own
  copy never reaches a handler (a conformance case on the in-memory server, server-bun and the Worker's).
- `InboundMessage.images`: a message's images, dispatched by `admitInbound` as the request's images;
  `inbound.normalize` stages keep them unless they mean to change them.
- `agent.observe` is read-only for a reader its consumer authorized for that conversation: an operator
  (`admin.auth`), or a channel's user for their own conversation, to whom the consumer shows only a
  projection of what that user may see (channel-web's live view).

### Pi adapter (`@pikit/pi-adapter`, the only package that imports Pi)
- On `@earendil-works/pi-durable` 1.2.0 (with `chord`, `pi-ai` and `pi-mcp` 1.2.0, exact pins):
  `createDurableRuntime` runs `agent.runtime`, `agent.conversations` and `agent.submissions` on one
  pi-durable `Harness` per storage, over `storage.sql` (`openDurableStorage`; pi-durable's storage
  conformance passes on SQLite and on a Durable Object). Messages queued while a run goes are answered
  together by the next run, steers join the run going; settlements are grouped exactly by their
  inputs' commit and logged once in `runtime_pi_answers`. Each conversation sends the provider its own
  session id, the same on every turn, so prompt caches keyed on it hit. Messages left queued behind a
  failed run get a run of their own. A storage error, which closes pi-durable's Harness, fails only
  the call that hit it: the next call opens another Harness, and `onFailure` tells the host so it
  need not wait for one. On Cloudflare Workers an idle
  conversation's context and unobserved documents are not kept in memory (`contextRetentionMs: 0`,
  `documentRetentionMs: 0`), so no timer keeps a Durable Object alive after a run.
- `createDurableExecutionConformance` runs pi-durable's `ExecutionEnv` suite (readers, `watch`, argv
  `exec`, output streams) and then pikit's cases it lacks; `watch: false` and `shell: false` leave out
  what an environment does not have.
- `createWorkspaceGitConformance` (`@pikit/pi-adapter/execution/testing`): the steward's git steps
  through an environment's shell against a remote, with real git's meaning; given the remote's
  credential, that it appears nowhere the agent can read. execution-local (the machine's git) and
  execution-do (bun and workerd) pass it.
- A tool gives its run's answer parts with `withParts` (`@pikit/pi-adapter/tools`), collected in order
  into `AgentResult.parts`; runtime-pi re-emits pi-durable's partial answer as `agent.partial`, at most
  once per `partialEveryMs` (its config, default a second) per conversation, never after the run's end.
- `agent.extension` (keyed): a component adds agent behaviour as a pi-durable extension (system
  prompt sections, hooks, tool wraps, tasks), from `@pikit/pi-adapter/extensions`; agents select
  them by name.
- `createObserver` (`agent.observe` from pi-durable's records), `driveSlice` / `nextWakeAt` for hosts
  that run in slices, `harnessEnv` (each tool call's `workspace` or `execution`), `modelsFrom`,
  `loginInteraction`.
- Subpaths: `./tools` (`defineTool`, whose tool returns `{ output }`, and Pi's own tools, with no
  replay: a component sets it), `./mcp`,
  `./execution`, `./node` (server only), `./providers/<id>` for every pi-ai built-in provider and
  `./api/<name>` for every lazy API (generated by `scripts/pi-providers.ts` at each Pi bump, checked
  against pi-ai; no barrel; Bedrock and Vertex server only), `./provider` (`createProvider`,
  `envApiKeyAuth`: a provider written in a project; `createAssistantMessageEventStream`,
  `isContextOverflow`, `isRetryableAssistantError`: one that answers through others), `./credentials`, `./wakeups`, and their `testing`
  suites.

### Components (`registry/`, copied into projects as source)
- Runtime and models: `runtime-pi` (resumes what is pending at start; with `wakeups`, drives runs in
  slices; after a storage error, opens pi-durable again by itself, with a backoff; model keys read through `secrets`; refuses to start an agent that names a coding tool with
  no environment, naming what to install), `provider-anthropic` (API keys on both targets, its login
  on a server), `provider-openai` (API keys on both targets, Sign in with ChatGPT on a server: a
  ChatGPT subscription), `provider-failover` (`failover/<chain>`: a chain of other providers' models;
  a model that fails before it answers, from a rate or usage limit, refused credentials or an outage,
  passes the request to the next and cools down; health per chain), `provider-openrouter` (`apiBase`), `provider-openai-compatible` (any endpoint that
  speaks OpenAI's API: `id`, `baseUrl`, the key's name, `models`), `provider-faux` (fake
  models for tests and trials: `faux/echo`, and `faux/scripted`, which calls a tool on
  `call: <tool> <json>` and shows the system prompt on `echo-system`), `credentials-file`.
- Channels: `channel-http` (server), `channel-telegram` (long polling, server),
  `channel-telegram-webhook` (Cloudflare: a Worker half and an object half, bot password and `/login`,
  self-registering webhook); both deliver through `startAnswerDelivery`, run a redelivered command
  once, and share their identical files (held by a test). The poller tries a failing update for 15
  minutes, never skipping past it, then tells its sender. `channel-google-chat` (a Chat app of your
  own, built as a Workspace add-on; one code on both targets: in process on a server, a Worker half and
  each conversation's object on Cloudflare): Google's ID token checked with WebCrypto, an answer in
  each message's thread, a conversation per thread or per chat (a setting with its dashboard section),
  "Thinking…" written into the answer as the model writes it, markdown as Chat text with tables, code
  and images as cards, photos to the model, text files in the text and other files in the workspace,
  quoted messages, spaces allowed before they are answered, several apps as instances, and the
  agent's questions as buttons and forms, answered once and closed by a reset. Routing:
  `router-basic`, `router-rules`.
  Delivery: `outbound-durable` (on `wakeups` on both targets: a retry is a timer on a server and the
  object's alarm on Cloudflare; transient failures never abandon, only an age of 24 hours does, also for a removed channel's pieces,
  which no transport sends).
- `channel-web` (server and durable, one code): a chat page at `/chat/` for people who are not
  operators, with accounts of its own (better-auth 1.7.7 over `storage.sql`, `CHANNEL_WEB_AUTH_SECRET`):
  email and password, a link by email, better-auth's built-in providers and any OAuth2/OIDC platform;
  who may sign up (`invite`, an allow list, `open`) decided in one hook for every method, a live
  setting; no unverified password. Each user sees only their own conversations (`web:<user>:<chat>`,
  built from the session: another's is `404` on every route), with images, the answer live as it is
  written (a projection of `agent.observe`, only for runs that took the user's message), stop, rename
  and delete; answers through `startAnswerDelivery` into its own table. Links only under
  `PIKIT_PUBLIC_URL` or a trusted host, rate limits by the server's client address, a per-user message
  rate, a CSP. The operator invites (a link shown once, emailed with `email.send`), resets, bans and
  removes users from the dashboard's Web users view or `pikit channel-web`, and sets sign-up in
  Settings, Web chat; last seen is kept through a ban. Its page is a UI project (`src/chat/`) made of
  the dashboard's shared pieces. On Cloudflare the accounts and the users' index are one actor's.
- Email: `email-ses` (SES v2 `SendEmail` signed with SigV4 over Web Crypto, checked against AWS's
  test vectors) and `email-resend` (Resend's `POST /emails`): `email.send` on both targets, with
  variables only (no SMTP, no SDK).
- Conversations and storage: `conversations-file`, `conversations-kv`, `storage-sqlite`, `storage-do`,
  `storage-kv-sql`, `secrets-env`, `secrets-workers`, `mailbox-local`, `wakeups-timers`,
  `actors-do` (mailbox, inbox and wakeups over one alarm; a stream is one RPC whose byte
  stream beats every `streamBeatMs` while it waits, so one nobody reads closes).
- `tool-ask-user`: the `askUser` tool asks one question (confirm, select, multiselect, text, date)
  and ends the run with it as a `question` part, never waiting; a channel that draws it shows buttons
  or a form, any other its fallback text, and the answer comes back as a message.
- Tools and execution: `tool-read`, `tool-write`, `tool-edit`, `tool-bash` (Pi's own), `tool-fetch`
  and `tool-websearch-brave` (their source in the component: the references for writing a tool),
  `tool-mcp` (remote MCP servers, with a deploy-time seed); each tool's `replay` is in its own source
  and a tool on `api.env` uses `execution` (checked by `registry validate`). `execution-local` (its
  commands run the image's plain git: no built-in, no token),
  `workspace-local` (a directory per agent under `execution`'s, or per channel of each agent with
  `per: "channel"`, with its variables and shell), `agents-folders` (each agent a folder of
  `src/agents/`, with its `SYSTEM.md`, channel texts and skills, and the skills catalog in `src/skills/`:
  `pikit agents` writes `src/extensions/agents.ts`, doctor fails while it is out of date),
  `execution-do` (files in the object's SQL, a shell without processes, `git`, `node` in QuickJS;
  pi-durable 1.0.3's environment: positional and directory readers, argv `exec`, no `watch`).
- Health: `health-registry` (server and durable): a degraded component, or a non-essential one down,
  makes the App `degraded`; an essential one (`essential` in config) down for `graceMs` (30 s) makes it
  `down`; a down verdict a restart did not fix doubles the grace (up to `maxGraceMs`, kept in
  `storage.kv`), which starts over after a calm period. Mark essential only what a restart can fix. It brings the dashboard's Health view (`view/`, the reference component with a view) and its
  route. `channel-telegram`'s bots report their polling: `degraded` after a failed `getUpdates`,
  `down` after 5 in a row.
- Self-improvement's gate, over `proposals`: `admin-proposals` (server and durable; on Cloudflare in
  both Apps), target-agnostic: the dashboard's Proposals view (state, checks, deploy; a page per
  proposal with its description, diff, checks and deploy; Approve at the head the operator read, Reject
  with a comment) and Settings → Self-improvement (each part the provider checks, the last deploy and
  rollback). `proposals-github` (durable): a pushed `pikit/self/*` branch's pull request opened for
  it, squash-merged or closed through GitHub's API, GitHub only through `repo.github`; failing, pending or
  missing checks refuse Approve unless overridden; it installs the project's CI,
  `.github/workflows/pikit-checks.yml` (typecheck, `bun test`, the Worker's dry-run bundle).
  `proposals-local` (server, nothing to set up): branches of a bare repository in the state volume,
  approvals recorded for deployment-docker's deployer. `pikit doctor` no longer calls a component
  whose only use is its routes unused on Cloudflare, where the Worker's host serves them.
- GitHub on Cloudflare: `repo-github-app` (durable; both Apps, its connection in one object): the
  dashboard's Settings → GitHub creates a GitHub App in the operator's account from a manifest
  (private, no webhook; contents and pull requests write, checks and statuses read) and installs it on
  the bot's repository, two clicks, no token pasted anywhere. The callback's `state` is single-use,
  expires in 15 minutes and is bound to the operator and the browser that started it; the App's
  private key and secrets are sealed (AES-GCM, a key derived from `PIKIT_ADMIN_TOKEN` by HKDF:
  changing that token means connecting again); installation tokens for the repository alone are
  minted with an RS256 JWT (Web Crypto, GitHub's PKCS#1 key wrapped as PKCS#8) and kept until shortly
  before they expire. `repo-github-token` (server and durable) provides the same `repo.github` from a
  `GITHUB_TOKEN` secret and the repository (a setting), for CLI users. proposals-github uses only the
  contract. execution-do's `git` knows no provider: it pushes only to `proposals.remote()`, under its
  `branchPrefix`, with its `authorization()` (sent to no other remote), which rejects, saying why,
  when the credential cannot be had. extension-pikit-self tells the steward how to propose from
  `proposals.remote()`: the same steps on every target (clone, `git checkout -b pikit/self/<topic>`,
  commit, `git push origin pikit/self/<topic>`).
- execution-do's `git` behaves as real git for its subset: `clone`, `checkout -b` / `checkout`,
  `status`, `diff` (`--staged`), `add`, `commit -m` (what was added; `-a`), `log` (real git's
  format, the whole message; `--oneline`), `push origin <branch>`; anything else is not supported here. No pull request command: a pushed
  `pikit/self/*` branch is the proposal.
- `outbound-durable` implements `pending` (50 per page, at most 500); a piece cut by a crash records
  why it is sent again.
- Serving and operating: `server-bun` (`/health` answers `{ status }`, 503 when `health` says `down`; `/ready`;
  a request body up to 32 MiB by default, `maxRequestBodyBytes`, above the largest message the chat page
  or the dashboard sends: 4 images of 5 MB), `admin-auth-token` (operators by a bearer
  token from `secrets`, and browser sessions: a signed, expiring HttpOnly SameSite=Strict cookie,
  `x-pikit-admin` required on unsafe methods), `admin-api` (the operator's HTTP API under
  `/admin/api/*`: the composition, config values that look like secrets redacted; conversations from
  its conversation index, newest activity first, paged, on both hosts; a transcript, live events as
  server-sent events, on Cloudflare streamed from the conversation's object as on a server, not polled; conversations of the dashboard's own (`dashboard:<uuid>`) and the operator's
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
- Memory (`features/memory.md`), the first registry-declared contract, `memory` (kind `memory-`):
  `memory-sql` (server and durable) declares and provides it, one actor per person (`memory:<person>`,
  `actor.mailbox` calls; on Cloudflare the person's Durable Object), per agent and person, idempotent
  by id, a known credential's shape refused; its suite `createMemoryConformance` (also in workerd).
  `memory-recall` (server and durable): the `memory` extension, a stable section of the person's facts
  and conversation summaries, `remember` (replay safe by call id), `forget`, `recall`.
  `memory-summaries` (server): summarizes each conversation quiet for `idleMinutes` into its person's
  memory, from the answers feed with a cursor and one wakeup, once across retries and restarts,
  credentials redacted before the model and before keeping.
- Deployment: `deployment-docker` (`up`, `down`, `restart`, `status`, `logs`; git in its image; with
  `proposals-local`, self-improvement's deployer as a second compose service started by the same
  `pikit up`, the only one with the Docker socket: it merges an approved head into `main`, runs the
  checks in containers without the socket, rebuilds and restarts the app, waits for `/health`, rolls
  back, and records each outcome; an approval on a server is the operator's decision, not a lock) and
  `deployment-cloudflare` (the Worker and one Durable Object per conversation running the project's
  two Apps; `up` waits for the new version on `/health`, then runs `afterDeploy` hooks, C8; while an
  object's App cannot start, a guard alarm wakes it again, from 30 s doubling up to 1 h, past
  Cloudflare's 6 retries). Its `wrangler.jsonc`'s `build.command` builds every UI project (the
  dashboard, a component's) before every bundle, whoever runs wrangler: a failed build stops the deploy;
  `wrangler dev` watches the Worker's sources and the modules those builds write, never `src/`.
  `deployment-docker` also adds the Compose file a component declares (`compose`) after its own, and
  runs `afterDeploy` hooks once the containers are healthy, with `PIKIT_PUBLIC_URL`.
- Expose: `expose-cloudflare-tunnel` gives a server project a public HTTPS URL (features/completed/expose.md):
  `pikit expose` makes a remotely managed Cloudflare Tunnel, its routes (only the listed paths and
  `/health`; anything else is Cloudflare's 404) and its DNS record on your domain, and `pikit up` runs
  `cloudflared` beside the app; `status`, `quick` (a temporary tunnel for `pikit dev`) and `delete`.
  Its step of `pikit configure` asks the hostname and the paths (proposing the installed channels'
  `http.route` paths, never the dashboard's) and offers to create the tunnel at once, so `pikit add`
  then `pikit configure` leave it ready for `pikit up`.
  The Cloudflare API token is never stored (`.env` reaches the app), the tunnel's token is for the
  `cloudflared` service only, and a DNS record it did not make stops it.

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
- Its shadcn items split the helpers from the operator's client: `@pikit/lib-ui` (generic: `utils`,
  `format`, `theme`, `messages`, `activity`, `names`, `sounds`) and `@pikit/admin-client` (the admin API's
  client and the shell). The shared pieces (`bui`, `markdown`, `message`, `PromptBar`, `error-note`) need
  `lib-ui` only and take everything by props (a test keeps them off the admin client), so another UI
  project (channel-web's page) carries copies of them.
- `/admin/?settings=<id>` opens the Settings dialog at a component's section (repo-github-app's setup
  comes back there). The CSP lets a form post to `https://github.com` (repo-github-app's Connect).

### Presets
- `http` and `telegram` (Docker on a server; conversations on `conversations-kv` over
  `storage-kv-sql`), `telegram-cloudflare` and `cloudflare-minimal` (`--target durable`). A preset is a
  list of `pikit add`s; its `choose` questions pick a channel (`multiple`: several at once), and its
  `features` are the components `pikit new` offers to add. The starter agent's prompt says where
  it is reached, and its model is one the preset installs; on a server it does not name `bash`,
  unless self-improvement is installed (`proposals-local`: the steward runs git and the tests).
  Self-improvement is a feature group on both targets (`--with admin-proposals`): with
  `proposals-local` on a server, with `proposals-github` and `repo-github-app` on Cloudflare; it brings the
  dashboard.
  Every preset that runs an agent installs `extension-pikit-self`, and the starter agent, the
  project's steward (`steward: true`), names it. Both `http` and `telegram-cloudflare` install `tool-fetch` and
  `tool-websearch-brave` (Brave's key optional), and the starter agent names them.

### CLI (`pikit`)
- A component may ship a UI project of its own (`component.json`'s `ui`: `{ source, target: "src/<name>" }`,
  channel-web's `src/chat/`): `add` writes it as the component's files (so `upgrade` merges it) and runs
  `bun install` in it, lists it where the project's `tsc` and `bun test` skip it, and `remove` takes it
  all away; `registry validate` checks its `package.json` `build`, `bun.lock` and the module its build
  writes. Every folder of `src/` with a `package.json` is a UI project: deployment-docker's `ui` stage
  and deployment-cloudflare's `build.command` build each one; `pikit dev` builds each at start on a server
  (wrangler's build command does on Cloudflare) and again when its files change.
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
  component other than `admin-*` whose shipped files name `APP_DESCRIPTION` (K13), a component whose
  shipped files read `pikit.target` or `ctx.target`, and `setup` that declares differently on two of
  its targets (K1). Outside the kit repository its messages say
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
- Component commands: a component declares `commands` in `component.json` (`pikit agents`), `add`
  records them in `pikit.json` (one owner per name; never one of the CLI's own), and `pikit <name>
  [args…]` runs the component's `command(io)` in the project, its arguments as typed; `pikit help`
  lists them. `doctor` says a component is missing from `pikit.config.ts` only when it is an app
  component (its `index.ts` has a default export), as `add` lists it. `pikit expose` is no longer the
  CLI's ("not built yet"): it is the installed `expose-*` component's command, and `expose` is a kind.
- `compose` in `component.json`: a Compose file of the component's own, recorded in `pikit.json` and
  run beside the app by `deployment-docker`; `registry validate` checks it is the component's and that
  the component runs on a server.
- `doctor` warns when a config value looks like a secret (pointing to `secrets`), and prints the
  config redacted.
- `configure` and `up` check credentials only for the model providers the agents name, and reach
  the deployment (Docker) only when one is missing here; `dev` checks this machine's. A provider's key
  name comes from its component's manifest, and a login is offered only where pi-ai has one. A
  login introduces itself as `pikit` and names its installation by a UUID kept in `.pikit/device-id`
  (Sign in with ChatGPT needs one).
- `pikit new` on a server makes the project a git repository on `main`, everything committed (without
  git it says so and goes on).
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
  `pikit new` itself, with self-improvement dormant (`admin-proposals`, `proposals-github` and
  `repo-github-app`): GitHub is
  connected after deploying from the dashboard's Settings → GitHub, never in the button's form.

### Docs and verification
- `MANIFESTO.md`, `SPEC.md` (what must hold), `IDEA.md`, one design note per feature in `features/`,
  and the upstream proposals to Pi in `docs/upstream/`.
- `.agents/skills/pikit-component`: how an AI agent writes a component (contract, or one of its own
  with `declares`; reference; durability through contracts, `startAnswerDelivery`, actor calls; suite;
  `registry validate`, `pikit add`). `.agents/skills/pikit-extension`: agent behaviour as an
  `agent.extension` (sections, hooks, documents, tools, testing with the scripted faux model).
- `features/memory.md` describes memory as built (memory-sql, memory-recall, memory-summaries) and
  stays the worked example of a feature of its own kind: a registry-declared contract, an actor per owner.
- `bun test` (every package and component), the workerd lane (`bun run test:workerd`: the Cloudflare
  components in real Durable Objects, eviction mid-run included), and `PIKIT_E2E=1` end-to-end tests:
  a project made by `pikit new` answers a message, on a server and in workerd.
