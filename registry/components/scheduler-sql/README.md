# scheduler-sql

Scheduled prompts: jobs that run a prompt in a conversation once at a time, or on a cron schedule in
a time zone, kept in `storage.sql` and woken by `wakeups`. It declares and provides `scheduler`
(`contract.ts`); it runs no agent itself. Ticks reach their conversation through **scheduler-admit**;
jobs are made by **tool-schedule** (the agent) and **scheduler-routines** (your config).

- **Provides:** `scheduler` (declared here, `experimental`).
- **Uses:** `storage.sql` (its table `scheduler_sql_jobs`), `wakeups` (its wakeup `scheduler-sql`).
- **Depends on:** `croner` 10.0.1 (MIT, no dependencies, no `node:*`), for cron expressions and zones.
- **Targets:** `server`.
- **Installs to:** `src/pikit/scheduler-sql/` (`index.ts`, `contract.ts`, `conformance.ts`, `scheduler-sql.test.ts`).

```sh
pikit add scheduler-sql scheduler-admit
```

## The contract

A job is `{ id, key, prompt, when: { at } | { cron, timezone }, missed: "skip" | "once" }`; `next` is
its next tick. `schedule`, `get`, `list({ key?, prefix?, after?, limit })`, `cancel`, and `handle`, the
one handler of every tick (scheduler-admit's). A job's id is chosen by whoever schedules it, prefixed
with its component's name. A component that uses `scheduler` carries an identical copy of
`contract.ts`.

## What it guarantees

- **Never early, maybe late.** A tick is delivered at or after its time on the App's clock.
- **At least once, with its identity.** A job moves on only after the handler resolved for its tick;
  a crash in between, or a rejection, delivers the same `tick` again (a rejected tick after the
  wakeup's backoff; the other jobs due go on meanwhile).
- **Missed ticks.** A tick is missed when it is delivered more than `GRACE_MS` (5 minutes) after its
  time, or when the job's following tick is already due (after a stop, a crash). `skip` drops missed
  ticks; `once` delivers the earliest of them, once. Then the job goes on at its first tick after now.
- **An `at` job ends with its tick**: gone from `get` and `list`, and its id stays taken for
  `KEEP_ENDED_MS` (7 days), so an agent's call replayed after a crash does not schedule it again.
- **Idempotent by id**: `schedule` of a known id returns the stored job unchanged.
- **Cancel is effective**: it waits for a tick in progress (delivering and cancelling share one lock
  per App), and no tick of the job starts after it resolves.
- **Durable**: jobs are rows; at start it asks `wakeups` again for the earliest tick (wakeups-timers
  forgets its requests at a restart). Ticks due before `handle` is called wait for it.
- **Validated**: an empty id, key or prompt, one over `LIMITS`, a cron that is not 5 fields or never
  matches, an unknown zone, a time that is no integer: refused, nothing kept.

Decisions in its source: `GRACE_MS`, `KEEP_ENDED_MS`, `LIMITS`, 50 ticks per wakeup run. One App per
database: the lock is in the process (several processes on one database would need a lease per row).

## On Cloudflare (`durable`), not yet

Each conversation is a Durable Object with its own `storage.sql` and one alarm (`actors-do`'s
`wakeups`), so this component would keep one conversation's jobs in that conversation's object. That
fits jobs made in a conversation (tool-schedule: the key is the object's own), and the tick is then
admitted in the object that owns the key. What is missing: a job made elsewhere (scheduler-routines in
the Worker) must be sent to the object of its key (`actor.mailbox`, a message type that schedules),
`list` across keys needs an index (as pikit's Cloudflare conversation index does for conversations),
and the suite must run in the workerd lane. Until then the manifest says `server` only.

## Removing it

`pikit remove scheduler-sql` refuses while scheduler-admit, tool-schedule or scheduler-routines is
installed. Its table stays in the database (drop `scheduler_sql_jobs` by hand).

## Tests

`scheduler-sql.test.ts` runs the `scheduler` suite (`createSchedulerConformance`, `conformance.ts`)
over a SQLite file and the in-memory wakeups on a manual clock: never early, cron in a zone, one job
per id, a rejected tick and a tick cut by a restart delivered again with the same identity, cancel
during a tick, a restart with `once` and with `skip`, a tick within the grace, `list` by key, prefix
and page, invalid jobs refused, one handler. Plus what setup declares, and a cron tick across a change
of time. Each case was checked to catch a broken provider (ticks early, no missed policy, an upsert, no
ended ids, no re-arm at start). A second provider copies `conformance.ts` and runs it.
