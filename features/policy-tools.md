# Tool policy

**Public appeal:** — (Hermes' command allowlist with approval patterns is the nearest)

**Specified:** partly (moved from the former SPEC §18; its §13 stated what it is not)

**Needed by:** nothing required.

## What it gives
Rules by agent role over what its tools may do: which commands and paths, allowed or denied, one
place for the whole project.

## How it fits pikit
- `policy-tools` intercepts tool calls: the adapter's translation of Pi's `before_tool` into the
  interceptable `agent.tool.call` (planned in the former SPEC §6.2; not in the code), and, to take
  tools away per role before a run, the `agent.prepare` pipeline
  ([pipeline anchors](pipeline-anchors.md)).
- Rules are values in its config (MANIFESTO.md, principle 8): roles, command and path patterns,
  allow and deny lists.
- It is policy mediation, not a sandbox; isolation is an `execution` provider's
  ([sandboxed execution](sandboxed-execution.md)).
- Absent: agents have the tools they name.

## Pi first
Pi's `tool_call` hook blocks or patches a call. Pi's own `permission-gate` and `protected-paths`
extensions ran unmodified per agent until running Pi coding-agent extensions was dropped with the
move to pi-durable; pi-durable's own extensions will replace it. `policy-tools` adds only rules by
role across agents in one place; before building it, check that such an extension, named per agent,
does not already cover the case.

## Open questions
- "Hot-reloadable" (below) against a deep-frozen config (SPEC K4): a reload is a restart, or
  the rules are data in `storage.sql`. Code is never hot-reloaded ([kit follow-ups](kit-follow-ups.md),
  "No code hot reload"), so live rules can only be data.
- Where roles come from: the agent, the actor, or both.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `policy-tools` | Role-based interception of `agent.tool.call`: shell command and path rules, allow/deny lists, hot-reloadable. Policy mediation, not a sandbox. |
