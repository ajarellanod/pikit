# agents-live

Agents as data: an operator creates, edits and removes agents in the dashboard, live.

- **Provides:** `agent.directory`, the agents an operator made, by name.
- **Requires:** `settings` (settings-store, which comes with the dashboard).
- **Uses:** `agent.definition` (the code's agents: no live agent takes one of their names),
  `model.provider`, `agent.tool` and `agent.extension` (what a live agent may name).
- **Targets:** `server` and `durable`.
- **Installs to:** `src/pikit/agents-live/`, and its Settings section to
  `src/dashboard/src/settings/agents-live/` when the project has a dashboard.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter`, `typebox`.
