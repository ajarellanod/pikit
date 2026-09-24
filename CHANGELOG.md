# Changelog

What changed for someone who uses pikit, newest first. Components version on their own; each
line names its area (AGENTS.md, "Git and docs").

## Unreleased

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
