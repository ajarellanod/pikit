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
- A skill is a file of the project: `src/agents/{name}/skills/` (Pi's format). Writing
  one changes the agent, so it is a self-change: a branch, `pikit doctor` and tests, a human's
  approval, a deploy (SPEC §6). There is no second path: a skill written into a live store
  that the running agent loads would bypass the gate, and is refused.
- Levels of autonomy for "its own prompt or skills" are the policy component SPEC §6 already
  allows later, with automatic rollback. They never open the gate for anything else.
- Only the steward holds the self-change tools; another agent's skill is proposed by the steward.
- pikit adds the nudge (after a long run, suggest a skill): a pi-durable extension at the run's end
  (once pikit adopts them; Pi coding-agent extensions no longer run) or a line of `pikit-self`. It needs a `skills` field of `AgentDefinition` (`[planned]` in the former
  SPEC §6.2a; not in `packages/contracts/src/agent.ts` yet), which SPEC §6 needs anyway for
  `pikit-self`.
- On Cloudflare nothing is loaded at run time: a learned skill reaches the agent at the next deploy.

## Pi first
Pi implements the Agent Skills specification: skills are listed by name and description and loaded
on demand (`Skill` and `AgentHarnessResources.skills` in `pi-agent-core`; `docs/skills.md` of
`pi-coding-agent`). Pi's durable runtime makes a code change a generation boundary. pikit builds no
skill format, loader or store.

## Open questions
- Approval fatigue: batch skill proposals, or let the autonomy policy take low-risk ones?
- How to tell a skill helped: Pi's usage records per run, before and after.
- May a non-steward agent ask the steward to write a skill for it, and through which path?
