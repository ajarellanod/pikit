# Skills catalog: skills by name, like tools

**Public appeal:** — (pi-hive links a shared `.agents/skills/<name>` into each agent's `skills/`)

**Status:** built: the keyed capability `agent.skill` (`packages/contracts/src/agent.ts`), skills by
name in `AgentDefinition.skills`, `DirectoryAgent.skills` and runtime-pi's overrides, checked by
runtime-pi at start (a code agent) or when used (a live one), offered in the dashboard (agents-live's
Agents, router-basic's Agent). The catalog fills itself from `src/skills/` with
[agent folders](../agent-folders.md) (`pikit agents`). Still open: the questions below.

**Needed by:** nothing required. [Skills hub](../skills-hub.md) and [learned skills](../learned-skills.md)
write into the catalog.

## What it gives
A skill is installed once in the project and given by name to the agents that should have it, as a
tool or an extension is: `skills: ["review", "google-sheets"]`. An operator gives a live agent skills
in the dashboard, and turns a code agent's skills off there as an override.

## Pi first
The format is Agent Skills, the one Pi's coding agent reads, and Pi packages distribute skills
(`pi install`). pi-durable has no skills; the runtime's section and `skill` tool mirror Pi's coding
agent's (`packages/pi-adapter/src/agent.ts`). The catalog adds only names and the allow-list rule.

## How it fits pikit (built)
- **`agent.skill`**, keyed, beside `agent.tool`: one `AgentSkill` per name, keyed by its `name`.
  Provided by the project, as its agents are (`providedBy: "project"` in the capability catalogue):

  ```ts
  // src/extensions/skills.ts, a project component
  import review from "../skills/review/SKILL.md" with { type: "text" };
  const skill = defineSkill(review, { name: "review" });
  pikit.provideKeyed("agent.skill", skill.name, skill);
  ```

- **`AgentDefinition.skills` takes names or skills**, as `tools` does: `readonly (AgentSkill | string)[]`.
  A name is an installed skill; an object is a skill of the agent's own, which no other agent has.
  `defineAgent` checks the names' shape and that no name comes twice (`skillsProblem`, across names
  and objects); the runtime resolves each name when it builds a turn (`AgentConfigs.resolve`,
  `DurableRuntimeOptions.skill`) and checks the resolved list again. `prepare` may return names too.
- **Installing gives nothing.** A skill reaches only the agents that name it.
- **runtime-pi** refuses to start when a code agent names a skill nothing provides, or when a skill is
  provided under a name that is not its own; a live agent naming one fails its admission, saying why.
- **Live agents** (`DirectoryAgent.skills`): agents-live's schema offers the installed skills, and its
  Settings section has a Skills switch per skill.
- **Overrides**: runtime-pi's `skills` override turns off, live, skills among those an agent's
  definition names (a catalog name, or one of its own by its name); a skill `prepare` adds beyond them
  stays, as with tools. For a live agent, among the installed ones. router-basic's Agent section has a
  Skills switch per skill.
- **pikit-self** lists an agent's skills by name, the catalog's included.
- **A change is a change of the project.** Adding or editing a skill is source, through the steward's
  proposal and the operator's approval (SPEC §6). Choosing which installed skills an agent has is
  configuration, as choosing its tools is.

## Code and tests
- Contract: `packages/contracts/src/agent.ts` (`skills`, `skillsProblem`, `agent.skill`),
  `skill.ts` (`isSkillName`), `agent-directory.ts`; `skill.test.ts`; the `agent.directory` suite
  round-trips a live agent's skills (`AgentDirectoryFixture.skill`).
- Runtime: `packages/pi-adapter/src/agent.ts` and `runtime.ts`; `skills.test.ts` (a named skill is the
  agent's and an installed one not named is not offered, names beside own skills, `prepare` naming
  them, a name nothing provides).
- runtime-pi: `index.ts`, `overrides.ts`; `runtime-pi.test.ts` (a skill loaded by name, the two start
  failures), `live-agents.test.ts` (a live agent's skills, one naming a missing skill, its override),
  `overrides.test.ts` (the schema's default, skills turned off).
- agents-live: `index.ts`, `settings/index.tsx`, `agents-live.test.ts`; router-basic
  `settings/index.tsx`; extension-pikit-self's `agentSummary`.

## Open questions
- Skills of one agent (`src/agents/<name>/skills/`) beside the catalog's, once
  [agent folders](../agent-folders.md) generates both: a name in both is refused, or the agent's wins.
- Whether a skill declares the tools it needs (`bash`, `read`) so an agent naming it without them is
  refused at start.
- A registry component that ships a skill with the tool it needs: the capability is the project's
  today (`providedBy: "project"`).
