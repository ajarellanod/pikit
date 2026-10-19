# tool-schedule

The `schedule`, `listSchedules` and `cancelSchedule` tools, for the agents that name them: the agent
schedules a prompt that comes back to its own conversation once at a time or on a cron schedule ("remind
me at 9", "every weekday at 8, summarize…"), lists them and cancels them. Each tick is a message from
the scheduler (scheduler-admit), and the agent's answer goes to the chat.

A delegated agent (tool-delegate) schedules into the chat its task comes from: the job's key is the
conversation's origin (`originOf(CONVERSATION)`), since a task's own key has no conversation a tick
could enter. That chat's agent answers the prompt, not the delegated one (the model is told so); the
tree's conversations list and cancel those jobs, and share `maxPerConversation`.

- **Provides:** `agent.tool`, under `schedule`, `listSchedules` and `cancelSchedule` (replay `safe`).
- **Uses:** `scheduler` (scheduler-sql).
- **Targets:** `server`, as scheduler-sql.
- **Installs to:** `src/pikit/tool-schedule/` (`index.ts`, `contract.ts`, `tool-schedule.test.ts`).

```sh
pikit add tool-schedule
```

Name the tools in the agents that schedule (`src/agents/<agent>/agent.ts`):

```ts
defineAgent({ name: "assistant", model: "…", tools: ["schedule", "listSchedules", "cancelSchedule"] })
```

and, optionally, bound them in `pikit.config.ts`:

```ts
"tool-schedule": { maxPerConversation: 20 },
```

The model calls `schedule({ prompt, at? | cron?, timezone?, missed? })`: `at` is an ISO 8601
date-time with its offset (`2030-05-01T09:00:00+02:00`; never a server's local time), `cron` 5 fields
in `timezone` (default `UTC`), `missed` `once` (default) or `skip`.

## What it guarantees

- **Its own conversation only.** A job runs in the run's conversation key (`CONVERSATION`). Listing
  and cancelling see only the jobs this tool made for that key: another conversation's job, or a
  routine's, is "no such job", whatever id the model gives.
- **Idempotent, so replay `safe`.** A job's id is `tool-schedule:<conversation>:<call>`, the same when
  pi-durable runs an interrupted call again; scheduler-sql keeps a known id as it is, and keeps an
  ended one's id for a week. Cancelling twice is cancelling once.
- **Bounded**: at most `maxPerConversation` jobs per conversation key.

## Tests

`tool-schedule.test.ts` (copied with it), over an in-memory `scheduler`: what setup declares; a job in
the run's conversation under the call's id, the same call again the same job; refusals (no offset,
`at` and `cron`, neither, over the bound); another conversation's jobs and a routine's neither listed
nor cancelled. Through runtime-pi with the ticks coming back: scheduler-admit's `app.test.ts`.
