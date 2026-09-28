# Pairing

**Public appeal:** ⭐ A stranger who writes to the bot waits until its owner approves them, from the
chat. OpenClaw pairs unknown senders by default (`openclaw pairing approve <channel> <code>`);
Hermes has DM pairing.

**Specified:** idea (the base is built: `channel-telegram`'s allowlist, SPEC §5)

**Needed by:** nothing required.

## What it gives
Access without editing `.env`: an unknown sender gets a code, the owner approves or refuses it in
their own chat, and the sender is in.

## How it fits pikit
- Today `channel-telegram` keeps its allowlist in `.env`, read through `secrets`, tells a stranger
  their id once, and its `configure` step allows whoever writes first (SPEC §5, §11).
- `router-pairing`: a `route.resolve` stage above the rules that denies an unknown actor, records a
  pairing request with a short code in `storage.sql`, and tells the owner; the approved actors are
  its records, per channel instance.
- The owner answers with a command ([slash commands](slash-commands.md)) or a button
  ([interaction](interaction.md), [approvals](approvals.md)).
- A denied sender is told, never left without an answer (the `denied` outcome, SPEC §5).
- Absent: each channel keeps its own allowlist.

## Pi first
Nothing in Pi: authorizing senders is ingress, which is pikit's (SPEC §6.2 table).

## Open questions
- Two sources of truth: a channel's allowlist in `.env` and the pairing records. The channel must
  let strangers reach routing when pairing is installed, without a flag (S3).
- Who is the owner, per instance; codes that expire; groups.
