# submissions-sql

No message your agent accepted ends without its answer reaching you, across crashes, restarts and
deploys. It provides `agent.submissions` (@pikit/contracts' submissions.ts) on `storage.sql`.

```sh
pikit add storage-sqlite      # the database it keeps its records in
pikit add submissions-sql
```

**Target:** `server` and `durable`. On Cloudflare its database is the conversation's Durable
Object (`storage-do`), and the records are that conversation's.

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
  error), not its transcript, which stays in the runtime's conversation (pi-durable). Settling a run twice
  changes nothing.
- **Pending.** At start, `runtime-pi` reads the conversations with pending requests (and when the
  oldest was admitted) and resumes them, a few at a time, in the background.
- **Abandoned.** Requests nothing can answer are settled unanswered by one `failed` run with error
  code `abandoned` and the reason as its message, appended to `answers` in the same transaction; a
  request already settled keeps its run. No schema change: `admitted_at` and `error_code` hold it.
- **Answers** are a feed (`Feed`, SPEC K3): a channel reads them from a cursor of its own, whenever
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

## A bridge over pi-durable's submissions

pi-durable keeps a record per message in the conversation itself, with its answer, and the runtime
deduplicates and resumes from it. This component is the bridge the channels read until they read
pi-durable directly: what one pi-durable storage cannot answer stays (which conversations hold pending
work, across storages: a Cloudflare object has one each), and the feed channels deliver from
(`features/pi-durable-migration.md`). Its column `session_id` holds the conversation id.

## Removing it

`pikit remove submissions-sql`: the runtime and the channels go back to events. Its tables stay in the
database; drop them if you want (`submissions_requests`, `submissions_answers`, `submissions_meta`).

## Tests

Copied with the component, they run in your project: the `agent.submissions` conformance suite
(pending, idempotent settlement, per-conversation requests, restarts, pruning) with the feed suite over
`answers`, the lifecycle suite, the retention, a database from a newer version, two processes
migrating at once, and the convergence
suite (the process killed after each of its commits in turn: every message still settled and its
answer delivered). pikit also runs the `agent.submissions` suite, with its feed, pruning and
restarts, in workerd over `storage-do` on a real SQLite-backed Durable Object (`tests/workerd`).
