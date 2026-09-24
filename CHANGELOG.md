# Changelog

What changed for someone who uses pikit, newest first. Components version on their own; each
line names its area (AGENTS.md, "Git and docs").

## Unreleased

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
