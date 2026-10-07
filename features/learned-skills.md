# Learned skills

**Public appeal:** ⭐ The agent gets better at recurring work by writing down how it did it. Hermes
creates skills autonomously after complex tasks, and its skills improve with use.

**Specified:** idea

**Needed by:** nothing required. It builds on self-improvement (SPEC §6), which already lets the
steward change its own skills through the gate.

## What it gives
After a task that took many steps, the agent writes a skill (a `SKILL.md` folder) so the next time
it loads instructions instead of rediscovering them; a skill that proves wrong is corrected.

## How it fits pikit
- A skill is a file of the project: `src/agents/{name}/skills/` (a folder with a `SKILL.md`, the
  format Pi's coding agent uses). pi-durable has no skills, so pikit loads them as data: an
  `agent.extension` whose system prompt `section` lists each skill's name and description, and the
  agent reads the one it needs with a read-only, replay-safe tool (`read`, or the extension's own).
  Nothing in a skill is executed. Writing one changes the agent, so it is a self-change: a branch,
  `pikit doctor` and tests, a human's approval, a deploy (SPEC §6). There is no second path: a skill
  written into a live store that the running agent loads would bypass the gate, and is refused.
- Levels of autonomy for "its own prompt or skills" are the policy component SPEC §6 already
  allows later, with automatic rollback. They never open the gate for anything else.
- Only the steward holds the self-change tools; another agent's skill is proposed by the steward.
- pikit adds the nudge (after a long run, suggest a skill): a hook of the same `agent.extension` on
  pi-durable's `GenerationTask` (`onYield` when the run would end, or `afterTools` to count a run's
  rounds), or a line of `pikit-self`. Agents that name the extension get both the list and the
  nudge; which skills an agent sees is its own (`AgentDefinition` has no `skills` field yet:
  `[planned]` in the former SPEC §6.2a, not in `packages/contracts/src/agent.ts`), which SPEC §6
  needs anyway for `pikit-self`.
- On Cloudflare nothing is loaded at run time: a learned skill reaches the agent at the next deploy.

## Pi first
Checked against Pi 1.0.3. Pi's coding agent implements the Agent Skills specification: skills are
listed by name and description and loaded on demand (`loadSkills` and `Skill` in pi-coding-agent's
`src/core/skills.ts`; its `docs/skills.md`). Its pi-durable mode does what pikit plans: a `skills`
system prompt section, loaded once per directory (`src/experimental/durable/prompt.ts`). pi-durable
itself (`@earendil-works/pi-durable`, what pikit runs) has no skills, and pi-agent-core no longer
holds them. pikit builds no skill format; the loader is the section above, as small as Pi's.

pi-durable makes a code change safe at a phase boundary: work already started keeps the code it took,
and the next phase, request or call uses the new code. A skill that is data (a document or a file
the section reads) changes without a code reload ([kit follow-ups](kit-follow-ups.md), "No code hot
reload").

## Open questions
- Approval fatigue: batch skill proposals, or let the autonomy policy take low-risk ones?
- How to tell a skill helped: pi-durable's usage records per run (`pi.usage`), before and after.
- May a non-steward agent ask the steward to write a skill for it, and through which path?
