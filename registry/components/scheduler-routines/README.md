# scheduler-routines

Routines: prompts on a cron schedule in a conversation, written in `pikit.config.ts`, so they are
reviewed and versioned with the project. At each start it makes `scheduler`'s jobs match the config.

- **Uses:** `scheduler` (scheduler-sql), `actor.inbox` (its Worker half: `actor.mailbox`).
- **Targets:** `server` and `durable`, as scheduler-sql. On `durable` the routines' jobs live with one
  Durable Object, `scheduler-routines:routines`, which syncs them from the objects' config when the
  Worker half asks, at each start of the Worker's App (a deploy's `/health` starts it). The Worker
  half (`worker.ts`, `scheduler-routines-worker`) has no config of its own.
- **Installs to:** `src/pikit/scheduler-routines/` (`index.ts`, `contract.ts`, `scheduler-routines.test.ts`).

```sh
pikit add scheduler-routines
```

```ts
"scheduler-routines": {
  routines: [
    {
      name: "morning-summary",            // its identity: the job scheduler-routines:morning-summary
      key: "telegram:12345",              // an existing conversation's key, as its channel built it
      prompt: "Summarize what is due today.",
      cron: "0 8 * * 1-5",                // minute hour day month weekday
      timezone: "Europe/Madrid",          // default UTC
      missed: "once",                     // or "skip"; default once
    },
  ],
},
```

The key is the conversation's, built by its channel (the dashboard's conversations show theirs). A
routine whose key has no conversation yet waits: scheduler-admit drops its ticks, with a warning,
until that chat writes once.

## What it guarantees

- **The config is the truth, at each start.** A routine added is scheduled; one changed (key, prompt,
  cron, zone, missed) is cancelled and scheduled again, its next tick computed anew; one taken out is
  cancelled. An unchanged one is left as it is.
- **Only its own jobs** (`scheduler-routines:` ids): the agent's (tool-schedule) are never touched.
- **Fails loudly**: a routine the scheduler refuses (a cron that never matches, an unknown zone) or two
  routines of one name stop the start, naming it: on `durable` the Worker's start, so the deploy
  fails `/health` and rolls back. A routines' actor that cannot be reached is logged, and the next
  start of a Worker's App asks again.
- **One actor syncs**: `scheduler-routines.sync` is answered only for `scheduler-routines:routines`
  (`invalid` elsewhere); a refused routine is `invalid`, a failing store is not.

## Removing it

Set `routines` to `[]` and start once (its jobs are cancelled), then `pikit remove scheduler-routines`.
Removed first, its jobs stay in the scheduler and keep running.

## Tests

`scheduler-routines.test.ts` (copied with it), over an in-memory `scheduler`: what setup declares; jobs
added, changed and removed at each start, another component's untouched; a refused routine and two of
one name stop the start; the sync call answered only by its actor, a refused routine `invalid`, a
failing store not; the Worker half's start failing on `invalid` and only logging an unreachable actor.
A routine's tick through runtime-pi: scheduler-admit's `app.test.ts`; on Cloudflare (synced at the
Worker's start, a refused routine failing it): the workerd lane's `scheduler.workerd.ts`.
