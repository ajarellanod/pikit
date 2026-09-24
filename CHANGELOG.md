# Changelog

What changed for someone who uses pikit, newest first. Components version on their own; each
line names its area (AGENTS.md, "Git and docs").

## Unreleased

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
