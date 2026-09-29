# Scheduler and routines

**Public appeal:** ⭐ "Every morning at 8, summarize my inbox and send it to Telegram." Hermes has a
built-in cron scheduler with delivery to any platform (daily reports, nightly backups, set up in
natural language).

**Specified:** partly (moved from SPEC §18 and §9.1; the `scheduler` capability is named in SPEC §4.5)

**Needed by:** nothing required. Decided by the owner: scheduled work is a feature, so M2 (reliability)
and M4 (Cloudflare) do not require it.

## What it gives
Prompts that run on a schedule, in a conversation, with the answer delivered to the chat. Routines
are scheduled prompts defined as files next to the agent, reviewed and versioned like its prompt.

## How it fits pikit
- `scheduler-cron` (server) and `scheduler-cloudflare` (Cron Triggers fanning out to Durable
  Objects, SPEC §9.2) provide `scheduler` (`Scheduler`: register and cancel timed jobs), with a
  conformance suite first.
- `routines` reads `src/agents/{name}/routines/*.yaml` and registers them with `scheduler`. Its
  kind prefix is to decide (`scheduler-routines` fits the naming table).
- A job reaches an agent through `admitInbound`, which SPEC §4.9 already names for "channels, and
  later the scheduler". Its request id is derived from the job and its tick, so a tick fired twice
  is one message (logical deduplication is Pi's).
- The answer travels as any answer does: `agent.submissions`'s `answers` and a channel with
  `outbound.queue`. A channel that cannot push (HTTP) cannot receive a routine's answer.
- What a missed tick does after downtime is the component's policy, declared to its suite.
- Absent: no timer, no table, no config key.

## Pi first
One Pi process cannot wake itself when it is not running, and Pi has no clock-driven triggers.
Pi's durable runtime has `sleep(until)` inside a task (`pi-durable` 0.99.0, which the adapter does not
run yet; `pico-v5.md` §5), which covers "remind me in two hours" inside one conversation: pikit
must not build that. A schedule that starts runs across conversations is the host's.

## Open questions
- The agent creating a job from natural language: a `tool-schedule` (`replay: "never"`), or a
  routine file proposed through the self-change gate (SPEC-CORE §6)?
- Previous-run context injection needs the `agent.prepare` pipeline ([pipeline anchors](pipeline-anchors.md)).
- Timezones: a job's zone is a value; tests spawn a subprocess instead of mutating `TZ` (AGENTS.md).

## Moved from SPEC
SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `routines` | File-defined scheduled prompts (`src/agents/{name}/routines/*.yaml`) synced into `scheduler`, with target fan-out by route tags and previous-run context injection. |

SPEC §9.1:

- Scheduler: `scheduler-cron` (in-process, `Bun.cron` or `croner`), jobs persisted in
  `storage.sql`.
