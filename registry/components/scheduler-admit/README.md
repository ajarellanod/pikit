# scheduler-admit

Each tick of `scheduler` becomes a message in its job's conversation, admitted with `admitInbound`
as a channel's message is; the conversation's own channel delivers the answer from the `answers`
feed, as it delivers every answer of that conversation.

- **Uses:** `scheduler` (scheduler-sql), `agent.runtime`, `conversations.registry`, `actor.mailbox`,
  `actor.inbox`.
- **Targets:** `server` and `durable`, as scheduler-sql.
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
- **Admitted by its key's actor.** Each tick goes to the actor of its job's key
  (`actor.mailbox.send`, `scheduler-admit.tick`), whose handler admits it; the tick is done once it is
  admitted. On a server that actor is the App; on `durable` a conversation's own job is a local call,
  a routine's tick an RPC from the routines' actor to the conversation's object. The handler takes
  only a tick for its own key.

The answer goes where the conversation's answers go: a channel that pushes (Telegram, Google Chat,
the web chat) sends it to the chat. One that cannot push (HTTP) never receives it.

## Tests

`scheduler-admit.test.ts` (copied with it): what setup declares, a tick's message, and a tick for
another key ignored (checked against a handler without the key check). `app.test.ts`
in the registry (it imports other components): runtime-pi, conversations-kv, router-basic,
scheduler-sql, tool-schedule and scheduler-routines in a real App on a manual clock. A reminder the
agent schedules and a routine's tick each become a message from the scheduler in the person's
conversation, answered under its key; a restart between ticks loses none and duplicates none, even a
tick delivered twice; a job whose key has no conversation admits nothing and creates none; a
conversation cannot cancel another's job. On Cloudflare, the workerd lane's `scheduler.workerd.ts`: a
routine's tick sent from the routines' object to the chat's and answered there, an agent's reminder
answered from the chat's own object.
