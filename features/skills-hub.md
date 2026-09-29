# Skills hub

**Public appeal:** ⭐ Install a skill someone else wrote, in one command. Hermes points to a Skills
Hub (agentskills.io); OpenClaw has ClawHub.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
Find, install and update shared skills for an agent, from a public or private source.

## How it fits pikit
- Skills are source the user owns (SPEC P3): installing one copies a `SKILL.md` folder into
  `src/agents/{name}/skills/`, records its source and hashes in `pikit.json`, and keeps a base for
  `pikit upgrade` (P6), exactly as components are installed.
- A CLI command (`pikit add skill <source> --agent <name>`) in `packages/cli`; the registry format
  may gain a skill entry ([open registries](open-registries.md)).
- A skill can tell the model to run programs: installing one shows its files and provenance first,
  as `pikit add` does.
- The agent installing a skill for itself is a self-change, through the gate (SPEC §6).
- Absent: skills are copied by hand, as today.

## Pi first
Pi packages already distribute extensions, skills and prompt templates from npm or git, with pinned
versions (`pi install`, `docs/packages.md` of `pi-coding-agent`), and Pi reads the agentskills.io
format. pikit must not invent a skill package format: it reads Pi packages and agentskills folders,
and adds only the copy into the project as owned, recorded source.

## Open questions
- Install from Pi packages directly (their skills, and their extensions as `agent.extension`), or
  only from pikit registries?
- Trust: pinned commits only, or signatures?
- Updating a skill the agent has since improved: the same three-way merge as components (P6).
