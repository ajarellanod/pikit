# scheduler-admit

Each tick of `scheduler` becomes a message in its job's conversation, admitted with `admitInbound`
as a channel's message is; the conversation's own channel delivers the answer from the `answers`
feed, as it delivers every answer of that conversation.

- **Uses:** `scheduler` (scheduler-sql), `agent.runtime`, `conversations.registry`.
- **Targets:** `server`, as scheduler-sql.
- **Installs to:** `src/pikit/scheduler-admit/` (`index.ts`, `contract.ts`, `scheduler-admit.test.ts`).

## What it guarantees

- **An honest sender.** The message comes from the channel `scheduler`, its actor the job's id, so a
  run's tools and hooks see `{ channel: "scheduler", id: <job> }` (`RUN_REQUESTS`), never a person of
  a channel. Your router sees it too: a stage of `route.resolve` may deny `scheduler` messages.
- **One tick, one message.** The message id is `scheduler:<job>:<tick>`: a tick delivered twice is
  one request, which the runtime admits once.
- **Only into a conversation that exists.** A key no message ever resolved is left alone: the tick is
  dropped with a warning. Admitting would create the conversation with `scheduler` as its channel,
  which no channel delivers for. A routine for a chat starts working once that chat wrote once.
- A tick routing stops (`denied`, `halted`, `no_route`) is dropped with a warning; a failing
  capability rejects, and scheduler-sql delivers the tick again.

The answer goes where the conversation's answers go: a channel that pushes (Telegram, Google Chat,
the web chat) sends it to the chat. One that cannot push (HTTP) never receives it.

## Tests

`scheduler-admit.test.ts` (copied with it): what setup declares, and a tick's message. `app.test.ts`
in the registry (it imports other components): runtime-pi, conversations-kv, router-basic,
scheduler-sql, tool-schedule and scheduler-routines in a real App on a manual clock. A reminder the
agent schedules and a routine's tick each become a message from the scheduler in the person's
conversation, answered under its key; a restart between ticks loses none and duplicates none, even a
tick delivered twice; a job whose key has no conversation admits nothing and creates none; a
conversation cannot cancel another's job.
