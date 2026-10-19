# scheduler-routines

Routines: prompts on a cron schedule in a conversation, written in `pikit.config.ts`, so they are
reviewed and versioned with the project. At each start it makes `scheduler`'s jobs match the config.

- **Uses:** `scheduler` (scheduler-sql).
- **Targets:** `server`, as scheduler-sql.
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
  routines of one name stop the start, naming it.

## Removing it

Set `routines` to `[]` and start once (its jobs are cancelled), then `pikit remove scheduler-routines`.
Removed first, its jobs stay in the scheduler and keep running.

## Tests

`scheduler-routines.test.ts` (copied with it), over an in-memory `scheduler`: what setup declares; jobs
added, changed and removed at each start, another component's untouched; a refused routine and two of
one name stop the start. A routine's tick through runtime-pi: scheduler-admit's `app.test.ts`.
