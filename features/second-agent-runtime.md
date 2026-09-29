# A second agent runtime

**Public appeal:** —

**Specified:** idea

**Needed by:** nothing required. Supporting runtimes other than Pi in v1 was a non-goal of the
former SPEC §1; today P1 says Pi is the agent.

## What it gives
Another agent loop (another SDK, a hosted agent) behind the same channels, routing and delivery.

## How it fits pikit
- A `runtime-*` component that provides `agent.runtime` and passes its conformance suite
  (`createAgentRuntimeConformance`, `@pikit/contracts/testing`): `dispatch` returning an admission,
  `agent.settled` / `agent.failed`, `resume()`.
- What does not carry over: Pi extensions (`agent.extension`), Pi's tools and `replay`, `prepare`
  applied through Pi's hooks, Pi sessions as the conversation's state. Its `doctor` must say which
  parts of an `AgentDefinition` it cannot honour.
- Absent: `runtime-pi`.

## Pi first
This is the one feature that goes around Pi rather than through it. The `AgentRuntime` boundary
exists "so it is possible, not so it is done" (the former SPEC §1).

## Open questions
- Whether any user needs it; nothing starts because it would be nice.

## Moved from the former ROADMAP
"Later, only if demanded":

> - A second agent runtime behind `AgentRuntime`.
