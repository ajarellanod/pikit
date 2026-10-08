# agents-live

Agents as data: an operator creates, edits and removes agents in the dashboard, live, with no deploy
and no restart.

- **Provides:** `agent.directory`, the agents an operator made, by name.
- **Requires:** `settings` (settings-store, which comes with the dashboard).
- **Uses:** `agent.definition` (the code's agents: no live agent takes one of their names),
  `model.provider`, `agent.tool` and `agent.extension` (what a live agent may name).
- **Targets:** `server` and `durable`.
- **Installs to:** `src/pikit/agents-live/`, and its Settings section to
  `src/dashboard/src/settings/agents-live/` when the project has a dashboard.
- **npm dependencies:** `@pikit/contracts`, `@pikit/pi-adapter`, `typebox`.

## What it does

A live agent is a name (kebab-case), a description, a system prompt, a model (one an installed
provider has), and tools and extensions by name (installed ones). It is made in the dashboard's
Settings, **Agents**: "New agent", then Edit or remove each. The project's own agents (`src/agents/`)
are listed there too, read-only: their prompt, model and tools are changed in **Agent**
(router-basic's section), as overrides of their definition.

- **Stored** as agents-live's settings, one key per agent (`{ support: { model, systemPrompt, … } }`),
  validated against a schema declared at start from what the App has: a value naming a model, tool or
  extension it does not have, or a code agent's name, is refused (`400 invalid_value`).
- **Read when used.** runtime-pi asks the directory for a conversation's agent its definitions do not
  have, at every admission (on Cloudflare at most once a second per object), and checks it then: a new
  agent answers its first message, and a change applies to the next run. A message to an agent that
  cannot run (removed, its model gone after a deploy) fails its admission, saying why.
- **Never the steward** (SPEC §6): a live agent has no `steward` field and is never offered
  `pikit-self`, what the project is made of.
- **Overrides**: runtime-pi's overrides apply to a live agent too, but its own fields are edited here.
- **Reached** by a conversation started from the dashboard (the new-conversation picker lists live
  agents), or by a routing rule: with **router-rules** installed (its Routing section), a channel, chat
  or sender goes to a live agent. `pikit new`'s features step installs both ("Agents from the
  dashboard"); after `pikit add agents-live`, add `router-rules` for routing.

A conversation keeps the agent it was created with, while that agent exists. **Removing a live agent**
(or one becoming unable to run, its model gone) is permanent, and handled once per message, never
retried: the runtime rejects its conversations' next message with `AgentUnavailableError`, and
`admitInbound` moves the key to a new conversation of the agent routed now (a rule's, or router-basic's
default), keeps the old one, logs a warning naming both, and the message goes there. A rule that still
names the removed agent halts its messages (the channel says it cannot take them; Telegram gets its
`200`). Only while the directory was never read (it cannot be read yet) is a missing name a failure
for a while: the platform delivers the message again. Agents warns of this when you remove one.

## Removing it

`pikit remove agents-live`: the live agents are no agents any more (their settings stay stored,
unused); conversations of theirs move to the agent routed now at their next message, and router-rules'
rules naming them halt.

## Tests

`agents-live.test.ts` is copied with the component and runs in your project (a `settings` double): the
`agent.directory` conformance suite, the lifecycle suite, what setup declares, the schema (the App's
models, tools and extensions, not `pikit-self`, no steward, no code agent's name), a stored agent a
deploy made invalid, and the directory before start.

`component.json` is generated from `setup` by the CLI and is not written by hand. The test "what
setup declares" pins it.
