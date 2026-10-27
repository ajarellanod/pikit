# Scheduler and routines

**Public appeal:** ⭐ "Every morning at 8, summarize my inbox and send it to Telegram." Hermes has a
built-in cron scheduler with delivery to any platform (daily reports, nightly backups, set up in
natural language).

**Specified:** built on both targets (below). The contract is a registry's
own, declared by `scheduler-sql` (`docs/contracts.md`, "A registry's own contracts").

**Needed by:** nothing required. Decided by the owner: scheduled work is a feature, so neither
reliability (SPEC §2) nor Cloudflare (SPEC §4) requires it.

## What it gives
Prompts that run on a schedule, in a conversation, with the answer delivered to the chat: once at a
time (a reminder the agent sets) or on a cron schedule in a time zone (a routine). Routines are
written in `pikit.config.ts`, reviewed and versioned with the project.

## What is built
| Component | Provides / uses | What it is |
|---|---|---|
| `scheduler-sql` | declares and provides `scheduler`; uses `storage.sql`, `wakeups` | the jobs (a table), one wakeup at the earliest tick, cron by `croner` 10.0.1; the suite `createSchedulerConformance` (`conformance.ts`) |
| `scheduler-admit` | uses `scheduler`, `agent.runtime`, `conversations.registry`, `actor.mailbox`, `actor.inbox` | the tick handler: each tick sent to its key's actor, a message in the job's conversation there, through `admitInbound` |
| `tool-schedule` | `agent.tool` (`schedule`, `schedule_list`, `schedule_cancel`); uses `scheduler` | the agent schedules, lists and cancels prompts of its own conversation |
| `scheduler-routines` | uses `scheduler`, `actor.inbox`; its Worker half `actor.mailbox` | routines from its config, made the scheduler's jobs by one actor (`scheduler-routines:routines`): at each start on a server, at each start of the Worker's App on `durable` |

Why four: a tool cannot use `agent.runtime` (the runtime uses every tool: a start-order cycle), so the
store runs no agent and the admission is its own component; routines are a config block and work over
any `scheduler` provider; the tool is a risk class of its own (the model creates jobs).

## Decisions
- **A job runs in a conversation that exists, under its key.** A key is its channel's
  ([conversation routing](conversation-routing.md)): the scheduler makes none. scheduler-admit admits a
  tick only when the key has a conversation; otherwise it drops the tick with a warning, since admitting
  would create the conversation with `scheduler` as its channel, which no channel delivers for.
- **The sender is the scheduler, honestly**: channel `scheduler`, actor the job's id
  (`{ channel: "scheduler", id: <job> }` in `RUN_REQUESTS`), never a person of a channel. Routing sees it
  (`route.resolve`) and may deny it.
- **One tick, one message**: message id `scheduler:<job>:<tick>`, `tick` being the tick's scheduled
  time, the same however often the scheduler delivers it; the runtime deduplicates by request id.
- **The answer travels as any answer does**: the `answers` feed, delivered by the channel that owns the
  key (`startAnswerDelivery`). A channel that cannot push (HTTP) cannot receive a scheduled answer.
- **Missed ticks are the job's policy**: a tick delivered more than the provider's grace after its time
  (scheduler-sql: 5 minutes), or whose following tick is already due, is missed; `skip` drops missed
  ticks, `once` delivers the earliest one, once.
- **Idempotent ids, prefixed by their component**: `tool-schedule:<conversation>:<call>` (a replayed
  call is the same job; an ended `at` job's id stays taken a week), `scheduler-routines:<name>`.
- **Ownership**: tool-schedule lists and cancels only its own jobs of the run's conversation key; a
  routine is the config's, so the agent cannot cancel it.
- **Absent**: nothing installed, no timer, no table, no config key.

## Pi first
One Pi process cannot wake itself when it is not running, and Pi has no clock-driven triggers.
Pi's durable runtime has `sleep(until)` inside a task (`pi-durable` 1.3.0, which the kit runs on,
[pi-durable migration](completed/pi-durable-migration.md); on a host that is evicted the sleep needs a wake-up,
`docs/upstream/pi-durable-next-wake.md`), which covers "remind me in two hours" inside one conversation: pikit
must not build that. A schedule that starts runs across conversations is the host's.

tool-schedule's `at` overlaps with that sleep: it was built because a reminder that is a new message,
answered when it comes, keeps no run open meanwhile and is listed and cancelled like a routine.
Decided (2026-10-21): `at` stays. A sleep is inside a task, so its run stays open and the agent can
neither list nor cancel it, and on an evicted host it wakes only with pi-durable's next-wake proposal.

## On `durable` (built, 2026-10-21; the owner's decisions)
- **A job lives with the actor that scheduled it.** An agent's reminder is its conversation's object's
  (tool-schedule's key is the object's own: its ticks are local calls); the routines are one actor's,
  `scheduler-routines:routines`. scheduler-admit sends each tick to its key's object
  (`actor.mailbox`), which admits it. No index: `list` sees an actor's own jobs, and nothing lists
  every scheduled prompt (a view of them would add an index, as admin-api's conversation index).
- **A refused routine fails the deploy.** The Worker half asks the routines' actor to sync at each start
  of the Worker's App, which a deploy's `/health` starts: `invalid` fails the start, and the deploy
  rolls back, as a refused routine stops a server's start.
- **20 ticks per run** of scheduler-sql's wakeup, then a new alarm: one RPC per tick for another key
  stays within an alarm's 50 subrequests on the Free plan.

## Open questions
- **A reset between two deliveries of one tick**: the runtime deduplicates per conversation, so a tick
  delivered again after `/new` moved the key would be admitted again, in the new conversation. Only a
  crash between admitting and moving on, followed by a reset before the restart, reaches it.
- Previous-run context injection: an agent extension (`agent.extension`, skill `pikit`, `references/extension.md`)
  that `scheduler-routines` provides and the routine's agent names, whose section renders the
  routine's last answer from its own `storage.sql` table (written when the answer is read from the
  `answers` feed). What remains open is whether that context belongs in the system prompt (a section,
  which changes once per tick) or in the scheduled message itself.
- Routines as files next to the agent (`src/agents/{name}/routines/*.yaml`, below) instead of
  `pikit.config.ts`, and a routine proposed by the agent through the self-change gate (SPEC §6).
- Out of scope for now: fan-out to routed targets, pipelines with gates, `deliver_to` (an answer
  delivered elsewhere than its conversation), shell crons.

## Moved from the former SPEC
The former SPEC §18, "Higher-level components":

| Component | What it encodes |
|---|---|
| `routines` | File-defined scheduled prompts (`src/agents/{name}/routines/*.yaml`) synced into `scheduler`, with target fan-out by route tags and previous-run context injection. |

The former SPEC §9.1:

- Scheduler: `scheduler-cron` (in-process, `Bun.cron` or `croner`), jobs persisted in
  `storage.sql`.
