# Skills catalog: skills by name, like tools

**Public appeal:** — (pi-hive links a shared `.agents/skills/<name>` into each agent's `skills/`)

**Specified:** no. Built today: `AgentDefinition.skills` holds `AgentSkill` objects
(`defineSkill(text, { location? })`, `packages/contracts/src/skill.ts`), and the runtime gives an
agent with skills a section listing them and the tool `skill` (`packages/pi-adapter/src/agent.ts`).
A live agent ([agents-live](../registry/components/agents-live/README.md)) has no skills.

**Needed by:** nothing required. [Skills hub](skills-hub.md) and [learned skills](learned-skills.md)
write into the catalog once it exists.

## What it gives
A skill is installed once in the project and given by name to the agents that should have it, as a
tool or an extension is: `skills: ["review", "google-sheets"]`. An operator gives a live agent skills
in the dashboard, and changes a code agent's skills there as an override, from the same list.

## How it fits pikit
- **A keyed capability, `agent.skill`**, in `@pikit/contracts` beside `agent.tool`: one per skill,
  keyed by its name, an `AgentSkill`. A component provides them: the project's catalog
  (`src/skills/<name>/SKILL.md`, through the index [agent folders](agent-folders.md) generates), or a
  registry component that ships a skill with the tools it needs.
- **`AgentDefinition.skills` takes names**, as `tools` does: `readonly (AgentSkill | string)[]`, a
  string naming an installed skill, an object a skill of the agent's own (its folder's). The runtime
  resolves the names when the App starts and refuses to start on a name nothing provides, as it does for
  tools; `skillsProblem` checks the resolved list (no name twice, no tool of the agent named `skill`).
- **Installing gives nothing.** A skill in the catalog reaches only the agents that name it: what an
  agent knows is written where it is defined, the rule tools and extensions already follow.
- **Live agents and overrides** gain `skills`: agents-live's schema lists the installed `agent.skill`
  keys (a stored name that a deploy removed makes that agent unable to run, refused at admission as a
  missing tool is), runtime-pi's overrides accept `skills`, and their Settings sections offer the list.
- **Where its files are**: on a server a skill's `location` is its folder in the deployed project, so
  the scripts it names run through the agent's own tools; on Cloudflare it is its text only.
- **A change is a change of the project.** Adding or editing a skill is source, through the steward's
  proposal and the operator's approval (SPEC §6). An operator choosing which installed skills an agent
  has is configuration, as choosing its tools is, and is not a self-change.

## Pi first
The format is Agent Skills, the one Pi's coding agent reads, and Pi packages distribute skills
(`pi install`). pi-durable has no skills; the runtime's section and `skill` tool already mirror
Pi's coding agent's. The catalog adds only names and the allow-list rule.

## Tests
- Contracts: the `agent.runtime` suite gains a case: an agent naming a skill nothing provides does not
  start, saying which; a named skill is listed in the section and returned by `skill`.
- agents-live: a live agent naming an installed skill runs with it; one naming another is refused
  (`400 invalid_value`); a skill removed by a deploy makes the agent unable to run, not the App.
- A provider breaking the rule (giving every installed skill to every agent) fails the suite.

## Open questions
- Skills of one agent (`src/agents/<name>/skills/`) beside the catalog's: a name in both is refused,
  or the agent's wins.
- Whether a skill declares the tools it needs (`bash`, `read`) so an agent naming it without them is
  refused at start.
