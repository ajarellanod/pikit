# Import from OpenClaw or Hermes

**Public appeal:** ⭐ Switch without starting over. Hermes imports settings, memories (`MEMORY.md`,
`USER.md`), skills and API keys from OpenClaw (`hermes claw migrate`, with a dry run).

**Specified:** idea

**Needed by:** nothing required.

## What it gives
A pikit project made from an existing OpenClaw or Hermes setup: its persona, skills, memories and
channels, ready to review.

## How it fits pikit
- A CLI command in `packages/cli`: `pikit import openclaw|hermes [<dir>] [--dry-run]`. It writes
  files and prints what it did; the user reviews the diff, as with any source they own.
- What maps to what:
  - skills → `src/agents/<name>/skills/` (both use `SKILL.md` folders);
  - persona and instructions → the agent's system prompt;
  - channels → the matching `channel-*` components, installed with `pikit add`, and their values
    through `pikit configure`;
  - memories and profiles → [memory](memory.md), only when it is installed;
  - API keys → `.env` or `model.credentials`, only with explicit consent, never printed (SPEC §13).
- What has no pikit counterpart is listed, not guessed.

## Pi first
Pi has no importer. Skills already in the agentskills format need no conversion.

## Open questions
- Which of their files are stable enough to read, and at which versions.
- Transcripts: imported as Pi sessions, or left behind.
- The migration as a skill for the steward agent (Hermes ships one), instead of a command.
