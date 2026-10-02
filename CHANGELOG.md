# Changelog

What changed for someone who uses pikit, newest first. Components version on their own; each
line names its area.

## Unreleased

- core, cli, registry: **breaking.** The target `cloudflare` is now `durable`: a target names a
  runtime model (`server`, a long-lived process with a persistent disk; `durable`, an actor per
  conversation with its own SQLite and one alarm), and Cloudflare is `durable`'s provider. `Target` in
  `@pikit/core`, `ctx.target`, the component schema's `targets` enum and every component's `targets`
  say `durable`; component, preset and package names keep Cloudflare's (`deployment-cloudflare`,
  `telegram-cloudflare`, `@pikit/contracts/cloudflare`). A project's `pikit.json` with
  `targets: ["cloudflare"]` is read as `durable` and saved so on the next write; `pikit new --target
  cloudflare` is refused (exit 2) with `--target durable` as the hint. SPEC §4 and
  `features/deployment-targets.md` say what each target guarantees and what Modal or Vercel would add.
- pi-adapter, runtime-pi: **breaking.** The runtime moves from Pi 0.99's `AgentHarness` to
  `@earendil-works/pi-durable` 1.0 (with `chord`, `pi-ai` and `pi-mcp` 1.0, exact pins);
  `pi-agent-core` is gone. runtime-pi keeps every conversation in `storage.sql` (pi-durable's tables:
  storage-sqlite on a server, storage-do on Cloudflare) and provides `agent.conversations`. The
  adapter's main layout is the former `./durable/*` (`.`, `./tools`, `./mcp`, `./execution`, `./node`,
  `./providers/*`, `./credentials`, `./wakeups`, `./testing`…); `./sql` (Pi 0.99's session repo),
  `createPiRuntime`, `toolComponent`, `agentTool` and `bindTool` are removed: a tool is pi-durable's
  `defineTool` object.
- registry: **breaking.** `sessions-sql`, `sessions-jsonl` and the `sessions.store` capability are
  removed; the `http`, `telegram-cloudflare` and `cloudflare-minimal` presets drop them
  (`cloudflare-minimal` also drops `conversations-kv`, which now needs the runtime).
- contracts: **breaking.** `ConversationRef.sessionId` is `conversationId`;
  `ConversationReset.previousSessionId`/`newSessionId` are `previousConversationId`/`newConversationId`
  (and `Pick<ConversationRef, "conversationId">` in `agent.submissions`, `answerKey`). New capability
  `agent.conversations` (the runtime creates a conversation). channel-http's reset answers
  `{ conversationId, previousRuntimeConversationId, runtimeConversationId }`; log-events logs
  `conversationId`/`previousConversationId` instead of `session`/`previousSession`.
- conversations-file, conversations-kv: **breaking.** Existing conversations start fresh after
  upgrading: a pointer written before the switch (a Pi 0.99 session id) counts as none, and the next
  message starts a new conversation, transparently and logged once; nothing is migrated. They create
  conversations through `agent.conversations` (install runtime-pi first). conversations-file writes
  its file in version 2. A message `agent.submissions` held pending for such a conversation is settled
  aborted at start (no channel tells the user), never abandoned.
- registry, cli: **breaking.** A tool's replay is pi-durable's word: `"never"` is `"unsafe"`
  (`component.json` `replay.tools`, `registry validate`). tool-read/write/edit/bash provide
  pi-durable's own tools (`codingTool`); the runtime gives each call its environment (the
  conversation's `workspace`, else `execution`). An MCP tool's reported failure (`isError`) is an error
  result, not a throw. execution-do's environment is pi-durable's (`env.ts`), its files namespaced per
  object; provider-openrouter's `apiBase` also moves image and classifier models.
- runtime-pi: messages sent while a run goes are queued and taken together by the next run, which
  answers them all (`requestIds`, one `agent.started` for the first); before, they steered the run in
  progress. A tool's `agent.state` update applies from the run's next model request, not the next run.
  With `wakeups`, a model retry's backoff is a wakeup at its time and pi-durable is closed meanwhile
  (`suspend`), so a Durable Object can be evicted; the conformance suite's three steering cases now
  describe the batching.

- pi-adapter, cli, contracts: **breaking.** Unmodified Pi coding-agent extensions no longer run.
  The compatibility layer is gone: the `@pikit/pi-extension-shim` package and the
  `@earendil-works/pi-coding-agent` alias to it, `@pikit/pi-adapter/extensions` (the vendored
  `ExtensionAPI`, its host and Pi's example extensions), the `PiExtension`/`ExtensionAPI` exports,
  `createPiRuntime`'s and `createRuntimePi`'s `extensions` (and the adapter's `extension`) options,
  the `agent.extension` capability, `AgentDefinition.extensions`, and `pikit doctor`'s Pi-extension
  checks. `pikit new` no longer writes `src/extensions/permission-gate.ts`, an
  `@earendil-works/pi-coding-agent` dependency or a vendored shim tarball, and lists `runtimePi`
  plainly; project code importing `@earendil-works/*` is now always an S1 problem in `pikit doctor`.
  Extensions return in pi-durable's own model (`defineExtension`) when the adapter moves to it.
- contracts: **breaking.** `WORKERS_HOST` and `WorkersHost` move from `@pikit/contracts` to its new
  `@pikit/contracts/cloudflare` export (`src/cloudflare.ts`, formerly `src/workers-host.ts`); the
  neutral root no longer exports them. `deployment-cloudflare`, `platform-cloudflare`, `storage-do`,
  `execution-do`, `secrets-cloudflare`, `channel-telegram-webhook` and the workerd lane import them
  from there. A project whose copied Cloudflare components still import them from the root gets them
  back with `pikit upgrade`, or changes the import to `@pikit/contracts/cloudflare`. `withWorkersHost`
  stays in `@pikit/contracts/testing`.
- cli/registry: the capability catalogue may mark a contract `transitional` (expected to be bridged or
  deleted, with what replaces it); `pikit registry capabilities` prints it next to its stability and
  on its own line. `agent.submissions` is marked so: it goes when the adapter moves to `pi-durable`.
- docs: MCP is a completed feature (`features/completed/mcp.md`); OAuth and stdio stay open in it.

- cli/registry: declarative file operations validate the registry index and portable paths and reject symlinks below project/component roots, including sources, copied files, rollback, bases and vendor tarballs. A symlinked root itself is supported; this is not a sandbox for trusted setup code.
- cli: `add` and `upgrade` resolve offers from the project's actual composition, separately per App, not another registry's manifests for installed names. An unknown composition gets a warning and no automatic offers.
- cli/registry: installation and validation share contracts/adapter compatibility checks. A component depending on either must declare a meaningful range (`requires.contracts` / `requires.adapter`); installed adapter ranges are recorded and checked before a kit refresh.
- cli: interrupted `add`, `remove` and `upgrade` leave `.pikit-operation-unfinished`, blocking later changes until manual recovery. A failed install retains it even after file rollback because `node_modules` is not restored. Doctor checks root dependency and override snapshots in JSONC `bun.lock`; binary or missing lockfiles remain explicitly unchecked.
- cli: automatic removal never inherits the requested component's `--force`; modified or uncertain leftover providers stay with a warning and lose obsolete `installedFor` ownership.
- component/channel-http: targets are server-only until its HTTP request path is integrated into the Cloudflare Worker's App. A real server integration test checks `POST /v1/messages`, not merely health.
- components/deployment-docker, deployment-cloudflare: Docker's stop deadline keeps the process alive even after its last other handle closes; Cloudflare never publishes an App stopped by its startup deadline, and retries on the next request/event.

- presets: `cloudflare-minimal` lists `storage-kv-sql` itself instead of getting it as an offer, so a second Cloudflare provider of `storage.kv` does not leave its projects without one.
- cli: `pikit add`, `pikit upgrade` and `pikit new` say when a component could use an optional capability (durable delivery, `outbound.queue`) that several components of the registry provide, so none is installed for it, and how to choose one; before, the project went without it in silence.
- cli: `pikit upgrade` runs `git merge-file` with async `Bun.spawn`: Bun 1.4's `spawnSync` can lose a child's exit and spin forever (oven-sh/bun#34069), and an upgrade runs one merge per file you edited.
- cli: `pikit upgrade [<component>...]` takes the registry's version of installed components (all of them that changed, without names) and keeps your edits: a file you did not modify is replaced, one you modified is three-way merged from its base in `pikit-bases/` (with `git merge-file`), and a conflict is written with `<<<<<<< yours` … `>>>>>>> <component>@<version>` markers, named, and ends the command with code 1. New files are added, dropped ones deleted unless you modified them (kept, named), files you deleted are not restored. Its `.env.example` block, npm packages, hooks, kit ranges and, on Cloudflare, its place in the Worker's App follow the new version; providers it now needs are offered. `--dry-run` only says what it would do; `--force` accepts a version this CLI's kit does not satisfy, or an older one. Everything is put back if a step fails.
- cli: `pikit add` on an installed component now points to `pikit upgrade`; `--force` still reinstalls it, overwriting your edits. A reinstall now also takes out the npm packages the component added and no longer declares (when nothing else needs them), and moves those it added to the version it now declares.

- presets: `http` and `telegram` now list `storage-sqlite` themselves instead of getting it as an offer, so `pikit new --preset http|telegram` keeps producing a working project once the registry has a second server provider of `storage.sql` (such as storage-postgres). `storage-sqlite` is now one of the project's own components: removing `submissions-sql` no longer removes it.
- cli: `pikit registry validate` now checks that every preset, and every `choose` answer on each target it runs on, composes: each required capability has a provider in its App, no single-provider capability is provided twice, at least one target runs all the preset's components, and the starter agent's model names a provider the preset installs.
- cli: a preset may declare the starter agent's `model` (`<provider>/<modelId>`); without it the model is still the target's (`anthropic/…` on a server, `openrouter/…` on Cloudflare). `pikit new` refuses, before writing anything, a preset that does not install that model's provider, and names the component that provides it.
- registry: `component.json` has a generated `modelProviders`, the `model.provider` keys a component provides (`provider-anthropic`: `anthropic`, `provider-openrouter`: `openrouter`); `registry validate` reports it when it drifts from setup.
- cli: a `pikit new` that fails after writing (its `bun install`, or doctor's problems) or is stopped with Ctrl-C leaves its directory marked unfinished (`.pikit-new-unfinished`) and says to delete it and run `pikit new` again; `pikit new <dir>` on it says the same, and the guided path no longer continues it as a finished project: it offers to delete it and make it again.
- registry: `component.json`'s `requires.contracts` says which `@pikit/contracts` versions a component works with (a semver range). Every component that depends on the contracts declares it, and `registry validate` checks that it accepts this repository's contracts and that a component depending on them declares it.
- cli: `pikit add` refuses a component whose `requires.contracts` does not accept the contracts this CLI vendors. Before it replaces the project's kit, it checks every installed component's recorded core and contracts ranges (`requires` in `pikit.json`; a component with no contracts range recorded is held to the `@pikit/contracts` version it pinned). It refuses and names each component that does not accept them, unless `--force`.
- cli: a reinstall (`pikit add <name> --force`) deletes the files the installed version wrote that the new one no longer ships (and their bases), and replaces the component's `.env.example` block with the new version's variables. A dropped file you modified is kept, named, and still recorded, so `pikit remove` asks for `--force` before deleting it.
- cli: `pikit.json` records the npm packages `pikit add` actually put in `package.json` for a component (`addedDependencies`, `addedDevDependencies`), and `pikit remove` takes out only those, so a package the project already had stays.
- cli: `pikit remove` puts back everything it wrote when a step fails (a `bun install`): `pikit.config.ts`, the files, `.env.example`, `pikit.json`, the bases, `package.json` and `bun.lock`. The components installed only for the removed one are removed before the final `pikit doctor`, which reports problems without skipping that cleanup.
- cli: `pikit status` prints a deployment component's `{ lines }` status as-is, and any other result as JSON; `deployment-docker`'s and `deployment-cloudflare`'s `status()` return their `lines` (the same text as before), so the CLI holds no Docker or Cloudflare knowledge.
- cli: `registry validate` checks that a `deployment-*` component's `index.ts` exports `up`, `down`, `logs` and `status` as functions, and flags exports one letter or case away from a command the CLI calls (`restar`, `Status`).
- component/deployment-docker: a start that fails or runs past its deadline now stops the components already started within the stop deadline (10 s by default), then exits 1. A component whose stop hangs can no longer leave a container running that never serves and that Docker never restarts (SPEC K2).
- core: `setup`'s `pikit` and the handlers' `ctx` no longer carry the whole app config (`pikit.config`, `ctx.config`); a component reads only its own config, `setup`'s second argument. What it needs from another component is a capability. `AppDefinition.config` and `describe().config` are unchanged. SPEC K4 says so.
- core: `exports.test.ts` also pins `@pikit/core/testing`'s exports, so changing what component tests import from it is a recorded decision.
- contracts: the `storage.sql` test suite uses only SQL that SQLite and Postgres both accept (`BIGINT` for 64-bit integers, `BYTEA` for bytes), so a Postgres provider can pass it; `storage.ts` lists the SQL every provider accepts.
- registry: `registry validate` rejects a component that imports a server-only kit export (`@pikit/pi-adapter/node`, `@pikit/pi-adapter/testing`) unless its targets are ["server"], as for `node:*`; the package boundary check and the component check now share one list.
- contracts: `ConversationRef.key` is documented as it is: an opaque address its channel builds (`telegram:12345`, `telegram:ops:12345`, `http:<id>`) and alone parses back, with no tenant or thread part; the former `tenant:channel:conversationId[:threadId]` grammar was never what channels made.
- docs: `features/conversation-routing.md` proposes routing answers by an optional `ConversationRef.address` (`{ channel, conversationId }`, set in `admitInbound` and kept in the conversation pointer) instead of parsing keys, so a tenant or `conversation.resolve` can rewrite keys without answers being silently dropped; on Cloudflare, a changed key must still reach the Durable Object named by the resolved key (C1, C2). `features/multi-tenant-isolation.md` and `features/threads.md` no longer repeat the old key grammar.
- docs: `features/outbound-delivery.md` proposes a shared answer-delivery helper in @pikit/contracts, the outbound counterpart of `admitInbound`: what a channel supplies and what the helper owns, primitives plus per-model schedulers, where `outbound.prepare` runs (queue, direct send, HTTP), and how the Telegram channels and the planned channels adopt it. `pipeline-anchors.md` now says `outbound.prepare` runs wherever an answer leaves its channel.
- docs: `docs/architecture-audit.md`, a verified audit of the registry's composition, core, contracts and CLI, with the findings these changes address.

- component/platform-cloudflare: an alarm's slice runs its due wakeup handlers at the same time (one run per name) and keeps starting those that come due while any runs, until its deadline; before, they ran one at a time, so a Telegram chat showed "typing…" once and not again while `runtime-pi.drive` waited for the model. The README says what a slice costs in subrequests.
- component/channel-telegram-webhook: the claim code is now the bot's **password**, in words anyone understands: the secret is `TELEGRAM_[<NAME>_]PASSWORD` (8 characters at least) and the command `/login <password>`. Every reply says so: a stranger is told "This bot is private. If you have its password, send /login <password>." with their id, a login "✓ You're logged in…", a wrong one "Wrong password.". Changing the password logs out every chat that logged in with the old one (a login keeps the password's fingerprint), and each is told once how to log in again; removing it stops new logins. `pikit configure` offers to choose a password on a first setup (Enter skips). Compatibility: `TELEGRAM_[<NAME>_]CLAIM_CODE` is still read when the password is not set, with one deprecation warning at the Worker's start (renamed with the same value, the chats stay logged in), and `/claim` still works as `/login`; neither is documented. The template (`scripts/template.ts`) asks for `TELEGRAM_PASSWORD`, and its README explains the password in six steps.
- cli: a component's `doctor` hook may resolve with `{ problems, notes }`; notes are printed and fail nothing. `pikit up` skips the `doctor` hook of a component that has a `beforeDeploy`, which it runs right before the build and which checks the same, so an MCP server is reached once per deploy, not twice (`pikit doctor` and `pikit dev` still run it).
- registry: `component.json`'s `generated` names files of the component's own directory that a hook rewrites; `pikit add` records them in `pikit.json`, `pikit doctor` never lists them as modified, `pikit remove` deletes them without `--force`, and `registry validate` checks each is a non-test file of the component.
- component/tool-mcp: `seed.ts` is declared `generated` (a deployed project no longer shows it modified, and `pikit remove tool-mcp` no longer needs `--force`). `pikit doctor` gives a note when `seed.ts` does not hold what a server lists now (run `pikit up`, or commit its seed, before a deploy without the CLI), and a start whose seed lacks a server's listing logs a warning.
- component/tool-mcp: a seed of the servers' tools, bundled. Its `beforeDeploy` hook (`deploy.ts`) lists each configured server's tools from the deploying machine and writes the configured ones into `src/pikit/tool-mcp/seed.ts` (by server: its URL and each tool's name, title, description, inputSchema and annotations; never a token, a secret's name, a header or a time, so it changes only when the tools do), which `index.ts` imports. A start takes the tools from the listing kept in `storage.kv`, else from the seed (same URL, every configured tool), else from the server: a new conversation's Durable Object on Cloudflare now starts with no MCP request. Installed, `seed.ts` is empty; commit it after `pikit up`, so a build without the CLI (Workers Builds, a Deploy to Cloudflare button) bundles it. A server that cannot be reached, or lacks a tool, stops `up` before anything is deployed. Its doctor check is declared as `hooks.doctor`.
- cli: `component.json`'s `hooks` also take `beforeDeploy` (a file exporting `beforeDeploy({ config, get, write, say })`, run by the deployment's `up` before it bundles or builds; `write` writes only a file of the component's own directory, and only when its text changes) and `doctor` (above). `registry validate` checks that each declared file exports its function, and `pikit add` records every hook in `pikit.json` by project path.
- component/deployment-cloudflare: `up` runs the installed components' `beforeDeploy` hooks once logged in, before `wrangler deploy`; any problem fails `up` with all of them and nothing is deployed. `deployHooks(cwd, "beforeDeploy")` lists them. `dev` runs none.
- component/deployment-docker: `up` runs the installed components' `beforeDeploy` hooks before `docker compose up --build`, as `deployment-cloudflare` does (`beforeDeployHooks(cwd)`, `say` option); a problem builds nothing.
- spec: §3.2 says what a component asks of the CLI: `configure.ts` (found by its path), and the hooks `component.json` declares and `pikit.json` records, `doctor`, `beforeDeploy` and `afterDeploy`, which run on the machine that deploys and never in the app.
- docs: `SPEC.md`, `features/` and the adapter's `state.ts` cite what exists now: a current decision (K, C, P), a contract file or a component's README, or no number; text moved from the SPEC and ROADMAP before they were cut keeps its numbers as "the former SPEC", which `features/README.md` defines. SPEC's property table drops its Standard column (the standards lived in the removed ROADMAP). `features/kit-follow-ups.md` lists kit work that is not a feature (the pi-durable spike, `WORKERS_HOST`'s subpath, `agent.submissions` as transitional, upstream fixes, Chord).
- docs: Pi 0.99.0 in the docs: where `pi-durable` stands (submissions, durable tasks with `sleep(until)`, its registry; its first chat turn has no tools and rejects a busy conversation, and `pi-agent-core` does not depend on it yet) in `features/pi-durable-migration.md` and `submissions.ts`; `provider_stream_event` for streaming replies; pi-ai still has no audio for voice; `features/mcp.md` updated for pi-mcp and tool-mcp (phase 1 built; OAuth, stdio and cold start open).
- contracts: the doc comments' SPEC references point at the current SPEC (K3, K8, C2–C5, SPEC §3) or drop the number where nothing current specifies it.
- contracts: `json.ts` holds `JsonValue` and `isJsonObject`, shared by every contract that carries JSON (`storage.kv`, `actor.mailbox`, `agent.state`, `WORKERS_HOST`); `isJsonObject` is exported. The adapter's `agent.state` checks patches with it instead of a private copy.
- spec: C2 and C3 say what the code does: an actor registers its handler with `actor.inbox`'s `handle(type, …)` and a timer's owner with `wakeups`' `handle(name, …)`, in `start`, not as keyed capabilities (a keyed `actor.inbox` made the mailbox depend on every handler's component, a cycle on Cloudflare through `platform-cloudflare`).
- repository: the workerd lane runs `tool-mcp` and `@pikit/pi-adapter/mcp`'s transport on workerd's real `fetch`, with fake MCP servers behind its outbound service (`test/mcp-outbound.ts`): JSON and server-sent event answers, tools described at start, calls, a reported failure, a forgotten session, a secret token; it pins pi-mcp's own transport failing with "Illegal invocation". tool-mcp adds 48 KiB (11 KiB gzip) to a conversation object's bundle.
- repository: `bun run --cwd tests/workerd bundle` measures with its own `wrangler.bundle.jsonc` (the dry run failed on the suites' classes, which `src/bundle.ts` does not export); re-measured on Pi 0.99.0: 4,188 KiB, 1,005 KiB gzip with `execution-do`.
- repository: `scripts/pi-extension-drift.ts` also compares Pi's `ToolDefinition` and `ExtensionToolContext`, so new tool fields (as 0.99's `exposure` and `defaultActive`) no longer go unnoticed.
- component/tool-mcp: new. The tools of remote MCP servers for the agents that name them, each as `<server>_<tool>`, through Pi's own client (`@earendil-works/pi-mcp`): `servers` in config (`url`, the `tools` to give, an optional `secret` naming a bearer token read through `secrets`, `headers`, `timeoutMs`). Tools are provided at setup and described at start from the server's `tools/list` (or from its cache, below); a server that cannot be reached or lacks a named tool, with nothing cached, stops the app. An MCP `isError` fails the call; calls honour cancellation; a forgotten session reconnects; stop ends sessions. `replay` is `safe` only for a tool the server marks read-only. Targets `server` and `cloudflare` (Streamable HTTP only).
- adapter: `@pikit/pi-adapter/mcp`: pi-mcp 0.99.0's client core and Streamable HTTP transport (never stdio or the OAuth callback server, so a Worker bundle has no Node module), `mcpHttpTransport` (calls `fetch` unbound, which Workers require, and opens no server-to-client stream, SPEC C4), `mcpAgentTool` (a remote tool as `agent.tool`: named at setup, described at start; an MCP `isError` throws), `mcpToolName`, `mcpParameters` and `mcpToolResult`; `@pikit/pi-adapter/mcp/testing` is a fake Streamable HTTP MCP server as a fetch handler.
- adapter: Pi extensions' tools follow Pi 0.99's `exposure`: direct and model-only tools are active once registered unless `defaultActive: false`; codemode and deferred ones reach the model only if an extension activates them (pikit has neither codemode nor tool search); hidden ones are never given to the harness. `setActiveTools` ignores unknown and hidden names, as Pi does; registering a name again replaces the tool; `getAllTools` reports exposure, namespace and annotations; `outputSchema` reaches the harness; `prepareLoadout` is ignored with a warning. A tool's `ctx` is an `ExtensionToolContext`: `tools` is empty and `executeTool` resolves to an `isError` outcome (pikit runs no nested calls).
- adapter: Pi 0.99's new `pi.*` members load as no-ops with a warning: `registerMcpServer` (pikit connects MCP servers with tool-mcp), `unregisterMcpServer`, `registerVirtualModel`, `unregisterVirtualModel`, `unregisterProvider`, and `getSettings` (an empty object); `getMcpServers` and `getCommands` answer `[]`. Before, calling any of them failed the extension's load and the app's start. `pikit doctor` lists the inert ones.
- adapter: a `pi-gaps` case pins that Pi's `AgentHarness` records a tool result with `isError: true` as a success (only the agent loop honours it), so a tool fails by throwing, as `ToolDefinition.execute` now documents; `toolComponent`'s migration note matches `pi-durable` 0.99.0's `ToolRegistration`.
- adapter: on Pi 0.99.0 (`@earendil-works/pi-agent-core` and `pi-ai`, from 0.87.1). The Pi facts and gaps the adapter asserts outside its extension host hold on it unchanged (the extension host is in the entries above); the object bundle grows 0.9 KiB gzip.
- component/tool-mcp: strict at deploy, tolerant at run time. With `storage.kv` installed, what each server's `tools/list` said about the configured tools is cached (namespace `tool-mcp`): a start that finds every tool cached makes no request, a server that is down fails only its calls, and each new connection refreshes the tools and the cache; a tool the server stops listing fails its calls and is logged. Without `storage.kv`, as before. On Cloudflare `storage.kv` is per conversation object, so a new conversation's first start still reaches every server (`features/mcp.md`). Its config schema carries an example, and it has a `doctor.ts` check: `pikit up` and `pikit dev` refuse when a configured server cannot be reached or lacks a configured tool (token read from `.env`, never printed).
- cli: a component may declare its own check of `pikit doctor`, `"hooks": { "doctor": "doctor.ts" }` in `component.json` (a file exporting `doctor({ config, get })` that resolves with its problems); `pikit doctor` runs the checks `pikit.json` records in a child process, and `up` and `dev` refuse on what they report. A project with none starts no process; `add`, `remove` and `new` skip these checks.
- registry: `registry generate` also describes a component from its root config schema's `examples`: `setup` runs with the default config and with each example, and `provides`, `requires` and `optional` are their union (tool-mcp now provides `agent.tool`). `replay.tools` keeps the default config's tools only (`pikit new` copies them into the starter agent). An example that is not a valid config fails generate and validate.
- adapter: Pi extensions' tools honour `executionMode: "sequential"`: such a call waits for the calls started before it and holds the ones after it (Pi's `AgentHarness` ignores a per-tool mode, pinned in `pi-gaps`). A tool registered after the extensions loaded is ignored with a warning, as before but no longer silently. `features/codemode.md` records what the extension host leaves for a codemode feature (`constrainedSampling`, codemode and deferred exposure, tool search, nested calls, `structuredContent`).
- repository: `bun scripts/template.ts telegram-cloudflare <dir>` makes the Deploy to Cloudflare template from pikit's own `pikit new --target cloudflare --preset telegram-cloudflare`: `wrangler.jsonc` names the Worker (`pikit-telegram-bot`), `.dev.vars.example` and `package.json`'s `cloudflare.bindings` ask for and describe `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CLAIM_CODE`, `OPENROUTER_API_KEY` and `BRAVE_API_KEY`, the `deploy` script registers the webhook after `wrangler deploy`, npm's `package-lock.json` replaces `bun.lock`, and its README has the button, the five steps after deploying, the costs and the security notes. Deterministic and idempotent; `PIKIT_E2E=1 bun test scripts/template.test.ts` checks it as Workers Builds takes it (`npm ci`, the bundle, the bot in workerd). `.github/workflows/template.yml` can push it to its repository from main, and is off until `PIKIT_TEMPLATE_REPO` and `PIKIT_TEMPLATE_TOKEN` are set (`templates/README.md`).
- component/deployment-cloudflare: a `name` in `wrangler.jsonc` (a Deploy to Cloudflare template's, which Workers Builds deploys under) names the Worker for `up`, `down`, `logs`, `status` and `dev` instead of `package.json`'s, so `pikit up` from a clone deploys the same Worker. pikit's own `wrangler.jsonc` still names none.
- registry: `component.json` may declare `devDependencies`, npm packages the project needs besides what its files import (a tool the component runs), each pinned to an exact version. `pikit add` puts them in the project's `package.json` devDependencies (reported, and put back with the rest when the install fails), `pikit remove` takes out those no other installed component declares and no project file imports, and `pikit.json` records them. `registry validate` refuses one that is also in `dependencies`, and a kit package.
- component/deployment-cloudflare: declares `wrangler` 4.143.0 in `devDependencies`, so `pikit add deployment-cloudflare` brings it to any project and `pikit remove` takes it away. `pikit new --target cloudflare` no longer adds wrangler itself: the CLI knows nothing of it.
- installer: Cloudflare in one line, `curl -fsSL …/installer/install.sh | sh -s -- --cloudflare` (or `PIKIT_CLOUDFLARE=1`): Docker is neither checked nor offered, Node.js >= 22 (what wrangler runs on) is checked instead, and it hands over to `pikit new --target cloudflare --preset telegram-cloudflare`, which asks the name, then `pikit configure`'s questions, then runs `pikit up`. The installer's README and deployment-cloudflare's have "Cloudflare in one line": the commands, what each step asks, and what it costs (the Workers Free plan is enough; the model's tokens are what you pay).
- cli: the guided `pikit new` asks "Where should it run?" (a server, or Cloudflare) when the registry has presets for both, offers the presets that have a channel, and takes `--target`, `--preset` and `--with` as answers to its questions; its "Start it?" says what `pikit up` does on the project's target.
- component/deployment-cloudflare: `up`, `down`, `logs` and `status` check the Cloudflare login first (`login()`: a `CLOUDFLARE_API_TOKEN`, exported or in `.env`, else `wrangler whoami`); at a terminal they offer `wrangler login` and continue, without one they say what to do (`bunx wrangler login`, or a token from the "Edit Cloudflare Workers" template). A first deploy on an account without a `workers.dev` subdomain fails saying how to choose one, and a wrangler without Node.js says so.
- component/channel-telegram-webhook: the Worker registers its own webhook, for a deploy with no `pikit up` (a Deploy to Cloudflare button, Workers Builds): on Cloudflare, when its App starts (once per isolate, on its first request, `/health` included) it asks `getWebhookInfo` and calls `setWebhook` only when Telegram has another URL or other updates (HTTPS origins only; a failure is logged, never a failed start); `GET /telegram/setup` always sets every bot's webhook at the Worker's origin with its own secret and answers what it did as JSON (`502` when Telegram refused). No auth: it can only point the bot at this Worker, with this Worker's secret.
- component/channel-telegram-webhook: `setup-webhook.mjs`, a dependency-free script for a build's deploy command (`wrangler deploy | node src/pikit/channel-telegram-webhook/setup-webhook.mjs`, or given the URL): it waits until `/health` answers the version deployed, then calls `GET /telegram/setup`, prints one line per bot and exits 1 on a failure. It needs no secret.
- component/channel-telegram-webhook: `/claim <code>`: with `TELEGRAM_[<NAME>_]CLAIM_CODE` set (8 characters at least), a private chat that sends it may talk to the bot, kept in the chat's object (`storage.kv`) across restarts. Compared in constant time; 5 wrong codes in a row make the chat wait 15 minutes. When a claim code is set or nobody is listed, the Worker hands strangers' updates to their chat's object (`telegram.stranger`), which tells them their id and, only with a claim code, `/claim`. Removing the code closes new claims and keeps the chats that claimed (while nobody is listed); changing it revokes them. `TELEGRAM_ALLOWED_USERS` works as before and may now be empty: the Worker starts, and says only chats that claimed can talk. `/claim` from an allowed chat is answered by the channel and never reaches the agent.
- component/channel-telegram-webhook: `pikit configure` checks a `TELEGRAM_CLAIM_CODE` it finds and saves it to `.env` (so `pikit up` uploads it); it never asks for one.
- contracts: `WorkersHost.origin`: in the Worker's App, the origin of the request that started it, where the Worker is reached.
- component/deployment-cloudflare: the Worker's App starts with `WORKERS_HOST` `{ env, origin }`, from its first request (`/health` included).
- repository: `e2e-telegram-cloudflare.test.ts` also runs the bot as a Deploy to Cloudflare button leaves it (nobody listed, a claim code): `setup-webhook.mjs` has the Worker in workerd register its webhook, and the owner claims the bot with `/claim` and is answered.
- repository: `e2e-telegram-cloudflare.test.ts` (`PIKIT_E2E=1`) makes the bot from the preset, configures it without and with a terminal against a fake Telegram, bundles it, and runs it in workerd (`wrangler dev`): `up`'s after-deploy hook sets the webhook, and a signed update posted to `/telegram` is answered at the fake's `sendMessage` through the mailbox, the chat's object, its inbox, the runtime in the object's alarm, and delivery, with a fake OpenRouter as the model.
- preset/telegram-cloudflare: new. `pikit new my-bot --target cloudflare --preset telegram-cloudflare`: a Telegram bot on Cloudflare, `pikit configure`, `pikit up`. secrets-cloudflare and platform-cloudflare in both Apps, channel-telegram-webhook's Worker half in the Worker's, and in each chat's Durable Object storage-do, storage-kv-sql, submissions-sql, sessions-sql, conversations-kv, provider-openrouter, runtime-pi, router-basic, the channel (with outbound-durable, offered), execution-do and tool-read, -write, -edit, -bash, -fetch and -websearch-brave; deployment-cloudflare runs it. The starter agent names every installed tool. deployment-cloudflare's README has "Your Telegram bot on Cloudflare": new, configure, up, and what `up` does.
- cli: `pikit new --target cloudflare` starts the agent on `openrouter/z-ai/glm-5.3-flash` (provider-anthropic is server-only); on a server it stays `anthropic/claude-sonnet-4-6`.
- cli: `pikit new --preset <p>` without `--target`, for a preset that runs on another target, is still refused, and now says the command that makes it (`pikit new <dir> --target cloudflare --preset <p>`).
- cli: `pikit configure` offers a model login only where a `model.credentials` component can keep it: on Cloudflare it asks for the API key instead of offering a login that fails.
- component/tool-websearch-brave: `BRAVE_API_KEY` is optional, as the app already started without it (`pikit doctor` no longer fails without it), and a `pikit configure` step asks for it in a terminal, where Enter skips.
- component/provider-openrouter: `apiBase` in config (OpenRouter's API by default) moves every model under a proxy or a test double; `fake-openrouter.test-support.ts` is a local OpenRouter for tests.
- component/deployment-cloudflare: `wrangler.jsonc` bundles execution-do's QuickJS (`@jitl/quickjs-wasmfile-release-sync/wasm`, a package export without `.wasm`), so a project with execution-do builds under `wrangler dev` and `deploy`.
- component/platform-cloudflare: new. `actor.mailbox`, `actor.inbox` and `wakeups` on Cloudflare, in both Apps: from the Worker, `send` is an RPC to the conversation's object (`env.CONVERSATION`, configurable; its `actor.inbox` and `wakeups` throw, saying they belong in the object); in the object, `deliver` calls the handler registered with `actor.inbox` for the type, `actor.mailbox` sends to its own key locally and to others by RPC, and `wakeups` are rows in `platform_cloudflare_wakeups` over the object's one alarm, run one at a time in slices (`sliceMs`, 60 s by default) with backoff rows. Target `cloudflare`; new kind `platform`. A slice leaves no timer longer than a second behind (a pending timer keeps an object from being evicted). Both suites also run in the workerd lane, by RPC and alarm to deployment-cloudflare's real `Conversation` class.
- component/runtime-pi: targets `cloudflare` too: in workerd, in a real Durable Object with sessions on `sessions-sql` over `storage-do`, a message sent from the Worker by RPC is answered by a run driven in `platform-cloudflare`'s alarm.
- docs: `sessions-sql` is transitional: when the adapter moves to Pi's durable runtime (`pi-durable`), sessions become its storage and `sessions-sql` goes (SPEC C5, `features/pi-durable-migration.md`). On Cloudflare they will sit on the object's SQL directly, since `pi-durable`'s SQLite core needs a synchronous database and `storage.sql` is asynchronous.
- registry: `component.json`'s `apps.worker` may be `"default"`: the component itself goes in both Apps of a Cloudflare project, under its own name and config key in each (SPEC C1). When it names a Worker half, `registry generate` writes what each half declares in `halves` (`default`, `worker`), and `registry validate` checks it and that the half is the component `<name>-worker`, its config key in `workerConfig`.
- cli: on Cloudflare, `pikit add` lists a component's Worker half in `export const worker` too (`import channelTelegramWebhook, { worker as channelTelegramWebhookWorker }`), or the component itself in both lists when `apps.worker` is `"default"`; what each half requires is warned about and offered in its own App; `pikit remove` takes its entries out of every list and its keys out of `config` and `workerConfig`, and refuses when something in either App requires what only it provides; `pikit doctor` prints the Worker's App too. Server projects are unchanged.
- registry: `component.json` may name an after-deploy hook, `"hooks": { "afterDeploy": "deploy.ts" }` (a file of the component exporting `afterDeploy({ url, config, get, say })` that resolves with its problems); `registry validate` checks the file exports it, and `pikit add` records it in `pikit.json` by project path.
- component/deployment-cloudflare: `up` runs the installed components' `afterDeploy` hooks once `/health` answers the new version (C8), with the deployed URL, each component's config and a reader of the environment and `.env`; it prints what they say and fails with all their problems, leaving the version deployed. `deployHooks(cwd)` lists them.
- component/channel-telegram-webhook: `component.json` names `deploy.ts` as its after-deploy hook, so `pikit up` registers each bot's webhook once the new version answers; `pikit add` puts each half in its App.
- component/secrets-cloudflare: `apps.worker` is `"default"`: `pikit add` lists it in both Apps.
- component/platform-cloudflare: `apps.worker` is `"default"`: `pikit add` lists it in both Apps (the mailbox in the Worker's; `wakeups`, `actor.inbox` and the mailbox in the object's).
- component/runtime-pi: uses `wakeups` when installed (SPEC C4): every run is driven inside the wakeup handler `runtime-pi.drive`, asked for by a dispatch or resume that leaves a run going, by start with `agent.submissions` (instead of resuming in the background) and by Pi's retry backoff; each run of it resumes what is due or pending, waits for the App's runs until its slice ends, and asks again at once while runs remain. Without `wakeups`, nothing changes. Its README has a Cloudflare section.
- adapter: `createPiRuntime({ retryAt })` continues a run past Pi's retry backoff from outside the process (the run stops being driven at the wait, and is resumed at or after `notBefore`) instead of a timer; `runtime.holds(conversation)` and `runtime.whenIdle(ctx)` tell a host whether this worker still drives runs, for one that must wait for them inside an event.
- cli: `pikit new <dir> --target cloudflare` records `targets: ["cloudflare"]` in `pikit.json` (components and offered providers are then those that run there), writes a two-App `pikit.config.ts` (the default export for each conversation's Durable Object, `export const worker` for the Worker, SPEC C1), and `.wrangler/`/`.dev.vars*` in `.gitignore`. `pikit add`/`remove` edit the default export's list in a file with several Apps; `pikit doctor` also composes `export const worker`; `pikit dev` runs the deployment's own `dev` when it exports one (`wrangler dev`); `pikit status` prints Cloudflare deployments; the guided `pikit new` offers only presets that run on a server. The server path is unchanged.
- preset/cloudflare-minimal: new. `pikit new <dir> --target cloudflare --preset cloudflare-minimal`: `storage-do`, `sessions-sql`, `conversations-kv` (with `storage-kv-sql`) and `deployment-cloudflare`; no channel or runtime yet.
- component/deployment-cloudflare: new. Runs a project on Cloudflare: `wrangler.jsonc` (one SQLite-backed `Conversation` Durable Object class, `nodejs_compat`, `version_metadata`, `.md`/`.wasm` rules) and an entrypoint that composes `pikit.config.ts`'s default export in each object (lazily, inside `blockConcurrencyWhile`, 20 s start and 5 s rollback deadlines, a failed start rethrown so the object resets) and `export const worker` in the Worker (its `http.route`s served), with `WORKERS_HOST` on each start context; `alarm()` and the RPC `deliver()` call the handlers registered with `onAlarm`/`onDeliver`; public `GET /health` answers `{ ok, version }`. Commands: `up` (`wrangler deploy --secrets-file` with `.env`'s secrets but `CLOUDFLARE_*`, then waits until `/health` answers the new version, rolling back one that answers its App does not start), `down` (`wrangler delete`, only at a terminal), `logs`, `status`, `dev`. Target `cloudflare`.
- repository: `wrangler` 4.143.0 in the root devDependencies (the version the workerd lane pins), for `deployment-cloudflare`'s bundle test, and the one it declares for projects; the workerd lane runs `deployment-cloudflare`'s entrypoint on real Durable Objects.
- registry: a deployment component's `commands.ts` runs on the machine that deploys (the CLI loads it), so `registry validate` lets it import `node:*` whatever the component's targets, as it does tests; every other file stays held to them (S5).
- component/channel-telegram-webhook: its object half registers `telegram.update` with `actor.inbox`'s `handle` in its start: `actor.inbox` moves from its `provides` to its `requires`. It starts in one object App with `platform-cloudflare` and `runtime-pi`, and answers an update there.
- component/channel-telegram-webhook: new. Telegram by webhook for Cloudflare (SPEC §4.1, C6), in two halves: the Worker's (the export `worker`: `POST /telegram` and `/telegram/<name>`, the webhook's secret checked in constant time, private text messages from allowed users only, a stranger told their id, then `actor.mailbox.send("telegram:<chat>", "telegram.update", update)`, `200` once the conversation holds it and `500` otherwise) and the object's (the `actor.inbox` handler: `/start`, `/help`, `/new`, `admitInbound`; the wakeup `channel-telegram-webhook.deliver`: answers from `agent.submissions`' feed with a cursor in `storage.kv`, pieces marked `sending`/`sent` and one found `sending` sent again with `↻ `, "typing…" while a message waits, `outbound.queue` if installed). `pikit configure` checks the token, generates `TELEGRAM_WEBHOOK_SECRET` and allows you; `deploy.ts`'s `afterDeploy({ url, config, get, say })` registers and checks each bot's webhook once a deploy answers (C8). Target `cloudflare`.
- registry: `component.json` may name a half for another App, `"apps": { "worker": "<export>" }` (SPEC §4.1, C1): the named export of `index.ts` goes in the Worker's App, the default export in the default one; `registry generate` and `validate` describe both halves, so `provides`, `requires` and `optional` cover the component as a whole, and a named export that is missing or not a component is a problem.
- repository: the workerd lane also runs Pi's session conformance on `sessions-sql` over `storage-do`
  (the Durable Object session backend passes it, SPEC §4) and `agent.runtime` on `runtime-pi` over
  those sessions, and `execution-do` with Pi's own tools on it; `bun run --cwd tests/workerd bundle`
  measures a conversation object's bundle (1,002 KiB gzip with `execution-do`, 216 KiB without).
- component/execution-do: new. `execution` and `execution.shell` in the conversation's Durable
  Object: files in its SQL (`execution_do_*` tables, 1 MB chunks), a shell without processes
  (just-bash) with `git` (isomorphic-git: clone, status, diff, commit, log, push, pr), `node` (QuickJS
  in WebAssembly, with an interrupt budget and a heap limit) and `curl`. Only `git` writes inside
  `.git`; pushes go only to `git.pushRepositories`, on `pikit/self/` branches, with a token read
  through `secrets` that never reaches the shell. Pi's `bash`, `read`, `write` and `edit` run on it
  unchanged. Target `cloudflare`; the Worker needs `nodejs_compat` and a `CompiledWasm` rule (README).
- adapter: `@pikit/pi-adapter/execution` gives an `execution` provider Pi's `ok`, `err`, `FileError`,
  `ExecutionError`, `truncateTail` and `truncateHead` without importing Pi; `@pikit/pi-adapter/testing/neutral`
  is the part of the test kit that runs in workerd too (Pi's session and execution suites, the scripted
  agent, `createRuntimeFixture` over records of your own, and `interruptInProcess`).

- cli: `pikit add` and `pikit new` also offer the provider of a capability a component requires when the catalogue marks it `offer`: `pikit add conversations-kv` offers `storage-kv-sql` (and `storage-sqlite`).
- component/conversations-kv: new. `conversations.registry` on `storage.kv` (namespace `conversations-kv`) and `sessions.store`; targets `server` and `cloudflare`. A first pointer is written with `setIfAbsent`, a reset emits `conversation.reset` once its pointer is stored, and its README says what holds when resets and resolves race across processes.
- component/tool-websearch-brave: new. The `websearch` tool on the Brave Search API; its key,
  `BRAVE_API_KEY`, is read through `secrets` and never reaches the model, and a search without it
  fails saying so. `replay: "safe"`, `apiBase` in config; targets `server` and `cloudflare`.
- component/tool-fetch: new. The `fetch` tool: one HTTP(S) request, GET by default (HEAD, POST, PUT,
  PATCH, DELETE allowed; the model is asked to confirm any but GET and HEAD with the user), 20 s,
  2 MB read, HTML as readable text with its links, JSON pretty-printed, binary refused, no
  credentials of its own; `replay: "never"`; targets `server` and `cloudflare`.
- component/provider-openrouter: new. OpenRouter's models for your agents, named
  `openrouter/<vendor>/<model>` (`openrouter/z-ai/glm-5.3-flash`), with `OPENROUTER_API_KEY` or a key
  in `model.credentials`; targets `server` and `cloudflare`. Your OpenRouter account's guardrails
  may refuse some models at their first request.
- adapter: `agentTool(tool, { replay })` in `@pikit/pi-adapter/tools`: the tool `toolComponent`
  provides, without the component, for a `defineComponent` of your own that needs config or a
  capability (a secret) and names itself (`tool-websearch-brave` provides `websearch`).
- adapter: `@pikit/pi-adapter/providers/openrouter` exposes pi-ai's OpenRouter provider by
  subpath, so a bundle carries only the providers it installs. Its module imports nothing node-only.
- component/submissions-sql: targets `cloudflare` too: unmodified, over `storage-do`, it passes its
  `agent.submissions` suite (with the feed, pruning and restarts) in workerd. On Cloudflare its
  records are the conversation object's.
- repository: the workerd lane (`bun run test:workerd`, `tests/workerd/`, a CI job): Vitest with
  `@cloudflare/vitest-plugin` runs, offline in workerd on a real SQLite-backed Durable Object, the
  `storage.sql` suite on `storage-do`, `storage.kv` on `storage-kv-sql` and `agent.submissions` (with
  its feed) on `submissions-sql` over it, and `secrets` on `secrets-cloudflare`, and typechecks them
  against Workers' runtime types.
- contracts: the agent runtime and HTTP route suites compile against Workers' runtime types too.
- component/secrets-cloudflare: new. `secrets` from the Worker's `env` (its secrets and variables;
  bindings and empty strings read `undefined`), in either App of a Cloudflare project. Target
  `cloudflare`.
- component/storage-do: new. `storage.sql` in a Durable Object's own SQLite (`ctx.storage.sql`), for
  the conversation object's App on Cloudflare; its README lists the object's SQL limits (2 MB per
  row, short `LIKE` patterns, 10 GB per object, 1 GB on Free). Target `cloudflare`.
- cli: `pikit add` and `pikit new` offer only providers that run on the project's targets, so a
  Cloudflare provider in the registry (`storage-do`) does not stop `storage-sqlite` from being
  offered on a server.
- contracts: the context key `WORKERS_HOST` (SPEC C5): on Cloudflare, each App's start context carries
  the Worker's `env` and, in a Durable Object's App, the object (its id, its storage, and hooks for
  its alarm and RPC deliveries), typed structurally. `withWorkersHost` in `@pikit/contracts/testing`
  puts it in the context of components under test.
- component/sessions-sql: new. `sessions.store` on `storage.sql` (the adapter's SQL store), so
  sessions live in the app's database on a server and in a Durable Object alike; tables
  `sessions_sql_*`, versioned and migrated at start; targets `server` and `cloudflare`. Optional
  `cwd` config.
- component/runtime-pi: its tests also run the `agent.runtime` conformance on sessions in
  `storage.sql`, including a worker killed mid-run.
- adapter: `createSqlSessionStore(db, { cwd })` in `@pikit/pi-adapter/sql` (neutral: server and
  Cloudflare): Pi sessions on `storage.sql`, a `sessions.store` with `find(id)` and `migrate()`. It
  passes Pi's session suites (repository, forks, storage) on SQLite held to a Durable Object's limits;
  a record over 256 Ki characters is stored in parts. In `@pikit/pi-adapter/testing`:
  `createPiRuntimeFixture(runtime, { sessions: "sql" })` and `killMidRun(…, "sql")` run the runtime
  and its killed workers on it, `openSqliteDatabase(path, { durableObjectLimits })` is a `storage.sql`
  for tests, and `createSessionRepoStreamingForkConformance` is Pi's fork cases the repository suite
  does not include yet.
- contracts: `actor.mailbox` and `actor.inbox` (experimental, SPEC C2): the component that handles a
  type of message registers its handler with `actor.inbox`'s `handle(type, handler)` in its `start`
  (one handler per type, dropped at stop), as `wakeups` registers its own, so it may also send, wake
  itself or use the runtime with no dependency cycle. `send(key, type, message, ctx)` resolves once
  the actor owning `key` holds the JSON message durably (its handler for `type` resolved), and
  rejects otherwise, with an error naming the type when nothing handles it. The handler gets a copy
  and a context of its own. Its conformance suite (with `wakeups: true`, an actor that also wakes
  itself) and a memory mailbox for tests are in `@pikit/contracts/testing`.
- contracts: `wakeups` (experimental, SPEC C3, C4): the component that owns the work registers a
  handler with `handle(name, handler)` in its `start` (one owner per name, dropped at stop) and asks
  with `at(name, time, ctx)`, replacing its earlier request; `cancel(name, ctx)` drops it. A request
  may come before its handler and waits for it. At least once, never early, one run per name at a
  time; a handler that rejects runs again with the provider's backoff, and its context may be
  cancelled at a slice deadline, after which it asks again. Its conformance suite (on a manual clock)
  and a memory wakeups for tests, forgetful or durable, are in `@pikit/contracts/testing`.
- component/mailbox-local: new. `actor.mailbox` and `actor.inbox` on a server: `send` calls the
  handler registered for the type in the same app with a JSON copy and resolves when it does; `stop`
  cancels the handlers still running and drops them. Targets `server`. `mailbox` is a new component kind.
- component/wakeups-timers: new. `wakeups` on a server as in-process timers on the app's clock: a
  failed handler runs again after 1 s, 5 s, 30 s, then every 60 s, logged each time; optional
  `sliceMs` cancels a running handler's context as Cloudflare would, and no timer outlives a stop by
  more than a second. Nothing is persisted: components register and ask again at start. Targets
  `server`. `wakeups` is a new component kind.
- spec: the Cloudflare target's decisions (SPEC §4.1, C1–C8): a thin Worker and an App per conversation's Durable Object, `actor.mailbox`, `wakeups`, work in slices inside events (with the limits measured on the Free plan), neutral state providers and one platform context key (`WORKERS_HOST`), `channel-telegram-webhook`, `execution-do`, and a deploy that waits for its version to answer.
- cli: `pikit doctor` notes a project file that registers tools with `pi.registerTool`: pikit runs
  them, but an extension's tools are never run again when a run resumes after a crash (`replay:
  "never"`), and a tool of your own chooses with `toolComponent`. A note, never a failure.
- docs: `toolComponent` is a bridge. When the adapter moves to Pi's durable runtime
  (`@earendil-works/pi-durable`), a tool is Pi's own object with its `replay` inside (`"safe"` /
  `"unsafe"`), `toolComponent` is deleted, and `replay` takes Pi's words. Until then: tools of your
  own with `toolComponent` (or `defineComponent` when they need a capability); Pi's `defineTool`
  only inside Pi extensions (`features/completed/tool-component.md`, `runtime-pi`'s README).
- adapter: `toolComponent(tool, { replay })` in `@pikit/pi-adapter/tools`: a tool of your own in the
  shape of Pi's `defineTool` becomes a component (`tool-<name>`) that provides `agent.tool`, so an
  agent names it in `tools`. Unlike a Pi extension's tool, it may be `replay: "safe"`, and `pikit
  doctor` lists it. Its fifth `execute` argument is the run's context (its conversation), not Pi's
  `ExtensionContext`: an object typed by Pi's `defineTool` does not compile there; write it inside
  `toolComponent`.
- contracts: `storage.kv` (experimental): small JSON values a component keeps across restarts, by
  key, in a namespace of its own (`get`, `set`, `setIfAbsent`, `delete`). Its conformance suite and a
  memory storage for tests are in `@pikit/contracts/testing`. `pikit add` offers its provider.
- component/storage-kv-sql: new. `storage.kv` on `storage.sql`, in one table
  (`storage_kv_sql_entries`); targets `server` and `cloudflare`.
- component/channel-telegram: its answers' cursor moves from its own `storage.sql` table
  (`channel_telegram_cursors`) to `storage.kv` (key `answers-cursor` of its namespace); answers come
  from the feed with `agent.submissions` and `storage.kv`. `pikit add channel-telegram` offers
  `storage-kv-sql`. The old table is not read: a project that upgrades starts its cursor at the
  feed's end, as on a first install, so an answer that ended during that one deploy is not sent.
- component/channel-telegram: an answer read from the feed that Telegram could not take, or whose
  send a stop aborted, is sent again later instead of being dropped; the cursor moves only past a
  delivered answer. Chats no longer wait for each other, a stuck answer is logged as an error, and
  every feed gap is logged. Installing it where `submissions-sql` already runs no longer resends old
  answers.
- component/channel-http: a malformed escape in a path id gets 400 instead of 500.
- adapter: a redelivered duplicate whose run's end `agent.submissions` never recorded (two crashes)
  is settled from the session. `recover` settles requests steered into another request's run and
  requests an abort withdrew (as `aborted`), never re-announces a settled request, and no longer
  waits for runs of new messages.
- component/runtime-pi: `stop` no longer waits on an `agent.submissions` whose `pending()` never
  answers.
- component/submissions-sql: `keepSettledDays` is at least 1 (0 pruned answers that ended during a
  deploy before the channels could deliver them); `migrate` reads the schema version inside each
  step's transaction, so two processes starting at once no longer both run migration 0.
- contracts: `agent.submissions`' settlement is idempotent within the provider's retention; the
  suite checks `pending`'s order by oldest pending request and re-settling after a restart.
- docs: features move out of SPEC.md into `features/`, one file each, with no order; ⭐ marks what
  makes OpenClaw or Hermes attractive.
- docs: SPEC-CORE adds a fourth required outcome, **the main agent knows and improves itself** (§6):
  a steward agent with a `pikit-self` skill and a read-only `pikit_self` tool changes its own
  project through git (a branch, `pikit doctor` and tests, a human's approval, a merge by a service
  identity it never holds, a deploy as a generation boundary, an automatic rollback), internally and
  in its dashboard, on the server and on Cloudflare (Sandbox workspace, Worker Previews, gradual
  deploys). K13: the kernel's `APP_DESCRIPTION` context key describes the running app, read only by
  the dashboard and the self-knowledge component. `ROADMAP.md` gains track S.
- samples: the http sample has the storage and submissions `runtime-pi` brings; a POST sent again
  answers with its outcome instead of `409 duplicate`.
- component/channel-http: `GET /v1/conversations/:id/messages/:messageId` returns what became of a
  message (`200` / `202` / `502` / `409 aborted`, `404` unknown), and a POST whose `messageId` is
  already in the conversation answers with its outcome, with `agent.submissions` installed. Without
  it, `GET` is `501` and a repeated POST is `409 duplicate`, as before.
- component/channel-telegram: with `agent.submissions` and `storage.sql`, answers are delivered from
  the `answers` feed with a cursor of the channel's own, so an answer that ends while the channel is
  stopped (a deploy) reaches the chat at the next start, and one the outbox could not store is tried
  again. Without them, every answer the channel cannot send is logged; before, it was dropped
  silently.
- component/runtime-pi: records in `agent.submissions` when installed, and resumes at start, in the
  background and four at a time, every conversation holding a message nobody answered. A message
  acknowledged to Telegram before a crash is answered with no new message. `pikit add runtime-pi`
  (and so `pikit new`) offers `submissions-sql`.
- adapter: with `submissions`, `createPiRuntime` records each message before `dispatch` resolves and
  each run's end before its event (retried when the record fails), and settles withdrawn messages as
  aborted. `PiRuntime.recover()` opens a conversation with pending requests and settles, from the
  result Pi stored, a run whose end was never recorded.
- component/submissions-sql: new, kind `submissions`. `agent.submissions` on `storage.sql`: pending
  requests, idempotent settlements, and the `answers` feed, kept 7 days (`keepSettledDays`). Passes
  the submissions, feed, lifecycle and convergence suites.
- contracts: `agent.submissions` (`AgentSubmissions`, `RunSettlement`, `SubmissionStatus`,
  `PendingConversation`), shaped like the submissions of Pi's durable runtime; its suite
  `createSubmissionsConformance` and its double `createMemorySubmissions`.
- docs: **`SPEC-CORE.md`**, what must hold whatever else pikit becomes, comes before every other
  document: the kernel's twelve decisions (no `Target` in the kernel, no persisted events, config as
  a plain object, a frozen `Context`, `stop()` never needed for correctness, several Apps per
  project, stability only after Node and Cloudflare prove it…), Cloudflare as a required target,
  and a required dashboard built with Beautiful UI. `ROADMAP.md` gains the required tracks K (the
  kernel is stable) and D (the service is visible). SPEC §12 no longer describes a
  `config/pikit.yaml` the CLI never read.
- cli: **`pikit.json` version 2.** The CLI's own registry is recorded as `builtin`, not as this
  machine's path, so a project cloned elsewhere keeps working; a registry inside the project is
  recorded relative to it, and any other `--registry` path draws a "not portable" warning. A version 1
  file is read and converted on the next write.
- cli: `pikit add` keeps the original of every file it installs in `pikit-bases/<sha256>` (committed
  with the project), the base M3's `upgrade` will merge from; `remove` deletes the ones nothing uses.
  The plan warns when the registry has uncommitted changes.
- cli: `pikit.json` records the commit of the kit in `vendor/`; `pikit add` refuses to replace a newer
  kit with its own older one unless `--force`. A commit the CLI's checkout does not know is only
  warned about.
- component/deployment-docker: `.dockerignore` leaves `pikit-bases/` out of the image.
- spec, adapter: pikit promises the tested tier A of Pi's extension API (tool policy, the run's
  lifecycle and notifications, tools), not every extension; the rest is best-effort or absent
  (SPEC §6.2b). `bun scripts/pi-extension-drift.ts <tag>` lists how Pi's extension API differs from
  pikit's before a bump.
- cli: `pikit doctor` fails on a Pi extension importing a name the shim does not export, and notes
  what each extension uses that pikit does not provide (events it never fires, inert `ctx.*` and
  `pi.*` members, terminal UI).
- repository: **correction.** pikit runs on Bun only; no `package.json` lists `node` in `engines`
  any more. The kit ships TypeScript source that Node does not run. Node ≥ 22 is a 1.0 requirement
  (SPEC §9.1).
- adapter: a Pi extension whose `tool_call` handler throws now blocks the call (fail closed), as Pi
  does. Before, a failing permission check let the tool run. The error goes to the log, never to the
  model.
- adapter: a message queued behind a run that fails, steered after a run's last boundary, or left
  by a worker that died between `steer` and `accept` now gets a run of its own. Before, it waited in
  Pi's inbox until the user wrote again, and a redelivery was answered `duplicate`.
- adapter: fix a deadlock when an extension calls `ctx.abort()` as a run ends; the runtime no longer
  keeps one entry per session forever.
- adapter: `close()` waits for conversations still opening, so none is left driving a run after
  shutdown; `agent.started` always precedes the run's `agent.settled` or `agent.failed`.
- contracts: the agent-runtime suite has a case for a message queued behind a failing run; its
  fixture gains `failNext()`.
- core: a failed rollback is no longer only logged. `start()` rejects with it attached (the start's
  own failure stays the message and cause), and a `stop()` that interrupted the start rejects, so
  the process exits non-zero.
- contracts: the convergence suite also kills the process the instant each commit lands, and
  injects a storage failure the process survives (fixture option `retryAfterMs`,
  `SimulatedStorageFailure`). `outbound-durable` fails the second at the write of a delivery (a
  known bug), marked `test.failing` until it is fixed.
- cli: a refused or failed `pikit add` leaves the project as it was (`package.json`, `vendor/`,
  `bun.lock`, `pikit.json`, `pikit.config.ts`). Every check and confirmation, offers included, comes
  before the first write. `pikit.config.ts` edits work in files without semicolons, in `add` and
  `remove`.
- cli: `pikit add` lists every file a component writes outside `src/pikit/<name>/` and names them in
  its confirmation. A component that would write the project's own records (`package.json`,
  `pikit.json`, `bun.lock`, `.env`, `.git/`, `vendor/`, `node_modules/`, `.pikit/`…) is refused, even
  with `--force`; `pikit registry validate` reports it.
- cli: `pikit doctor` fails, and `pikit remove` refuses without `--force`, when an agent names a
  tool, an extension or a model provider that no installed component provides.
- installer: installs a pinned Bun (1.4.2, `PIKIT_BUN_VERSION` to change it) and accepts an existing
  Bun only from 1.4.0 up to, not including, 2.0.0; `bun upgrade` is no longer run.
- samples/http: the live Anthropic test runs only with `PIKIT_LIVE=1` and a credential, so a plain
  `bun test` never calls a paid API.
- repository: CI runs `bun test`, the typecheck and `registry validate` on every pull request and
  push to main; a nightly workflow runs the installer and the e2e suites with Docker.
- component/credentials-file: a write flushes the directory after its rename, as
  `conversations-file` does. Before, a crash right after a token refresh could bring the old file
  back, with a refresh token the provider had already revoked.
- core, contracts: **breaking.** `@pikit/core` is now only the kernel: `defineApp`,
  `defineComponent`, the capability, event and pipeline machinery, the context, clock and logger.
  The vocabulary the components share moved to a new package, `@pikit/contracts`, which versions on
  its own (SPEC §4.9):
  - `defineAgent` and the agent's types, `admitInbound` and `InboundMessage`, `answerKey`,
    `AGENT_STATE`, `CONVERSATION`, and the `storage.sql`, `secrets`, `http.route`,
    `conversations.registry`, `outbound.queue` and feed contracts;
  - their conformance suites, now in `@pikit/contracts/testing`. `@pikit/core/testing` keeps
    `createLifecycleConformance` and `createManualClock`.

  To migrate a project, import those names from `@pikit/contracts` and declare it in
  `package.json`. The kernel's export list is held by a test: adding to it is a decision.
- cli: `pikit new` vendors `@pikit/contracts` with the rest of the kit. `pikit add` on a project made
  before the split adds its tarball and its override. The project's own imports still have to be
  moved by hand.
- registry: every component that imports `@pikit/contracts` lists it in `component.json`'s
  `dependencies`, with its own version; `requires.pikit` covers the kernel only.
- component/channel-http: **breaking.** `inbound.authenticate` is now `http.authenticate`, and
  `channel-http`, its only user, declares it instead of the core. A component's own names carry its
  prefix (SPEC §4.3). Its value, its stage (`channel-http-bearer`) and failing closed are unchanged.
  A project extension that adds a stage to it changes the pipeline's name.
- contracts, component/outbound-durable: `createOutboundQueueConformance(fixture, { retry })` takes
  the provider's retry policy and holds it to it. The waits and the maximum age are no longer fixed
  by the suite, so a copy of `outbound-durable` can change them and still pass. `outbound-durable`'s
  policy is unchanged.
- cli: the capability catalogue gives each capability a level (`experimental` or `stable`), shown by
  `pikit registry capabilities`. A `stable` one needs two providers in the registry. Every capability
  is `experimental` except `agent.definition`, which the project provides and which is shown so.

- core, component/outbound-durable: the convergence suite, `createConvergenceConformance` in
  `@pikit/core/testing` (SPEC §14). It kills the process after each of its commits in turn (its
  `storage.sql` refuses the next commit and everything after it), starts a new one over the same
  records, repeats the scenario as a retrying world would, and checks an invariant. Its own test shows
  a consumer reading a feed passes and one reacting to events alone fails. `outbound-durable` passes
  it: after a crash at any of its commits, every piece is delivered in order with one receipt, and
  every repeated send is marked a possible duplicate.
- core, component/outbound-durable: delivery receipts. `OutboundQueue.receipts` is a feed of
  `DeliveryReceipt`s: one per piece that settled, delivered (with the platform's message id) or
  abandoned (with its reason), in the order they settled (SPEC §5). `outbound-durable` writes each in
  the same transaction as the piece's state (`outbound_receipts`), prunes them with their pieces, and
  now versions its tables (`outbound_meta`): an existing database gains the receipts table, and one
  written by a newer outbox is refused at start. The queue suite checks receipts, and runs the feed
  suite over them.
- core, component/channel-telegram: `answerKey(conversation, requestId)`, the one formula for a run's
  answer key (`${sessionId}:${requestId}`, SPEC §5). The channel enqueues answers under it; a tool finds
  its run's answer with `answerKey(context.value(CONVERSATION), invocation.operationId)`. Keys are
  unchanged.
- core: feeds (SPEC §4.8), for what must not be missed. `Feed<T>`, `FeedPage` and `FeedItem`: facts a
  component records in the same commit as the change they describe, read by others in commit order
  after a cursor of their own, with `gap` when facts were pruned before they were read. Events stay
  notices. `@pikit/core/testing` has the suite, `createFeedConformance`, and the in-memory double,
  `createMemoryFeed`.
- cli, registry: offered providers. A component brings the providers of what it can use when the
  catalogue marks the capability `offer` (today `outbound.queue`): `pikit add channel-telegram` offers
  `outbound-durable` and the `storage-sqlite` it needs, `pikit new` installs them, and `pikit remove`
  takes them away with it when nothing else uses them (`installedFor` in `pikit.json`). `pikit doctor`
  notes a component nothing uses. The base preset no longer installs a queue an HTTP project never uses.
- samples: scenario 8, many agents (`samples/http/test/scenario-8.test.ts`): `router-rules`, extensions
  named per agent and `workspace-local` together, with Pi's real `bash`; and the same project without
  `router-rules`.
- cli: `pikit add` brings a project made by an older checkout onto this CLI's kit (`@pikit/core`,
  `@pikit/pi-adapter`, the shim): vendored tarballs are named with a hash of their files, and a
  project on other ones gets new tarballs, `package.json` rewritten and `bun install`. Adding a
  component that needs a newer core used to fail with "Export named … not found".
- component/channel-telegram: several bots in one project. `accounts: ["ops"]` adds the bot
  `telegram:ops` (`TELEGRAM_OPS_BOT_TOKEN`, `TELEGRAM_OPS_ALLOWED_USERS`), with its own users,
  conversations (`telegram:ops:<chat>`) and transport; `router-rules` can give it its own agent.
  `pikit configure` sets up each bot. The default bot and its keys are unchanged.
- component/workspace-local: each agent's tools work in a directory of their own, `<root>/<agent>/`
  (default root `.pikit/workspaces`), created on the agent's first call; commands start from an
  allowlist of variables, as with `execution-local`. An agent name that could leave the root is
  refused. Order, not isolation: `bash` can still `cd ..` and read `.pikit/credentials.json`
  (SPEC §8.2). Not in any preset.
- component/tool-read, tool-write, tool-edit, tool-bash: in a run, they work in the agent's
  `workspace` when one is installed (`useOptional("workspace")`); without one, or outside a run, on
  `execution` / `execution.shell` as before.
- adapter: the `workspace` capability (`WorkspaceProvider`, `Workspace { env }`; `ref`, `checkpoint`
  and `release` stay planned) and its suite, `createWorkspaceConformance`. `bindTool`'s `env` is now
  `(context) => ExecutionEnv | Promise<ExecutionEnv>`, asked on every call with the call's context.
  Every run's context carries its conversation.
- core: the context key `CONVERSATION`: the runtime puts the run's `ConversationRef` in every run's
  context, and tools read it with `context.value(CONVERSATION)` (SPEC §6.3).
- component/channel-telegram: answers go through `outbound.queue` when it is installed: the channel
  attaches its transport (`transport.ts`: HTML or plain text, failures classified for the queue) and
  enqueues each answer once per run. A piece sent again after a crash starts with `↻ `. Without a
  queue it sends directly, as before.
- component/outbound-durable: every answer is stored before it is sent (`outbound.queue` on
  `storage.sql`), then delivered in order per conversation. Transient failures are retried after 5 s,
  30 s, 2 min and 10 min and abandoned at the fifth; rate limits wait what the platform asked; permanent
  failures and anything older than 24 hours are abandoned. A send the process died during is sent
  again as a possible duplicate. A test kills a process with SIGKILL mid-send (SPEC §5).
- core: the outbound contracts (`OutboundMessage`, `ChannelTransport`, `DeliveryError`,
  `outbound.queue`, the `outbound.delivered` / `outbound.abandoned` events), their conformance suite, and
  `createManualClock` for tests of components that wait.
- registry: the `outbound` kind, and `*.test-support.ts` for a component's shared test fakes and
  fixtures (held like tests for S5, never imported by a shipped file).
- core, component/storage-sqlite: the `storage.sql` contract, an async `SqlDatabase` (`query`, `run`,
  `transaction`), and its conformance suite (`createSqlDatabaseConformance`). `storage-sqlite`
  provides it in one SQLite file (`.pikit/pikit.db`) through `node:sqlite`, in WAL mode, one statement
  at a time (SPEC §4.5, §16).
- component/router-rules: routes each conversation to an agent by an ordered list of rules in
  config, matching the channel (an instance, or a kind for all its accounts), the conversation and
  the sender; a rule can also deny. What no rule matches goes to `router-basic`'s `defaultAgent`, and
  removing it sends everything there. It refuses to start when a rule names an unknown agent.
- core, adapter, component/runtime-pi: an agent names the Pi extensions it uses,
  `defineAgent({ extensions: ["permission-gate"] })`, and a component provides each one under the keyed
  capability `agent.extension` (SPEC §6.2b). A conversation loads the extensions given to
  `createRuntimePi({ extensions })` for every agent, then the ones its agent names, each factory once;
  a name nothing provides fails the conversation's open, and `runtime-pi` refuses to start with it.
- core: `admitInbound` runs the inbound path every channel takes (`inbound.normalize`,
  `route.resolve`, the conversation, `dispatch`) and returns what happened (`admitted`, `duplicate`,
  `halted`, `denied`, `no_route`); a stage that changes which message or conversation it is now
  fails the path in every channel. `@pikit/core/testing` adds `createChannelConformance`, which
  `channel-http` and `channel-telegram` pass.
- component/channel-telegram: a message a stage stops (a policy in `inbound.normalize`, a rule in
  `route.resolve`) is answered "I can't take that message." instead of nothing, and a stage that
  moves a message to another conversation no longer gets it dispatched to the original one.
- component/channel-http: runs the inbound path through `admitInbound`; its responses are unchanged.
- repo: the packages' import boundaries are checked on every `bun test` (`scripts/boundaries.test.ts`):
  core and every package export not marked server-only run on every target (no `node:*`, `bun:*`,
  `cloudflare:*` or Pi's Node subpath, through everything they import), only the adapter imports
  Pi, and a package imports only what its `package.json` declares.
- registry: `registry validate` no longer mistakes a method named `require` (`capabilities.require("x")`)
  for an import.
- adapter, component/sessions-jsonl: a message to an idle conversation no longer reads every
  session file. The runtime opens a conversation's session with the store's new `find(id)`, which
  `sessions-jsonl` answers from an index (one listing after a restart, then about 0.02 ms instead
  of 350 ms at 5,000 sessions). A store without `find` is listed, as before.
- cli, registry: presets ask, instead of multiplying. A base preset lists its components and may
  `choose` one per kind: `pikit new` asks "Where do you want to talk to your agent?" and offers every
  `channel-*` component in the registry that runs on the new project, by the new `title` in its
  `component.json`; a new channel shows up there without editing any preset. `--with <component>`
  answers in a script (`pikit new my-bot --preset http --with channel-telegram`), and the guided
  path prints that command. `telegram` is now an alias (`extends: http`, `with: [channel-telegram]`),
  so `--preset telegram` works as before. `pikit new` checks every component against the project's
  target before writing anything.
- registry: `component.json` and presets have JSON Schemas (`registry/schema/`), generated from the
  CLI's own definitions. Every `component.json` names its schema in `$schema` and each preset in a
  `yaml-language-server` comment, so editors complete and check them. `registry validate` checks both
  against them, and now rejects fields it does not know (a typo was silently ignored);
  `pikit add` checks a component's manifest before installing it.
- cli: `pikit registry capabilities` prints each capability (single or keyed, who defines its
  contract, what it is) and the components that provide and use it. A capability defined without an
  entry in the catalogue fails the type check, and `registry validate` rejects a component that uses
  one.

- cli: the guided path and `pikit configure` look like a modern installer (`@clack/prompts`): menus
  you move through with the arrow keys, yes/no questions, text with a default, a spinner while the
  project is created, and every line on one rail. A secret shows one ▪ per character. Components'
  `configure` steps get `choose` and `confirm`; `channel-telegram` asks "Allow them?" as a yes/no.
- component/channel-telegram: pasting the bot token no longer ends the setup with `getMe: 404`. The
  token is taken out of whatever is pasted (BotFather's whole message, quotes, spaces), something
  that is not a token is asked again without calling Telegram, and a 404 (a malformed token) is asked
  again like a 401. The fake Bot API answers 404 to a malformed token, as Telegram does.
- cli: a secret prompt drops the terminal's escape sequences (bracketed-paste markers, arrow keys),
  and a line break inside a paste no longer ends the answer.
- cli, installer, registry: the guided path. The installer, on a terminal, goes straight into `pikit
  new`, which asks the agent's name and where to talk to it (the presets, by their new `title`), then
  sets up the channel, logs in to the model and starts it. Ctrl-C stops it; `pikit new` with the same
  name continues. The installer also adds you to the `docker` group when it installs Docker (with the
  same consent), and ends with the lines to paste. Ctrl-C at any prompt now exits with 130.
- cli, component/deployment-docker: an OAuth login made by `pikit configure` now reaches `pikit up`.
  `deployment-docker` exports `exec()` (`docker compose run --rm` of the app), and `configure` logs in
  through it, into the app's volume; `--login <provider> --local` logs in on this machine for `pikit
  dev`. `pikit up` checks the credentials where the app runs and refuses to start without them. It
  used to start an agent that failed at its first message.
- cli: `pikit configure` runs the steps components ship in `src/pikit/<name>/configure.ts`, before
  asking for the other variables; a component's variables are then its own. `channel-telegram`'s
  step checks the bot and allows you by asking you to message it. An end-to-end test covers
  `new --preset telegram` → `configure` → `dev` → an answer in the chat (SPEC §11).
- cli: a secret prompt turns echo off before it shows, so a value pasted the moment it appears is not
  echoed.
- registry: the `telegram` preset (`pikit new my-bot --preset telegram`), the `http` preset with
  `channel-telegram` instead of `channel-http` (SPEC §11).
- component/channel-telegram: talk to the agent in Telegram. It receives by long polling (no public
  URL), lets only `TELEGRAM_ALLOWED_USERS` reach the agent, and handles `/new`. It shows "typing…",
  formats Markdown, splits long answers and retries sends. It ships its own `pikit configure` step,
  which checks the token and allows whoever messages the bot (SPEC §5, §13).
- installer: `installer/install.sh` (`curl -fsSL <url> | sh`) puts `pikit` on a clean Debian/Ubuntu
  VPS or macOS: git, curl and unzip through apt-get after asking, Bun >= 1.4 from bun.sh, a Git
  checkout of pikit in `~/.pikit/pikit`, and `~/.pikit/bin/pikit`. It prints the PATH line instead
  of editing shell files, and installs Docker (Linux, official script) only with `--install-docker`
  or a "y". Idempotent; `PIKIT_SOURCE` installs from a local checkout.
- cli: the `pikit` CLI (`packages/cli`, M1 commands of SPEC §11). `pikit new <dir> --preset <name>`
  writes a project (its agent, `pikit.config.ts`, `package.json`, README), vendors `@pikit/core`,
  `@pikit/pi-adapter` and `@pikit/pi-extension-shim` into `vendor/`, adds every component of the
  preset, runs `bun install` and `doctor`. `pikit add` / `pikit remove` follow the install flow
  (files, npm dependencies, `pikit.config.ts`, `.env.example`, hashes in `pikit.json`) and removing
  what was added leaves no trace; `remove` refuses to leave a required capability without a provider
  and never deletes a file you modified without `--force`. `pikit doctor` prints the graph and checks
  providers, required variables and the Pi import rule, and lists modified files. `pikit configure`
  fills `.env` (0600) and logs in to model providers through pi-ai, also without a terminal
  (`--yes`, `--generate`). `pikit dev` runs the deployment's entrypoint with `bun --watch`;
  `up | down | restart | logs | status` delegate to the installed `deployment-*` component.
- registry: the `generate` / `validate` code moved into the CLI package (`packages/cli/src/registry/`);
  `bun run registry` is now a thin caller of `pikit registry`, so both run the same checks.
- adapter: a Pi extension's `pi.getActiveTools()` returns the tools an agent's `prepare` gave the
  run, in `before_agent_start` and after, and in a run resumed after a crash. It returned the tools
  the conversation opened with.
- component/deployment-docker: the `Dockerfile` copies `vendor/` before `bun install`, so a project
  whose `@pikit/*` packages are vendored tarballs (M1, until they are published) builds in Docker.
- component/deployment-docker: the JSON logger compares field names word by word, so token counts
  (`totalTokens`, `tokenCount`) are logged while tokens (`accessToken`, `PIKIT_HTTP_TOKEN`) stay redacted.
- samples: `samples/http` installs `log-events`, so it is exactly the `http` preset plus its own agents.
- registry: every component has a `component.json` and the registry a `registry.json` index.
  `bun run registry generate` writes the fields `setup` declares (`provides`, `requires.capabilities`,
  `optional.capabilities`, the tools' `replay`) from `describe()`; `bun run registry validate` fails on
  drift, naming, layout, install scripts, sibling or Pi imports, runtime imports outside a
  server-only component, `dependencies` that differ from the files' imports, and a `files` entry that
  maps a directory other than `files/src` (files outside `src/` are listed one by one).
- component/runtime-pi: documents and tests agents with `state` and `prepare`: a tool moves the
  conversation's state on and the next run gets the tools `prepare` gives for it. No new wiring:
  the state lives in the Pi session (SPEC §6.2a).
- adapter: runs an agent's `prepare(state)` in Pi's `before_run`, once per run, and gives the run
  the model, system prompt and tools it returns; each run's configuration is a `pikit.turn` custom
  entry in the session. A resumed run is prepared again with the current state; a failing `prepare`
  gives the run the static definition, logged. Every run's context carries its conversation's
  `AGENT_STATE`, so tools update the state. The scripted test provider calls any tool on
  `call: <tool> <json>` (SPEC §6.2a).
- adapter: `agent.state` stored in the conversation's Pi session as the session value
  `pikit` / `agent.state`; it passes `createAgentStateConformance` on memory and JSONL sessions
  (SPEC §6.4).
- core: `defineAgent({ state, prepare })`. `state` is each conversation's initial JSON state;
  `prepare(state, ctx)` returns what changes for a run (model, system prompt, tools) and is a plain
  function in tests. New export: `PrepareContext` (SPEC §6.2a).
- core: `AgentState` (`get` / `update(patch)`), the per-conversation JSON state of an agent, and the
  context key `AGENT_STATE` through which a tool reaches the state of the conversation it runs in;
  `createAgentStateConformance` in `@pikit/core/testing`, passed by an in-memory double (SPEC §6.2a).
- samples: `samples/http` runs through `deployment-docker`'s entrypoint (JSON-lines logs, deadlines,
  signals) and in Docker (`docker compose up` from `samples/http/`, built from the repository's root).
  `registry/presets/http.yaml` lists its components plus `log-events` and `deployment-docker`.
- component/deployment-docker: runs a project in Docker. Its entrypoint starts with a deadline, stops
  on SIGTERM/SIGINT within `stop_grace_period` and exits non-zero on failure; logs are JSON lines
  with secrets redacted by name; `Dockerfile`, `compose.yaml` and `.dockerignore` at the project root
  (non-root, `.pikit/` on a volume, `.env` at run time, healthcheck on `/health`); `up`, `down`,
  `restart`, `logs` and `status` for the CLI to delegate to (SPEC §9.1, §10.2, §11).
- component/log-events: one structured log line per `agent.*`, `conversation.reset`,
  `pipeline.halted` and `runtime.*` event, with the conversation, agent, request ids, admission and
  run kinds, duration, tokens, cost and error code; never a message's text (SPEC §9.1, §13).
- adapter: every `agent.settled` / `agent.failed` carries `usage`, the run's tokens and cost as Pi
  recorded them on the run's entries; the runs of a session add up to Pi's session totals (SPEC §6.1).
- samples: `samples/http`'s agent has Pi's `read`, `write`, `edit` and `bash` tools in its workspace,
  with `permission-gate` loaded; scenario 7 runs against the real `bash`.
- component/tool-bash: provides Pi's `bash` tool as `agent.tool` `bash`, working on `execution.shell`,
  with replay `never`; an agent gets it by naming it (SPEC §6.3).
- component/tool-edit: provides Pi's `edit` tool as `agent.tool` `edit`, working on `execution`,
  with replay `never`; an agent gets it by naming it (SPEC §6.3).
- component/tool-write: provides Pi's `write` tool as `agent.tool` `write`, working on `execution`,
  with replay `never`; an agent gets it by naming it (SPEC §6.3).
- component/tool-read: provides Pi's `read` tool as `agent.tool` `read`, working on `execution`,
  with replay `safe`; an agent gets it by naming it (SPEC §6.3).
- adapter: `@pikit/pi-adapter/tools` exposes Pi's `read`, `write`, `edit` and `bash` tools and
  `bindTool(tool, { env, replay })`, which binds a tool to its environment and sets its replay (SPEC §6.3).
- component/execution-local: provides `execution` and `execution.shell` on the server's filesystem
  and shell, in a working directory; commands start from an allowlist of variables. Not a sandbox
  (SPEC §8.3).
- adapter: `createLocalExecution({ cwd, env })` in `@pikit/pi-adapter/node` is Pi's `NodeExecutionEnv`
  whose commands start from the variables given, not from the server's environment (SPEC §8.3).
- component/runtime-pi: gives each agent the installed tools it names (`agent.tool`), and refuses to
  start when a named tool has no provider (SPEC §6.3).
- core: an agent names installed tools in `AgentDefinition.tools` (`["read", "bash", myTool]`),
  resolved through the keyed capability `agent.tool`; the adapter resolves them when a conversation
  opens (SPEC §6.3).
- adapter: `@pikit/pi-adapter` types `execution` and `execution.shell` (Pi's `ExecutionEnv`), and
  `createExecutionConformance` in `@pikit/pi-adapter/testing` checks them (SPEC §8.3, §14).
- spec: every component installs to `src/pikit/<name>/`, under its exact name, instead of a path by
  kind (`src/pikit/secrets-env/`, not `src/pikit/secrets/env/`) (SPEC §10.1).
- samples: `samples/http` talks to Claude over HTTP (SPEC §15 scenario 1), with an OAuth login
  script and end-to-end tests for scenario 1 and the HTTP half of scenario 7.
- component/channel-http: `POST /v1/messages` answers in the response (`200`, or `202` past
  `replyTimeoutMs`), including messages steered into a busy run; `POST /v1/conversations/:id/reset`;
  bearer token from `PIKIT_HTTP_TOKEN` (SPEC §5).
- component/server-bun: serves every `http.route` with Hono on `Bun.serve`, plus `GET /health` and an
  honest `GET /ready`. Stopping cancels the requests in flight (SPEC §9.1).
- component/router-basic: a `route.resolve` stage that sends every message no earlier stage routed
  to `defaultAgent` (SPEC §5).
- component/provider-anthropic: provides pi-ai's Anthropic provider as `model.provider` `anthropic`,
  signing in with a stored OAuth login or API key, or `ANTHROPIC_API_KEY` (SPEC §4.5).
- component/runtime-pi: builds its models with `model.credentials` when installed, and refuses to
  start when an agent's provider has no credentials at all (SPEC §6.2).
- adapter: the scripted test provider answers `bash: <command>` with a `bash` tool call and can
  require a stored API key (`scriptedProvider({ apiKey })`); `recordingBash` stands in for Pi's `bash`.
- component/credentials-file: provides `model.credentials` in a JSON file with mode 0600. Tokens
  that pi-ai refreshes are written back (SPEC §4.5).
- component/conversations-file: provides `conversations.registry` in one JSON file written
  atomically. It creates sessions through `sessions.store`, and a reset keeps the old session (SPEC §7.4, §7.6).
- component/sessions-jsonl: provides `sessions.store` as Pi's JSONL files on the server's disk, and
  passes Pi's session suites (SPEC §7.5).
- component/secrets-env: provides `secrets` from the process environment. An empty variable is not
  set, and it never reads a `.env` file itself (SPEC §4.5, §13).
- adapter: `@pikit/pi-adapter/providers/anthropic` exposes pi-ai's Anthropic provider by subpath
  (SPEC §6.2).
- adapter: `@pikit/pi-adapter` types `model.credentials` (pi-ai's `CredentialStore`),
  `modelsFrom(providers, { credentials })` builds models with it, and
  `createCredentialStoreConformance` in `@pikit/pi-adapter/testing` checks a store, including
  refreshed OAuth tokens written back (SPEC §4.5, §14).
- adapter: `@pikit/pi-adapter/node` exposes Pi's JSONL session store (`createJsonlSessionStore`),
  and `@pikit/pi-adapter/testing` Pi's session conformance suites with `storageOf` (SPEC §7.5).
- core: `http.route` contract (`HttpRoute`, keyed by `"METHOD /path"`) and its conformance suite
  (SPEC §9.1, §14).
- core: `conversations.registry` contract (`ConversationRegistry`), the `conversation.reset` event
  and its conformance suite (SPEC §7.4, §7.6, §14).
- core: `secrets` contract (`SecretStore`) and its conformance suite (SPEC §4.5, §14).
- core: `InboundMessage`, `RouteDecision` and the `inbound.authenticate`, `inbound.normalize` and
  `route.resolve` pipelines (SPEC §4.4, §5).
- adapter: Pi extensions see `agent_start` for a run resumed after a crash, and a closing
  conversation waits for their handlers and actions in flight, so an `agent_end` handler's
  `appendEntry` is not lost (SPEC §6.2b).
- adapter: existing Pi extensions run unmodified, except for their terminal UI. A vendored
  subset of `ExtensionAPI` lives in `@pikit/pi-adapter/extensions`, and
  `@pikit/pi-extension-shim` is installed as `@earendil-works/pi-coding-agent` so their imports
  resolve (SPEC §6.2b).
- component/runtime-pi: `createRuntimePi({ extensions })` loads Pi extensions for every
  conversation.
- core: `AgentResult.requestIds` lists every request a run answered, so a channel that replies per
  message answers the ones queued into a run too (SPEC §6.1).
- component/runtime-pi: the agent runtime component. Pi runs the agents through `@pikit/pi-adapter`;
  it provides `agent.runtime` over `sessions.store`, `agent.definition` and `model.provider`, and
  ships the `agent.runtime` and lifecycle conformance tests (SPEC §6).
- adapter: `@pikit/pi-adapter` implements `agent.runtime` on Pi 0.87.1, bridging four gaps of
  `pi-agent-core` until Pi's durable runtime ships (SPEC §6.4). `@pikit/pi-adapter/testing` runs
  a scripted model for component tests.
- core: the agent contracts (`defineAgent`, `AgentRuntime`, `agent.*` events, `agent.definition`)
  and the `agent.runtime` conformance suite in `@pikit/core/testing` (SPEC §6.1, §14).
