# outbound-durable

Every answer your agent gives is stored before it is sent, and delivered even if the process dies,
the platform is down for ten minutes, or it asks you to slow down. It provides `outbound.queue`
(SPEC §5, "Outbound delivery") on `storage.sql`.

```sh
pikit add storage-sqlite      # the database it keeps its records in
pikit add outbound-durable
```

A channel that supports it (`channel-telegram`) uses it as soon as it is installed; remove it and
the channel sends directly again, best effort.

## What it does

- **Stored before sent.** A channel enqueues each answer; it is split into the pieces the platform
  accepts and stored in one transaction, one row per piece. Enqueuing the same answer twice sends it
  once.
- **In order, per conversation.** One conversation's pieces go out one at a time. A piece waiting to
  be retried holds the ones behind it; other conversations do not wait.
- **Failures** are classified by the channel, handled here:

  | The channel says | What happens |
  |---|---|
  | transient (network, 5xx) | retried after 5 s, 30 s, 2 min, 10 min; abandoned at the 5th failure |
  | rate limited | waits what the platform asked; not counted as a failure |
  | permanent (bot blocked, chat gone) | abandoned at once |
  | anything, after 24 hours | abandoned |

- **Crashes.** A piece that was being sent when the process died is sent again by the next one, as a
  *possible duplicate*: a platform with idempotent sends drops the copy; Telegram shows a `↻` marker.
  Losing an answer is worse than receiving it twice. A piece that had not been sent yet is sent
  normally.
- **Stopping** waits for the sends in flight, within the stop deadline, then aborts them; they are
  sent again (as possible duplicates) next time.

Known gap: an answer is enqueued by the channel right after the run ends. A crash in those few
milliseconds loses its delivery (the answer is still in the conversation's session). Pi's durable
runtime has the same gap; it closes when Pi can enqueue in the same commit as the answer.

## Seeing what happened

Everything is in the table `outbound_pieces` of the database (`.pikit/pikit.db`):

```sh
sqlite3 .pikit/pikit.db "SELECT key, state, attempts, last_error FROM outbound_pieces WHERE state != 'delivered'"
```

Delivered pieces are kept 7 days, abandoned ones 30, with their reason. Each delivery emits
`outbound.delivered`, each abandonment `outbound.abandoned` (and a warning in the logs).

## Config

```ts
"outbound-durable": {
  concurrency: 8,         // conversations sent to at the same time
  keepDeliveredDays: 7,
  keepAbandonedDays: 30,
}
```

## Removing it

`pikit remove outbound-durable`: channels send directly again. Pieces still pending in the table are
not sent by anyone; empty the table first if that matters.

## Tests

Copied with the component, they run in your project: the `outbound.queue` conformance suite (order,
each retry to the millisecond, rate limits, abandonment, restarts, detach), the lifecycle suite, and
a test that kills a process with SIGKILL during a send and checks the next process delivers it.
