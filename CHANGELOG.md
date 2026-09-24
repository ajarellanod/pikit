# Changelog

What changed for someone who uses pikit, newest first. Components version on their own; each
line names its area (AGENTS.md, "Git and docs").

## Unreleased

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
