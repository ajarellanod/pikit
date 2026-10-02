# Tool policy

**Public appeal:** — (Hermes' command allowlist with approval patterns is the nearest)

**Specified:** partly (moved from the former SPEC §18; its §13 stated what it is not)

**Needed by:** nothing required.

## What it gives
Rules by agent role over what its tools may do: which commands and paths, allowed or denied, one
place for the whole project.

## How it fits pikit
- `policy-tools` is an agent extension (`agent.extension`, skill `pikit-extension`), named by the
  agents it governs: a `hook(ToolTask, { beforeTool })` sees every call before it runs and returns
  `{ block: reason }` (the model reads the reason) or `{ arguments }` (rewritten), and a section can
  tell the model the rules up front. `extension-house-rules` is the reference: a section from config
  and a `beforeTool` hook that refuses tools by name; `policy-tools` adds command and path patterns,
  and roles.
- Taking a tool away entirely is the agent's own `tools` list, or its `prepare(state)` per run; a
  role that spans agents is one extension that several agents name (`extensions: [...shared]`), or
  one extension per role.
- Rules are values in its config (MANIFESTO.md, principle 8): roles, command and path patterns,
  allow and deny lists.
- A `beforeTool` hook runs again when a call is retried after a crash: it decides from the call
  alone and has no effect of its own.
- It is policy mediation, not a sandbox; isolation is an `execution` provider's
  ([sandboxed execution](sandboxed-execution.md)).
- Absent: agents have the tools they name.

## Pi first
pi-durable's `beforeTool` hook blocks or rewrites a call, and `afterTool` replaces a result: the
policy is a pi-durable extension, reached through `agent.extension`. `policy-tools` adds only rules
by role across agents in one place; before building it, check that `extension-house-rules`, or an
extension of Pi's named per agent, does not already cover the case.

## Open questions
- "Hot-reloadable" (below) against a deep-frozen config (SPEC K4): a reload is a restart, or
  the rules are data in `storage.sql`. Code is never hot-reloaded ([kit follow-ups](kit-follow-ups.md),
  "No code hot reload"), so live rules can only be data.
- Where roles come from: the agent, the actor, or both. The sender of a message does not reach a run
  today (only its conversation does), so a role by actor needs it first.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `policy-tools` | Role-based interception of `agent.tool.call`: shell command and path rules, allow/deny lists, hot-reloadable. Policy mediation, not a sandbox. |
