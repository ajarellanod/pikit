# Tool policy

**Public appeal:** — (Hermes' command allowlist with approval patterns is the nearest)

**Specified:** partly (moved from SPEC §18; SPEC §13 states what it is not)

**Needed by:** nothing required.

## What it gives
Rules by agent role over what its tools may do: which commands and paths, allowed or denied, one
place for the whole project.

## How it fits pikit
- `policy-tools` intercepts tool calls: the adapter's translation of Pi's `before_tool` into the
  interceptable `agent.tool.call` (SPEC §6.2), and, to take tools away per role before a run, the
  `agent.prepare` pipeline ([pipeline anchors](pipeline-anchors.md)).
- Rules are values in its config (S7): roles, command and path patterns, allow and deny lists.
- It is policy mediation, not a sandbox (SPEC §13); isolation is an `execution` provider's
  ([sandboxed execution](sandboxed-execution.md)).
- Absent: agents have the tools they name, and the Pi extensions they name.

## Pi first
Pi's `tool_call` hook blocks or patches a call, and Pi's own `permission-gate` and `protected-paths`
extensions already run unmodified per agent (SPEC §6.2b, scenarios 7 and 8). A project may need
nothing more. `policy-tools` adds only rules by role across agents in one place; before building
it, check that a Pi extension named per agent does not already cover the case.

## Open questions
- "Hot-reloadable" (below) against a deep-frozen config (SPEC-CORE K4): a reload is a restart, or
  the rules are data in `storage.sql`.
- Where roles come from: the agent, the actor, or both.

## Moved from SPEC
SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `policy-tools` | Role-based interception of `agent.tool.call`: shell command and path rules, allow/deny lists, hot-reloadable. Policy mediation, not a sandbox. |
