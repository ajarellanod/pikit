# submissions-sql

No message your agent accepted ends without its answer reaching you, across crashes, restarts and
deploys. It provides `agent.submissions` (SPEC §6.1, §6.4) on `storage.sql`.

```sh
pikit add storage-sqlite      # the database it keeps its records in
pikit add submissions-sql
```

`pikit add runtime-pi` offers it (with `storage-sqlite`). The runtime and the channels that support it
(`channel-telegram`, `channel-http`) use it as soon as it is installed; remove it and they work as
before, from events only.

## What it fixes

- **A deploy during a long answer.** `pikit up` stops the channel before the runtime; a run that ends
  in between used to be answered to nobody. Now its outcome is recorded, and the channel delivers it
  when it starts again.
- **A crash after the platform was told "received".** Telegram does not send a message again once it
  was acknowledged. The runtime now resumes, at start, every conversation holding a message nobody
  answered, with no new message needed.
- **An HTTP answer that took too long.** A `POST` that answered `202` can fetch its answer later with
  `GET /v1/conversations/:id/messages/:messageId`, and sending the same `messageId` again answers with
  its outcome instead of `409 duplicate`.

## How

- **Admitted.** The runtime records each message once Pi holds it and before `dispatch` returns, so a
  channel acknowledges its platform only once both hold it (`submissions_requests`).
- **Settled.** When a run ends, the requests it took are settled by it, and the run is appended to
  `answers` in the same transaction (`submissions_answers`): what it said (its final text, or its
  error), not its transcript, which stays in the conversation's Pi session. Settling a run twice
  changes nothing.
- **Pending.** At start, `runtime-pi` reads the conversations with pending requests and resumes them,
  a few at a time, in the background.
- **Answers** are a feed (SPEC §4.8): a channel reads them from a cursor of its own, whenever
  `agent.settled` wakes it and when it starts, so a crash only delays a delivery.

```ts
const page = await submissions.answers.read(savedCursor, 50);
for (const { cursor, fact } of page.items) {
  // fact.conversation, fact.requestId (the run's first request: answerKey(conversation, requestId)),
  // fact.requestIds, fact.kind ("completed" | "failed" | "aborted"), fact.text, fact.error
}
if (page.gap) {
  // Settlements after savedCursor were pruned before you read them: say so.
}
```

## Retention

Settled runs, and the requests they settled, are kept `keepSettledDays` (7 by default), then pruned at
start and at most hourly after. Pending requests are never pruned: nothing answered them yet.

`keepSettledDays` is at least 1. The retention is how long a stopped channel has to read an answer:
with 0, `start` would prune every answer that ended during a deploy before the channels start (each
reader told `gap`, the answer never delivered), and the hourly prune could drop an answer settled a
moment earlier that a woken channel has not read yet. Settling a run is idempotent only within the
retention: once pruned, the same run settled again is appended to `answers` a second time.

## Seeing what happened

```sh
sqlite3 .pikit/pikit.db "SELECT session_id, request_id, conversation_key FROM submissions_requests WHERE answer_seq IS NULL"
sqlite3 .pikit/pikit.db "SELECT seq, conversation_key, request_id, kind, error_code FROM submissions_answers ORDER BY seq DESC LIMIT 20"
```

## Config

```ts
"submissions-sql": {
  keepSettledDays: 7,
}
```

## When Pi's durable runtime ships submissions

Pi's durable runtime (`pi-durable`) will keep a record per message in the session itself, with its
answer. The adapter will then use Pi's, and what this component records per session goes. What one
session cannot know stays: which sessions hold pending work, and the feed channels deliver from
(SPEC §6.4).

## Removing it

`pikit remove submissions-sql`: the runtime and the channels go back to events. Its tables stay in the
database; drop them if you want (`submissions_requests`, `submissions_answers`, `submissions_meta`).

## Tests

Copied with the component, they run in your project: the `agent.submissions` conformance suite
(pending, idempotent settlement, per-session requests, restarts, pruning) with the feed suite over
`answers`, the lifecycle suite, the retention, a database from a newer version, and the convergence
suite (the process killed after each of its commits in turn: every message still settled and its
answer delivered).
